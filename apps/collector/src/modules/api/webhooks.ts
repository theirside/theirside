import { histogramQuantile } from '@theirside/shared';
import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../../context.js';
import type { InboundKey, Tenant, WebhookCandidate } from '../../storage/types.js';
import { inboundKeyId, isInbound } from '../../storage/types.js';
import { floorMinute } from '../../util/clock.js';
import { nameKey, suggestProvider } from '../discovery/candidate-match.js';
import { MAX_PENDING_CANDIDATES } from '../ingest/route.js';
import { inboundStats } from '../scoring/inbound.js';
import {
  EMPTY_PROFILE,
  HOUR_MS,
  holdAllQuiet,
  hourOfWeek,
  judgeSilence,
} from '../scoring/silence.js';
import { resolveThresholds, webhookThresholdsFor } from '../scoring/thresholds.js';
import { RANGES, type RangeKey } from './series.js';

const MIN = 60_000;

const rangeKey = z.enum(Object.keys(RANGES) as [RangeKey, ...RangeKey[]]);
const listQuery = z.object({
  range: rangeKey.default('24h'),
  environment: z.string().optional(),
  provider: z.string().optional(),
});
const seriesQuery = z.object({
  provider: z.string().min(1),
  endpoint: z.string().optional(),
  environment: z.string().optional(),
  range: rangeKey.default('24h'),
});
const sourcePatch = z
  .object({
    environment: z.string().min(1).max(128),
    provider: z.string().min(1).max(128),
    endpoint: z.string().min(1).max(512),
    expectedQuiet: z.boolean().optional(),
    /** Judge silence although the gap model calls the source irregular. */
    silenceForced: z.boolean().optional(),
  })
  .refine((b) => b.expectedQuiet !== undefined || b.silenceForced !== undefined);

const candidateRoute = z.object({ endpoint: z.string().min(1).max(512) });
const candidateConfirm = candidateRoute.extend({
  provider: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .refine((v) => v.toLowerCase() !== 'unknown', 'give the sender a name'),
  /**
   * `link`: `provider` is an existing provider's name (its outgoing endpoints and these
   * webhooks then share one provider); `new`: create it (409 when one with that name
   * exists). Missing: link when it exists, else create (older dashboards).
   */
  mode: z.enum(['link', 'new']).optional(),
});

const DAY_MS = 86_400_000;
const startOfUtcDay = (d: Date) => new Date(Math.floor(d.getTime() / DAY_MS) * DAY_MS);

/** A discovered webhook route as the dashboard shows it. */
export function candidateView(c: WebhookCandidate, today: Date) {
  // average over the days it could have been seen in the last 7 (first seen today: 1 day)
  const since = Math.floor((today.getTime() - startOfUtcDay(c.firstSeenAt).getTime()) / DAY_MS) + 1;
  const days = Math.max(1, Math.min(7, since));
  return {
    endpoint: c.endpoint,
    method: c.method,
    suggestedName: c.suggestedName,
    status: c.status,
    provider: c.provider,
    deliveriesPerDay: Math.round((c.deliveries7d / days) * 10) / 10,
    deliveries7d: c.deliveries7d,
    firstSeenAt: c.firstSeenAt.toISOString(),
    lastSeenAt: c.lastSeenAt.toISOString(),
    lastService: c.lastService,
    decidedAt: c.decidedAt?.toISOString() ?? null,
  };
}

/** `waiting`: a confirmed route that hasn't delivered since (no source yet). */
export type WebhookSourceStatus =
  'incident' | 'quiet' | 'learning' | 'irregular' | 'all_quiet' | 'ok' | 'waiting';

/**
 * Dashboard API for inbound webhooks (architecture §3.3): every source with its
 * last delivery, deliveries in the last hour against the learned rate for this
 * hour of week, rejected share, handler p95 and delivery lag over the range,
 * and the open inbound incident. Reads inbound rollups, sources and stored
 * baselines only.
 */
