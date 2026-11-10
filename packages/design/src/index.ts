import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { contrast } from './contrast.js';

export { contrast, luminance } from './contrast.js';

/**
 * Theirside design tokens (`packages/design/tokens.json`, the only source) and the
 * CSS custom properties generated from them. The dashboard imports the generated
 * `dist/tokens.css` (built by `scripts/build-css.mjs`); the collector's status page
 * calls `themeCss()` / `fontFaceCss()` directly. docs/design-system.md documents
 * every token.
 */

export type ThemeName = 'dark' | 'light';
export type ColorName =
  | 'background'
  | 'surface'
  | 'surface-alt'
  | 'border'
  | 'grid'
  | 'text'
  | 'text-muted'
  | 'text-secondary'
  | 'accent'
  | 'danger'
  | 'warning'
  | 'healthy'
  | 'info'
  | 'neutral'
  | 'on-accent'
  | 'on-danger'
  | 'qr-background'
  | 'link'
  | 'accent-subtle'
  | 'highlight'
  | 'on-highlight';

export interface Tokens {
  color: Record<ThemeName, Record<ColorName, string>>;
  chart: Record<ThemeName, string[]>;
  font: { ui: string; mono: string };
  type: Record<string, { size: number; line: number }>;
  weight: Record<string, number>;
  space: Record<string, number>;
  radius: Record<string, number>;
  shadow: Record<ThemeName, Record<string, string>>;
  focus: { width: number; offset: number; color: ColorName };
  size: Record<string, number>;
  contrast: {
    min: number;
    minNonText: number;
    text: ColorName[];
    backgrounds: ColorName[];
    pairs: [ColorName, ColorName][];
  };
}

export const tokens: Tokens = JSON.parse(
  readFileSync(new URL('../tokens.json', import.meta.url), 'utf8'),
) as Tokens;

export const THEMES: readonly ThemeName[] = ['dark', 'light'];

/** The self-hosted font files (OFL-1.1, from Fontsource), served by the collector at /fonts/. */
export const FONTS_DIR = fileURLToPath(new URL('../fonts/', import.meta.url));

const LATIN =
  'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';
const LATIN_EXT =
  'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF';

export const FONT_FILES = [
  { family: 'Albert Sans', file: 'albert-sans-latin-ext-wght-normal.woff2', range: LATIN_EXT },
  { family: 'Albert Sans', file: 'albert-sans-latin-wght-normal.woff2', range: LATIN },
  { family: 'Roboto Mono', file: 'roboto-mono-latin-ext-wght-normal.woff2', range: LATIN_EXT },
  { family: 'Roboto Mono', file: 'roboto-mono-latin-wght-normal.woff2', range: LATIN },
] as const;

/** `@font-face` rules for the self-hosted fonts; `base` is the URL the files are served under. */
export function fontFaceCss(base: string): string {
  const dir = base.endsWith('/') ? base : `${base}/`;
  return FONT_FILES.map(
    (f) =>
      `@font-face{font-family:'${f.family}';font-style:normal;font-display:swap;font-weight:100 900;src:url(${dir}${f.file}) format('woff2');unicode-range:${f.range}}`,
  ).join('\n');
}

/** `0.5` → `0_5`: custom property names can't contain dots. */
const key = (k: string) => k.replace('.', '_');

/** Theme-independent properties: fonts, type scale, weights, spacing, radii, focus, sizes. */
function baseVars(t: Tokens): string {
  const v: string[] = [`--font-ui:${t.font.ui}`, `--font-mono:${t.font.mono}`];
  for (const [k, s] of Object.entries(t.type))
    v.push(`--text-${k}:${s.size}px`, `--leading-${k}:${s.line}px`);
  for (const [k, w] of Object.entries(t.weight)) v.push(`--weight-${k}:${w}`);
  for (const [k, px] of Object.entries(t.space)) v.push(`--space-${key(k)}:${px}px`);
  for (const [k, px] of Object.entries(t.radius)) v.push(`--radius-${k}:${px}px`);
  for (const [k, px] of Object.entries(t.size)) v.push(`--size-${k}:${px}px`);
  v.push(
    `--focus-width:${t.focus.width}px`,
    `--focus-offset:${t.focus.offset}px`,
    `--focus-color:var(--color-${t.focus.color})`,
  );
  return v.join(';');
}

/** One theme's colours, chart series and shadows. */
export function themeVars(theme: ThemeName, t: Tokens = tokens): string {
  const v: string[] = [`color-scheme:${theme}`];
  for (const [k, c] of Object.entries(t.color[theme])) v.push(`--color-${k}:${c}`);
  t.chart[theme].forEach((c, i) => v.push(`--chart-${i + 1}:${c}`));
  for (const [k, s] of Object.entries(t.shadow[theme])) v.push(`--shadow-${k}:${s}`);
  return v.join(';');
}

/**
 * The custom properties for a page. `auto` follows prefers-color-scheme and lets
 * `data-theme="light|dark"` on any element (the explicit toggle on `<html>`, or a
 * gallery panel) override it for that subtree; `light`/`dark` pin one theme.
 */
export function themeCss(mode: 'auto' | ThemeName = 'auto', t: Tokens = tokens): string {
  const base = `:root{${baseVars(t)}}`;
  if (mode !== 'auto') return `${base}\n:root{${themeVars(mode, t)}}`;
  return [
    base,
    `:root,[data-theme="light"]{${themeVars('light', t)}}`,
    `@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){${themeVars('dark', t)}}}`,
    `[data-theme="dark"]{${themeVars('dark', t)}}`,
  ].join('\n');
}

/** Every text/background pair the contrast rules cover, with its ratio. */
export function contrastPairs(
  t: Tokens = tokens,
): { theme: ThemeName; fg: ColorName; bg: ColorName; ratio: number; min: number }[] {
  const out = [];
  for (const theme of THEMES) {
    const c = t.color[theme];
    for (const fg of t.contrast.text)
      for (const bg of t.contrast.backgrounds)
        out.push({ theme, fg, bg, ratio: contrast(c[fg], c[bg]), min: t.contrast.min });
    for (const [fg, bg] of t.contrast.pairs)
      out.push({ theme, fg, bg, ratio: contrast(c[fg], c[bg]), min: t.contrast.min });
    for (const bg of t.contrast.backgrounds)
      out.push({
        theme,
        fg: t.focus.color,
        bg,
        ratio: contrast(c[t.focus.color], c[bg]),
        min: t.contrast.minNonText,
      });
  }
  return out;
}
