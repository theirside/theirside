import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { INCIDENT_KINDS } from '../src/modules/scoring/evaluate.js';
import { FAULT_DEFAULT_SIZE } from '../src/sim/generate.js';
import { REFERENCE, findReference, referenceMarkdown } from '../src/sim/reference.js';
import {
  INBOUND_FAULTS,
  OUTBOUND_FAULTS,
  PATTERNS,
  endpointSchema,
  expectSchema,
  faultSchema,
  inboundNormalSchema,
  outboundNormalSchema,
  providerSchema,
  scenarioSchema,
  trafficSchema,
  webhookSchema,
} from '../src/sim/scenario.js';
import { INBOUND_KINDS } from '../src/storage/types.js';

const keys = (id: string) => {
  const s = REFERENCE.find((x) => x.id === id);
  if (!s) throw new Error(`no section ${id}`);
  return s.entries.map((e) => e.key);
};
const shape = (schema: z.ZodObject<z.ZodRawShape>) => Object.keys(schema.shape);

describe('scenario reference (Simulation page hints, pnpm sim:help, docs/simulation-reference.md)', () => {
  it.each([
    ['scenario', shape(scenarioSchema)],
    ['providers', [...shape(providerSchema), ...shape(endpointSchema)]],
    ['webhooks', shape(webhookSchema)],
    ['traffic', shape(trafficSchema).filter((k) => k !== 'pattern')],
    ['normal-outbound', shape(outboundNormalSchema)],
    ['normal-inbound', shape(inboundNormalSchema)],
    ['faults', shape(faultSchema)],
    ['patterns', [...PATTERNS]],
    ['fault-types', [...OUTBOUND_FAULTS, ...INBOUND_FAULTS]],
    ['kinds', [...INCIDENT_KINDS, ...INBOUND_KINDS]],
  ])('%s: every setting has an entry', (id, expected) => {
    expect(keys(id)).toEqual(expect.arrayContaining(expected));
  });

  it('expectations: every expectation type and its fields', () => {
    const inner = expectSchema.options.flatMap((o) =>
      Object.entries(o.shape).flatMap(([k, v]) => [
        k,
        ...Object.keys((v as z.ZodObject<z.ZodRawShape>).shape),
      ]),
    );
    expect(keys('expect')).toEqual(expect.arrayContaining(inner));
  });

  it('every entry has a summary; patterns list settings that exist; fault defaults come from the generator', () => {
    for (const s of REFERENCE) for (const e of s.entries) expect(e.summary, e.key).not.toBe('');
    const traffic = keys('traffic');
    for (const e of REFERENCE.find((s) => s.id === 'patterns')!.entries)
      for (const u of e.uses ?? []) expect(traffic, `${e.key} uses ${u}`).toContain(u);
    const types = REFERENCE.find((s) => s.id === 'fault-types')!.entries;
    for (const t of Object.keys(FAULT_DEFAULT_SIZE))
      expect(types.find((e) => e.key === t)?.default, t).toBeTruthy();
  });

  it('finds a section or a key', () => {
    expect(findReference('patterns').map((s) => s.id)).toEqual(['patterns']);
    expect(findReference('daily')[0]!.entries.map((e) => e.key)).toEqual(['daily']);
    expect(findReference('nothing-like-this')).toEqual([]);
  });

  it('docs/simulation-reference.md is up to date (pnpm sim:help --write)', () => {
    const doc = readFileSync(
      new URL('../../../docs/simulation-reference.md', import.meta.url),
      'utf8',
    );
    expect(doc === referenceMarkdown(), 'run pnpm sim:help --write').toBe(true);
  });
});
