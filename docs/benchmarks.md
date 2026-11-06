# Benchmarks

Numbers are from a developer laptop unless stated otherwise. Re-run the scripts after changing the SDK hot path or the ingest path, and update this file in the same commit.

## SDK overhead per call

Target: **p99 < 0.1 ms (100 µs)** of SDK work per outgoing call.

Script: `pnpm --filter @theirside/sdk bench` (`packages/sdk/bench/overhead.ts`, 50,000 sequential calls per client after 2,000 warm-up calls, against a local HTTP server, SDK fully enabled: provider matching, an explicit route, auto templating of a PAN-carrying path, a `getCorrelationId` function, request-ID header lookup, batching and gzip uploads to a local collector running throughout).

Method: the script wraps every `diagnostics_channel` subscriber the SDK registers (by patching `subscribe` before `init`) and `Recorder.end` (called from the request's emit wrapper on http); nested time is counted once. Because calls are sequential, the SDK time accumulated during one call is that call's sample. Not included: the per-event function call of the emit wrapper on http requests (a closure call plus a `switch`, nanoseconds), and the batch upload, which runs once per flush off the request path (serialising 500 events takes about 0.3 ms on the event loop; gzip runs on the libuv thread pool).

2026-11-03, Node v24.13.0, macOS x64 (12 cores), two runs (second shown; the first was within 1 µs at p99):

| Client | mean | p50 | p95 | p99 | max |
|---|---|---|---|---|---|
| `http.get` | 15.3 µs | 14.3 µs | 20.6 µs | **32.3 µs** | 186 µs |
| `fetch` | 11.6 µs | 11.0 µs | 15.1 µs | **23.8 µs** | 144 µs |

Result: **pass**, p99 is 3–4× under the target.

End-to-end loopback latency (10,000 calls each; context only, dominated by loopback and event-loop noise, and the "without" run goes first with a colder JIT, so the order biases it):

| Client | without SDK p50 / p99 | with SDK p50 / p99 |
|---|---|---|
| `http.get` | 161 / 422 µs | 174 / 583 µs |
| `fetch` | 266 / 553 µs | 234 / 485 µs |

## SDK memory soak

Target: the SDK never makes the host app's memory grow. After a 5-minute warm-up, heap growth over the next 55 minutes is **< 1 MB with no upward trend**, with the collector up and with it unreachable.

Tool: `tools/soak` (`pnpm --filter @theirside/sdk build`, then `pnpm --filter @theirside/soak soak -- --minutes 60 --collector up|down|cycle [--no-sdk] [--out run.csv]`).

- The measured process (`tools/soak/src/app.mjs`) is a plain-JS host app that loads the **built** SDK, as users do (no tsx, no source condition). The fake provider and collector run in the parent process (`run.mjs`), so their memory is not counted.
- Traffic: 300 calls/s, rotating fetch, `http.get` and axios, with fresh IDs in every path (numbers, UUIDs, tokens) so endpoint templating sees an unbounded stream of raw paths. Per 100 calls: 70 ok, 8 HTTP 503, 4 HTTP 404, 5 client timeouts (100 ms against a provider that never answers), 5 caller aborts (10 ms), 4 connection refused, 3 connection resets, 1 call to an untracked host.
- Collector modes: `up` (fake collector answers 202), `down` (port closed: every flush fails with ECONNREFUSED), `cycle` (up and down alternating every 10 minutes).
- Every 10 s the app forces a full GC (`--expose-gc`) and reports `heapUsed`, RSS, external memory and the SDK's queue/drop/sent counters. The runner fits a least-squares line to heap used after the warm-up and reports the slope, the growth it implies over 55 minutes, and R² (how much of the variation is a trend).
- Name-like path segments (`/v1/customers/anna-smith/cards`, `/v2/people/ivan-petrenko`, 2,500 combinations) exercise the route learner's 5-sightings rule; half of the http/axios calls go to discovered hosts (20 vendors with subdomains, 5,000 tenant subdomains).
- `--collector external --endpoint URL --api-key KEY` sends to a real collector instead of the fake; `--hours N` sets the length; the CSV (`--out`) is written as samples arrive, and SIGTERM ends a run early with a report.
- Overnight: `tools/soak/overnight.sh [--hours 8]` starts `src/overnight.mjs` detached (`nohup caffeinate -i -s`). It checks that the collector on `:4318` answers `/v1/sdk-config`, then runs three variants in parallel on the same machine: (a) SDK on with the real collector (Docker stack), (b) SDK on with the collector unreachable (closed port), (c) SDK off. Samples every 30 s into one CSV per variant under `tools/soak/results/<date>/` (git-ignored), and at the end writes `SUMMARY.md` (`src/summary.mjs`, also runnable by hand on a results folder): heap and RSS slopes per hour per variant, the gaps a − c and b − c, first half vs second half to see whether the gap levels off, and a verdict (thresholds in the file). Stop early with `kill <orchestrator pid>` from `pids.json`; the summary covers what ran.
- Heap snapshots (`--snapshots 180,840`) and `pnpm --filter @theirside/soak diff early.heapsnapshot late.heapsnapshot` compare objects by constructor. Use them only in diagnostic runs: writing a snapshot adds 100+ MB of RSS to the process.

2026-11-04, Node v24.13.0, macOS x64, four 60-minute runs in parallel, ~1.0 M calls each:

| run | heap after warm-up | heap growth over 55 min (slope) | R² | RSS over the hour |
|---|---|---|---|---|
| SDK on, collector up | 13.35–14.25 MB | **+0.23 MB** (0.25 MB/h) | 0.14 | 222 → 204 MB |
| SDK on, collector down | 15.85–16.59 MB | **+0.21 MB** (0.23 MB/h) | 0.19 | 226 → 206 MB |
| SDK on, collector cycling every 10 min | 13.43–16.80 MB | +0.97 MB overall; +0.42 MB within "up" phases, +0.26 MB within "down" phases | 0.05 | 222 → 208 MB |
| SDK off (control) | 12.62–13.24 MB | **+0.19 MB** (0.20 MB/h) | 0.46 | 221 → 203 MB |

Result: **pass**. The heap grows at the same rate with the SDK on as with it off (V8 compiling more code and interning strings; the 15-minute snapshot diffs show only `(code)` and string growth, no SDK objects: no pending-call state, events, maps or timers accumulate). With the collector down, the heap sits ~2.5 MB higher because the queue is full at `maxQueue` (10,000 events), which is the designed bound; it drains as soon as the collector is back. The cycling run's overall slope is that sawtooth (it starts in an "up" phase and ends in a "down" phase), not a trend (R² 0.05). RSS *falls* by about 18–20 MB over the hour in every run, SDK on or off.

What was behind the earlier "+8 MB": the first soak (below) measured RSS of a process running the SDK from TypeScript source through tsx, with no SDK-off control. RSS rises during the first minutes of any Node process under load (allocator arenas, JIT, socket buffers) and is not a leak signal; heap after a forced GC is. Nothing in the SDK needed fixing; the fix is the measurement (built SDK, forced GC, heap slope, SDK-off control).

#### After auto-discovery

Same tool, with half of the http and axios calls going to discovered hosts (`api|files|sandbox.vendor0…19.test` and 5,000 tenant subdomains `t*.saasco.test`, all resolved to the local provider), so the SDK's host policy, route learner, templater caps and remote-config polling are all exercised. 2026-11-04, Node v24.13.0, macOS x64, 60-minute runs, ~1.0 M calls each:

| run | heap after warm-up | heap growth over 55 min (slope) | R² | RSS growth over 55 min |
|---|---|---|---|---|
| SDK on, collector up | 14.75–15.88 MB | **+0.40 MB** (0.43 MB/h) | 0.30 | +16.2 MB |
| SDK on, collector down | 17.54–18.29 MB | **+0.21 MB** (0.23 MB/h) | 0.16 | +12.8 MB |
| SDK on, collector cycling every 10 min | 14.61–18.39 MB | +1.08 MB overall; +0.28 MB within "up" phases, +0.51 MB within "down" | 0.06 | +6.4 MB |
| SDK off (control) | 13.36–13.99 MB | **+0.18 MB** (0.19 MB/h) | 0.28 | +9.1 MB |

Result: **pass** on the heap criterion: no upward trend, with the SDK on or off; the learner and templater stay inside their caps (also covered by unit tests with 100,000 calls over 5,000 hosts). The heap sits ~1.5 MB higher than before discovery: the bounded host/route/template caches filling up.

Not settled: with this traffic RSS rises steadily in every run, the SDK-off control included (+9 MB/h), so most of it is the test app's own load (thousands of distinct hosts and keep-alive sockets in its agent). With the SDK on it rises 4–7 MB/h more than without while the JS heap stays flat, i.e. native memory (socket, TLS-free http and zlib buffers) rather than accumulating SDK objects. Whether it levels off needs a longer run (several hours) on a real staging environment; the pre-discovery runs above, with one host, showed RSS falling. Three of the first runs crashed on a harness bug (the test app's custom DNS lookup answered synchronously, so a rare `EINVAL` reached a socket before `http` listened); the lookup is asynchronous now and the numbers above are from clean reruns.

