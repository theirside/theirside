/**
 * Simulation mode wiring, shared by the collector (THEIRSIDE_SIM=1) and the
 * `pnpm sim` CLI: the scheduler the engine steps minute by minute, the
 * simulation alert channels and the /__sim routes.
 */
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { CollectorConfig } from '../config.js';
import type { AppContext } from '../context.js';
import { schedulerJobs } from '../jobs.js';
import { Scheduler, type Job } from '../modules/scheduler/scheduler.js';
import type { SimClock } from './clock.js';
import { SimEngine, type TimelineEvent } from './engine.js';
import { registerSimRoutes, scenarioDirs } from './routes.js';

/** Simulated time before any scenario is loaded: Monday 2026-01-05 00:00 UTC. */
export const SIM_DEFAULT_START = Date.UTC(2026, 0, 5);

/** The demo's alert sink (the chaos provider's /__alerts) unless THEIRSIDE_SIM_ALERT_URL says otherwise. */
export const DEFAULT_ALERT_SINK = 'http://localhost:4010/__alerts';
const SINK_NAME = 'Simulation alert sink';
const SLACK_NAME = 'Simulation Slack';

/**
 * Alerts from simulation go to the demo's alert sink (a signed webhook) and to Slack
 * when THEIRSIDE_SIM_SLACK_WEBHOOK_URL is set; their payloads carry simulated times.
 */
export async function ensureSimAlertChannels(
  ctx: AppContext,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const orgs = await ctx.storage.config.listOrgs();
  const orgId = orgs[0]?.id;
  const projectId = orgId ? (await ctx.storage.config.listProjects(orgId))[0]?.id : undefined;
  if (!orgId || !projectId) return;
  const tenant = { orgId, projectId };
  const existing = await ctx.storage.config.listAlertChannels(tenant);
  const sink = env.THEIRSIDE_SIM_ALERT_URL ?? DEFAULT_ALERT_SINK;
  if (sink !== 'off' && !existing.some((c) => c.name === SINK_NAME))
    await ctx.storage.config.createAlertChannel(tenant, {
      kind: 'webhook',
      name: SINK_NAME,
      enabled: true,
      config: { url: sink, secret: env.THEIRSIDE_SIM_ALERT_SECRET ?? 'simulation-sink-secret' },
    });
  const slack = env.THEIRSIDE_SIM_SLACK_WEBHOOK_URL;
  if (slack && !existing.some((c) => c.name === SLACK_NAME))
    await ctx.storage.config.createAlertChannel(tenant, {
      kind: 'slack',
      name: SLACK_NAME,
      enabled: true,
      config: { webhookUrl: slack },
    });
}

export async function attachSim(
  app: FastifyInstance,
  ctx: AppContext,
  pool: pg.Pool,
  config: CollectorConfig,
  clock: SimClock,
  opts: { log?: (m: string) => void; onEvent?: (e: TimelineEvent, engine: SimEngine) => void } = {},
): Promise<{ engine: SimEngine; scheduler: Scheduler }> {
  const info = opts.log ?? (() => {});
  // THEIRSIDE_SIM_PROFILE=1: time each job, printed every simulated day
  const all = schedulerJobs(ctx, config, info);
  const jobs = all.map((j, i) =>
    process.env.THEIRSIDE_SIM_PROFILE === '1' ? timed(j, info, i === all.length - 1) : j,
  );
  const scheduler = new Scheduler(ctx.storage, clock, jobs, {
    info: (_o, m) => info(m),
    error: (o, m) => info(`${m}: ${JSON.stringify(o)}`),
  });
  await ensureSimAlertChannels(ctx);
  const engine = new SimEngine(
    {
      storage: ctx.storage,
      pool,
      clock,
      scheduler,
      log: info,
      ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
    },
    ctx.alerts as unknown as { enqueue: (...a: never[]) => Promise<unknown> },
  );
  await registerSimRoutes(app, ctx, engine, scenarioDirs());
  return { engine, scheduler };
}

const totals = new Map<string, { ms: number; runs: number }>();
let lastReport = 0;
function timed(job: Job, log: (m: string) => void, last: boolean): Job {
  return {
    name: job.name,
    async run(now) {
      const t0 = performance.now();
      try {
        await job.run(now);
      } finally {
        const t = totals.get(job.name) ?? { ms: 0, runs: 0 };
        t.ms += performance.now() - t0;
        t.runs++;
        totals.set(job.name, t);
        if (last && now.getTime() - lastReport >= 24 * 3_600_000) {
          lastReport = now.getTime();
          log(
            `profile: ${[...totals].map(([n, v]) => `${n} ${(v.ms / v.runs).toFixed(1)} ms`).join(', ')}`,
          );
        }
      }
    },
  };
}
