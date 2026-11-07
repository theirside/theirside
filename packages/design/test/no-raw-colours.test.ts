import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * UI source uses tokens only (docs/design-system.md): no raw hex, rgb() or hsl()
 * colours outside packages/design/tokens.json.
 */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const UI_SOURCES = ['apps/dashboard/src', 'apps/collector/src/modules/status-page'];
const RAW = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/g;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return files(p);
    return /\.(tsx?|css|html)$/.test(n) ? [p] : [];
  });
}

describe('no raw colours in UI source', () => {
  it.each(UI_SOURCES)('%s', (dir) => {
    const hits: string[] = [];
    for (const f of files(join(ROOT, dir))) {
      readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          // `#/settings` routes and `&#39;` entities are not colours
          const code = line.replace(/['"`]#\/[^'"`]*['"`]/g, '').replace(/&#\d+;/g, '');
          for (const m of code.matchAll(RAW))
            hits.push(`${relative(ROOT, f)}:${i + 1}: ${m[0]} (use a token)`);
        });
    }
    expect(hits).toEqual([]);
  });

  it('catches what it should', () => {
    expect('color: #fff; background: rgb(0 0 0)'.match(RAW)).toHaveLength(2);
    expect("href('#/design')".replace(/['"`]#\/[^'"`]*['"`]/g, '').match(RAW)).toBeNull();
  });
});