CI runs a 5-minute version (`soak:ci`, collector up and down as two jobs): 1-minute warm-up, slope projected to 55 minutes, fails at ≥ 5 MB with R² ≥ 0.5. Checked against an injected leak (`--leak-bytes 16`, a retained string per call, ~110 bytes of heap each): +112 MB projected, R² 1.00, exit 1. At 300 calls/s the 5 MB threshold corresponds to a leak of about 5 bytes per call.

## Flush per invocation (serverless)

Target: a function pays little for `wrap()`'s flush with a reachable collector, and at most the cap (300 ms by default) when it isn't.

Script: `pnpm --filter @theirside/sdk bench:flush` (`packages/sdk/bench/flush.ts`): 200 invocations of a wrapped handler that records 10 calls each, against a local collector (serverless mode: a new connection per flush; and long-running mode with keep-alive), a closed port and a collector that never answers (20 invocations each).

2026-11-07, Node v24.13.0, macOS x64, time added to each invocation:

| collector | median | p95 | max |
|---|---|---|---|
| up, serverless (new connection per flush) | 0.84 ms | 1.38 ms | 19.10 ms |
| up, long-running (keep-alive) | 0.53 ms | 0.75 ms | 1.69 ms |
| unreachable (closed port) | 0.73 ms | 2.51 ms | 2.51 ms |
| never answers (cap 300 ms) | 300.86 ms | 301.47 ms | 301.47 ms |

