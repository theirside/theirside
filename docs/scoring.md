# Scoring, baselines and incidents

How the collector decides that a provider endpoint is unhealthy. Code: `apps/collector/src/modules/scoring/` (pure functions) and `apps/collector/src/modules/incidents/` (rules, summaries, scheduler job). Keep this file in sync with the code; the defaults below live in `scoring/thresholds.ts`.

Everything reads `rollups_1m`, never raw events (raw events only supply sample request IDs).

## Inputs

An **endpoint** is (environment, provider, endpoint template, method). Each minute the scheduler evaluates the **last complete minute T** (ticks run 5 s past each minute, so late SDK flushes have arrived) over a **window** of the 5 minutes ending at T.

Per window:

| | |
|---|---|
| calls | all calls minus `aborted` (a caller cancelling is not the provider's fault) |
| provider errors | `http_5xx` + `timeout` + `conn_reset` + `conn_refused` + `dns` + `tls` |
| error rate | provider errors / calls |
| 4xx rate | `http_4xx` excluding 429, / calls |
| 429 rate | responses with status 429 / calls |
| p50, p95 | from the merged latency histogram (18 log₂ buckets, linear interpolation inside a bucket) |

## Baseline

Per endpoint, from the last **7 days** of rollups, **excluding the last 15 minutes** (an emerging incident must not teach the baseline) and **excluding minutes covered by past incidents** on that endpoint (from 5 minutes before the endpoint joined the incident until it recovered). Values: provider-error rate, 4xx rate, 429 rate, p50, p95, sample size, minutes of history. Recomputed at most every 10 minutes and cached in `baselines`.

**Learning**: until the endpoint has ≥ 24 h of history and ≥ 500 calls. While learning, the baseline provider-error rate is **max(observed, 1%)**; p95 is what has been seen so far. An endpoint with no history at all uses 1% and no latency baseline.

## Incident rule

A window is **bad** if, with at least **20 calls** in it, either:

- **errors**: provider errors ≥ **3**, error rate ≥ **max(5 × baseline, baseline + 5 pp)**, and a one-sided binomial test of the errors against the baseline rate gives **p < 0.001** (the null rate is floored at 0.1% so a 0% baseline doesn't make every error "significant"); or
- **latency**: p95 ≥ **3 × baseline p95** and p95 ≥ **baseline p95 + 1000 ms**.

Then, per provider (one open incident per provider at a time):

- **Open** when an endpoint's windows ending at T, T−1 and T−2 are all bad (3 consecutive minutes). The incident starts at T−2. Several failing endpoints of one provider are grouped into one incident (`scope: provider`); an endpoint that starts failing while the incident is open is added to it.
- **Escalate** (alert) when the combined error rate of the incident's active endpoints is ≥ 2 × the last alerted rate for 3 consecutive windows (latency incidents: p95 ≥ 2 × the last alerted p95), or when another endpoint joins. Requiring 3 windows stops a window that is still filling up after the open from escalating.
- **Resolve** an endpoint after 10 consecutive healthy (not bad) windows; minutes with no traffic count as healthy. The incident resolves when all its endpoints have. Because windows are 5 minutes long, this is typically ~14 minutes after the failure stops.
- **Cooldown**: if every failing endpoint recovered from an earlier incident less than 30 minutes ago, the new incident is recorded but **muted** (no open/escalation/resolve alerts). This stops flapping endpoints from paging repeatedly.

Every alert states whether the provider's **other endpoints** with traffic in the window are fine ("Other Acme Cards endpoints: OK.") or lists those that are also bad.

Ticks are idempotent per minute (`incidents.last_evaluated_minute`) and recomputed from rollups, so restarts, several replicas (advisory-lock leader) and late ticks don't change outcomes.

### How fast

A window turns bad once enough of the failure is inside it: at 40% errors against a ~1% threshold baseline that takes about 45 seconds of failure, so the first bad window is the minute the failure started in or the next one. Three bad windows plus the tick at 5 s past the following minute put the open alert **3m05s–3m50s after the failure starts** (measured end to end in docker compose: 223 s). Higher failure rates are detected slightly sooner; rates close to the threshold take longer. Resolving needs the 5-minute window to clear and then 10 healthy windows: about 14–15 minutes after the failure stops.

### Defaults and per-project overrides

Set any of these in `settings.thresholds` (JSON, per project) to override:

| key | default | meaning |
|---|---|---|
| `windowMinutes` | 5 | window length |
| `minCalls` | 20 | calls in the window before anything can open |
| `minErrors` | 3 | provider errors in the window for an error incident |
| `rateMultiplier` | 5 | error rate ≥ multiplier × baseline … |
| `rateDeltaPp` | 0.05 | … and ≥ baseline + this (fraction) |
| `maxPValue` | 0.001 | binomial test significance |
| `latencyMultiplier` | 3 | p95 ≥ multiplier × baseline p95 … |
| `latencyDeltaMs` | 1000 | … and ≥ baseline p95 + this |
| `openAfterMinutes` | 3 | consecutive bad minutes to open |
| `resolveAfterMinutes` | 10 | consecutive healthy minutes to resolve |
| `cooldownMinutes` | 30 | mute window after recovery |
| `baselineDays` | 7 | baseline history |
| `baselineGapMinutes` | 15 | recent minutes excluded from the baseline |
| `learningMinHours` | 24 | learning until this much history … |
| `learningMinCalls` | 500 | … and this many calls |
| `learningDefaultRate` | 0.01 | provider-error rate floor while learning |
| `minBaselineRate` | 0.001 | floor for the binomial test's null rate |
| `escalationFactor` | 2 | "doubles" |

## Score (0–100)

Computed over the same 5-minute window, for the dashboard, health API and status page. Start at 100 and subtract four penalties, each scaled to 0..1:

| penalty | weight | full penalty when |
|---|---|---|
| provider errors | 60 | error rate reaches the incident threshold: `(rate − baseline) / (threshold − baseline)` |
| latency | 25 | p95 is 3 × baseline **and** +1000 ms: `clamp((p95/baseline − 1.5) / 1.5) × clamp((p95 − baseline) / 1000 ms)` |
| 4xx | 10 | 4xx rate is 20 pp above its baseline |
| 429 | 5 | 429 rate is 10 pp above its baseline |

Error and latency penalties are multiplied by `min(1, calls / 20)`, so one failure on a quiet endpoint doesn't turn it red. No traffic in the window gives no score (`unknown`).

Status: **green ≥ 90**, **amber 60–89**, **red < 60**. An endpoint at the incident threshold scores 40 (red); halfway there, 70 (amber). An endpoint with an open incident is shown red.

**Provider score** = call-volume-weighted mean of its endpoints' scores; a single red endpoint makes the provider at least amber.

## Incident summary

Stored on the incident, refreshed every minute, copyable from the dashboard and included in every alert:

```
Acme Cards — POST /v2/cards/:id/activate failing since 14:02 UTC (6 min)
Error rate 38% (normal 0.2%), 412 calls in window. Outcomes: 5xx 71%, timeout 29%.
p95 latency 8.1 s (normal 420 ms). Other Acme Cards endpoints: OK.
Sample provider request IDs: req_8f2..., req_91a..., req_0cd...
Support: support@acmecards.com
```

Grouped incidents list each endpoint on its own lines. "normal" is the baseline (", still learning" is added while it is learning). Sample request IDs are up to 5 recent failing calls with a provider request ID. The support line comes from the provider's settings. After recovery the first line becomes "… recovered at HH:MM UTC after N min".

## Tests

- `apps/collector/test/scoring.test.ts`: binomial tail (checked against exact values), window stats, incident rule, thresholds, score and provider roll-up, baselines (table-driven).
- `apps/collector/test/incidents.test.ts`: minute-by-minute simulations through the same code as the scheduler: 40% for 6 minutes (exactly one open within 4 minutes naming the endpoint with others OK, one resolve; several seeds; also on a fresh install), steady 3% for 3 days never alerts, 5 calls/min with 1–2 failures never alerts, grouping, escalation, cooldown, latency, overrides.
- `apps/collector/test/alerting.test.ts`: the same 40% scenario end to end through `/v1/ingest`, Postgres, the scheduler and real Slack/webhook receivers (signature checked), plus delivery retries.
