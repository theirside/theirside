import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { COLLECTOR_ENV } from '../src/config-env.js';

/**
 * docs/site/configuration.md is generated from COLLECTOR_ENV: it must list exactly the
 * variables config.ts reads, so a new setting can't ship undocumented.
 */
describe('COLLECTOR_ENV', () => {
  const source = readFileSync(new URL('../src/config.ts', import.meta.url), 'utf8');
  const read = new Set(
    [...source.matchAll(/env\.([A-Z][A-Z0-9_]+)|\(\s*env,\s*'([A-Z][A-Z0-9_]+)'/g)].map(
      (m) => m[1] ?? m[2]!,
    ),
  );

  it('lists every variable config.ts reads, and nothing else', () => {
    expect(COLLECTOR_ENV.map((v) => v.name).sort()).toEqual([...read].sort());
  });

  it('has no duplicates and a description for each', () => {
    const names = COLLECTOR_ENV.map((v) => v.name);
    expect(new Set(names).size).toBe(names.length);
    for (const v of COLLECTOR_ENV) expect(v.description.length, v.name).toBeGreaterThan(5);
  });
});
