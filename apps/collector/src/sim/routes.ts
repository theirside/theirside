/**
 * Simulation API (admins only; registered only with THEIRSIDE_SIM=1, so every
 * /__sim path is a 404 otherwise). docs/demo.md "Simulate weeks in minutes".
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { requireAdmin } from '../modules/auth/routes.js';
import { parseSpeed } from './clock.js';
import type { SimEngine } from './engine.js';
import { REFERENCE } from './reference.js';
import {
  DAY,
  HOUR,
  MIN,
  parseScenarioYaml,
  historySchema,
  scenarioToYaml,
  validateScenario,
} from './scenario.js';

/** Where the ready-made scenarios and the saved ones live. */
export interface ScenarioDirs {
  examples: string;
  saved: string;
}

const here = dirname(fileURLToPath(import.meta.url));

/** Defaults: the repo's examples/sim and examples/sim/local (git-ignored), when run from the repo. */
export function scenarioDirs(env: NodeJS.ProcessEnv = process.env): ScenarioDirs {
  const repoExamples = resolve(here, '../../../../examples/sim');
  const examples =
    env.THEIRSIDE_SIM_EXAMPLES ??
    (existsSync(repoExamples) ? repoExamples : resolve('examples/sim'));
  return { examples, saved: env.THEIRSIDE_SIM_SAVE_DIR ?? join(examples, 'local') };
}

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export async function listScenarios(dirs: ScenarioDirs) {
  const out: {
    name: string;
    source: 'example' | 'saved';
    description: string | null;
    error?: string;
  }[] = [];
  for (const [dir, source] of [
    [dirs.examples, 'example'],
    [dirs.saved, 'saved'],
  ] as const) {
    const files = existsSync(dir)
      ? (await readdir(dir)).filter((f) => f.endsWith('.yaml')).sort()
      : [];
    for (const f of files) {
      const name = f.replace(/\.yaml$/, '');
      try {
        const v = parseScenarioYaml(await readFile(join(dir, f), 'utf8'));
        out.push({ name, source, description: v.scenario.description ?? null });
      } catch (err) {
        out.push({ name, source, description: null, error: (err as Error).message });
      }
    }
  }
  return out;
}

/** A scenario file by name: saved ones first (a saved copy shadows the example). */
export async function readScenario(dirs: ScenarioDirs, name: string): Promise<string | null> {
  if (!NAME.test(name)) return null;
  for (const dir of [dirs.saved, dirs.examples]) {
    const p = join(dir, `${name}.yaml`);
    if (existsSync(p)) return readFile(p, 'utf8');
  }
  return null;
}

const scenarioBody = z.object({
  yaml: z.string().optional(),
  scenario: z.unknown().optional(),
});
const toScenario = (b: z.infer<typeof scenarioBody>) =>
  b.yaml !== undefined ? parseScenarioYaml(b.yaml) : validateScenario(b.scenario);

