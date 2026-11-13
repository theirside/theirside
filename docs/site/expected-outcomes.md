---
title: Expected outcomes
description: Tell Theirside when a provider's error status is a normal answer (a consent check answering 400), in code with markExpected or expecting, or from the dashboard.
order: 5
---

# Expected outcomes

Some APIs answer a normal business case with an error status: a consent check answers `400` when the user hasn't consented, a lookup answers `404` for "no such customer yet". Counted as failures, these make the endpoint's normal noisy, and a change in how often users hit them can open an incident. Tell Theirside which answers are normal; those calls then count as successful.

## In code: `markExpected` (recommended)

Call it after your code has read the answer and decided it's a normal case:

```ts
// consent.ts
import { markExpected } from '@theirside/sdk';

export async function hasConsent(userId: string): Promise<boolean> {
  const res = await fetch(`https://api.consentco.test/v1/consent/${userId}`);
  if (res.status === 400) {
    const body = (await res.json()) as { code?: string };
    if (body.code === 'consent_required') {
      markExpected('consent_required'); // a normal answer: the user hasn't consented yet
      return false;
    }
  }
  if (!res.ok) throw new Error(`consent check failed: ${res.status}`);
  return true;
}
```

`markExpected(reason)` tags the latest outgoing call that ended in the same incoming request, if it answered with a 4xx in the last 5 seconds. It works in any Node HTTP server (Express, Fastify, NestJS). Only the reason label is sent (letters, digits and `_ . : -`, up to 64 characters); the SDK never reads the response itself.

## In code: `expecting`

When you know up front, wrap the call instead. 4xx answers to the calls made inside, also from async work it starts, are tagged:

```ts
// consent-check.ts
import { expecting } from '@theirside/sdk';

export async function check(userId: string) {
  return expecting('consent_required', () => consentClient.check(userId));
}
```

Use `expecting()` outside an incoming request (queue consumers, cron jobs), and when several calls run at once in one request: `markExpected()` tags whichever ended last.

## Why only the calls you tag

Untagged calls with the same status stay failures. So if the provider changes its contract and starts answering `400` to everything, your code doesn't recognise those answers, doesn't tag them, and you still get an alert. Only 4xx answers can be expected; a 5xx, timeout or connection error never is. Tagged calls show as their own series per reason on the endpoint page.

## From the dashboard

Without a code change, mark a status as expected for a whole endpoint: from an incident ("Mark 404 as expected for POST /v1/lookup"), from the endpoint row, or in the provider's settings. Members and admins can do it, and an open incident it explains is resolved with a note. Slack alerts about 401/403, 404 or 400/409/422 have a **Mark as expected** button.

That is coarser: every answer with that status from that endpoint counts as fine. A **safety net** still opens an incident when the marked status takes over: above 80% of calls, or halfway from its normal share to every call if that is higher, with confidence, for about 10 minutes ("400 (marked expected) now 95% of calls, normally 30%").

## Which to use

| | In code | From the dashboard |
|---|---|---|
| Precision | Only the answers your code read as normal | Every answer with that status |
| Contract change ("400 to everything") | Alerts as usual | Alerts only once the status takes over |
| Effort | A line where you handle the answer | A click |
| Works on | Node servers; `expecting()` anywhere | Any SDK version |

Start from the dashboard to quiet an endpoint today; move to `markExpected` where you handle the answer when you next touch that code.

## Checking it

`getStats().expected` counts `tagged` calls and `missed` marks (a `markExpected` that found no 4xx to tag); with `debug: true` the SDK says why a mark missed.
