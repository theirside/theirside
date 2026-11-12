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
| p50, p95 | from the merged latency histogram (130 buckets at 2^(1/8) ≈ 9% steps from 1 ms to 65.5 s, log-linear interpolation inside a bucket; rows from before collector 0.4 carry 18 power-of-two buckets, spread evenly over their eight fine buckets when read) |
| slow calls | calls above the endpoint's slow threshold (below), read from the same histogram |

## Baseline

Per endpoint, from the last **7 days** of rollups, **excluding the last 15 minutes** (an emerging incident must not teach the baseline) and **excluding minutes covered by past incidents** on that endpoint (from 5 minutes before the endpoint joined the incident until it recovered). Values: provider-error rate, 4xx rate, 429 rate, p50, p95, sample size, minutes of history, and the **count tests' model** (`baselines.model`, migration 020): for each failure class (provider errors, 401/403, 404, 400/409/422, 429, other 4xx, all unsuccessful calls) its **overdispersion** ρ, and the **slow class**: the threshold max(`latencyMultiplier` × p95, p95 + `latencyDeltaMs`), the normal share of calls above it and its ρ. ρ is the method-of-moments intra-class correlation over the history's clock hours (hours an incident touched left out): how much more the class's share swings from hour to hour, day-to-day and hour-of-day variation alike, than chance would make it. Recomputed at most every 10 minutes and cached in `baselines`, with the provider's own latency overrides.

**Learning**: until the endpoint has ≥ 24 h of history and ≥ 500 calls. While learning, the baseline provider-error rate is **max(observed, 1%)**; p95 is what has been seen so far. An endpoint with no history at all uses 1% and no latency baseline.

## Incident rule

Every rule below is the same **count test** (`scoring/model.ts countTest`): the window's failures of one class against the count its normal share predicts. It passes when

- the **excess** over that expected count is at least **`minExcess` (5)** failures, and
- a one-sided **beta-binomial** test with the class's learned overdispersion ρ (Var = n·p·(1−p)·(1 + (n−1)·ρ); ρ = 0 is the binomial) gives **p < `maxPValue` (0.001) / k**, where k is the number of failure classes the check tests for the endpoint (`classesTested`: provider errors; the slow class once learned; once the status mix is learned the four 4xx groups and other 4xx; while it learns, all unsuccessful calls pooled; 7 for a typical learned endpoint). Sharing the significance this way (Bonferroni, like the low-traffic windows below) keeps an endpoint with seven classes from being seven times as likely to page by chance. The null share is floored at 0.1% (`minBaselineRate`) so a 0% normal doesn't make every failure "significant".

An endpoint whose error share swings a lot from hour to hour needs a bigger jump to be significant than one whose share is always the same; a few everyday 404s among twenty calls never reach the minimum excess.

A window is **bad** if, with at least **20 calls** in it, either:

