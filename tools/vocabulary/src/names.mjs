// Builds names.txt: common first and last names from many countries, used to
// keep personal names out of the vocabulary (build.mjs) and by the names test.
// Source: github.com/sigpwned/popular-names-by-country-dataset (CC0 1.0),
// romanized forms, lower-cased, diacritics stripped, split into single words.
//   node src/names.mjs
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'https://raw.githubusercontent.com/sigpwned/popular-names-by-country-dataset/main/';

/** Minimal CSV parser (quoted fields with commas). */
function parseCsv(text) {
  const [head, ...rows] = text
    .replace(/^\uFEFF/, '')
    .trim()
    .split(/\r?\n/);
  const cols = head.split(',');
  return rows.map((line) => {
    const cells = [];
    let cur = '';
    let quoted = false;
    for (const ch of line) {
      if (ch === '"') quoted = !quoted;
      else if (ch === ',' && !quoted) {
        cells.push(cur);
        cur = '';
      } else cur += ch;
    }
    cells.push(cur);
    return Object.fromEntries(cols.map((c, i) => [c, cells[i] ?? '']));
  });
}

const words = new Set();
for (const file of ['common-forenames-by-country.csv', 'common-surnames-by-country.csv']) {
  const rows = parseCsv(await (await fetch(BASE + file)).text());
  for (const r of rows)
    for (const name of [r['Romanized Name'], r['Localized Name']])
      for (const w of (name ?? '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .split(/[^a-z]+/))
        if (w.length >= 2) words.add(w);
}
const sorted = [...words].sort();
writeFileSync(
  path.join(here, '..', 'names.txt'),
  `# Common first and last names, many countries (${sorted.length} words).\n# From github.com/sigpwned/popular-names-by-country-dataset (CC0 1.0); rebuilt by src/names.mjs.\n${sorted.join('\n')}\n`,
);
console.log(`names.txt: ${sorted.length} words`);
