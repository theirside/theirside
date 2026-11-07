# Fonts

Self-hosted so the dashboard and the public status page make no third-party requests.

| File | Font | Source | Licence |
|---|---|---|---|
| `albert-sans-latin*-wght-normal.woff2` | Albert Sans (variable weight) | `@fontsource-variable/albert-sans` 5.3.0 | SIL OFL 1.1, `OFL-albert-sans.txt` |
| `roboto-mono-latin*-wght-normal.woff2` | Roboto Mono (variable weight) | `@fontsource-variable/roboto-mono` 5.3.0 | SIL OFL 1.1, `OFL-roboto-mono.txt` |

Latin and Latin Extended subsets only; other scripts fall back to system fonts. `@font-face` rules: `fontFaceCss()` in `../src/index.ts`. The collector serves these at `/fonts/`.