- **errors**: provider errors ≥ **3**, error rate ≥ **max(baseline + 5 pp, min(5 × baseline, halfway from the baseline to 100%))** (for the usual small baselines: max(5 × baseline, baseline + 5 pp); the halfway cap keeps it reachable for groups that are normally frequent), and the count test; or
- **latency**: the **slow calls**, those slower than **max(3 × normal p95, normal p95 + 1000 ms)** (`latencyMultiplier`, `latencyDeltaMs`: the settings keep their meaning), pass the count test against their own normal share and reach **max(normal + 2.5 pp, min(5 × normal, halfway to 100%))** of the calls. A uniform 3× slowdown makes exactly the calls above the old p95, 5%, slower than 3 × the normal p95, so the floor is half of that (the error rule's 5 pp would make a 3× slowdown undetectable); without the floor a busy endpoint's handful of everyday very slow calls would page by chance a few times a year. Not judged until the baseline has learned the slow class; or
- **behaviour change** (collector 0.3.0): a status group is far above its own normal share, with the same safeguards (see below).

Then, per provider (one open incident per provider at a time):

- **Open** when an endpoint's windows ending at T, T−1 and T−2 are all bad (3 consecutive minutes). The incident starts at T−2. Several failing endpoints of one provider are grouped into one incident (`scope: provider`); an endpoint that starts failing while the incident is open is added to it.
- **Escalate** (alert) when the combined error rate of the incident's active endpoints is ≥ 2 × the last alerted rate for 3 consecutive windows (latency incidents: p95 ≥ 2 × the last alerted p95), or when another endpoint joins. Requiring 3 windows stops a window that is still filling up after the open from escalating.
- **Resolve** an endpoint after 10 consecutive healthy (not bad) windows; minutes with no traffic count as healthy. The incident resolves when all its endpoints have. Because windows are 5 minutes long, this is typically ~14 minutes after the failure stops.
- **Cooldown**: if every failing endpoint recovered from an earlier incident less than 30 minutes ago, the new incident is recorded but **muted** (no open/escalation/resolve alerts). This stops flapping endpoints from paging repeatedly.

### Behaviour change: any status, against its own normal

A provider can answer 401, 404 or 422 where it used to answer 200, with nothing changed on your side. Detection doesn't depend on who is to blame: each endpoint's calls are split into groups, and each group is compared with that endpoint's own normal share, learned over the same 7 days (incident minutes excluded) and stored on the baseline (`status_mix`; rollups count 3xx, 400, 401, 403, 404, 409 and 422 one by one, migration 016):

| group | statuses | incident kind | what the alert says |
|---|---|---|---|
| outage | 5xx, timeouts, resets, refused, DNS, TLS | `errors` | failing; outcomes breakdown (as before) |
| auth | 401, 403 | `auth` | "returns 401 for 62% of calls (normally 0%); credentials may have expired or the provider changed access rules" |
| not found | 404 | `not_found` | "…; the provider may have changed or removed this endpoint" |
| validation | 400, 409, 422 | `validation` | "…; the provider may have changed its contract" |
| rate limited | 429 | `rate_limited` | "…; the provider is limiting the rate of these calls" |
| other 4xx; all unsuccessful calls only while the status mix is learning | | `behaviour` | "62% of calls are not successful (normally 3%): the endpoint answers differently than usual" |

A group breaches with the same rule as errors: at least 3 calls in it, its share ≥ max(normal + 5 pp, min(5 × normal, halfway to 100%)), and the count test with the group's own ρ. An endpoint where 30% 404 is normal stays quiet at 30% and alerts from about 65%. When several groups breach, the kind follows this order: `errors`, `auth`, `not_found`, `validation`, `rate_limited`, `behaviour`, `latency`; an incident takes a stronger kind if one appears later. 4xx groups are judged only once the endpoint's normal is learned (24 h and 500 calls), so a new endpoint's usual 4xx don't alert; its 5xx do, as before. After the upgrade to collector 0.3.0 the same holds for every endpoint for a day: rollups written before it can't tell a 404 from another 4xx, so the status mix is learned only from minutes since the upgrade (`install_meta.status_mix_since`, set by migration 016, incident minutes excluded) and 4xx groups are judged (and scored) once that covers a day. The success share is judged meanwhile: every rollup has ok vs not-ok counts, so an endpoint that normally succeeds (≥ 90% of its calls over the 7-day baseline) and drops far below that (all unsuccessful calls against their normal share, the same rule and safeguards) opens a `behaviour` incident and scores red right away; once the per-status normal is learned, the incident takes the specific kind (`auth`, `not_found`, …). This pooled class (all unsuccessful calls) is tested **only while the status mix is learning**; once it is learned, each class has its own rule (the 4xx groups, other 4xx, provider errors). Testing the pool as well only added a test in which everyday 404s, 422s and 5xx happen to coincide: in the detection bench it caused most of the remaining low-volume false alarms ("answering differently (6 of 23 calls)") and caught nothing the per-class rules missed. An endpoint that has failed ever since the upgrade has no calls outside incidents to learn from; after the day, each of its groups is judged against its normal unsuccessful share, which no group can exceed. Endpoints succeeding less than 90% wait for the day. Low-traffic windows, 3 bad minutes in a row, per-provider overrides, cooldown, escalation (the incident's own rate doubling) and resolution work as for errors.

