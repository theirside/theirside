// Stage 1: pull every API's preferred spec from the APIs.guru OpenAPI
// directory (https://github.com/APIs-guru/openapi-directory, CC0) and keep only
// the literal path segments, per API, in .cache/segments.json (git-ignored).
// Specs are never stored. Re-running skips APIs already cached.
//   node src/fetch.mjs [--concurrency 16]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(here, '..', '.cache');
const OUT = path.join(CACHE, 'segments.json');
const i = process.argv.indexOf('--concurrency');
const CONCURRENCY = i > 0 ? Number(process.argv[i + 1]) : 16;

mkdirSync(CACHE, { recursive: true });
const cache = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {};

const list = await (await fetch('https://api.apis.guru/v2/list.json')).json();
const todo = Object.entries(list).filter(([key]) => !(key in cache));
console.log(`${Object.keys(list).length} APIs, ${todo.length} to fetch`);

/** Literal segments of every path template (`{param}` and empty segments dropped). */
function segmentsOf(spec) {
  const out = new Set();
  for (const p of Object.keys(spec.paths ?? {}))
    for (const seg of p.split(/[/?#]/))
      if (seg && !seg.includes('{') && !seg.includes(':')) out.add(seg);
  return [...out];
}

let done = 0;
let failed = 0;
async function worker() {
  for (;;) {
    const next = todo.shift();
    if (!next) return;
    const [key, api] = next;
    const url = api.versions[api.preferred]?.swaggerUrl;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      cache[key] = segmentsOf(await res.json());
    } catch (e) {
      failed++;
      console.error(`skip ${key}: ${e.message}`);
    }
    if (++done % 100 === 0) {
      writeFileSync(OUT, JSON.stringify(cache));
      console.log(`${done}/${todo.length + done} fetched (${failed} failed)`);
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
writeFileSync(OUT, JSON.stringify(cache));
console.log(`done: ${Object.keys(cache).length} APIs cached, ${failed} failed`);
