# Design system

One source of truth for every Theirside UI: the dashboard, the public status page and, later, the landing page. Tokens live in [`packages/design/tokens.json`](../packages/design/tokens.json); everything else is generated from it or built from the shared components in [`apps/dashboard/src/components/ui.tsx`](../apps/dashboard/src/components/ui.tsx). The `#/design` gallery renders all of it in both themes.

## Principles

- **Tokens only.** No raw colours, font stacks, spacing or radii in UI source. A test (`packages/design/test/no-raw-colours.test.ts`) fails on hex, `rgb()` or `hsl()` colours in `apps/dashboard/src` and the status page.
- **Shared components only.** Pages compose `Card`, `Table`, `Badge`, `Button`, `Field`, `StatusDot`, `LegendCheckbox`, `Tabs`, `Segmented` and `Callout`; they don't restyle them. A new pattern becomes a component (and a gallery entry) before a second page uses it.
- **Semantic names.** Colours say what they are for (`danger`, `text-muted`), not what they look like, so the light and dark themes change values, never names.
- **Calm by default.** Most of the screen is neutral; colour marks state (healthy, warning, danger) and actions (accent). A failing endpoint should be the loudest thing on the page.
- **Accessible.** Text contrast ≥ 4.5:1, focus always visible, touch targets ≥ 44 px (see [Accessibility](#accessibility)).
- **Structure, not a redesign.** The current look is the baseline; a designer's patch is applied on top by changing tokens and components, not pages.

## How it fits together

| Piece | Where | What |
|---|---|---|
| Tokens | `packages/design/tokens.json` | The only place values are written |
| Generator | `packages/design/src/index.ts` (`themeCss`, `fontFaceCss`) | Turns tokens into CSS custom properties |
| Dashboard CSS | `@theirside/design/tokens.css` (built by `pnpm --filter @theirside/design build`), then `apps/dashboard/src/styles.css` | Custom properties + component styles |
| Status page | `apps/collector/src/modules/status-page/render.ts` | Calls `themeCss()` / `fontFaceCss()` at render time |
| Fonts | `packages/design/fonts/` | Self-hosted woff2 (OFL-1.1), served by the collector at `/fonts/` and bundled into the dashboard |
| Components | `apps/dashboard/src/components/ui.tsx`, `Chart.tsx` | The shared primitives |
| Gallery | `#/design` (`apps/dashboard/src/pages/DesignGallery.tsx`) | Every token and component, light and dark side by side |
| Tests | `packages/design/test/` | Contrast of every text/background pair, token shape, no raw colours |

### Themes

`themeCss('auto')` writes the light theme on `:root`, switches to dark under `prefers-color-scheme: dark`, and honours `data-theme="light"` or `data-theme="dark"` on any element (the dashboard's theme menu sets it on `<html>`; the gallery sets it on each panel). `themeCss('light' | 'dark')` pins one theme (the status page's `?theme=` and its configured theme). The dashboard keeps the choice per browser (`localStorage` `theirside.theme`); "Auto theme" follows the system.

The dark theme is seeded from the design review; its accent is the same deep blue as the light theme, so buttons and the brand panel match across themes, with a lighter `link` blue for text. The light theme derives from the status page's light theme, with the status colours darkened so they pass 4.5:1 as text.

## Tokens

All custom properties, with the rule for each. Values: `tokens.json` (and the gallery).

### Colour

| Token | Use for | Don't |
|---|---|---|
| `--color-background` | The page | Cards (use `surface`) |
| `--color-surface` | Cards, tables, header, inputs' surroundings, the status box | The page background |
| `--color-surface-alt` | Inset or hovered areas inside a surface: table row hover, code blocks, selected nav item | Large areas |
| `--color-border` | Hairlines: card and table borders, dividers, input borders | Text |
| `--color-grid` | Chart grid lines and ticks | Borders |
| `--color-text` | Body text, headings, values | |
| `--color-text-secondary` | Secondary emphasis: legend labels, supporting values | Body text |
| `--color-text-muted` | Labels, hints, timestamps, table headers, inactive tabs | Anything the user must read to act |
| `--color-accent` | Primary buttons, the selected tab or segment, focus ring, the sign-in brand panel (a fill: the same deep blue in both themes) | Text (use `link`), status |
| `--color-link` | Links and other blue text. Dark: a lighter tint of the accent so text reads on near-black; light: the accent | Fills |
| `--color-on-accent` | Text and icons on `accent` | |
| `--color-accent-subtle` | A quiet blue tint: hovered secondary buttons, selected rows, a highlighted card. `text`, `text-muted` and `link` read on it | Buttons' main fill (use `accent`), large page areas |
| `--color-danger` | Failing, errors, destructive actions, the incident threshold | Anything that isn't a problem |
| `--color-on-danger` | Text on a `danger` fill (the incident badge) | |
| `--color-warning` | Degraded, caveats (`Callout` default) | Errors |
| `--color-healthy` | Healthy, success, "normal" reference lines | Decoration |
| `--color-info` | Neutral notices and hints | Status |
| `--color-neutral` | No data, idle rings, empty bars | Text |
| `--color-qr-background` | Behind QR codes (always white so scanners read them) | Anything else |
| `--color-highlight` | Marketing only (the website): one warm block per page, such as the final call to action | Anything in the product UI, text, status |
| `--color-on-highlight` | Text and icons on `highlight` | |

### Chart series

`--chart-1` … `--chart-8` (blue, pink, purple, teal, amber, red, green, grey), per theme. Give each series a fixed colour by meaning (the Provider page maps outcomes and status groups to them: `http_5xx` and outage → `chart-6`, auth → `chart-3`, …); semantic colours are fine for reference lines (`--color-healthy` for "normal", `--color-danger` for the incident threshold, dashed). Canvas can't read custom properties: `Chart` resolves `var(--…)` at draw time and redraws on a theme change.

### Type

Fonts: `--font-ui` (Albert Sans) for everything, `--font-mono` (Roboto Mono) for code, endpoints, request IDs, incident summaries and numbers in legends.

| Step | Size / line height | Use |
|---|---|---|
| `xs` | 11 / 16 | Badges, small buttons, chart axes |
| `sm` | 12 / 16 | Table headers, captions, code, status page legend |
| `md` | 13 / 20 | Field labels, secondary UI |
| `base` | 14 / 20 | Body (default) |
| `lg` | 16 / 24 | Card titles (`h2`), KPI values |
| `xl` | 20 / 28 | Page titles (`h1`) |
| `2xl` | 24 / 32 | Reserved for the landing page and hero numbers |
| `display` | 48 / 52 | Brand statements: the sign-in panel and, later, the landing page hero |

Set both: `font-size: var(--text-md); line-height: var(--leading-md)`. Weights: `--weight-regular` 400, `medium` 500, `semibold` 600 (labels, provider names, table headers), `bold` 700 (page titles, brand).

### Spacing

A 4 px grid: `--space-1` 4, `--space-2` 8, `--space-3` 12, `--space-4` 16, `--space-5` 20, `--space-6` 24, `--space-8` 32, `--space-10` 40, `--space-12` 48; `--space-0_5` (2 px) only for hairline insets such as the gaps between status bars. Rules:

- **Cards**: 24 px padding on all sides (`--space-6`), 16 px between the card header and its content (`--space-4`); 16 px between stacked cards.
- **Forms**: 12 px between rows, 16 px between columns; label to control 4 px.
- **Status page**: 24 px from the title to the status box, 32 px from the status box to the first divider, 24 px above and below each provider divider.
- **Tables**: cells 8 × 12 px.

### Radii, shadows, sizes, focus

- Radii: `--radius-sm` 4 (badges, legend boxes), `md` 6 (buttons, inputs, tabs, callouts), `lg` 8 (code blocks), `xl` 10 (cards, tables, the status box), `2xl` 12 (sign-in card, gallery panels), `full` (dots).
- Shadows: `--shadow-sm|md|lg` per theme, for popovers and overlays only; cards use borders, not shadows.
- Sizes: `--size-control` 32 (inputs, buttons), `--size-touch` 44 (minimum on touch screens), `--size-dot` 10, `--size-status-bar` 28, `--size-page` 1200 and `--size-page-narrow` 760 (content widths).
- Focus: `--focus-width` 2 px, `--focus-offset` 2 px, `--focus-color` (= accent). Applied to `:focus-visible` everywhere.

## Components

All in `apps/dashboard/src/components/ui.tsx` unless noted.

| Component | Do | Don't |
|---|---|---|
| `Card` (`title`, `actions`) | One per section of a page; title as a short noun phrase, actions on the right | Nest cards; add padding inside |
| `Table` | Data with columns; `num` cells for numbers (right-aligned, tabular figures); `clickable` rows open details | Lay out forms with it |
| `Badge` (`tone`, `href`) | A short state next to a name: `danger` for an open incident (links to it), `healthy` for "New", neutral for "alerts off" | Sentences; more than two per row |
| `Button` (`variant`, `size`) | `primary` for the one main action of a form or card, default for the rest, `danger` for destructive ones (with a confirmation) | Two primary buttons side by side; links styled as buttons for navigation |
| `Field` (`label`, `hint`, `wide`, `check`) | Every form control, inside a `.form` grid: fields in one row share a bottom edge; `check` puts a checkbox before its label, centred on an input's height | Bare `<label>`s; hints longer than a line |
| `StatusDot` (`status`, `label`) | Health of a provider or endpoint; `label` shows the word next to the dot, otherwise it's for screen readers | Colour alone where the state matters (add the label or a badge) |
| `LegendCheckbox` (`Chart.tsx` uses it) | Chart legends: a box in the series colour, filled with a dark tick while shown, outlined while hidden; the whole row toggles; the hidden set survives data refreshes and theme changes | Hiding the last series without a way back |
| `Tabs` (`href` items, or `onChange` with `variant="sub"`) | Sections of a page (links) or panels of a table (buttons) | More than 8 tabs |
| `Segmented` | Switching a view's parameter, e.g. the time range | Navigation |
| `Callout` (`tone`, `title`) | A note in the flow: `warning` (default) for caveats, `danger` for problems, `info` for hints | Errors from a request (use `ErrorBox`) |
| `Chart` (`Chart.tsx`) | Time series with token colours (`var(--chart-N)`) | Raw colours |

Layout helpers in `styles.css`: `.page-h` (page title row), `.form` (two-column field grid, one column on phones), `.stack`, `.row`, `.muted`, `.num`.

## Accessibility

- **Contrast**: text tokens (`text`, `text-muted`, `text-secondary`, `link`, `danger`, `warning`, `healthy`, `info`) are ≥ 4.5:1 on `background`, `surface` and `surface-alt` in both themes, `on-accent`/`on-danger`/`on-highlight` on their fills, and `text`, `text-muted` and `link` on `accent-subtle`; the focus colour is ≥ 3:1. `packages/design/test/tokens.test.ts` checks every pair, so a token change that breaks contrast fails CI.
- **Focus visible**: `:focus-visible` draws the focus ring on every interactive element; never remove outlines.
- **Touch targets**: on coarse pointers (`@media (pointer: coarse)`) buttons, inputs, tabs, segments and legend entries are at least 44 px tall.
- **Not colour alone**: status dots carry a text label (visible or screen-reader); legend entries carry the series name; incident badges carry words.
- **Semantics**: `Tabs` use links with `aria-current` or `role="tab"` with `aria-selected`; `LegendCheckbox` is `role="checkbox"` with `aria-checked`; form controls are inside their `Field` label.

## Changing the system

**Add or change a token**

1. Edit `packages/design/tokens.json` (both themes for colours and shadows).
2. `pnpm --filter @theirside/design build` and `pnpm vitest run --project design`: the contrast test must pass. If a colour fails, adjust it; don't loosen the rule.
3. Use it through its custom property (`var(--color-…)`, `var(--space-…)`).
4. Update this page and check `#/design` in both themes, in the same commit.

**Add or change a component**: put it in `components/ui.tsx` (styles in `styles.css` under its class), add it to the gallery and the component table above, in the same commit.

**A designer's patch** lands as token and component changes on top of this structure; pages shouldn't need edits.

## The gallery

`#/design` renders every colour (with its contrast on the background), chart series, the type scale, spacing, radii, shadows, the focus ring and every component, light and dark side by side. It is open without sign-in when the collector runs with `THEIRSIDE_DESIGN_GALLERY=1`, which `docker/docker-compose.yml` sets for the local and demo stack; without it the page doesn't exist, not even for admins. The Playwright smoke saves screenshots of both panels.
