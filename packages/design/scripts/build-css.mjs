// Writes dist/tokens.css (fonts + both themes) from tokens.json, after tsc built dist/index.js.
import { writeFileSync } from 'node:fs';
import { fontFaceCss, themeCss } from '../dist/index.js';

const css = `/* Generated from packages/design/tokens.json by scripts/build-css.mjs. Do not edit. */
${fontFaceCss('../fonts/')}
${themeCss('auto')}
`;
writeFileSync(new URL('../dist/tokens.css', import.meta.url), css);
console.log('design: dist/tokens.css written');
