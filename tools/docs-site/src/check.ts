/**
 * CI check for docs/site (the pages theirside.dev publishes):
 * - each page has front matter with `title`, `description` and a unique numeric `order`;
 * - every TypeScript/JavaScript block type-checks against the SDK's published types:
 *   `@theirside/sdk` resolves through the package's own `exports` map, which is the
 *   published one (CI builds the SDK first), so ESM samples get `dist/index.d.ts` and
 *   CommonJS ones (`require(…)`) `dist/index.d.cts`, as for anyone who installs it;
 * - JSON blocks parse, YAML blocks parse (several documents allowed);
 * - the generated tables in configuration.md match the source (src/generate.ts);
 * - links between pages and their `#anchors` resolve (anchors as theirside.dev makes them);
 * - every collector minor tag (`ghcr.io/theirside/collector:0.6`) is the one the self-host
 *   compose file pulls, so a new minor can't leave the docs on the old one.
 * A block preceded by `<!-- docs-check: skip (why) -->` is not checked. A first line like
 * `// instrumentation.ts` names the block's file, so a later block on the same page can
 * import it (`import './instrumentation.js'`).
 *
 *   pnpm docs:check     (after `pnpm build`)
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import YAML from 'yaml';
import { configPage } from './generate.ts';
import { readFileSync } from 'node:fs';
import { ROOT, anchors, readPages, type Block } from './pages.ts';

const errors: string[] = [];
const fail = (where: string, msg: string) => errors.push(`${where}: ${msg}`);

const sdkTypes = path.join(ROOT, 'packages/sdk/dist/index.d.ts');
if (!existsSync(sdkTypes)) {
  console.error(
    'docs check: the SDK is not built (pnpm build, or pnpm --filter @theirside/sdk build)',
  );
  process.exit(1);
}

const pages = readPages();
if (pages.length === 0) fail('docs/site', 'no pages');

// front matter
const orders = new Map<number, string>();
for (const p of pages) {
  const where = `docs/site/${p.file}`;
  if (p.frontError) {
    fail(where, p.frontError);
    continue;
  }
  for (const key of ['title', 'description'])
    if (typeof p.front[key] !== 'string' || !(p.front[key] as string).trim())
      fail(where, `front matter needs a ${key}`);
  const order = p.front.order;
  if (typeof order !== 'number') fail(where, 'front matter needs a numeric order');
  else if (orders.has(order)) fail(where, `order ${order} is also used by ${orders.get(order)}`);
  else orders.set(order, p.file);
}

// code blocks
const OUT = path.join(ROOT, 'tools/docs-site/.blocks');
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
// .ts samples are ES modules, as in a project with "type": "module"
writeFileSync(path.join(OUT, 'package.json'), '{ "type": "module" }\n');
const origin = new Map<string, { page: string; block: Block }>();
let checked = 0;
for (const p of pages) {
  p.blocks.forEach((b, n) => {
    const where = `docs/site/${p.file}:${b.line}`;
    if (b.skip) return;
    if (b.lang === 'json') {
      checked++;
      try {
        JSON.parse(b.code);
      } catch (err) {
        fail(where, `JSON: ${(err as Error).message}`);
      }
      return;
    }
    if (b.lang === 'yaml' || b.lang === 'yml') {
      checked++;
      for (const doc of YAML.parseAllDocuments(b.code))
        for (const e of doc.errors) fail(where, `YAML: ${e.message}`);
      return;
    }
    const ts_ = b.lang === 'ts' || b.lang === 'typescript';
    const js = b.lang === 'js' || b.lang === 'javascript';
    if (!ts_ && !js) return;
    checked++;
    // `// src/instrumentation.ts` on the first line names the file
    const hint = /^\/\/\s*(?:[\w.-]+\/)*([\w.-]+?)\.(?:m|c)?[jt]s\b/.exec(b.code)?.[1];
    const ext = ts_ ? '.ts' : /\brequire\(/.test(b.code) ? '.cjs' : '.mjs';
    const dir = path.join(OUT, p.file.replace(/\.md$/, ''));
    mkdirSync(dir, { recursive: true });
    let file = path.join(dir, `${hint ?? `block-${n + 1}`}${ext}`);
    for (let k = 2; existsSync(file); k++) file = path.join(dir, `${hint ?? 'block'}-${k}${ext}`);
    writeFileSync(file, b.code + '\n');
    origin.set(path.resolve(file), { page: p.file, block: b });
  });
}

const program = ts.createProgram({
  rootNames: [...origin.keys(), path.join(ROOT, 'tools/docs-site/src/samples.d.ts')],
  options: {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    allowJs: true,
    checkJs: true,
    // NestJS decorators are the legacy kind
    experimentalDecorators: true,
    emitDecoratorMetadata: true,
    types: ['node'],
    typeRoots: [path.join(ROOT, 'tools/docs-site/node_modules/@types')],
  },
});
for (const d of ts.getPreEmitDiagnostics(program)) {
  const msg = ts.flattenDiagnosticMessageText(d.messageText, '\n');
  const src = d.file ? origin.get(path.resolve(d.file.fileName)) : undefined;
  if (d.file && src && d.start !== undefined) {
    const { line } = d.file.getLineAndCharacterOfPosition(d.start);
    fail(`docs/site/${src.page}:${src.block.line + line}`, msg);
  } else fail(d.file ? path.relative(ROOT, d.file.fileName) : 'typescript', msg);
}

// links between pages, and their anchors
const byFile = new Map(pages.map((p) => [p.file, p]));
const anchorsOf = new Map(pages.map((p) => [p.file, anchors(p)]));
for (const p of pages) {
  const lines = p.text.split('\n');
  let fenced = false;
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (fenced) return;
    for (const m of line.matchAll(/\]\(([^)\s]+)\)/g)) {
      const href = m[1]!;
      if (/^[a-z]+:/i.test(href)) continue; // https:, mailto:
      const [file, anchor] = href.split('#') as [string, string | undefined];
      const target = file === '' ? p.file : file;
      const where = `docs/site/${p.file}:${i + 1}`;
      if (!byFile.has(target)) {
        fail(where, `link to ${href}: no page ${target} in docs/site`);
        continue;
      }
      if (anchor && !anchorsOf.get(target)!.has(anchor))
        fail(where, `link to ${href}: ${target} has no heading with the anchor #${anchor}`);
    }
  });
}

// collector image tags follow the self-host compose file's minor line
const compose = readFileSync(path.join(ROOT, 'docker/compose.selfhost.yml'), 'utf8');
const minor = /image:\s*ghcr\.io\/theirside\/collector:(\d+\.\d+)\s/.exec(compose)?.[1];
if (!minor)
  fail('docker/compose.selfhost.yml', 'no ghcr.io/theirside/collector:<major>.<minor> image');
for (const p of pages)
  p.text.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/ghcr\.io\/theirside\/collector:(\d+\.\d+)(?![\d.])/g))
      if (minor && m[1] !== minor)
        fail(
          `docs/site/${p.file}:${i + 1}`,
          `collector:${m[1]}, but the compose file pulls :${minor}`,
        );
  });

// generated tables
const { current, expected } = configPage();
if (current !== expected)
  fail('docs/site/configuration.md', 'generated tables are out of date: run pnpm docs:generate');

if (errors.length > 0) {
  console.error(errors.join('\n'));
  console.error(`\ndocs check: ${errors.length} problem${errors.length === 1 ? '' : 's'}`);
  process.exit(1);
}
console.log(`docs check: ${pages.length} pages, ${checked} code blocks OK`);
