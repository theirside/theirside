// The package's conditional exports: fetch runtimes get the fetch-only entry,
// Node keeps the Node entry. `node test-runtime/conditions.mjs` (after build).
import { execFileSync } from 'node:child_process';

const resolve = (conditions) =>
  execFileSync(
    process.execPath,
    [
      ...conditions.map((c) => `--conditions=${c}`),
      '--input-type=module',
      '-e',
      "console.log(import.meta.resolve('@theirside/sdk'))",
    ],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8' },
  ).trim();

let failed = false;
for (const [conditions, want] of [
  [['workerd', 'worker', 'browser'], '/dist/edge.js'], // wrangler
  [['deno'], '/dist/edge.js'],
  [['bun'], '/dist/edge.js'],
  [['edge-light'], '/dist/edge.js'], // Vercel Edge
  [[], '/dist/index.js'], // Node ESM
]) {
  const got = resolve(conditions);
  const ok = got.endsWith(want);
  failed ||= !ok;
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} [${conditions.join(', ') || 'node'}] → ${got.slice(got.indexOf('/dist/'))}`,
  );
}
const edge = execFileSync(
  process.execPath,
  [
    '-e',
    "console.log(require('node:fs').readFileSync(require('node:path').join(process.cwd(), 'dist/edge.js'), 'utf8'))",
  ],
  { cwd: new URL('..', import.meta.url), encoding: 'utf8' },
);
if (/from\s*["']node:|require\(["']node:/.test(edge)) {
  console.log('FAIL dist/edge.js imports a Node built-in');
  failed = true;
} else console.log('ok   dist/edge.js imports no Node built-in');
process.exit(failed ? 1 : 0);
