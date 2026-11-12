# Simulation scenario reference

<!-- Generated from apps/collector/src/sim/reference.ts by `pnpm sim:help --write`; do not edit by hand. -->

Every setting of a simulation scenario ([docs/demo.md](demo.md#simulate-weeks-in-minutes)): the same text as the Simulation page's field hints and Reference panel, and `pnpm sim:help [topic]`. Ready-made scenarios: `examples/sim/` (`pnpm sim:list`).

[Scenario](#scenario) · [Times and durations](#times) · [History](#history) · [Providers and endpoints](#providers) · [Webhooks](#webhooks) · [Traffic patterns](#patterns) · [Traffic settings](#traffic) · [Normal levels, outgoing](#normal-outbound) · [Normal levels, webhooks](#normal-inbound) · [Faults](#faults) · [Fault types](#fault-types) · [Expectations](#expect) · [Incident kinds](#kinds)

<a id="scenario"></a>

## Scenario

A YAML file in examples/sim/ (or saved from the Simulation page); the page and `pnpm sim:run` read the same format.

| Key | What it does | Default |
|---|---|---|
| `name` | Shown on the page and in the CLI output. |  |
| `description` | What the scenario shows and what must happen. |  |
| `start` | Simulated start time (ISO, UTC). Days in times count from here. | 2026-01-05T00:00:00Z (a Monday) |
| `duration` | How long the scenario runs, e.g. 3d, 2w. |  |
| `seed` | Random seed: the same seed gives the same traffic, run after run. | 1 |
| `environment` | The environment name the traffic is reported under. | production |
| `history` | Start from an empty database, or with days of generated history (see History). | empty |
| `providers` | Outgoing calls: providers and their endpoints (see Providers). |  |
| `webhooks` | Incoming webhooks: senders and routes (see Webhooks). |  |
| `faults` | What breaks, when and for how long (see Faults). |  |
| `expect` | What must (or must not) happen; checked live (see Expectations). |  |

```yaml
# duration
duration: 5d
```

<a id="times"></a>

## Times and durations

| Key | What it does | Default |
|---|---|---|
| `day N HH:MM` | N days and HH:MM after `start` (with a midnight start, the clock time on day N). |  |
| `+DURATION` | That long after `start`. |  |
| `ISO time` | An absolute time. |  |
| `durations` | w, d, h, m (and s), combined: 30m, 2h, 3d, 1w2d, 1d6h. |  |

```yaml
# day N HH:MM
at: day 2 14:00
# +DURATION
at: +2d6h
# ISO time
at: 2026-01-07T14:00:00Z
# durations
duration: 1d6h
```

<a id="history"></a>

## History

Baselines need history: with an empty start the collector learns for about a day before it judges an endpoint, and silence needs 21 days.

| Key | What it does | Default |
|---|---|---|
| `mode: empty` | Start with nothing; watch baselines form. |  |
| `mode: seeded` | Generate `days` of history before the start (1–60). |  |
| `days` | Days of history to generate (seeded only). |  |
| `traffic` | One traffic pattern for every source's history (seeded only). | each source's own traffic (random bursts instead of a schedule) |

```yaml
# mode: seeded
history: { mode: seeded, days: 8 }
```

<a id="providers"></a>

## Providers and endpoints

| Key | What it does | Default |
|---|---|---|
| `name` | Provider name (use fake ones: PayCo, NotifyCo, …). |  |
| `host` | Its API host. | api.<name>.test |
| `endpoints` | Its endpoints, one or more. |  |
| `id` | Endpoint id for faults and expectations. | "<provider> <METHOD> <path>", e.g. "PayCo POST /v1/charges" |
| `method` | HTTP method. | GET |
| `path` | Path template, e.g. /v1/charges/:id. |  |
| `traffic` | How many calls, when (see Traffic patterns). |  |
| `normal` | Normal error and latency levels (see Normal levels, outgoing). |  |
| `markedExpected` | Statuses marked expected for this endpoint from the dashboard (400, 401, 403, 404, 409, 422): counted as successful, with the safety net. Pair with `normal.expected` and `expectedTagged: false`. |  |

```yaml
# markedExpected
markedExpected: [400]
```

<a id="webhooks"></a>

## Webhooks

| Key | What it does | Default |
|---|---|---|
| `provider` | The sender, e.g. NotifyCo. |  |
| `route` | Our route that receives them, e.g. /webhooks/notifyco. |  |
| `id` | Source id for faults and expectations. | "<provider> webhooks <route>" |
| `traffic` | How many deliveries, when (see Traffic patterns). |  |
| `normal` | Normal rejection, handling and lag levels (see Normal levels, webhooks). |  |

<a id="patterns"></a>

## Traffic patterns

How many calls (or deliveries) a source gets each minute. Counts are random around the rate (Poisson), never exact. Times are UTC.

| Key | What it does | Default | Uses |
|---|---|---|---|
| `steady` | The same rate around the clock. Flat unless `night` or `weekend` is set. |  | `rate`, `night`, `weekend`, `holidays` |
| `daily` | A daily cycle: peak at 14:00 UTC, lowest at 02:00 UTC, quieter at weekends. `rate` is the 14:00 peak, so the average is lower: with the defaults about 65% of the peak on weekdays and 26% at weekends. |  | `rate`, `night`, `weekend`, `holidays` |
| `low` | A few calls an hour, flat. |  | `perHour`, `night`, `weekend`, `holidays` |
| `bursty` | Clumps of calls with long gaps between them, on a daily cycle. Like a sender that batches webhooks: 80% of the traffic comes in clumps (each spread over 1–3 minutes), 20% as background. Silence must wait for its longest normal gap. |  | `clumpSize`, `clumpEvery`, `rate`, `night`, `weekend`, `holidays` |
| `test-bursts` | Traffic only in bursts, nothing in between (a dev or test environment). Random bursts, or exactly at `schedule` times (then none after the last one). Seeded history always uses random bursts. |  | `rate`, `burstMinutes`, `idleHours`, `schedule` |
| `rare` | A few calls a day; whole hours often pass without one. Exercises the guards for sparse traffic: no silence or error alarms on a handful of calls. |  | `perDay`, `night`, `weekend`, `holidays` |
| `off` | No traffic. |  |  |

```yaml
# steady
traffic: { pattern: steady, rate: 30 }
# daily
traffic: { pattern: daily, rate: 40, night: 0.2, weekend: 0.3, holidays: [9] }
# low
traffic: { pattern: low, perHour: 6 }
# bursty
traffic: { pattern: bursty, clumpSize: 20, clumpEvery: 15 }
# test-bursts
traffic: { pattern: test-bursts, rate: 5, burstMinutes: [60, 90], schedule: ["day 1 15:00"] }
# rare
traffic: { pattern: rare, perDay: 5 }
# off
traffic: { pattern: off }
```

<a id="traffic"></a>

## Traffic settings

| Key | What it does | Default |
|---|---|---|
| `rate` | Per minute: flat (steady), at the 14:00 peak (daily), during a burst (test-bursts), on average (bursty). | 10; test-bursts 80; bursty clumpSize ÷ clumpEvery + 0.4 |
| `perHour` | low: calls per hour. | 4 |
| `perDay` | rare: calls per day. | 3 |
| `night` | Level at 02:00 UTC as a share of the peak (0–1). | 0.3 for daily and bursty; 1 (flat) for the others |
| `weekend` | Level on Saturdays, Sundays and holidays as a share (0–1). | 0.4 for daily and bursty; 1 for the others |
| `holidays` | Days counted from `start` that are as quiet as a weekend. |  |
| `clumpSize` | bursty: calls per clump, on average. | 20 |
| `clumpEvery` | bursty: minutes between clumps, on average. | 15 |
| `burstMinutes` | test-bursts: burst length range in minutes [min, max]. | 60–120 |
| `idleHours` | test-bursts: gap between random bursts in hours [min, max]. | 12–36 |
| `schedule` | test-bursts: bursts exactly at these times instead of random ones. |  |

```yaml
# holidays
holidays: [9]
# schedule
schedule: ["day 1 15:00", "day 3 10:00"]
```

<a id="normal-outbound"></a>

## Normal levels, outgoing

An endpoint's everyday behaviour, before any fault.

| Key | What it does | Default |
|---|---|---|
| `errors` | Provider errors as a share of calls (5xx, a fifth of them timeouts); varies ±50% by day. | 0.4% |
| `notFound` | 404s as a share of calls. | 1% |
| `validation` | 422s as a share of calls. | 0.5% |
| `latencyMs` | Median latency in ms. | 250 ms |
| `latencySigma` | Latency spread (log-normal sigma, 0–3): higher means a longer slow tail. | 0.5 |
| `noise` | Everyday noise: a lone 5xx and a few very slow calls a day, short latency wobbles. | on |
| `expected` | Expected outcomes: a share of calls answered with a 4xx that is a normal business answer (a consent check answering 400 when the user has not consented). A number, or `[min, max]`: the share drifts between them hour by hour. | none |
| `expectedStatus` | The status of those answers (a 4xx). | 400 |
| `expectedTagged` | Tagged in code (SDK `markExpected`), so they count as successful; off: plain 4xx answers (for marking them from the dashboard). | on |
| `expectedReason` | The reason label tagged answers carry. | consent_required |

```yaml
# expected
expected: [0.1, 0.4]
```

<a id="normal-inbound"></a>

## Normal levels, webhooks

| Key | What it does | Default |
|---|---|---|
| `rejected` | Deliveries our app answers non-2xx, as a share; varies ±50% by day. | 0.2% |
| `handlerMs` | Median handling time in ms. | 80 ms |
| `lagS` | Median seconds between the sender signing and the delivery arriving. | 1.5 s |
| `lateShare` | Share of deliveries that arrive 20–90 s late. | 0.3% |
| `signed` | The sender signs a timestamp; off: no delivery lag is measured. | on |
| `noise` | Everyday noise, as for outgoing calls. | on |

<a id="faults"></a>

## Faults

| Key | What it does | Default |
|---|---|---|
| `id` | Name the expectations refer to. |  |
| `target` | The source: "PayCo POST /v1/charges", "NotifyCo webhooks /webhooks/notifyco", or its `id`. |  |
| `at` | When it starts (see Times). |  |
| `duration` | How long it lasts. |  |
| `type` | What goes wrong (see Fault types). |  |
| `size` | How bad: a share of calls (0–1) for error faults and rejected, × for latency, ms for slow, seconds for late. | per type (see Fault types) |
| `ramp` | latency: grow from 1× to `size` over the duration (slow degradation). |  |
| `status` | rejected: the status our app answers (401 for a signing-secret mismatch). auth, not_found, validation: the status the provider answers instead of the usual one, never tagged expected (a contract change: `type: validation, status: 400`). | rejected 500; auth 401/403; not_found 404; validation 422 |

```yaml
# at
at: day 1 14:00
# duration
duration: 2h
```

<a id="fault-types"></a>

## Fault types

Outgoing types apply to endpoints, webhook types to webhook sources.

| Key | What it does | Default | Uses |
|---|---|---|---|
| `5xx` | `size` share of calls answer 503 (an outage or partial outage); incident `errors`. | 30% | `outgoing` |
| `timeouts` | `size` share of calls time out after 10–30 s; incident `errors`. | 30% | `outgoing` |
| `resets` | `size` share of calls fail with a connection reset; incident `errors`. | 30% | `outgoing` |
| `auth` | `size` share of calls answer 401/403 (changed access rules, a revoked key); incident `auth`. | 50% | `outgoing` |
| `not_found` | `size` share of calls answer 404; incident `not_found`. | 50% | `outgoing` |
| `validation` | `size` share of calls answer 422 (or `status`, e.g. 400), never tagged expected; incident `validation`. | 50% | `outgoing` |
| `latency` | Every call takes `size` × longer; with `ramp`, grows from 1× to `size` over the duration; incident `latency`. | 3× | `outgoing` |
| `silent` | The sender stops delivering; incident `webhook_silence`. |  | `webhooks` |
| `rejected` | `size` share of deliveries get `status` from our app (500, or 401 for a signing-secret mismatch); incident `webhook_rejections`. | 100% | `webhooks` |
| `slow` | Our handler gets slow: median handling time `size`/2 ms; incident `webhook_slow`. | 8000 ms | `webhooks` |
| `late` | Deliveries arrive `size` seconds (median) after the sender signed them; incident `webhook_lag`. | 480 s | `webhooks` |

<a id="expect"></a>

## Expectations

Checked live on the page and at the end of `pnpm sim:run` (exit 1 when one fails).

| Key | What it does | Default |
|---|---|---|
| `incident` | An incident must open within `within` of fault `fault` starting. |  |
| `fault` | incident: the fault id. |  |
| `within` | incident: the longest acceptable time to open. |  |
| `kind` | incident: required incident kind, or a list of them (see Incident kinds). | any |
| `target` | incident / quiet: the source. | the fault's source / every source |
| `quiet` | No incident may open between `from` and `to`. |  |
| `from` | quiet: window start. |  |
| `to` | quiet: window end. |  |
| `irregular` | Webhook source `target` must be marked irregular (silence alerts off) by `by`. |  |
| `by` | irregular: the latest time. |  |

```yaml
# incident
expect:
  - incident: { fault: outage, within: 10m, kind: errors }
# quiet
expect:
  - quiet: { from: day 0 00:00, to: day 1 14:00 }
# irregular
expect:
  - irregular: { target: NotifyCo webhooks /webhooks/notifyco, by: day 6 }
```

<a id="kinds"></a>

## Incident kinds

The `kind` values an incident can have.

| Key | What it does | Default |
|---|---|---|
| `errors` | 5xx, timeouts or connection resets above normal. |  |
| `auth` | 401/403 above normal. |  |
| `not_found` | 404 above normal. |  |
| `validation` | 422 and other 4xx above normal. |  |
| `rate_limited` | 429 above normal. |  |
| `behaviour` | The status mix changed in a way none of the other kinds describe. |  |
| `latency` | Slower than normal. |  |
| `webhook_silence` | A webhook sender stopped delivering. |  |
| `webhook_rejections` | Our app rejects deliveries (non-2xx). |  |
| `webhook_slow` | Our app handles deliveries slowly. |  |
| `webhook_lag` | Deliveries arrive long after the sender signed them. |  |