Alerts and summaries also say:

- **Side signals**: call volume ≥ 3× normal ("Call volume 8.8/min, 6× normal (often a retry loop in the caller).") and a median ≤ 30% of the normal median ("Responses are fast (median 113 ms, normally 998 ms): calls fail before doing work."). Only against a learned normal.
- **Deploy hint**, decided once at the open: from the services that called these endpoints (`service_templates`) and their processes (`sdk_processes`, SDK 0.2.0+), either "Your user-api was restarted or deployed at 13:58 UTC, 4 min before this started: check your recent changes." (a long-running process started in the 15 minutes before or 2 after; for serverless services only a new SDK version counts, since they start processes all the time) or "No deploy or restart of your services calling this (user-api) around this time: likely on the provider's side." Nothing when no calling service reports processes.

**Low traffic.** An endpoint with fewer than 20 calls in 5 minutes (under 4 calls/min) would never have a bad window. For it the window widens to the first of **15, 30 or 60 minutes** that holds 20 calls (else 60). A window with fewer than **100 calls** (`SMALL_SAMPLE_CALLS`) is a small sample: the count test can't see 5 extra failures in it when only 5% of calls fail (the slow calls of a 3× slowdown), so the wider windows are tested too, up to the first holding 100 calls or 60 minutes, and the tests share `maxPValue` (Bonferroni: k windows tested at maxPValue / k each, so testing more windows doesn't raise the false-alarm rate). The strongest kind any of them finds wins, on the narrowest window that finds it. Everything else is the same: the threshold, the count test, 3 bad minutes in a row. So a quiet endpoint that starts failing still opens an incident, about as long after the failure starts as it takes to collect the calls the test needs (at 1 call/min, failing every call: ~25–30 min; 10% errors at 4 calls/min: ~15–25 min), while a few failed calls never do. A busy endpoint (≥ 20 calls/min) is judged on its 5-minute window only. Per-provider overrides apply (a provider with a lower minimum keeps the 5-minute window more often). Such incidents are stored with their window (`incidents.window_minutes`), alerts say so (`failing (5 of 30 calls, low volume, last 30 min)`, and in the summary `… calls in the last 30 min (low volume: too few calls in 5 min, so judged over 30)`), and they resolve once every window tested holds no bad minutes for 10 minutes, so up to an hour after the failure stops (a medium endpoint at ~4 calls/min, judged over 30 minutes too: ~40 minutes). While the long window is still filling after the open, a rising rate isn't reported as "getting worse".

Every alert states whether the provider's **other endpoints** with traffic in the window are fine ("Other Acme Cards endpoints: OK.") or lists those that are also bad.

Ticks are idempotent per minute (`incidents.last_evaluated_minute`) and recomputed from rollups, so restarts, several replicas (advisory-lock leader) and late ticks don't change outcomes.

### How fast

A window turns bad once enough of the failure is inside it: at 40% errors against a ~1% threshold baseline that takes about 45 seconds of failure, so the first bad window is the minute the failure started in or the next one. Three bad windows plus the tick at 5 s past the following minute put the open alert **3m05s–3m50s after the failure starts** (measured end to end in docker compose: 223 s). Higher failure rates are detected slightly sooner; rates close to the threshold take longer. Resolving needs the 5-minute window to clear and then 10 healthy windows: about 14–15 minutes after the failure stops.

### Defaults and per-project overrides

