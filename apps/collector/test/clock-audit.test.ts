import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Product time goes through the injectable clock (`ctx.clock`, a `Clock` argument,
 * or the `now` a job is given), so simulation mode can run it on simulated time and
 * tests on a fake clock. Wall-clock reads left in the collector are listed here on
 * purpose, each with its reason (docs/demo.md "Simulate weeks in minutes").
 */
const SRC = join(import.meta.dirname, '../src');

/** file → reads allowed there (substring of the line), with why. */
const ALLOWED: Record<string, { line: string; why: string }[]> = {
  'util/clock.ts': [{ line: 'now: () => new Date()', why: 'the real clock itself' }],
  'demo-seed.ts': [
    { line: 'Date.now()', why: 'how long the demo seed took (real time, a log line)' },
  ],
  'demo-ready.ts': [
    {
      line: 'Date.now()',
      why: "the demo stack's ready line: its start-up timeout and the demo app's first calls since this start (real time)",
    },
  ],
  'demo/seed.ts': [
    {
      line: 'opts.now ?? new Date()',
      why: 'the demo seed runs against real time unless told otherwise',
    },
  ],
  'modules/scheduler/scheduler.ts': [
    {
      line: 'const now = Date.now();',
      why: 'aligning real ticks to wall-clock minutes; simulation mode steps the scheduler itself',
    },
  ],
  'modules/alerts/routes.ts': [
    { line: 'now: Date = new Date()', why: 'default of testPayload(); the route passes ctx.clock' },
  ],
  'modules/alerts/channels.ts': [
    {
      line: 'Math.floor(Date.now() / 1000)',
      why: 'webhook signature timestamp: replay protection checked against the receiver’s real clock',
    },
  ],
  'sim/guard.ts': [
    { line: 'new Date().toISOString()', why: 'when a database was marked (real time)' },
  ],
  'sim/engine.ts': [
    { line: 'Date.now()', why: 'real elapsed time and pacing of the simulated clock' },
  ],
  'sim/cli.ts': [{ line: 'Date.now()', why: 'real run time printed by the CLI' }],
};

const READS = /Date\.now\(\)|new Date\(\)|performance\.now\(\)/;
/** SQL now() that decides something (an audit column default like updated_at is fine). */
const SQL_LOGIC = /now\(\)\s*[-+<>]|[<>]=?\s*now\(\)|COALESCE\(\$\d+(?:::timestamptz)?, now\(\)\)/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('clock audit: no wall-clock reads in product time', () => {
  it('every Date.now() / new Date() / performance.now() is on the allowlist', () => {
    const found: string[] = [];
    for (const f of files(SRC)) {
      const rel = relative(SRC, f);
      readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (!READS.test(line) || line.trim().startsWith('//') || line.trim().startsWith('*'))
            return;
          // profiling-only timers in simulation mode
          if (rel.startsWith('sim/') && line.includes('performance.now()')) return;
          if ((ALLOWED[rel] ?? []).some((a) => line.includes(a.line))) return;
          found.push(`${rel}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(found).toEqual([]);
  });

  it('SQL never decides with the database clock (only audit-column defaults use now())', () => {
    const found: string[] = [];
    for (const f of files(SRC)) {
      const rel = relative(SRC, f);
      readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          const sql = line.replace(/(Date|performance)\.now\(\)/g, '');
          if (SQL_LOGIC.test(sql)) found.push(`${rel}:${i + 1}: ${line.trim()}`);
        });
    }
    // the provider rows created without a time keep the old default, but every caller passes one
    expect(found.every((l) => l.includes('COALESCE($'))).toBe(true);
  });

  it('every allowlisted read still exists (no stale entries)', () => {
    for (const [rel, entries] of Object.entries(ALLOWED)) {
      const text = readFileSync(join(SRC, rel), 'utf8');
      for (const e of entries) expect(text, `${rel}: ${e.line}`).toContain(e.line);
    }
  });
});
