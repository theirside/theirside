import { describe, expect, it } from 'vitest';
import { contrastPairs, contrast, themeCss, fontFaceCss, tokens, THEMES } from '../src/index.js';

describe('contrast: every text/background token pair, both themes', () => {
  const pairs = contrastPairs();
  it.each(pairs.map((p) => [`${p.theme}: ${p.fg} on ${p.bg}`, p] as const))('%s', (_n, p) => {
    expect(p.ratio, `${p.ratio.toFixed(2)}:1, needs ${p.min}:1`).toBeGreaterThanOrEqual(p.min);
  });

  it('covers each theme × text colour × background', () => {
    const t = tokens.contrast;
    expect(pairs).toHaveLength(
      THEMES.length *
        (t.text.length * t.backgrounds.length + t.pairs.length + t.backgrounds.length),
    );
  });

  it('computes WCAG ratios', () => {
    expect(contrast('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrast('#777777', '#FFFFFF')).toBeCloseTo(4.48, 2);
  });
});

describe('tokens.json', () => {
  it('both themes define the same colours, as #RRGGBB', () => {
    expect(Object.keys(tokens.color.light).sort()).toEqual(Object.keys(tokens.color.dark).sort());
    for (const theme of THEMES)
      for (const c of [...Object.values(tokens.color[theme]), ...tokens.chart[theme]])
        expect(c).toMatch(/^#[0-9A-F]{6}$/);
    expect(tokens.chart.light).toHaveLength(tokens.chart.dark.length);
  });

  it('spacing is on the 4px grid (2px only as the half step)', () => {
    for (const [k, px] of Object.entries(tokens.space))
      expect(k === '0.5' || px % 4 === 0, `space ${k}`).toBe(true);
  });

  it('seeds the dark theme from the design review', () => {
    expect(tokens.color.dark).toMatchObject({
      background: '#09090B',
      surface: '#151519',
      'surface-alt': '#111114',
      border: '#26272D',
      text: '#F1F2F4',
      'text-muted': '#9A9DA6',
      'text-secondary': '#C7C9CF',
      // one deep blue accent in both themes; a lighter tint for blue text on near-black
      accent: '#2563EB',
      link: '#6B9EFF',
      danger: '#FF6B6B',
      healthy: '#3DD68C',
      warning: '#F2B35A',
    });
    expect(tokens.chart.dark).toEqual(expect.arrayContaining(['#FF7AB6', '#B58CFF', '#4FD1C5']));
  });
});

describe('generated CSS', () => {
  it('auto: light by default, dark by preference unless pinned, explicit overrides', () => {
    const css = themeCss('auto');
    expect(css).toContain('--color-background:#FFFFFF');
    expect(css).toContain(
      '@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){color-scheme:dark;--color-background:#09090B',
    );
    expect(css).toContain('[data-theme="dark"]{color-scheme:dark;');
    expect(css).toContain('--space-0_5:2px');
    expect(css).toContain('--chart-3:#B58CFF');
    expect(css).toContain('--focus-color:var(--color-accent)');
  });

  it('a pinned theme has only that theme', () => {
    expect(themeCss('dark')).not.toContain('#FFFFFF;--color-surface');
    expect(themeCss('light')).not.toContain('#09090B');
  });

  it('font faces point at the served files', () => {
    const css = fontFaceCss('../fonts');
    expect(css.match(/@font-face/g)).toHaveLength(4);
    expect(css).toContain("url(../fonts/albert-sans-latin-wght-normal.woff2) format('woff2')");
  });
});