A refused connection fails fast; a collector that accepts and hangs costs the full cap, so keep `flushTimeoutMs` small where every millisecond is billed. A real collector across a network adds its round trip (one TLS handshake per invocation in serverless mode).

## SDK with the collector unreachable

Target: memory stays bounded and the app is unaffected when the collector is down for 10 minutes.

Script: `pnpm --filter @theirside/sdk bench:collector-down -- --minutes 10` (`packages/sdk/bench/collector-down.ts`): the SDK points at a port with nothing listening; the "app" makes 500 calls/s (half `http.get`, half `fetch`) to a local provider; `maxQueue` 10,000; heap measured after a forced GC.

2026-11-03, Node v24.13.0, macOS x64, 10 minutes, collector port closed the whole time (sampled every 60 s, heap after forced GC):

| elapsed | calls | heap MB | RSS MB | queued | dropped | last flush error | app p50 | app p99 |
|---|---|---|---|---|---|---|---|---|
| 60 s | 27,910 | 14.9 | 269 | 10,460 | 17,450 | ECONNREFUSED | 1.16 ms | 2.40 ms |
| 120 s | 55,730 | 14.9 | 272 | 10,460 | 45,265 | ECONNREFUSED | 1.10 ms | 2.22 ms |
| 180 s | 83,555 | 14.8 | 273 | 10,460 | 73,095 | ECONNREFUSED | 1.13 ms | 2.26 ms |
| 240 s | 111,345 | 14.7 | 274 | 10,460 | 100,885 | ECONNREFUSED | 1.16 ms | 2.10 ms |
| 300 s | 139,175 | 14.8 | 274 | 10,460 | 128,710 | ECONNREFUSED | 1.13 ms | 2.14 ms |
| 360 s | 167,010 | 14.6 | 275 | 10,460 | 156,550 | ECONNREFUSED | 1.13 ms | 1.92 ms |
| 420 s | 194,830 | 14.7 | 276 | 10,460 | 184,370 | ECONNREFUSED | 1.15 ms | 2.13 ms |
| 480 s | 222,655 | 14.7 | 277 | 10,460 | 212,195 | ECONNREFUSED | 1.14 ms | 2.10 ms |
| 540 s | 250,565 | 14.7 | 277 | 10,460 | 240,105 | ECONNREFUSED | 1.15 ms | 2.17 ms |
| 600 s | 278,430 | 14.6 | 277 | 10,460 | 267,970 | ECONNREFUSED | 1.15 ms | 2.13 ms |

