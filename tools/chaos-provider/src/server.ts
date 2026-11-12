import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { WebhookSender } from './webhooks.js';

/**
 * A fake third-party provider for demos and tests. Every path answers like a
 * provider API (JSON + x-request-id) unless a chaos rule matches it.
 *
 * Admin API (JSON):
 *   GET    /__chaos               current rules
 *   POST   /__chaos/rules         add a rule, returns it with its id
 *   DELETE /__chaos/rules/:id     remove one rule
 *   DELETE /__chaos/rules         remove all rules
 * Webhook sender (when started with WEBHOOK_TARGET; see webhooks.ts):
 *   GET    /__webhooks            mode, rate, counts of the target's answers
 *   PUT    /__webhooks            {mode?: normal|silent|slow|rejected|late, ratePerMin?, delayMs?, lagSeconds?}
 * Alert sink (collector webhook channel target):
 *   POST   /__alerts              record a webhook; verifies x-theirside-signature when SINK_SECRET is set
 *   GET    /__alerts              recorded alerts, oldest first
 *   DELETE /__alerts              clear
 */
export interface Rule {
  id: string;
  /** Path template: `/v2/cards/:id/activate`, `*` matches the rest; matched against the path only. */
  path: string;
  method?: string;
  /** Match only requests whose Host header starts with this (e.g. `acme-cards`). */
  host?: string;
  /** Fraction of matching calls answered with `errorStatus`. */
  errorRate?: number;
  errorStatus?: number;
  /** Fraction of matching calls that never get a response (until `hangMs`). */
  timeoutRate?: number;
  hangMs?: number;
  /** Fraction of matching calls whose connection is reset. */
  resetRate?: number;
  /** Extra latency for every matching call. */
  latencyMs?: number;
  /** Rule expires after this many seconds. */
  durationSeconds?: number;
  expiresAt?: number;
}

export interface SinkEntry {
  receivedAt: string;
  event: string | undefined;
  signatureValid: boolean | null;
  body: unknown;
}

export interface ChaosOptions {
  /** Base latency for healthy calls, ms (random in [min, max]). */
  baseLatencyMs?: [number, number];
  sinkSecret?: string;
  random?: () => number;
  now?: () => number;
  /** Webhook sender controlled through /__webhooks (none: 404). */
  webhooks?: WebhookSender;
}

function matchPath(pattern: string, path: string): boolean {
  const p = pattern.split('/').filter(Boolean);
  const s = path.split('/').filter(Boolean);
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '*') return true;
    if (i >= s.length) return false;
    if (p[i]!.startsWith(':')) continue;
    if (p[i] !== s[i]) return false;
  }
  return p.length === s.length;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let b = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => (b += c));
    req.on('end', () => resolve(b));
  });
}

function verifySignature(secret: string, header: string | undefined, body: string): boolean {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header ?? '');
  if (!m) return false;
  const expected = createHmac('sha256', secret).update(`${m[1]}.${body}`).digest('hex');
  return timingSafeEqual(Buffer.from(expected), Buffer.from(m[2]!));
}

