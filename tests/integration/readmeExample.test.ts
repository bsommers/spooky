// Keeps the README's "add a filter in under 20 lines" example honest: the snippet below is copied verbatim into
// README.md, and this test runs it through a real Engine.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { KNOWN_FILTER_NAMES } from '../../config/filters.js';
import { Engine, defaultFactories, loadConfig, MockLlmClient } from '../../src/index.js';
import type { Filter } from '../../src/index.js';
import { corpus } from '../helpers/rig.js';

// ---- README snippet start ----
const noEmoji: Filter = {
  name: 'noEmoji',
  stages: ['post'],
  onError: 'skip', // a failure is recorded in the trace and the text passes on unchanged
  async process(text) {
    const content = text.replace(/\p{Extended_Pictographic}/gu, '');
    return { content, modified: content !== text, metadata: { removed: text.length - content.length } };
  },
};
// 1. config/filters.ts: add 'noEmoji' to KNOWN_FILTER_NAMES.
// 2. Config filters.pipeline: insert { name: 'noEmoji', stage: 'post' } between the 'style' entry and the final 'confidentiality' entry.
// 3. Engine: new Engine({ config, factories: { ...defaultFactories(), noEmoji: () => noEmoji } })
// ---- README snippet end ----

describe('README example: a custom filter', () => {
  const added = !KNOWN_FILTER_NAMES.includes('noEmoji');
  afterEach(() => {
    const i = (KNOWN_FILTER_NAMES as string[]).indexOf('noEmoji');
    if (i >= 0) (KNOWN_FILTER_NAMES as string[]).splice(i, 1);
  });

  it('runs in the post stage, before the final confidentiality pass, and shows up in the trace', async () => {
    if (added) (KNOWN_FILTER_NAMES as string[]).push('noEmoji'); // step 1, done in the source tree for real users
    const config = loadConfig({
      llm: { model: 'mock' },
      filters: {
        pipeline: [
          { name: 'confidentiality', stage: 'pre', onError: 'fail-closed' },
          { name: 'style', stage: 'post', onError: 'skip' },
          { name: 'noEmoji', stage: 'post' },
          { name: 'confidentiality', stage: 'post', onError: 'fail-closed' },
        ],
      },
    });
    const engine = new Engine({ config, llm: new MockLlmClient(['Shipped it 🚀 on Friday.']), factories: { ...defaultFactories(), noEmoji: () => noEmoji } });
    await engine.ingest('terse', 'Terse', corpus());
    const r = await engine.generate('terse', 'engineer', 'We shipped the fix.');
    expect(r.text).toBe('Shipped it  on Friday.');
    expect(r.trace.map((t) => t.filter)).toEqual(['confidentiality', 'llm', 'style', 'noEmoji', 'confidentiality']);
    expect(r.trace.find((t) => t.filter === 'noEmoji')).toMatchObject({ modified: true, metadata: { removed: 2 } });
  });
});

describe('README example: the snippet in README.md is this test\'s snippet', () => {
  const squash = (t: string): string => t.replace(/\s+/g, ' ').trim();

  it('the fenced ts block that defines noEmoji matches the code between the markers, ignoring whitespace', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const self = readFileSync(join(here, 'readmeExample.test.ts'), 'utf8');
    // The marker strings are built from pieces so that this function does not contain them itself.
    const start = '// ---- README snippet ' + 'start ----\n';
    const end = '// ---- README snippet ' + 'end ----';
    const a = self.indexOf(start);
    const b = self.indexOf(end);
    expect(a, 'start marker').toBeGreaterThanOrEqual(0);
    expect(b, 'end marker').toBeGreaterThan(a);
    const snippet = self.slice(a + start.length, b);

    const readme = readFileSync(join(here, '..', '..', 'README.md'), 'utf8');
    const blocks = [...readme.matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1] as string).filter((blk) => blk.includes('const noEmoji'));
    expect(blocks, 'exactly one README ts block defines noEmoji').toHaveLength(1);
    expect(squash(blocks[0] as string)).toBe(squash(snippet));
  });
});