Set any of these per project in Settings → Thresholds (admins; stored in `settings.thresholds`, also `PUT /v1/admin/settings/thresholds`) to override:

| key | default | meaning |
|---|---|---|
| `windowMinutes` | 5 | window length |
| `minCalls` | 20 | calls in the window before anything can open |
| `minErrors` | 3 | provider errors in the window for an error incident |
| `minExcess` | 5 | count test: failures at least this many above the expected count |
| `rateMultiplier` | 5 | error rate ≥ multiplier × baseline … (slow share too) |
| `rateDeltaPp` | 0.05 | … and ≥ baseline + this (fraction) |
| `maxPValue` | 0.001 | count test significance (beta-binomial); shared across the failure classes tested and across the windows tested at low traffic |
| `latencyMultiplier` | 3 | a call is slow above multiplier × normal p95 … |
| `latencyDeltaMs` | 1000 | … and above normal p95 + this |
| `openAfterMinutes` | 3 | consecutive bad minutes to open |
| `resolveAfterMinutes` | 10 | consecutive healthy minutes to resolve |
| `cooldownMinutes` | 30 | mute window after recovery |
| `baselineDays` | 7 | baseline history |
| `baselineGapMinutes` | 15 | recent minutes excluded from the baseline |
| `learningMinHours` | 24 | learning until this much history … |
| `learningMinCalls` | 500 | … and this many calls |
| `learningDefaultRate` | 0.01 | provider-error rate floor while learning |
| `minBaselineRate` | 0.001 | floor for the count test's null share |
| `escalationFactor` | 2 | "doubles" |

### Per-provider overrides

A provider can override six of these (Settings → Providers → a provider → Alerts & thresholds; admins only; stored in `providers.thresholds`): `minCalls`, `openAfterMinutes`, `rateMultiplier`, `rateDeltaPp`, `latencyMultiplier`, `latencyDeltaMs`. Precedence: **the provider's override, then the project's, then the default above**, per key (`thresholdsFor` in `apps/collector/src/modules/scoring/thresholds.ts`). The incident rule, the score and the chart's incident threshold all use the provider's values; a provider's endpoints are evaluated with them. Everything else (window, resolve, cooldown, baselines, learning) is per project only. Alerts on/off is the provider's own switch (`alerts_enabled`); incidents are tracked either way.

## Score (0–100)

Computed over the same 5-minute window, for the dashboard, health API and status page. Start at 100 and subtract four penalties, each scaled to 0..1:

| penalty | weight | full penalty when |
|---|---|---|
| failures | 60 | the worst group (provider errors; once the normal is learned also 401/403, 404, 400/409/422, 429, other 4xx and all unsuccessful calls; the last also while the status mix is learning after the upgrade, for an endpoint that normally succeeds ≥ 90%) reaches its incident threshold: `(share − normal) / (threshold − normal)`. An endpoint answering 401 to every call scores like one answering 503 |
| latency | 25 | p95 is 3 × baseline **and** +1000 ms: `clamp((p95/baseline − 1.5) / 1.5) × clamp((p95 − baseline) / 1000 ms)` |
| 4xx | 10 | 4xx rate is 20 pp above its baseline |
| 429 | 5 | 429 rate is 10 pp above its baseline |

Error and latency penalties are multiplied by `min(1, calls / 20)`, so one failure on a quiet endpoint doesn't turn it red. No traffic in the window gives no score: an endpoint or provider that was called before (endpoints: within the range asked for, 24 h by default in the health API; providers: ever) is `idle`, one never called is `unknown`. Idle is neither healthy nor failing; the dashboard shows its last call and totals over the range instead of live values.

Status: **green ≥ 90**, **amber 60–89**, **red < 60**. An endpoint at the incident threshold scores 40 (red); halfway there, 70 (amber). An endpoint with an open incident is shown red.

**Provider score** = call-volume-weighted mean of its endpoints' scores; a single red endpoint makes the provider at least amber.