export async function registerSimRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  engine: SimEngine,
  dirs: ScenarioDirs = scenarioDirs(),
): Promise<void> {
  const admin = { preHandler: requireAdmin(ctx), config: { role: 'admin' as const } };
  const clockView = async () => {
    const s = await engine.state();
    return {
      now: new Date(s.now).toISOString(),
      start: s.start === null ? null : new Date(s.start).toISOString(),
      end: s.end === null ? null : new Date(s.end).toISOString(),
      speed: s.speed,
      paused: s.paused,
      status: s.status,
      jumpTo: s.jumpTo === null ? null : new Date(s.jumpTo).toISOString(),
      realElapsedMs: s.realElapsedMs,
      minutesPerSecond: s.minutesPerSecond,
    };
  };
  const bad = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, err: unknown) =>
    reply.code(400).send({ error: (err as Error).message });

  app.get('/__sim/clock', admin, clockView);

  /** The scenario reference (field hints and the Reference panel; also pnpm sim:help). */
  app.get('/__sim/reference', admin, async () => ({ sections: REFERENCE }));

  app.put('/__sim/clock', admin, async (req, reply) => {
    const b = z
      .object({
        speed: z.union([z.number(), z.literal('max')]).optional(),
        paused: z.boolean().optional(),
      })
      .safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'expected {speed?, paused?}' });
    if (b.data.speed !== undefined) {
      const s = parseSpeed(b.data.speed);
      if (s === null) return reply.code(400).send({ error: 'speed: a positive number or "max"' });
      engine.setSpeed(s);
    }
    if (b.data.paused === true) await engine.pause();
    if (b.data.paused === false) engine.play();
    return clockView();
  });

  app.post('/__sim/clock/advance', admin, async (req, reply) => {
    const b = z
      .object({
        minutes: z.number().positive().optional(),
        hours: z.number().positive().optional(),
        days: z.number().positive().optional(),
      })
      .safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'expected {minutes|hours|days}' });
    const ms = (b.data.minutes ?? 0) * MIN + (b.data.hours ?? 0) * HOUR + (b.data.days ?? 0) * DAY;
    if (ms <= 0) return reply.code(400).send({ error: 'expected {minutes|hours|days}' });
    engine.advance(ms);
    return clockView();
  });

  /** Stop a jump in progress where it is (back to paused or running, as before it). */
  app.delete('/__sim/clock/advance', admin, async () => {
    await engine.cancelJump();
    return clockView();
  });

  /** Everything the Simulation page shows; `since` = timeline events already shown. */
  app.get('/__sim/state', admin, async (req) => {
    const since = Number((req.query as { since?: string }).since ?? 0) || 0;
    const s = await engine.state();
    return {
      ...s,
      yaml: s.scenario ? scenarioToYaml(s.scenario) : null,
      timelineTotal: s.timeline.length,
      timeline: s.timeline.slice(since),
    };
  });

  app.get('/__sim/scenarios', admin, async () => ({
    scenarios: await listScenarios(dirs),
    savedDir: dirs.saved,
  }));

  app.get('/__sim/scenarios/:name', admin, async (req, reply) => {
    const yaml = await readScenario(dirs, (req.params as { name: string }).name);
    if (yaml === null) return reply.code(404).send({ error: 'not found' });
    try {
      return { yaml, scenario: parseScenarioYaml(yaml).scenario };
    } catch (err) {
      return reply.code(422).send({ error: (err as Error).message, yaml });
    }
  });

  /** Save (create or replace) a scenario in the saved folder. */
  app.put('/__sim/scenarios/:name', admin, async (req, reply) => {
    const name = (req.params as { name: string }).name;
    if (!NAME.test(name))
      return reply.code(400).send({ error: 'name: lowercase letters, digits and dashes' });
    const b = scenarioBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'expected {yaml} or {scenario}' });
    try {
      const v = toScenario(b.data);
      await mkdir(dirs.saved, { recursive: true });
      const yaml = scenarioToYaml(v.scenario);
      await writeFile(join(dirs.saved, `${name}.yaml`), yaml);
      return { name, path: join(dirs.saved, `${name}.yaml`), yaml };
    } catch (err) {
      return bad(reply, err);
    }
  });

  app.post('/__sim/validate', admin, async (req, reply) => {
    const b = scenarioBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'expected {yaml} or {scenario}' });
    try {
      const v = toScenario(b.data);
      return { ok: true, scenario: v.scenario, yaml: scenarioToYaml(v.scenario) };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  /**
   * Load a scenario and reset the simulation database: by name, YAML or object; `history`
   * overrides its start option ("start from empty" / "start with seeded history").
   */
  app.post('/__sim/load', admin, async (req, reply) => {
    const b = z
      .object({
        name: z.string().optional(),
        yaml: z.string().optional(),
        scenario: z.unknown().optional(),
        history: historySchema.optional(),
        play: z.boolean().optional(),
      })
      .safeParse(req.body);
    if (!b.success)
      return reply.code(400).send({ error: 'expected {name|yaml|scenario, history?}' });
    try {
      let input: unknown = b.data.scenario;
      if (b.data.name !== undefined) {
        const yaml = await readScenario(dirs, b.data.name);
        if (yaml === null) return reply.code(404).send({ error: 'no such scenario' });
        input = parseScenarioYaml(yaml).scenario;
      } else if (b.data.yaml !== undefined) input = parseScenarioYaml(b.data.yaml).scenario;
      await engine.load(input, b.data.history ? { history: b.data.history } : {});
      if (b.data.play) engine.play();
      return clockView();
    } catch (err) {
      return bad(reply, err);
    }
  });

  /** Apply edits live (traffic, normal levels, future faults, expectations), or say a restart is needed. */
  app.put('/__sim/scenario', admin, async (req, reply) => {
    const b = scenarioBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'expected {yaml} or {scenario}' });
    try {
      const scenario =
        b.data.yaml !== undefined ? parseScenarioYaml(b.data.yaml).scenario : b.data.scenario;
      return engine.applyLive(scenario);
    } catch (err) {
      return bad(reply, err);
    }
  });
}