export function createChaosServer(opts: ChaosOptions = {}) {
  const random = opts.random ?? Math.random;
  const now = opts.now ?? Date.now;
  const [minLat, maxLat] = opts.baseLatencyMs ?? [20, 120];
  let rules: Rule[] = [];
  const alerts: SinkEntry[] = [];
  const hanging = new Set<http.ServerResponse>();

  const activeRules = () => {
    const t = now();
    rules = rules.filter((r) => !r.expiresAt || r.expiresAt > t);
    return rules;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://chaos');
    const path = url.pathname;
    const method = (req.method ?? 'GET').toUpperCase();

    // ---- admin API
    if (path === '/__chaos' && method === 'GET') return json(res, 200, { rules: activeRules() });
    if (path === '/__chaos/rules' && method === 'POST') {
      try {
        const r = JSON.parse(await readBody(req)) as Rule;
        if (typeof r.path !== 'string') return json(res, 400, { error: 'path is required' });
        const rule: Rule = {
          ...r,
          id: randomBytes(4).toString('hex'),
          ...(r.durationSeconds ? { expiresAt: now() + r.durationSeconds * 1000 } : {}),
        };
        rules.push(rule);
        return json(res, 201, rule);
      } catch {
        return json(res, 400, { error: 'invalid JSON' });
      }
    }
    if (path === '/__chaos/rules' && method === 'DELETE') {
      rules = [];
      return json(res, 200, { rules });
    }
    const del = /^\/__chaos\/rules\/([^/]+)$/.exec(path);
    if (del && method === 'DELETE') {
      rules = rules.filter((r) => r.id !== del[1]);
      return json(res, 200, { rules });
    }

    // ---- webhook sender
    if (path === '/__webhooks') {
      if (!opts.webhooks)
        return json(res, 404, { error: 'no webhook sender (set WEBHOOK_TARGET)' });
      if (method === 'GET') return json(res, 200, opts.webhooks.state);
      if (method === 'PUT') {
        try {
          const err = opts.webhooks.set(JSON.parse((await readBody(req)) || '{}'));
          if (err) return json(res, 400, { error: err });
          console.log(`[webhooks] mode ${opts.webhooks.state.mode}`);
          return json(res, 200, opts.webhooks.state);
        } catch {
          return json(res, 400, { error: 'invalid JSON' });
        }
      }
    }

    // ---- alert sink
    if (path === '/__alerts' && method === 'POST') {
      const body = await readBody(req);
      let parsed: unknown = body;
      try {
        parsed = JSON.parse(body);
      } catch {
        // keep raw
      }
      alerts.push({
        receivedAt: new Date(now()).toISOString(),
        event: req.headers['x-theirside-event'] as string | undefined,
        signatureValid: opts.sinkSecret
          ? verifySignature(
              opts.sinkSecret,
              req.headers['x-theirside-signature'] as string | undefined,
              body,
            )
          : null,
        body: parsed,
      });
      const p = parsed as { event?: string; title?: string };
      console.log(`[alert] ${p.event ?? '?'}: ${p.title ?? ''}`);
      return json(res, 200, { ok: true });
    }
    if (path === '/__alerts' && method === 'GET') return json(res, 200, { alerts });
    if (path === '/__alerts' && method === 'DELETE') {
      alerts.length = 0;
      return json(res, 200, { ok: true });
    }
    if (path === '/healthz') return json(res, 200, { ok: true });

    // ---- provider API
    req.resume();
    const host = String(req.headers.host ?? '');
    const rule = activeRules().find(
      (r) =>
        matchPath(r.path, path) &&
        (!r.method || r.method.toUpperCase() === method) &&
        (!r.host || host.startsWith(r.host)),
    );
    const latency = minLat + random() * (maxLat - minLat) + (rule?.latencyMs ?? 0);
    const roll = random();
    const resetCut = rule?.resetRate ?? 0;
    const timeoutCut = resetCut + (rule?.timeoutRate ?? 0);
    const errorCut = timeoutCut + (rule?.errorRate ?? 0);

    if (roll < resetCut) {
      req.socket.destroy();
      return;
    }
    if (roll < timeoutCut) {
      hanging.add(res);
      setTimeout(() => {
        hanging.delete(res);
        req.socket.destroy();
      }, rule?.hangMs ?? 60_000).unref();
      return;
    }
    setTimeout(() => {
      const requestId = `req_${randomBytes(6).toString('hex')}`;
      res.setHeader('x-request-id', requestId);
      if (roll < errorCut) {
        return json(res, rule?.errorStatus ?? 503, {
          error: 'service_unavailable',
          request_id: requestId,
        });
      }
      const idMatch = /\/([^/]+)\/[^/]*$/.exec(path);
      return json(res, method === 'POST' ? 201 : 200, {
        ok: true,
        id: idMatch?.[1] ?? randomBytes(4).toString('hex'),
        path,
        request_id: requestId,
      });
    }, latency).unref();
  });

  return {
    server,
    rules: () => activeRules(),
    alerts,
    close: () =>
      new Promise<void>((resolve) => {
        for (const r of hanging) r.socket?.destroy();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