Result: **pass**. The queue sits at `maxQueue` (10,000) plus the one batch kept for retry (460); the JS heap is flat; app latency is flat and there were 0 app errors; `shutdown()` returned in 4 ms. RSS rose 8 MB in the first 8 minutes and then stayed level; the JS heap (where all SDK buffers live) did not grow. The memory soak below, with an SDK-off control, shows this is process warm-up and not the SDK. Actual rate was ~465 calls/s (10 ms timer granularity).

A compressed version runs in CI (`packages/sdk/test/transport.test.ts`: 200,000 events into a 1,000-slot queue with the collector down; asserts the queue bound, the drop count and < 50 MB heap growth).

## Collector ingest

Target: **5,000 events/s on a small box.**

Script: `pnpm --filter @theirside/collector bench:ingest -- --seconds 60 --concurrency 4` (`apps/collector/bench/ingest-load.ts`): pre-built gzip batches of 500 realistic events (3 providers, ~20 endpoints, ~3% errors, request and correlation IDs), posted to `/v1/ingest` at fixed concurrency; each request is a full ingest transaction (raw insert, rollup upsert, usage, SDK heartbeat).

Setup: `docker/docker-compose.yml` stack on Docker Desktop (macOS x64 host), containers capped with `docker update`: **collector 1 CPU / 512 MB, Postgres 16 1 CPU / 1 GB**, default Postgres settings.

2026-11-04, 60 s run:

| events/s | requests | statuses | request p50 / p95 / p99 | collector RSS | Postgres RSS |
|---|---|---|---|---|---|
| **25,340** (1.52 M events) | 3,043 × 500 events | all 202 | 81 / 123 / 180 ms | 122 MB | 386 MB |

Result: **pass**, about 5× the target. Storage: 216 bytes per raw event including indexes (313 MB for 1.52 M events); rollups are negligible (31 rows for that run's keys and minutes).

### Postgres outage

Same stack and load (concurrency 2), Postgres container stopped at 10 s and started at 25 s:

| phase | result |
|---|---|
| before | ~24,000 events/s, 202 |
| Postgres down | `/v1/ingest` answers **503** with `Retry-After: 30` (1,135 requests), `/healthz` stays 200 with `db: "unavailable"` so the container is not restarted |
| Postgres back | 202 again within seconds, ~27,000 events/s |

Collector restarts: 0. This run first exposed a crash (pg emits `error` on checked-out clients whose connection dies; only idle-client errors were handled). Fixed, with a regression test in `apps/collector/test/outage.test.ts`. The same file runs the end-to-end check with a real SDK: Postgres is cut behind a TCP proxy while a "demo app" calls a provider through the SDK; the SDK sees 503, backs off (≤ 2 attempts in 1.5 s against a 100 ms flush interval), the app has 0 errors and p99 < 25 ms, and after recovery every event is stored.
