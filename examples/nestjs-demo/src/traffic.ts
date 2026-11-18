/**
 * Built-in demo users for the zero-setup demo (docker/compose.demo.yml): with
 * DEMO_TRAFFIC_RPS set, the app calls its own routes at that rate, so the demo needs no
 * separate load generator. The dev demo stack leaves it unset and runs tools/loadgen,
 * which calls the same routes with the same weights.
 *
 * The calls go to 127.0.0.1, which the SDK never records (loopback); what it records are
 * the provider calls each route makes.
 */
const ROUTES = [
  { method: 'POST', path: () => `/cards/${id('card')}/activate`, weight: 3 },
  { method: 'GET', path: () => `/cards/${id('card')}`, weight: 3 },
  { method: 'POST', path: () => '/onboarding', weight: 2 },
  { method: 'POST', path: () => '/payouts', weight: 2 },
];

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
function id(prefix: string): string {
  let s = String(Math.floor(Math.random() * 10));
  for (let i = 0; i < 9; i++) s += B62[Math.floor(Math.random() * 62)];
  return `${prefix}_${s}`;
}

export function startDemoUsers(port: number, rps: number): void {
  const pool = ROUTES.flatMap((r) => Array.from({ length: r.weight }, () => r));
  const perTick = rps / 10;
  let carry = 0;
  const timer = setInterval(() => {
    carry += perTick;
    while (carry >= 1) {
      carry -= 1;
      const r = pool[Math.floor(Math.random() * pool.length)]!;
      void fetch(`http://127.0.0.1:${port}${r.path()}`, {
        method: r.method,
        ...(r.method === 'POST'
          ? { body: '{}', headers: { 'content-type': 'application/json' } }
          : {}),
        signal: AbortSignal.timeout(15_000),
      })
        .then((res) => res.arrayBuffer())
        .catch(() => {});
    }
  }, 100);
  timer.unref();
}