## Webhooks (inbound)

Deliveries your app receives from a provider (SDK 0.3.0+, collector 0.4.0+; what is captured: [privacy.md](privacy.md#inbound-webhooks)) are judged per **source**: (environment, provider, route template). Code: `scoring/inbound.ts`, `scoring/silence.ts`, `incidents/inbound.ts`. Everything reads `rollups_inbound_1m`. **Discovered routes** (webhook discovery: routes the SDK reports as possible deliveries from senders it can't identify) are never scored: they have no rollups, sources, baselines or incidents until an admin confirms the route with a name, and from then on its deliveries are a source like any other (history starts at the confirmation). A **rejected** delivery is one our app didn't answer 2xx (3xx, 4xx, 5xx, or the connection closed first: the sender gives up and retries).

| kind | rule | what the alert says |
|---|---|---|
| `webhook_silence` | a gap since the last delivery longer than this source's normal gaps at these times (below) | "No Stripe webhooks for 2h 10m; normally ~40/hour at this time" |
| `webhook_rejections` | rejected share against the source's normal share, **the same rule as provider errors**: at least `minCalls` deliveries in the window (low-traffic windows included), at least `minErrors` rejected, share ≥ max(normal + `rateDeltaPp`, min(`rateMultiplier` × normal, halfway to 100%)), the count test with the rejections' ρ; learning floor `learningDefaultRate` | "GitHub webhooks rejected by our app (38%, mostly 401/403)"; when most rejections are 401/403: "the webhook signing secret likely does not match (rotated, or test vs live mode)" |
| `webhook_slow` | deliveries handled slower than max(`latencyMultiplier` × normal p95, normal p95 + `latencyDeltaMs`), against their normal share: **the latency rule** (count test, share floor) | "…handled slowly (p95 8.1 s, normally 420 ms)", and that providers retry deliveries that time out, so slow handling causes duplicates |
| `webhook_lag` | deliveries received later than max(`lagMultiplier` × normal p95 lag, normal + `lagDeltaSeconds`) (3×, +60 s) after the sender signed them, against their normal share, the same way; only senders that sign a timestamp | "…arriving late (p95 6m 20s after sending, normally 2 s)" |

Each source's checks share `maxPValue` the same way across the classes it tests (rejections, plus the slow and late classes once learned: up to 3). Normal values (rejected share, handler p50/p95, lag p95, and the count tests' model in `inbound_baselines.model`: the rejections' ρ and the slow and late classes) come from the last `baselineDays` of inbound rollups minus the last `baselineGapMinutes` and the minutes of the source's incidents, cached in `inbound_baselines` and refreshed every 10 minutes, like outgoing baselines. Lag is stored in the latency histogram's buckets read as seconds (1 s … 18 h). A sender clock slightly ahead of ours gives a negative lag, counted as 0; a timestamp more than 7 days off is ignored by the SDK. The receive time is the SDK's, so batching never adds lag; our own host's clock error does.

**Incidents.** One open inbound incident per source, kept apart from the provider's outgoing incidents (it never changes the provider's outgoing score or status). Rejections, slow handling and lag open after `openAfterMinutes` bad windows in a row and resolve after `resolveAfterMinutes` healthy ones; **silence opens as soon as it is significant and resolves on the next delivery**, or when the source is marked expected quiet. Its start is the minute after the last delivery, so the incident covers the whole gap. A stronger kind takes over an open incident with an escalation alert (order: silence, rejections, slow, lag): rejections that turn into silence. Rejection incidents escalate when the share doubles for `openAfterMinutes` windows, slow and lag incidents when the p95 does. Cooldown is per kind (a silence followed by rejections when deliveries come back is not muted). The provider's alerts switch applies. Every alert says whether the provider's other webhook routes are fine.

### Silence

Silence is judged from the source's **normal gaps** (`scoring/silence.ts`, collector 0.4). For each source, every minute:

1. **History**: over the last `silenceHistoryDays` (28), from the first delivery to the latest one (the current gap never teaches the model), the hourly counts of deliveries and of **minutes with a delivery**, and every **gap** (silent stretch between two minutes with deliveries). Hours and gaps that touch a past silence incident are left out.
2. **Rates per hour of the week** (UTC, 168 slots), for deliveries and for minutes with a delivery. Empirical Bayes on two levels: each hour of day pulled toward the overall mean, and each hour-of-week slot toward its hour of day, each with a strength fitted from how much the means really differ, i.e. their spread minus what sampling noise alone gives (a Gamma prior by moments; the noise is the spread within a slot across weeks, Poisson until a slot has two weeks). A flat source's rates are flat from its first week instead of echoing which hours happened to be busy; a source that only sends on weekdays borrows almost nothing for Saturdays.
3. **Gaps in normal time.** A gap's **weight** is the number of minutes-with-a-delivery the source normally has in it: L = Σ over its minutes of −ln(1 − p), with p = that hour-of-week's minutes with a delivery / 60 (capped at 0.999). An overnight gap of a business-hours source weighs almost nothing; the same hours at noon weigh a lot. This replaces multiplying clock hours as if they were independent.
4. **Longest normal gap**: the heaviest gap in the history, in the same weight (and its length in minutes, for the summary).
5. **Open** when all of these hold, and the source has `silenceMinHistoryDays` (**21**) of history with `silenceMinDeliveries` (100) in it (three weeks, so the longest normal gap has been measured over enough gaps to be stable; with one or two weeks it was still growing and paged clumpy sources in their second week):
   - the gap is at least `silenceMinGapMinutes` (15);
   - the model calls it unlikely: P = (1 + L/k)^(−k) < `maxPValue`, the whole gap as one negative-binomial draw (k: the burstiness of the hourly minute counts against the hour-of-day profile; no overdispersion: P = e^(−L)), so a gap is never made "significant" by multiplying hours;
   - its weight is more than **1.5 × the longest normal gap**. Clumpy sources (deliveries in bursts with long quiet stretches between) are judged against their own long gaps.
6. **Irregular sources**: when the longest normal gap weighs **30** or more (`IRREGULAR_GAP`: the source normally goes quiet for stretches its own rates call near-impossible, chance e^−30, as test-driven or batch traffic does), silence is **not judged**: the dashboard shows "irregular: silence alerts off" on the route, with **Alert on silence anyway** (`silence_forced`, members, `PUT /v1/admin/webhooks/sources {silenceForced}`), which judges it with the same rules. Rejections, slowness and lag are judged as usual.
7. **Project-wide guard: all sources quiet.** When at least two of a project's sources are silent and no other source of the project has delivered while they all were (`holdAllQuiet`), every source has gone quiet at once: more likely a holiday or our own receiver (a proxy, DNS, a firewall in front of the app) than each provider failing. Silence alerts are held (the verdicts become `all_quiet`) and the Webhooks page says **"All sources quiet: possible holiday or receiver issue"**; they resume as soon as any source delivers. A silence incident already open stays open. **Limit:** a project with a single webhook source has nothing to compare with, so a holiday (a weekday as quiet as a weekend) is judged like any other day there; the 1.5 × margin absorbs a quieter day only partly, and the detection bench shows the case (one false alarm in 26 weeks on a clumped source, on its simulated holiday). Mark the route expected quiet for known quiet days.
8. **Not judged** when the route is marked **expected quiet** (per source, on the provider's page), or when the service that received the source's last delivery has stopped reporting for 15 minutes (no batch, no heartbeat; SDK health shows it, and the cause is the app, not the provider). Serverless services don't heartbeat and are always treated as running. Naturally rare sources (a few deliveries a day) never reach the minimum deliveries and never page.

The past-weeks guard of collector 0.3 ("was the same window ever silent in the last four weeks?") is gone: weighing gaps by the hour-of-week rate and comparing with the longest normal gap covers what it guarded against (quiet weekends, nights) without being trivially satisfied by multi-hour gaps.

What it means in practice (tests: `apps/collector/test/silence.test.ts`; the detection bench in docs/benchmarks.md):

| source | silence opens after |
|---|---|
| steady ~300/min | 15 minutes (the minimum gap) |
| steady ~40/hour | ~20–25 minutes (1.5 × its longest normal gap of ~15 min) |
| ~4/hour, random | ~2.5–3 hours |
| clumps of ~20 every ~15 min | 1.5 × its longest normal gap (~1.5–2 hours) |
| ~100/hour Mon–Fri 09–17 UTC | ~15–30 min during business hours; never at night or at weekends |
| test-driven bursts (1–2 h of traffic, then 12–36 h of nothing) | never: irregular, unless switched on |
| ~1/day | never (too few deliveries) |

Hour of week is UTC, so a daylight-saving change shifts a local-time pattern by an hour twice a year; the shrinkage toward the hour of day and the 1.5 × margin absorb that in practice.

### Webhook thresholds

The project thresholds above apply to webhooks too (`minCalls` = deliveries in the window, `minErrors` = rejected deliveries, `rateMultiplier`/`rateDeltaPp` for the rejected share, `latencyMultiplier`/`latencyDeltaMs` for slow handling, `minExcess` and `maxPValue` for the count tests (`maxPValue` also for silence), plus open/resolve/cooldown/baselines). Webhook-only keys, per project in Settings → Thresholds:

| key | default | meaning |
|---|---|---|
| `silenceHistoryDays` | 28 | history the hour-of-week rates and the normal gaps are learned from |
| `silenceMinHistoryDays` | 21 | silence is judged only after this much history … |
| `silenceMinDeliveries` | 100 | … with at least this many deliveries in it |
| `silenceMinGapMinutes` | 15 | silence never opens before this long without a delivery |
| `lagMultiplier` | 3 | a delivery is late above multiplier × normal p95 lag … |
| `lagDeltaSeconds` | 60 | … and above normal + this |

A provider can override, for its webhooks only (Settings → Providers → a provider → Webhooks; admins; `providers.webhook_thresholds`): `minCalls`, `openAfterMinutes`, `rateMultiplier`, `rateDeltaPp`, `latencyMultiplier`, `latencyDeltaMs`, `silenceMinGapMinutes`, `lagMultiplier`, `lagDeltaSeconds`. These are separate from the provider's outgoing overrides: a low minimum for its API traffic says nothing about its webhooks. Precedence per key: the provider's webhook override, then the project's, then the default. The per-source **expected quiet** switch (members too, like alerts on/off) turns silence off for one route; rejections, slowness and lag are still judged.

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
- `apps/collector/test/silence.test.ts`: the silence model: hour-of-week profile (business hours, a weekly batch, a slot seen empty once, excluded incidents), burstiness, the exact zero-probability for Poisson and negative binomial across clock hours, the minimum gap, history and deliveries, the past-weeks guard, and a month of minute-by-minute quiet-but-healthy traffic with at most one false alarm.
- `apps/collector/test/inbound-engine.test.ts`: rejections, slow handling and lag rules (table-driven), and the inbound incident engine (silence opens at once and resolves on the next delivery, bad/healthy windows, kind takeover, escalation, cooldown) and alert titles.
- `apps/collector/test/webhooks-db.test.ts`: deliveries through `/v1/ingest` into their own rollups (never `rollups_1m`), silence opening and resolving with the alert text, rejections with the 401/403 hint, expected quiet, the dashboard API and the status page row.
- `apps/collector/test/alerting.test.ts`: the same 40% scenario end to end through `/v1/ingest`, Postgres, the scheduler and real Slack/webhook receivers (signature checked), plus delivery retries.