export async function registerWebhookRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  r: {
    auth: object;
    members: object;
    tenantOf: (req: FastifyRequest, reply: FastifyReply) => Promise<Tenant | null | undefined>;
  },
): Promise<void> {
  app.get('/v1/admin/webhooks', r.auth, async (req, reply) => {
    const tenant = await r.tenantOf(req, reply);
    if (!tenant) return;
    const q = listQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'invalid query' });
    const now = ctx.clock.now();
    const to = new Date(floorMinute(now.getTime()) + MIN);
    const from = new Date(to.getTime() - RANGES[q.data.range].minutes * MIN);
    const hourAgo = new Date(to.getTime() - 60 * MIN);
    const filter = {
      ...(q.data.environment ? { environment: q.data.environment } : {}),
      ...(q.data.provider ? { provider: q.data.provider } : {}),
    };
    const [sources, ranged, lastHour, baselines, open, providers, thresholds, routes] =
      await Promise.all([
        ctx.storage.inbound.listSources(tenant),
        ctx.storage.inbound.aggregateByKey(tenant, { from, to, ...filter }),
        ctx.storage.inbound.aggregateByKey(tenant, { from: hourAgo, to, ...filter }),
        ctx.storage.inbound.getBaselines(tenant),
        ctx.storage.incidents.list(tenant, { status: 'open', direction: 'inbound' }),
        ctx.storage.config.listProviders(tenant),
        ctx.storage.config.getThresholds(tenant),
        ctx.storage.inbound.candidateRoutes(tenant),
      ]);
    const projectT = resolveThresholds(thresholds);
    const rangeBy = new Map(ranged.map((a) => [inboundKeyId(a), a]));
    const hourBy = new Map(lastHour.map((a) => [inboundKeyId(a), a]));
    const baseBy = new Map(baselines.map((b) => [inboundKeyId(b), b]));
    const providerBy = new Map(providers.map((p) => [p.name, p]));
    const incidents = open.filter(isInbound);
    const slot = hourOfWeek(now.getTime());
    // the job's project-wide guard, from the same inputs: every source quiet at once
    const end = floorMinute(now.getTime());
    const guard = holdAllQuiet(
      sources.map((s) => {
        const t = webhookThresholdsFor(projectT, providerBy.get(s.provider)?.webhookThresholds);
        const last = floorMinute(s.lastDeliveryAt.getTime());
        return {
          id: inboundKeyId(s),
          lastDelivery: last,
          silence: judgeSilence(
            baseBy.get(inboundKeyId(s))?.silence ?? EMPTY_PROFILE,
            last,
            end,
            t,
            {
              expectedQuiet: s.expectedQuiet,
              silenceForced: s.silenceForced,
            },
          ),
        };
      }),
    );
    const heldIds = new Set(
      guard.sources
        .filter((x) => !x.silence.judged && x.silence.reason === 'all_quiet')
        .map((x) => x.id),
    );

    const out = new Map<string, unknown[]>();
    for (const s of sources) {
      if (q.data.environment && s.environment !== q.data.environment) continue;
      if (q.data.provider && s.provider !== q.data.provider) continue;
      const id = inboundKeyId(s);
      const b = baseBy.get(id);
      const t = webhookThresholdsFor(projectT, providerBy.get(s.provider)?.webhookThresholds);
      const stats = inboundStats(rangeBy.has(id) ? [rangeBy.get(id)!] : []);
      const profile = b?.silence ?? EMPTY_PROFILE;
      const learning =
        profile.historyHours < t.silenceMinHistoryDays * 24 ||
        profile.deliveries < t.silenceMinDeliveries;
      const inc = incidents.find(
        (i) =>
          i.environment === s.environment &&
          i.provider === s.provider &&
          i.endpoints[0]?.endpoint === s.endpoint,
      );
      const status: WebhookSourceStatus = inc
        ? 'incident'
        : heldIds.has(id)
          ? 'all_quiet'
          : s.expectedQuiet
            ? 'quiet'
            : learning
              ? 'learning'
              : profile.irregular && !s.silenceForced
                ? 'irregular'
                : 'ok';
      const list = out.get(s.provider) ?? [];
      list.push({
        environment: s.environment,
        endpoint: s.endpoint,
        firstSeenAt: s.firstSeenAt.toISOString(),
        lastDeliveryAt: s.lastDeliveryAt.toISOString(),
        lastService: s.lastService,
        expectedQuiet: s.expectedQuiet,
        status,
        silenceLearning: learning,
        // normal gaps too irregular to judge silence (test-driven traffic): off unless forced
        silenceIrregular: profile.irregular,
        silenceForced: s.silenceForced,
        longestNormalGapMinutes: learning ? null : profile.longestGapMinutes,
        deliveries: stats.deliveries,
        deliveriesPerHour: hourBy.get(id)?.total ?? 0,
        normalPerHour: learning ? null : (profile.rates[slot] ?? null),
        rejectionRate: stats.deliveries > 0 ? stats.rejectionRate : null,
        authRate: stats.deliveries > 0 ? stats.auth / stats.deliveries : null,
        normalRejectionRate: b?.rejectionRate ?? null,
        p95Ms: stats.p95,
        normalP95Ms: b?.p95Ms ?? null,
        lagP95S: stats.lagCount > 0 ? stats.lagP95S : null,
        normalLagP95S: b?.lagP95S ?? null,
        incident: inc ? { id: inc.id, kind: inc.kind, openedAt: inc.openedAt.toISOString() } : null,
      });
      out.set(s.provider, list);
    }
    // confirmed routes listed before their first delivery under that provider (the SDK
    // picks the confirmation up within a minute; the route then records like any other)
    for (const c of routes.confirmed) {
      if (q.data.provider && c.provider !== q.data.provider) continue;
      if (sources.some((s) => s.provider === c.provider && s.endpoint === c.path)) continue;
      const list = out.get(c.provider) ?? [];
      list.push({
        environment: '',
        endpoint: c.path,
        firstSeenAt: null,
        lastDeliveryAt: null,
        lastService: null,
        expectedQuiet: false,
        status: 'waiting' satisfies WebhookSourceStatus,
        silenceLearning: true,
        silenceIrregular: false,
        silenceForced: false,
        longestNormalGapMinutes: null,
        deliveries: 0,
        deliveriesPerHour: 0,
        normalPerHour: null,
        rejectionRate: null,
        authRate: null,
        normalRejectionRate: null,
        p95Ms: null,
        normalP95Ms: null,
        lagP95S: null,
        normalLagP95S: null,
        incident: null,
      });
      out.set(c.provider, list);
    }
    return {
      range: q.data.range,
      // every source of the project quiet at once: silence alerts are held
      allQuiet: guard.held,
      providers: [...out.entries()]
        .map(([provider, list]) => {
          const p = providerBy.get(provider);
          const statuses = list.map((x) => (x as { status: WebhookSourceStatus }).status);
          return {
            provider,
            displayName: p?.displayName ?? null,
            providerId: p?.id ?? null,
            alertsEnabled: p?.alertsEnabled ?? true,
            webhooksPublic: p?.webhooksPublic ?? false,
            status: statuses.includes('incident') ? 'incident' : 'ok',
            sources: list,
          };
        })
        .sort(
          (a, b) =>
            Number(b.status === 'incident') - Number(a.status === 'incident') ||
            a.provider.localeCompare(b.provider),
        ),
    };
  });

  /** Per-bucket deliveries, rejections, handler p95 and lag, with the learned rate as the normal line. */
  app.get('/v1/admin/webhooks/series', r.auth, async (req, reply) => {
    const tenant = await r.tenantOf(req, reply);
    if (!tenant) return;
    const q = seriesQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'invalid query' });
    const range = RANGES[q.data.range];
    const now = ctx.clock.now();
    const to = new Date(floorMinute(now.getTime()) + MIN);
    const from = new Date(to.getTime() - range.minutes * MIN);
    const filter = {
      provider: q.data.provider,
      ...(q.data.endpoint ? { endpoint: q.data.endpoint } : {}),
      ...(q.data.environment ? { environment: q.data.environment } : {}),
    };
    const [rows, baselines] = await Promise.all([
      ctx.storage.inbound.series(tenant, { from, to, ...filter, bucketMinutes: range.bucket }),
      ctx.storage.inbound.getBaselines(tenant),
    ]);
    const mine = baselines.filter(
      (b) =>
        b.provider === q.data.provider &&
        (!q.data.endpoint || b.endpoint === q.data.endpoint) &&
        (!q.data.environment || b.environment === q.data.environment),
    );
    // expected deliveries per bucket: the summed hour-of-week rates of the sources
    const expected = (start: number) => {
      let sum = 0;
      for (
        let m = start;
        m < start + range.bucket * MIN;
        m += Math.min(HOUR_MS, range.bucket * MIN)
      ) {
        const minutes = Math.min(60, range.bucket);
        for (const b of mine) sum += ((b.silence.rates[hourOfWeek(m)] ?? 0) * minutes) / 60;
      }
      return sum;
    };
    const byStart = new Map(rows.map((x) => [new Date(x.minute).getTime(), x]));
    const points = [];
    for (
      let m = from.getTime() - (from.getTime() % (range.bucket * MIN));
      m < to.getTime();
      m += range.bucket * MIN
    ) {
      const x = byStart.get(m);
      points.push({
        t: new Date(m).toISOString(),
        deliveries: x?.total ?? 0,
        expected: mine.some((b) => b.silence.historyHours > 0) ? expected(m) : null,
        rejected: x?.rejected ?? 0,
        rejectionRate: x && x.total > 0 ? x.rejected / x.total : null,
        p95Ms: x ? histogramQuantile(x.durationHistogram, 0.95) : null,
        lagP95S: x && x.lagCount > 0 ? histogramQuantile(x.lagHistogram, 0.95) : null,
      });
    }
    return { range: q.data.range, bucketMinutes: range.bucket, points };
  });

  /**
   * Webhook discovery: routes the SDKs reported as possible deliveries from
   * senders they can't identify. Never scored until confirmed.
   */
  app.get('/v1/admin/webhooks/candidates', r.auth, async (req, reply) => {
    const tenant = await r.tenantOf(req, reply);
    if (!tenant) return;
    const today = startOfUtcDay(ctx.clock.now());
    const [list, providers] = await Promise.all([
      ctx.storage.inbound.listCandidates(tenant, today),
      ctx.storage.config.listProviders(tenant),
    ]);
    return {
      candidates: list.map((c) => ({
        ...candidateView(c, today),
        // the provider to link it to (or create) when confirming, and why
        match:
          c.status === 'pending'
            ? suggestProvider(c.suggestedName, providers, ctx.directory.catalog)
            : null,
      })),
      pending: list.filter((c) => c.status === 'pending').length,
      maxPending: MAX_PENDING_CANDIDATES,
    };
  });

  /** Confirm a discovered route with a sender name (admins): from now on it is a declared route. */
  app.put('/v1/admin/webhooks/candidates/confirm', r.auth, async (req, reply) => {
    const tenant = await r.tenantOf(req, reply);
    if (!tenant) return;
    const p = candidateConfirm.safeParse(req.body);
    if (!p.success)
      return reply.code(400).send({ error: 'invalid route', detail: p.error.issues[0]?.message });
    const providers = await ctx.storage.config.listProviders(tenant);
    const exact = providers.find((x) => x.name === p.data.provider);
    if (p.data.mode === 'link' && !exact)
      return reply.code(404).send({ error: 'provider not found', provider: p.data.provider });
    if (p.data.mode === 'new') {
      // a second provider for the same company is what linking avoids
      const key = nameKey(p.data.provider);
      const same = providers.find(
        (x) => nameKey(x.name) === key || (x.displayName && nameKey(x.displayName) === key),
      );
      if (same)
        return reply.code(409).send({
          error: `a provider named ${same.displayName || same.name} exists: link the route to it`,
          provider: same.name,
        });
    }
    const ok = await ctx.storage.inbound.decideCandidate(tenant, p.data.endpoint, {
      status: 'confirmed',
      provider: p.data.provider,
      by: req.principal?.userId ?? null,
      at: ctx.clock.now(),
    });
    if (!ok) return reply.code(404).send({ error: 'not found' });
    if (!exact) {
      // settings, alerts switch and thresholds live on the provider row
      await ctx.storage.config.ensureProviders(
        tenant,
        [p.data.provider],
        new Map(),
        ctx.clock.now(),
      );
      // a catalog provider starts with the catalog's category and support contact
      const entry = ctx.directory.catalog.entries.find((e) => e.name === p.data.provider);
      const created = entry
        ? (await ctx.storage.config.listProviders(tenant)).find((x) => x.name === p.data.provider)
        : undefined;
      if (entry && created)
        await ctx.storage.config.updateProvider(tenant, created.id, {
          category: entry.category,
          supportEmail: created.supportEmail ?? entry.supportEmail,
          supportUrl: created.supportUrl ?? entry.supportUrl,
        });
      ctx.directory.invalidate(tenant);
    }
    return {
      endpoint: p.data.endpoint,
      status: 'confirmed',
      provider: p.data.provider,
      linked: !!exact,
    };
  });

  /** Ignore a discovered route (members): the SDKs stop reporting it. */
  app.put('/v1/admin/webhooks/candidates/ignore', r.members, async (req, reply) => {
    const tenant = await r.tenantOf(req, reply);
    if (!tenant) return;
    const p = candidateRoute.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'invalid route' });
    const today = startOfUtcDay(ctx.clock.now());
    const current = (await ctx.storage.inbound.listCandidates(tenant, today)).find(
      (c) => c.endpoint === p.data.endpoint,
    );
    if (!current) return reply.code(404).send({ error: 'not found' });
    // stopping a monitored route is an admin's call (restore first)
    if (current.status === 'confirmed')
      return reply.code(409).send({ error: 'confirmed routes are changed by an admin' });
    await ctx.storage.inbound.decideCandidate(tenant, p.data.endpoint, {
      status: 'ignored',
      provider: null,
      by: req.principal?.userId ?? null,
      at: ctx.clock.now(),
    });
    return { endpoint: p.data.endpoint, status: 'ignored' };
  });

  /** Back to pending (admins): a confirmed route is no longer recorded as deliveries. */
  app.put('/v1/admin/webhooks/candidates/restore', r.auth, async (req, reply) => {
    const tenant = await r.tenantOf(req, reply);
    if (!tenant) return;
    const p = candidateRoute.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'invalid route' });
    const ok = await ctx.storage.inbound.decideCandidate(tenant, p.data.endpoint, {
      status: 'pending',
      provider: null,
      by: null,
      at: ctx.clock.now(),
    });
    return ok
      ? { endpoint: p.data.endpoint, status: 'pending' }
      : reply.code(404).send({ error: 'not found' });
  });

  /**
   * The per-source silence switches, members like alerts on/off: "expected quiet" (silence
   * not judged) and "alert on silence anyway" for a source the gap model calls irregular.
   */
  app.put('/v1/admin/webhooks/sources', r.members, async (req, reply) => {
    const tenant = await r.tenantOf(req, reply);
    if (!tenant) return;
    const p = sourcePatch.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'invalid source' });
    const key: InboundKey = {
      environment: p.data.environment,
      provider: p.data.provider,
      endpoint: p.data.endpoint,
    };
    let ok = true;
    if (p.data.expectedQuiet !== undefined)
      ok = await ctx.storage.inbound.setExpectedQuiet(tenant, key, p.data.expectedQuiet);
    if (ok && p.data.silenceForced !== undefined)
      ok = await ctx.storage.inbound.setSilenceForced(tenant, key, p.data.silenceForced);
    return ok
      ? {
          ...key,
          ...(p.data.expectedQuiet !== undefined ? { expectedQuiet: p.data.expectedQuiet } : {}),
          ...(p.data.silenceForced !== undefined ? { silenceForced: p.data.silenceForced } : {}),
        }
      : reply.code(404).send({ error: 'not found' });
  });
}
