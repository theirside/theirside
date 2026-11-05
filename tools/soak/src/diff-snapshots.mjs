// Compares two V8 heap snapshots by constructor/type name: count and self size.
//   node src/diff-snapshots.mjs early.heapsnapshot late.heapsnapshot [--top 25]
import { readFileSync } from 'node:fs';

const [a, b] = process.argv.slice(2).filter((x) => !x.startsWith('--'));
const ti = process.argv.indexOf('--top');
const TOP = ti > 0 ? Number(process.argv[ti + 1]) : 25;
if (!a || !b) {
  console.error('usage: diff-snapshots.mjs <early.heapsnapshot> <late.heapsnapshot> [--top N]');
  process.exit(1);
}

function summarize(file) {
  const snap = JSON.parse(readFileSync(file, 'utf8'));
  const meta = snap.snapshot.meta;
  const fields = meta.node_fields;
  const types = meta.node_types[0];
  const stride = fields.length;
  const iType = fields.indexOf('type');
  const iName = fields.indexOf('name');
  const iSize = fields.indexOf('self_size');
  const groups = new Map();
  const nodes = snap.nodes;
  for (let i = 0; i < nodes.length; i += stride) {
    const type = types[nodes[i + iType]];
    const name =
      type === 'object' || type === 'closure' ? snap.strings[nodes[i + iName]] : `(${type})`;
    const key = type === 'closure' ? `closure ${name}` : name;
    const g = groups.get(key) ?? { count: 0, size: 0 };
    g.count++;
    g.size += nodes[i + iSize];
    groups.set(key, g);
  }
  return groups;
}

const ga = summarize(a);
const gb = summarize(b);
const keys = new Set([...ga.keys(), ...gb.keys()]);
const rows = [...keys].map((k) => {
  const x = ga.get(k) ?? { count: 0, size: 0 };
  const y = gb.get(k) ?? { count: 0, size: 0 };
  return { k, dCount: y.count - x.count, dSize: y.size - x.size, count: y.count, size: y.size };
});
const total = (g) => [...g.values()].reduce((s, v) => s + v.size, 0);
console.log(
  `total self size: ${(total(ga) / 1048576).toFixed(2)} MB -> ${(total(gb) / 1048576).toFixed(2)} MB`,
);
console.log('\nlargest growth by self size:');
console.log('  Δsize KB   Δcount   count    name');
for (const r of rows.sort((p, q) => q.dSize - p.dSize).slice(0, TOP)) {
  console.log(
    `  ${(r.dSize / 1024).toFixed(1).padStart(8)} ${String(r.dCount).padStart(8)} ${String(r.count).padStart(8)}    ${r.k.slice(0, 90)}`,
  );
}
