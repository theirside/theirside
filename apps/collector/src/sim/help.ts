/**
 * `pnpm sim:help [topic]`: the scenario reference in the terminal (a section such as
 * `patterns` or `faults`, or a key such as `daily`, `rate` or `latency`).
 * `--markdown` prints docs/simulation-reference.md; `--write` regenerates it.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { REFERENCE, findReference, referenceMarkdown, referenceText } from './reference.js';

export const REFERENCE_DOC = fileURLToPath(
  new URL('../../../../docs/simulation-reference.md', import.meta.url),
);

const args = process.argv.slice(2).filter((a) => a !== '--');
if (args.includes('--write')) {
  writeFileSync(REFERENCE_DOC, referenceMarkdown());
  console.log(`wrote ${REFERENCE_DOC}`);
} else if (args.includes('--markdown')) {
  process.stdout.write(referenceMarkdown());
} else {
  const topic = args.find((a) => !a.startsWith('--'));
  const found = topic ? findReference(topic) : REFERENCE;
  if (!found.length) {
    console.error(
      `Nothing called "${topic}". Topics: ${REFERENCE.map((s) => s.id).join(', ')}, or a key such as daily, rate, latency.`,
    );
    process.exit(1);
  }
  console.log(referenceText(found));
  if (!topic)
    console.log(
      `One topic: pnpm sim:help <${REFERENCE.map((s) => s.id).join('|')}> or a key (daily, rate, …). Also: docs/simulation-reference.md`,
    );
}
