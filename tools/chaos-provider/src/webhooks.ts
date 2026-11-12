import { createHmac, randomBytes } from 'node:crypto';
import http from 'node:http';

/**
 * A fake provider's webhook sender for the demo (docs/demo.md): POSTs signed
 * deliveries to the demo app, Standard Webhooks style (`webhook-id`,
 * `webhook-timestamp`, `webhook-signature: v1,<base64 HMAC-SHA256 of
 * "id.timestamp.body">`), so the SDK detects them without setup. Modes, set
 * through the admin API (`PUT /__webhooks`):
 *   normal    deliveries at `ratePerMin`, correctly signed
 *   silent    nothing is sent (the provider stopped delivering)
 *   slow      the body asks the demo handler to take `delayMs` (our app is slow)
 *   rejected  signed with a wrong secret: the demo app answers 401 (a rotated secret)
 *   late      the signed timestamp is `lagSeconds` old (the provider's queue is backed up)
 */
export const WEBHOOK_MODES = ['normal', 'silent', 'slow', 'rejected', 'late'] as const;
export type WebhookMode = (typeof WEBHOOK_MODES)[number];

export interface WebhookState {
  mode: WebhookMode;
  ratePerMin: number;
  delayMs: number;
  lagSeconds: number;
  sent: number;
  /** Status codes the target answered, counted. */
  answers: Record<string, number>;
  lastError: string | null;
}

export interface WebhookSenderOptions {
  /** Where deliveries go, e.g. http://demo:3000/webhooks/notifyco. */
  target: string;
  secret: string;
  ratePerMin?: number;
  now?: () => number;
  /** Test hook: send through this instead of http. */
  post?: (headers: Record<string, string>, body: string) => Promise<number>;
}

/** Standard Webhooks signature: `v1,` + base64(HMAC-SHA256(secret, `${id}.${ts}.${body}`)). */
export function signStandardWebhook(secret: string, id: string, ts: number, body: string): string {
  return `v1,${createHmac('sha256', secret).update(`${id}.${ts}.${body}`).digest('base64')}`;
}

function httpPost(target: string) {
  return (headers: Record<string, string>, body: string) =>
    new Promise<number>((resolve, reject) => {
      const req = http.request(
        target,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          timeout: 15_000,
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      );
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      req.end(body);
    });
}

export function createWebhookSender(opts: WebhookSenderOptions) {
  const now = opts.now ?? Date.now;
  const post = opts.post ?? httpPost(opts.target);
  const state: WebhookState = {
    mode: 'normal',
    ratePerMin: opts.ratePerMin ?? 30,
    delayMs: 3000,
    lagSeconds: 600,
    sent: 0,
    answers: {},
    lastError: null,
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  /** One delivery now (whatever the mode allows). Never rejects. */
  async function deliver(): Promise<void> {
    if (state.mode === 'silent') return;
    const id = `msg_${randomBytes(8).toString('hex')}`;
    const ts = Math.floor(now() / 1000) - (state.mode === 'late' ? state.lagSeconds : 0);
    const body = JSON.stringify({
      type: 'message.delivered',
      id: `evt_${randomBytes(6).toString('hex')}`,
      created: ts,
      ...(state.mode === 'slow' ? { simulate: 'slow', delayMs: state.delayMs } : {}),
    });
    const secret = state.mode === 'rejected' ? `${opts.secret}-rotated` : opts.secret;
    try {
      const status = await post(
        {
          'webhook-id': id,
          'webhook-timestamp': String(ts),
          'webhook-signature': signStandardWebhook(secret, id, ts, body),
        },
        body,
      );
      state.sent++;
      state.answers[String(status)] = (state.answers[String(status)] ?? 0) + 1;
      state.lastError = null;
    } catch (err) {
      state.lastError = String((err as Error).message ?? err);
    }
  }

  /** Poisson-ish arrivals at `ratePerMin`: exponential gaps, like real webhook traffic. */
  function schedule(): void {
    if (stopped) return;
    const meanMs = 60_000 / Math.max(0.01, state.ratePerMin);
    const gap = -Math.log(1 - Math.random()) * meanMs;
    timer = setTimeout(() => {
      void deliver();
      schedule();
    }, gap);
    timer.unref?.();
  }

  return {
    state,
    deliver,
    start: () => {
      stopped = false;
      schedule();
    },
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    /** Apply an admin change; returns an error message for invalid input. */
    set(patch: Partial<Pick<WebhookState, 'mode' | 'ratePerMin' | 'delayMs' | 'lagSeconds'>>) {
      if (patch.mode !== undefined && !WEBHOOK_MODES.includes(patch.mode))
        return `mode must be one of ${WEBHOOK_MODES.join(', ')}`;
      for (const k of ['ratePerMin', 'delayMs', 'lagSeconds'] as const) {
        const v = patch[k];
        if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < 0))
          return `${k} must be a non-negative number`;
      }
      Object.assign(state, patch);
      return null;
    },
  };
}

export type WebhookSender = ReturnType<typeof createWebhookSender>;
