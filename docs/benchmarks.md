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

### Incoming requests (webhook check)

Every request the app serves passes the inbound webhook check (`http.server.request.start`). Script: `pnpm --filter @theirside/sdk bench:inbound` (`packages/sdk/bench/inbound.ts`): `InboundRecorder.begin` for an ordinary API GET and POST with eight typical headers, and begin + end for a Stripe delivery (detection, timestamp parse, templating, queueing). A POST or PUT also goes through webhook discovery: a regex pre-check of the path for route words, a scan of the header names for a signature or HMAC header, the CloudEvents headers, and the `content-type` and `host` values. Not included: the diagnostics channel dispatch itself, and the response's emit wrapper for a delivery (a closure call per event).

2026-11-10, Node v24.13.0, macOS x64 (with webhook discovery): **0.59 µs** per ordinary GET (only header names are checked), **0.80 µs** per ordinary POST, **1.68 µs** per webhook delivery. Before webhook discovery the ordinary request was 0.46 µs. 2026-11-12, with the wider discovery rules (signature or HMAC names, CloudEvents, webhook hosts, version-path names): **0.53 µs** per ordinary GET, **1.53 µs** per ordinary POST (0.77 µs before them), **1.71 µs** per webhook delivery. All far under the 100 µs target.

## SDK memory soak

Target: the SDK never makes the host app's memory grow. After a 5-minute warm-up, heap growth over the next 55 minutes is **< 1 MB with no upward trend**, with the collector up and with it unreachable.

Tool: `tools/soak` (`pnpm --filter @theirside/sdk build`, then `pnpm --filter @theirside/soak soak -- --minutes 60 --collector up|down|cycle [--no-sdk] [--out run.csv]`).

- The measured process (`tools/soak/src/app.mjs`) is a plain-JS host app that loads the **built** SDK, as users do (no tsx, no source condition). The fake provider and collector run in the parent process (`run.mjs`), so their memory is not counted.
- Since SDK 0.4.1 the app also **receives** requests (`--inbound-rps`, default 20/s, `inbound: true`): webhook deliveries from a known sender (40%), CloudEvents candidates over 80 sender words, more than the SDK keeps (50 candidate routes, 16 names; 20%), candidates with IDs in the path (10%), API requests whose handler calls a provider that answers 404 and marks half of them expected (20%), and browser POSTs and GETs (10%). So the soak covers per-request frames, the `markExpected` hold, held and sent deliveries and candidate reports. The CSV adds `received`, `inboundSent`, `inboundHeld`, `inboundDropped`, `candidatesSeen` and `expectedTagged`.
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

Not settled: with this traffic RSS rises steadily in every run, the SDK-off control included (+9 MB/h), so most of it is the test app's own load (thousands of distinct hosts and keep-alive sockets in its agent). With the SDK on it rises 4–7 MB/h more than without while the JS heap stays flat, i.e. native memory (socket, TLS-free http and zlib buffers) rather than accumulating SDK objects. Whether it levels off needs a longer run (several hours) on a staging environment; the pre-discovery runs above, with one host, showed RSS falling. Three of the first runs crashed on a harness bug (the test app's custom DNS lookup answered synchronously, so a rare `EINVAL` reached a socket before `http` listened); the lookup is asynchronous now and the numbers above are from clean reruns.

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

## Detection (alert quality)

Script: `pnpm bench:detect` (`apps/collector/bench/detect/`). It generates per-minute traffic for simulated weeks and runs the real incident jobs over it, minute by minute in accelerated time: `incidentJob` and `inboundJob` with their baseline refreshes, scoring and incident engines. No Docker: the jobs read and write an in-memory implementation of the repository methods they call. `test/detect-bench-storage.test.ts` checks that it answers like Postgres on the same rows. Rows are built with the ingest helpers (`addStatus`, `bucketIndex`, `addDelivery`), with every call's latency, handling time and lag sampled one by one. Thresholds are the defaults.

- **Profiles**, the same six for outgoing calls and incoming webhooks: steady high (~300/min at the daily peak, 0.3× at night, 0.3× at weekends and on holidays), medium (~4/min peak, same cycles), low (~4/hour, Poisson), test-driven bursts (1–2 h at ~80/min at random times, then 12–36 h of nothing), rare (~3/day), bursty (clumps of ~20 every ~15 min plus background, ~2/min on average).
- **Noise, always on, must open nothing**:
  - error rate drawn per day between 0.2% and 0.6% (provider) or 0.1% and 0.4% (our webhook answers), about a fifth of provider errors being timeouts;
  - 1% 404 and 0.5% 422;
  - a lone 5xx ~3 times a day;
  - 0.1% single very slow calls (8–25 s; webhook handling 4–12 s);
  - latency wobbles of +30–50% for 2–6 minutes ~3 times a day;
  - 0.3% of deliveries 20–90 s late;
  - one quiet weekday every 4 weeks;
  - the gaps of the bursts profile.
