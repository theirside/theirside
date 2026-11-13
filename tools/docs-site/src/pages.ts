import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

/** The repository root and the folder theirside.dev renders (docs/site). */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const SITE = path.join(ROOT, 'docs/site');

/** A fenced code block: its language, its text and the line its first code line is on. */
export interface Block {
  lang: string;
  code: string;
  line: number;
  /** Preceded by `<!-- docs-check: skip (why) -->`: not checked. */
  skip: boolean;
}

export interface Page {
  file: string;
  front: Record<string, unknown>;
  frontError?: string;
  blocks: Block[];
}

const SKIP = '<!-- docs-check: skip';

export function parsePage(file: string, text: string): Page {
  const lines = text.split('\n');
  const page: Page = { file, front: {}, blocks: [] };
  let i = 0;
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1);
    if (end < 0) page.frontError = 'front matter is not closed with ---';
    else {
      try {
        page.front = (YAML.parse(lines.slice(1, end).join('\n')) ?? {}) as Record<string, unknown>;
      } catch (err) {
        page.frontError = `front matter: ${(err as Error).message}`;
      }
      i = end + 1;
    }
  } else page.frontError = 'no front matter (title, description, order)';
  for (; i < lines.length; i++) {
    const open = /^(\s*)```([\w-]*)/.exec(lines[i]!);
    if (!open) continue;
    const indent = open[1]!.length;
    const start = i + 1;
    let j = start;
    while (j < lines.length && !/^\s*```\s*$/.test(lines[j]!)) j++;
    let k = i - 1;
    while (k >= 0 && lines[k]!.trim() === '') k--;
    page.blocks.push({
      lang: open[2]!.toLowerCase(),
      code: lines
        .slice(start, j)
        .map((l) => l.slice(Math.min(indent, l.length - l.trimStart().length)))
        .join('\n'),
      line: start + 1,
      skip: k >= 0 && lines[k]!.trim().startsWith(SKIP),
    });
    i = j;
  }
  return page;
}

export function readPages(): Page[] {
  return readdirSync(SITE)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => parsePage(f, readFileSync(path.join(SITE, f), 'utf8')));
}
