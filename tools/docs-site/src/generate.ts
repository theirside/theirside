/**
 * The generated parts of docs/site/configuration.md, so they can't drift from the code:
 * every `init()` option from the JSDoc of `InitOptions` (packages/sdk/src/config.ts), and
 * every collector environment variable from `COLLECTOR_ENV` (apps/collector/src/config-env.ts).
 *
 *   pnpm docs:generate           rewrite the generated sections
 *   (src/check.ts runs it in check mode and fails when the file is out of date)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { COLLECTOR_ENV } from '../../../apps/collector/src/config-env.ts';
import { ROOT, SITE } from './pages.ts';

const cell = (s: string) =>
  s
    .replace(/\|/g, '\\|')
    .replace(/\s*\n\s*/g, ' ')
    .trim();

/** Type aliases shown as what they allow. */
const NAMED_TYPES: Record<string, string> = { PathPrivacy: "'strict' | 'balanced'" };

/** Every `InitOptions` member except deprecated ones, with its type, default and description. */
export function initOptions(): { name: string; type: string; dflt: string; text: string }[] {
  const file = path.join(ROOT, 'packages/sdk/src/config.ts');
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  let decl: ts.InterfaceDeclaration | undefined;
  sf.forEachChild((n) => {
    if (ts.isInterfaceDeclaration(n) && n.name.text === 'InitOptions') decl = n;
  });
  if (!decl) throw new Error('InitOptions not found in packages/sdk/src/config.ts');
  const out = [];
  for (const m of decl.members) {
    if (!ts.isPropertySignature(m) || !m.type) continue;
    const name = m.name.getText(sf);
    const tags = ts.getJSDocTags(m);
    if (tags.some((t) => t.tagName.text === 'deprecated')) continue;
    const doc = (m as unknown as { jsDoc?: ts.JSDoc[] }).jsDoc?.[0];
    const text = ts.getTextOfJSDocComment(doc?.comment) ?? '';
    const dflt = ts.getTextOfJSDocComment(tags.find((t) => t.tagName.text === 'default')?.comment);
    if (!text || !dflt)
      throw new Error(`InitOptions.${name}: needs a description and a @default in its JSDoc`);
    // `?: string | undefined` reads as `string`; a function's return type keeps its undefined
    const raw = m.type.getText(sf);
    const type =
      NAMED_TYPES[raw] ??
      (ts.isFunctionTypeNode(m.type) ? raw : raw.replace(/\s*\|\s*undefined$/, ''));
    out.push({ name, type, dflt, text });
  }
  return out;
}

function initTable(): string {
  return [
    '| Option | Type | Default | What it does |',
    '|---|---|---|---|',
    ...initOptions().map(
      (o) => `| \`${o.name}\` | \`${cell(o.type)}\` | ${cell(o.dflt)} | ${cell(o.text)} |`,
    ),
  ].join('\n');
}

function envTables(): string {
  const shown = COLLECTOR_ENV.filter((v) => !v.internal);
  const groups = [...new Set(shown.map((v) => v.group))];
  return groups
    .map((g) =>
      [
        `### ${g}`,
        '',
        '| Variable | Default | What it does |',
        '|---|---|---|',
        ...shown
          .filter((v) => v.group === g)
          .map((v) => `| \`${v.name}\` | ${cell(v.default)} | ${cell(v.description)} |`),
      ].join('\n'),
    )
    .join('\n\n');
}

const SECTIONS: Record<string, () => string> = {
  'init-options': initTable,
  'collector-env': envTables,
};

export const CONFIG_PAGE = path.join(SITE, 'configuration.md');

/** The page with every generated section filled in from the source. */
export function render(text: string): string {
  let out = text;
  for (const [id, fn] of Object.entries(SECTIONS)) {
    const re = new RegExp(
      `(<!-- generated:${id} start[^>]*-->)[\\s\\S]*?(<!-- generated:${id} end -->)`,
    );
    if (!re.test(out)) throw new Error(`configuration.md: no generated:${id} markers`);
    out = out.replace(re, (_m, a: string, b: string) => `${a}\n\n${fn()}\n\n${b}`);
  }
  return out;
}

/** The current file and what it should be. */
export function configPage(): { current: string; expected: string } {
  const current = readFileSync(CONFIG_PAGE, 'utf8');
  return { current, expected: render(current) };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { current, expected } = configPage();
  if (current === expected) console.log('docs/site/configuration.md is up to date');
  else {
    writeFileSync(CONFIG_PAGE, expected);
    console.log('docs/site/configuration.md: generated sections rewritten');
  }
}
