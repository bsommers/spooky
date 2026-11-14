// Keeps the README's "add a filter in under 20 lines" example honest: the snippet below is copied verbatim into
// README.md, and this test runs it through a real Engine.
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
// 2. Config: { filters: { pipeline: [...default entries..., { name: 'noEmoji', stage: 'post' }] } }, before the last confidentiality.
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