- **Faults**, starting at a random weekday minute between 10:00 and 16:00 UTC (for the bursts profile, 10 minutes into a test burst):
  - outgoing: full outage (30 min), 30% and 10% 5xx (60 min), latency 3× (15 min), 50% 401/403 (30 min);
  - webhooks: deliveries stop (12 h), our app answers 401 to all or 5xx to half (30 min), handler p95 ~8 s (30 min), deliveries ~8 min late (60 min).
- **Expected outcomes** (docs/scoring.md "Expected outcomes"), two more directions on the steady, medium and bursts profiles, the same noise: `expected`, a consent-style endpoint where 10–40% of calls answer 400 tagged in code (the share drifts hour by hour), and `marked`, `marked30` and `marked85`, where 5–15%, 25–35% or 80–90% answer plain 400s and 400 is marked expected for the endpoint from the dashboard. Faults: a contract change answering untagged 400 to every call (30 min; for `marked` only the safety net can catch it), and the full outage. The safety net's limit is max(80%, halfway from the normal share to 100%): 80%, 80% and 92.5%.
- **Expected results** (`EXPECTED` in `main.ts`): a time-to-alert target per profile and fault, from the fault's first minute to the alert, or "not detectable by design". Examples of the latter: fewer than `minCalls` calls in the widest window, or a source with too few deliveries for silence. They were written down from docs/scoring.md before the first run.
- **Runs**: a no-fault run of `--weeks` weeks per profile (`--no-fault-seeds`, default 1), and `--seeds` runs per fault (default 5): `--warmup` days of noise (21; 23 for silence faults, which are judged after 21 days of history), then the fault.
- **Pass/fail** (decided 2026-11-11):
  - **False alarms**, per direction and profile, pooled over every fault-free minute of its runs (the no-fault run and the time before each fault; each run is one source): **at most 1 per source per 6 simulated months** (26 weeks), and **none** for the test-burst and rare profiles. Shown on the profile's no-fault row as "N in W source-weeks = R per 6 months".
  - **Fault cells**: the **median over seeds** of (time to alert − that seed's target) must be ≤ 0, a miss counting as +∞; the table shows the median and p90 time to alert. Seeds whose fault brought too few calls for the rule are not required, and cells listed in `NOT_RELIABLE` (bursty 10% 5xx: the fault's effect sits at the count test's minimum, so it depends on how many calls the hour brings) are reported but never required.
  - Exit code 1 when either fails. Seeds are fixed; `--explain` prints each false alarm's alert; `--markdown` prints the table below.
- **Targets scale with traffic** (`targetFor` in `main.ts`): no rule can fire before its window holds the calls it needs, so a rate fault's target is max(the fixed target, minutes until the fault's own calls reach max(`minCalls`, `minExcess` / the fault's effect share) + `openAfterMinutes`). Effect shares follow from the faults: 100% for an outage, 30% or 10% for 5xx, 50% for 401/403, and 5% for a 3× slowdown (exactly the calls above the old p95 end up slower than 3 × the normal p95). A fault that never brings that many calls before it ends is "not detectable at this volume" (not required). This is the expected-value time: when the fault's failures arrive later than average, the alert can come a few minutes after it.
- **Cost and CI**: cells run in parallel worker processes (`--jobs`, default cores − 1). The full sweep (1,348 simulated weeks with 5 seeds per fault) takes about 22 minutes on 12 cores; it runs **weekly** (`.github/workflows/detection-weekly.yml`, Monday, or by hand; the table kept as an artifact) and **locally** when a change touches detection. Releases don't wait for it: on a standard 4-core runner it takes over an hour. **Pushes to main and pull requests** run `--ci` (`detection-ci.yml`): seventeen key profile × scenario cells (`CI_CELLS`: steady and bursts no-fault, steady outage and 3× latency, medium 30% 5xx, bursty 401/403; webhooks steady silence and 401s, medium lag, bursts no-fault), 3-week no-fault runs, 9 days of warm-up (23 for silence), one fixed seed: 24 simulated weeks, under 30 s on 12 cores, about a minute on a 4-core runner. (`--fast` is an alias.)

### Expected outcomes, 26-week sweep, 2026-11-12 (5 seeds per fault): all pass

`pnpm bench:detect --only expected,marked`: 18 cells, 358 simulated weeks, 445 s on 12 cores.

| direction | profile | no fault (false alarms) | contract change, untagged 400 to all (median, p90) | outage (median, p90) |
|---|---|---|---|---|
| expected (10–40% tagged 400) | steady | 0 in 60 source-weeks | 3 min, 3 min (target 6) | 3 min, 3 min |
| expected | medium | 2 in 60 source-weeks = 0.87 per 6 months (an `errors` and a `not_found` window of the everyday noise; none from the tagged 400s) | 4 min, 4 min (12) | 4 min, 5 min |
| expected | bursts | 0 in 60 | 3 min, 3 min (6) | 3 min, 3 min |
| marked (5–15% plain 400, marked) | steady | 0 in 60 | 14 min, 14 min (16: the safety net's 10 minutes after the window clears the limit) | 3 min, 3 min |
| marked | medium | 0 in 59 | 27 min, missed in 2 of 5 seeds (30; the 15-minute low-traffic window fills slowly) | 4 min, 5 min |
| marked | bursts | 0 in 59 | 14 min, 14 min (16) | 3 min, 3 min |
| marked30 (25–35% plain 400, marked) | steady | 0 in 59 | 13 min, 13 min (16) | 3 min, 3 min |
| marked30 | medium | 0 in 60 | 27 min, missed in 1 of 5 (30) | 4 min, 5 min |
| marked30 | bursts | 0 in 62 | 14 min, 14 min (16) | 3 min, 3 min |
| marked85 (80–90% plain 400, marked) | steady | 0 in 59 | 13 min, 13 min (16) | 3 min, 3 min |
| marked85 | medium | 0 in 59 | not reliably detectable at this volume (0 of 5; listed in `NOT_RELIABLE`) | 4 min, 4 min |
| marked85 | bursts | 0 in 60 | 14 min, 14 min (16) | 3 min, 3 min |

Safety-net limit max(80%, normal + (100% − normal) / 2), cleared with 99.9% confidence (rerun 2026-11-12 after the limit change; 27 marked cells, 538 simulated weeks, all pass, no false alarm). With the first, count-test version an 85% status raised 1.3 false alarms per 6 months on steady traffic (an ordinary 90% hour against a learned mean of 83%); the confidence bound removed them. At 85% normal and ~4 calls/min, telling "every call answers 400" from "90% do" takes about 60 calls in a window, more than a 30-minute change brings, so that cell isn't required; a real contract change that lasts longer is caught once the 60-minute window has enough of it.

Tagged business answers cost nothing in false alarms or time to alert; a dashboard mark trades a slower alert for a contract change (the safety net) for not having to change code.

### Results, 26-week sweep, 2026-11-11 (5 seeds per fault): all pass

After the decisions on the second sweep's failures (pooled class only while the status mix learns; silence after 21 days and the all-sources-quiet guard; median targets; the false-alarm budget above) and then sharing `maxPValue` across the failure classes an endpoint's check tests (each of k classes at maxPValue / k; 7 for a typical learned endpoint): **every cell passes**. 5 false alarms in 1,348 simulated weeks (medium outgoing 0.70 per 6 months, bursty outgoing 0.23, bursty webhooks 0.23; all others 0); 72 cells, 20 minutes on 12 cores.

Sharing `maxPValue` across classes cost no measurable time to alert: every fault cell's median and p90 are the same as before it, except bursty 10% 5xx (not required), whose median went from 48 to 51 minutes. It removed 6 of medium's 9 false alarms (2.11 → 0.70 per 6 months); the 3 left (per-window p ≈ 1e-6 to 1e-4) are a 404, a 422 and a 5xx window at the minimum excess.

**Outgoing calls** (no-fault runs 26 weeks × 1 seed(s); fault runs 5 seeds, 21 days of warm-up, 23 for silence)

| profile | scenario | target | time to alert (median, p90) | detected | false alarms | result |
|---|---|---|---|---|---|---|
| steady | no fault (noise; budget pooled over the profile’s fault-free time) | ≤ 1 per 6 months | – | – | 0 in 111 source-weeks = 0.00 per 6 months, budget 1 | pass |
| steady | full outage (503s and timeouts), 30 min | ≤ 5 min | 3 min, 3 min | 5/5 | 0 | pass |
| steady | 30% 5xx, 60 min | ≤ 5 min | 3 min, 3 min | 5/5 | 0 | pass |
| steady | 10% 5xx, 60 min | ≤ 8 min | 5 min, 6 min | 5/5 | 0 | pass |
| steady | latency 3×, 15 min | ≤ 8 min | 5 min, 6 min | 5/5 | 0 | pass |
| steady | 50% 401/403 (provider auth change), 30 min | ≤ 6 min | 3 min, 3 min | 5/5 | 0 | pass |
| medium | no fault (noise; budget pooled over the profile’s fault-free time) | ≤ 1 per 6 months | – | – | 3 in 111 source-weeks = 0.70 per 6 months, budget 1 | pass |
| medium | full outage (503s and timeouts), 30 min | ≤ 10 min–12 min (20 calls) | 4 min, 6 min | 5/5 | 0 | pass |
| medium | 30% 5xx, 60 min | ≤ 12 min | 7 min, 10 min | 5/5 | 1 | pass |
| medium | 10% 5xx, 60 min | ≤ 20 min–21 min (50 calls) | 20 min, 28 min | 5/5 | 0 | pass |
| medium | latency 3×, 15 min | none at this volume (needs 100 calls) | missed, missed | 1/5 | 1 | pass |
| medium | 50% 401/403 (provider auth change), 30 min | ≤ 12 min–14 min (20 calls) | 6 min, 10 min | 5/5 | 1 | pass |
| low | no fault (noise; budget pooled over the profile’s fault-free time) | ≤ 1 per 6 months | – | – | 0 in 109 source-weeks = 0.00 per 6 months, budget 1 | pass |
| low | full outage (503s and timeouts), 30 min | by design: none | not detected | 0/5 | 0 | pass |
| low | 30% 5xx, 60 min | by design: none | not detected | 0/5 | 0 | pass |
| low | 10% 5xx, 60 min | by design: none | not detected | 0/5 | 0 | pass |
| low | latency 3×, 15 min | by design: none | not detected | 0/5 | 0 | pass |
| low | 50% 401/403 (provider auth change), 30 min | by design: none | not detected | 0/5 | 0 | pass |
| bursts | no fault (noise; budget pooled over the profile’s fault-free time) | 0 false alarms | – | – | 0 in 113 source-weeks = 0.00 per 6 months, budget 0 | pass |
| bursts | full outage (503s and timeouts), 30 min | ≤ 5 min | 3 min, 3 min | 5/5 | 0 | pass |
| bursts | 30% 5xx, 60 min | ≤ 5 min | 3 min, 3 min | 5/5 | 0 | pass |
| bursts | 10% 5xx, 60 min | ≤ 8 min | 5 min, 6 min | 5/5 | 0 | pass |
| bursts | latency 3×, 15 min | ≤ 8 min | 5 min, 6 min | 5/5 | 0 | pass |
| bursts | 50% 401/403 (provider auth change), 30 min | ≤ 6 min | 3 min, 3 min | 5/5 | 0 | pass |
| rare | no fault (noise; budget pooled over the profile’s fault-free time) | 0 false alarms | – | – | 0 in 110 source-weeks = 0.00 per 6 months, budget 0 | pass |
| rare | full outage (503s and timeouts), 30 min | by design: none | not detected | 0/5 | 0 | pass |
| rare | 30% 5xx, 60 min | by design: none | not detected | 0/5 | 0 | pass |
| rare | 10% 5xx, 60 min | by design: none | not detected | 0/5 | 0 | pass |
| rare | latency 3×, 15 min | by design: none | not detected | 0/5 | 0 | pass |
| rare | 50% 401/403 (provider auth change), 30 min | by design: none | not detected | 0/5 | 0 | pass |
| bursty | no fault (noise; budget pooled over the profile’s fault-free time) | ≤ 1 per 6 months | – | – | 1 in 111 source-weeks = 0.23 per 6 months, budget 1 | pass |
| bursty | full outage (503s and timeouts), 30 min | ≤ 20 min–25 min (20 calls) | 3 min, 13 min | 5/5 | 0 | pass |
| bursty | 30% 5xx, 60 min | ≤ 25 min | 11 min, 11 min | 5/5 | 0 | pass |
| bursty | 10% 5xx, 60 min | not reliably detectable at this volume | 51 min, missed | 3/5 | 1 | pass |
| bursty | latency 3×, 15 min | none at this volume (needs 100 calls) | not detected | 0/5 | 0 | pass |
| bursty | 50% 401/403 (provider auth change), 30 min | ≤ 25 min–32 min (20 calls) | 14 min, 28 min | 5/5 | 0 | pass |

**Incoming webhooks** (no-fault runs 26 weeks × 1 seed(s); fault runs 5 seeds, 21 days of warm-up, 23 for silence)

| profile | scenario | target | time to alert (median, p90) | detected | false alarms | result |
|---|---|---|---|---|---|---|
| steady | no fault (noise; budget pooled over the profile’s fault-free time) | ≤ 1 per 6 months | – | – | 0 in 112 source-weeks = 0.00 per 6 months, budget 1 | pass |
| steady | deliveries stop, 12 h | ≤ 20 min | 15 min, 15 min | 5/5 | 0 | pass |
| steady | our app answers 401 to all (signing secret), 30 min | ≤ 5 min | 3 min, 3 min | 5/5 | 0 | pass |
| steady | our app answers 5xx to half, 30 min | ≤ 5 min | 3 min, 3 min | 5/5 | 0 | pass |
| steady | handler p95 ~8 s, 30 min | ≤ 8 min | 3 min, 3 min | 5/5 | 0 | pass |
| steady | deliveries arrive ~8 min late, 60 min | ≤ 8 min | 3 min, 3 min | 5/5 | 0 | pass |
| medium | no fault (noise; budget pooled over the profile’s fault-free time) | ≤ 1 per 6 months | – | – | 0 in 112 source-weeks = 0.00 per 6 months, budget 1 | pass |
| medium | deliveries stop, 12 h | ≤ 30 min | 15 min, 15 min | 5/5 | 0 | pass |
| medium | our app answers 401 to all (signing secret), 30 min | ≤ 12 min | 4 min, 5 min | 5/5 | 0 | pass |
| medium | our app answers 5xx to half, 30 min | ≤ 15 min | 6 min, 8 min | 5/5 | 0 | pass |
| medium | handler p95 ~8 s, 30 min | ≤ 10 min | 4 min, 4 min | 5/5 | 0 | pass |
| medium | deliveries arrive ~8 min late, 60 min | ≤ 10 min | 4 min, 5 min | 5/5 | 0 | pass |
| low | no fault (noise; budget pooled over the profile’s fault-free time) | ≤ 1 per 6 months | – | – | 0 in 112 source-weeks = 0.00 per 6 months, budget 1 | pass |
| low | deliveries stop, 12 h | ≤ 4h 00m | 2h 24m, 2h 48m | 5/5 | 0 | pass |
| low | our app answers 401 to all (signing secret), 30 min | by design: none | not detected | 0/5 | 0 | pass |
| low | our app answers 5xx to half, 30 min | by design: none | not detected | 0/5 | 0 | pass |
| low | handler p95 ~8 s, 30 min | by design: none | not detected | 0/5 | 0 | pass |
| low | deliveries arrive ~8 min late, 60 min | by design: none | not detected | 0/5 | 0 | pass |
| bursts | no fault (noise; budget pooled over the profile’s fault-free time) | 0 false alarms | – | – | 0 in 115 source-weeks = 0.00 per 6 months, budget 0 | pass |
| bursts | deliveries stop, 12 h | by design: none | not detected | 0/5 | 0 | pass |
| bursts | our app answers 401 to all (signing secret), 30 min | ≤ 5 min | 3 min, 3 min | 5/5 | 0 | pass |
| bursts | our app answers 5xx to half, 30 min | ≤ 5 min | 3 min, 3 min | 5/5 | 0 | pass |
| bursts | handler p95 ~8 s, 30 min | ≤ 8 min | 3 min, 3 min | 5/5 | 0 | pass |
| bursts | deliveries arrive ~8 min late, 60 min | ≤ 8 min | 3 min, 3 min | 5/5 | 0 | pass |
| rare | no fault (noise; budget pooled over the profile’s fault-free time) | 0 false alarms | – | – | 0 in 114 source-weeks = 0.00 per 6 months, budget 0 | pass |
| rare | deliveries stop, 12 h | by design: none | not detected | 0/5 | 0 | pass |
| rare | our app answers 401 to all (signing secret), 30 min | by design: none | not detected | 0/5 | 0 | pass |
| rare | our app answers 5xx to half, 30 min | by design: none | not detected | 0/5 | 0 | pass |
| rare | handler p95 ~8 s, 30 min | by design: none | not detected | 0/5 | 0 | pass |
| rare | deliveries arrive ~8 min late, 60 min | by design: none | not detected | 0/5 | 0 | pass |
| bursty | no fault (noise; budget pooled over the profile’s fault-free time) | ≤ 1 per 6 months | – | – | 1 in 115 source-weeks = 0.23 per 6 months, budget 1 | pass |
| bursty | deliveries stop, 12 h | ≤ 3h 00m | 45 min, 47 min | 5/5 | 0 | pass |
| bursty | our app answers 401 to all (signing secret), 30 min | ≤ 25 min–28 min (20 calls) | 12 min, 27 min | 5/5 | 0 | pass |
| bursty | our app answers 5xx to half, 30 min | ≤ 30 min–37 min (20 calls) | 10 min, 26 min | 5/5 | 0 | pass |
| bursty | handler p95 ~8 s, 30 min | ≤ 15 min–25 min (20 calls) | 19 min, 24 min | 5/5 | 0 | pass |
| bursty | deliveries arrive ~8 min late, 60 min | ≤ 15 min–52 min (20 calls) | 16 min, 20 min | 5/5 | 0 | pass |

Profiles: steady: steady high (~300/min peak, day/night, weekends); medium: medium (~4/min peak); low: low/sparse (~4/hour, random); bursts: test-driven bursts (1–2 h at ~80/min, then 12–36 h idle); rare: rare (~3/day); bursty: bursty (clumps of ~20 every ~15 min, ~2/min average).

Cells to note: the bursty webhook source's one false alarm is the single-source holiday case (2026-05-07, the simulated quiet weekday), within its budget and the documented limit (docs/scoring.md); bursty 10% 5xx is reported as not reliably detectable (3 of 5 seeds detected).

### Third sweep's remaining failure (2026-11-11), before sharing `maxPValue` across classes

**Medium outgoing traffic: 9 false alarms in 111 source-weeks, 2.1 per 6 months (budget 1).** All 9 are per-class count tests at or just past the minimum excess in a low-volume window: "answering 404 (6 of 95 calls, last 60 min)" against a ~1% normal, "answering 422 (6 of 65 calls)" against 0.5%, one "failing (6 of 87 calls)" against 0.4%, and one muted re-open of an earlier one. Their binomial tails are 1e-6 to 4e-4: individually rare windows, but a medium endpoint is judged every minute over up to two windows and six failure classes, on the order of 10⁵–10⁶ tests per six months, and each class is tested at `maxPValue` on its own. The pooled-class decision removed the "answering differently" alarms; these are the per-class tests themselves. Decided: share `maxPValue` across the failure classes tested (below).

### Before and after the rule changes (26-week sweeps, seed 1)

The first sweep (2026-11-10) found 582 false alarms and 27 must-catch cells missed, slow or with false alarms. The rules were then changed (docs/architecture.md §10, 2026-11-11; docs/scoring.md), the noise model and fixed targets were not, and the sweep was re-run (2026-11-11): **17 false alarms, 2 must-catch faults missed or slow**. FA/mo is false alarms per simulated month; in fault runs (3–4 weeks) one false alarm reads as 1.2–1.4/month.

| direction | profile | scenario | before (2026-11-10) | after (2026-11-11) |
|---|---|---|---|---|
| out | steady | no fault (noise only) | pass | pass |
| out | steady | full outage (503s and timeouts), 30 min | pass (3 min) | pass (3 min) |
| out | steady | 30% 5xx, 60 min | pass (3 min) | pass (3 min) |
| out | steady | 10% 5xx, 60 min | pass (5 min) | pass (5 min) |
| out | steady | latency 3×, 15 min | FAIL (not detected) | pass (4 min) |
| out | steady | 50% 401/403 (provider auth change), 30 min | pass (3 min) | pass (3 min) |
| out | medium | no fault (noise only) | FAIL (10.04 FA/mo) | FAIL (1.00 FA/mo) |
| out | medium | full outage (503s and timeouts), 30 min | FAIL (5 min, 8.47 FA/mo) | pass (5 min) |
| out | medium | 30% 5xx, 60 min | FAIL (4 min, 9.02 FA/mo) | FAIL (7 min, 1.29 FA/mo) |
| out | medium | 10% 5xx, 60 min | FAIL (25 min, 13.65 FA/mo) | FAIL (26 min) |
| out | medium | latency 3×, 15 min | FAIL (not detected, 9.91 FA/mo) | FAIL (not detected, 1.24 FA/mo) |
| out | medium | 50% 401/403 (provider auth change), 30 min | FAIL (4 min, 11.12 FA/mo) | pass (4 min) |
| out | low | no fault (noise only) | pass | pass |
| out | low | full outage (503s and timeouts), 30 min | pass (not detected) | pass (not detected) |
| out | low | 30% 5xx, 60 min | pass (not detected) | pass (not detected) |
| out | low | 10% 5xx, 60 min | pass (not detected) | pass (not detected) |
| out | low | latency 3×, 15 min | pass (not detected) | pass (not detected) |
| out | low | 50% 401/403 (provider auth change), 30 min | pass (not detected) | pass (not detected) |
| out | bursts | no fault (noise only) | pass | pass |
| out | bursts | full outage (503s and timeouts), 30 min | pass (3 min) | pass (3 min) |
| out | bursts | 30% 5xx, 60 min | pass (3 min) | pass (3 min) |
| out | bursts | 10% 5xx, 60 min | pass (5 min) | pass (5 min) |
| out | bursts | latency 3×, 15 min | FAIL (not detected) | pass (5 min) |
| out | bursts | 50% 401/403 (provider auth change), 30 min | pass (3 min) | pass (3 min) |
| out | rare | no fault (noise only) | pass | pass |
| out | rare | full outage (503s and timeouts), 30 min | pass (not detected) | pass (not detected) |
| out | rare | 30% 5xx, 60 min | pass (not detected) | pass (not detected) |
| out | rare | 10% 5xx, 60 min | pass (not detected) | pass (not detected) |
| out | rare | latency 3×, 15 min | pass (not detected) | pass (not detected) |
| out | rare | 50% 401/403 (provider auth change), 30 min | pass (not detected) | pass (not detected) |
| out | bursty | no fault (noise only) | FAIL (4.18 FA/mo) | FAIL (0.17 FA/mo) |
| out | bursty | full outage (503s and timeouts), 30 min | FAIL (3 min, 1.36 FA/mo) | FAIL (3 min, 1.36 FA/mo) |
| out | bursty | 30% 5xx, 60 min | FAIL (4 min, 4.95 FA/mo) | pass (5 min) |
| out | bursty | 10% 5xx, 60 min | FAIL (46 min, 8.47 FA/mo) | FAIL (not detected, 1.41 FA/mo) |
| out | bursty | latency 3×, 15 min | FAIL (not detected, 5.15 FA/mo) | pass (not detected) |
| out | bursty | 50% 401/403 (provider auth change), 30 min | FAIL (7 min, 7.12 FA/mo) | FAIL (8 min, 2.37 FA/mo) |
| in | steady | no fault (noise only) | pass | pass |
| in | steady | deliveries stop, 12 h | pass (15 min) | pass (15 min) |
| in | steady | our app answers 401 to all (signing secret), 30 min | pass (3 min) | pass (3 min) |
| in | steady | our app answers 5xx to half, 30 min | pass (3 min) | pass (3 min) |
| in | steady | handler p95 ~8 s, 30 min | pass (3 min) | pass (3 min) |
| in | steady | deliveries arrive ~8 min late, 60 min | pass (3 min) | pass (3 min) |
| in | medium | no fault (noise only) | FAIL (3.68 FA/mo) | pass |
| in | medium | deliveries stop, 12 h | FAIL (15 min, 2.77 FA/mo) | pass (15 min) |
| in | medium | our app answers 401 to all (signing secret), 30 min | FAIL (3 min, 3.87 FA/mo) | pass (4 min) |
| in | medium | our app answers 5xx to half, 30 min | FAIL (4 min, 4.06 FA/mo) | pass (6 min) |
| in | medium | handler p95 ~8 s, 30 min | FAIL (3 min, 4.05 FA/mo) | pass (4 min) |
| in | medium | deliveries arrive ~8 min late, 60 min | FAIL (3 min, 5.40 FA/mo) | pass (4 min) |
| in | low | no fault (noise only) | FAIL (3.85 FA/mo) | pass |
| in | low | deliveries stop, 12 h | FAIL (89 min, 2.64 FA/mo) | pass (2h 21m) |
| in | low | our app answers 401 to all (signing secret), 30 min | FAIL (not detected, 3.58 FA/mo) | pass (not detected) |
| in | low | our app answers 5xx to half, 30 min | FAIL (not detected, 3.87 FA/mo) | pass (not detected) |
| in | low | handler p95 ~8 s, 30 min | FAIL (not detected, 5.38 FA/mo) | pass (not detected) |
| in | low | deliveries arrive ~8 min late, 60 min | FAIL (not detected, 5.15 FA/mo) | pass (not detected) |
| in | bursts | no fault (noise only) | FAIL (19.90 FA/mo) | pass |
| in | bursts | deliveries stop, 12 h | FAIL (not detected, 15.23 FA/mo) | pass (not detected) |
| in | bursts | our app answers 401 to all (signing secret), 30 min | FAIL (3 min, 15.78 FA/mo) | pass (3 min) |
| in | bursts | our app answers 5xx to half, 30 min | FAIL (3 min, 16.63 FA/mo) | pass (3 min) |
| in | bursts | handler p95 ~8 s, 30 min | FAIL (3 min, 10.89 FA/mo) | pass (3 min) |
| in | bursts | deliveries arrive ~8 min late, 60 min | FAIL (3 min, 15.55 FA/mo) | pass (3 min) |
| in | rare | no fault (noise only) | pass | pass |
| in | rare | deliveries stop, 12 h | pass (not detected) | pass (not detected) |
| in | rare | our app answers 401 to all (signing secret), 30 min | pass (not detected) | pass (not detected) |
| in | rare | our app answers 5xx to half, 30 min | pass (not detected) | pass (not detected) |
| in | rare | handler p95 ~8 s, 30 min | pass (not detected) | pass (not detected) |
| in | rare | deliveries arrive ~8 min late, 60 min | pass (not detected) | pass (not detected) |
| in | bursty | no fault (noise only) | FAIL (16.73 FA/mo) | FAIL (0.17 FA/mo) |
| in | bursty | deliveries stop, 12 h | FAIL (29 min, 19.87 FA/mo) | FAIL (28 min, 1.17 FA/mo) |
| in | bursty | our app answers 401 to all (signing secret), 30 min | FAIL (8 min, 12.32 FA/mo) | pass (9 min) |
| in | bursty | our app answers 5xx to half, 30 min | FAIL (5 min, 24.58 FA/mo) | FAIL (8 min, 1.29 FA/mo) |
| in | bursty | handler p95 ~8 s, 30 min | FAIL (3 min, 22.28 FA/mo) | pass (3 min) |
| in | bursty | deliveries arrive ~8 min late, 60 min | FAIL (21 min, 20.15 FA/mo) | FAIL (20 min, 1.19 FA/mo) |

**Sensitivity traded** for fewer false alarms, stated rather than tuned away:

- **Latency 3× on medium and bursty** is now "not detectable at this volume": a 15-minute 3× slowdown at ~4 calls/min brings ~50 calls, of which ~2.5 are slow, and the count test needs 5 above normal. It wasn't detected before either; then the cells were "missed", now the target says why.
- **Low-volume windows look up to 60 minutes back**, so low-volume incidents resolve later: a medium endpoint (~4 calls/min) about 40 minutes after the failure stops instead of ~15–25.
- **Silence on a ~4/hour source** opens after 2h 21m instead of 89 min (target 4 h): it must outlast 1.5 × the longest normal gap.
- **Small slowdowns of a few alerts**: webhook 5xx-to-half on medium 4 → 6 min and bursty 5 → 8 min, 401/403 on bursty 7 → 8 min, 30% 5xx on medium 4 → 7 min (all within target): the count test's minimum excess and the shared significance across windows need a few more failures.

### Second sweep's remaining failures (2026-11-11, seed 1), before the decisions

Every one traced with `--explain` (and, for the bursty 10% miss, a replay printing each window's counts); none comes from the bench.

1. **Behaviour / 404 false alarms on medium and bursty outgoing traffic** (13 of the 17: medium no-fault 6, i.e. 1.0/month; bursty no-fault 1, 0.17/month; fault runs 6). Examples: "answering differently (6 of 23 calls, low volume, last 15 min)" against a 2% normal; "answering 404 (8 of 95 calls, last 30 min)" against 1%. Each is the minimum excess (5 above expected) at p ≈ 1e-5 to 1e-4, i.e. a 1-in-10,000 window, and the bench evaluates every minute for half a year with up to three windows and seven failure classes each (around 10⁶ tests per profile), so a few pass. The behaviour rule (all unsuccessful calls) is the main source: it pools the 404, 422 and 5xx classes into a 2% class where three everyday failures from different classes coincide. Options: test the pooled class only while the status mix is learning (each group is tested on its own once it is learned), a stricter p for the pooled class, or a larger `minExcess` at low volume (each trades sensitivity; not changed).
2. **Silence false alarms on the bursty (clumped) webhook source** (4): three in the source's second week (history 8–10 days: the longest normal gap seen so far is shorter than it will be), one on 2026-05-07 at 02:21, a weekday the bench makes as quiet as a weekend (a holiday, one every 4 weeks), so the weekday hour-of-week rates over-weigh its night gaps. Options: a longer minimum history for silence on clumped sources (sensitivity during weeks 2–3), or a model of unannounced quiet days (not changed).
3. **10% 5xx on bursty: missed** (target 66 min). The fault's hour brought only ~55 calls, and by its last minute the widest window held 5 errors, an excess of 4.7: just under `minExcess` (5). The scaled target assumes the expected number of failures arrive.
4. **10% 5xx on medium: 26 min vs 20** (expected time to the needed 50 calls: ~18 min). Same reason: the 5 extra errors arrived later than average.


### First sweep's findings (2026-11-10), before the rule changes

Every finding below was traced to its cause with `--explain`; none comes from the bench.

1. **Latency 3× is not detected** (steady, bursts, medium, bursty). The rule needs p95 ≥ 3× normal, and p95 is read from power-of-two histogram buckets with linear interpolation inside a bucket. For a lognormal latency (median 250 ms) the normal p95 reads 698 ms, and a uniform 3× slowdown reads 1,937 ms (2.78×). 3.5× reads 2.92×, and only about 4× clears the rule. A real 3× slowdown therefore sits just under the threshold.
2. **Low-volume p95 is two calls** (outgoing "slow", webhook "slow" and "lag" on medium and bursty). With 20–50 calls in the window, p95 is the second or third largest value. Two of the everyday very slow calls or timeouts (or two late deliveries) in one window make it, and a widened 15–60 minute window keeps them in for many minutes, so 3 bad minutes in a row add nothing. No minimum number of slow calls is required.
3. **Repeated testing at low volume** (outgoing errors, not_found, validation, behaviour on medium and bursty; webhook rejections on medium). Each minute's window is tested at p < 0.001 with `minErrors` 3. At ~20 calls, 3 everyday 404s or 422s pass that test. Overlapping windows are tested every minute, and the day's error rate can sit above the 7-day baseline. Together that gives several per month. The 3-minute confirmation doesn't help, because consecutive widened windows hold the same calls.
4. **Webhook silence on low (~4/hour) sources is a fixed statistical rate.** For Poisson arrivals, p < 0.001 on a gap is reached about once per thousand gaps, which at ~100 deliveries a day is ~3 per month. That is what `maxPValue` means per judgment. The past-weeks guard doesn't help, because random gaps aren't tied to the time of week.
5. **Webhook silence between test bursts** (~20/month). Silence multiplies each clock hour's zero-delivery probability as if hours were independent. For bursts every 12–36 h, the hours are anything but independent, so a normal day-long gap reaches p ≈ 1e-4 to 1e-6. The past-weeks guard was meant for exactly this, but for a gap of many hours the same window a week earlier almost always held a burst.
6. **Webhook silence on clumped sources** (bursty, gaps of 15–40 min). The negative-binomial dispersion is fitted to hourly counts, and clumping within the hour doesn't show at that scale, so a normal 20-minute gap between clumps looks improbable.
7. **Time-to-alert targets missed by a little**: 10% 5xx on medium (25 min vs 20) and bursty (46 vs 45), and lag on bursty (21 vs 15). The fault starts in a quiet stretch and the window needs time to collect 20 calls.

