import { describe, expect, it } from 'vitest';
import { DEFAULT_PHRASES } from '../../../config/phrases.js';
import { FilterPipeline } from '../../../src/filters/pipeline.js';
import { StyleFilter } from '../../../src/filters/style.js';
import { ConfigError } from '../../../src/models/errors.js';
import type { PipelineContext, StylometricProfile } from '../../../src/models/types.js';

const ctx = (extra: Partial<PipelineContext> = {}): PipelineContext => ({ authorId: 'a', personaKey: 'p', stage: 'post', ...extra });

const profile = (avg: number, sd: number): StylometricProfile => ({
  authorId: 'a',
  displayName: 'A',
  avgSentenceLength: avg,
  sentenceLengthStdDev: sd,
  lexicalDensityRatio: 0.5,
  preferredPunctuation: [';', ':', '('],
  hedgingFrequency: 1,
  activePassiveRatio: 0.7,
  commonTransitionWords: ['but'],
  vectorCollectionName: 'c',
  corpusWordCount: 1000,
});

const del = (...patterns: string[]) => new StyleFilter({ phrases: patterns.map((pattern) => ({ pattern })) });
async function edit(text: string, f: StyleFilter, c: PipelineContext = ctx()) {
  return (await f.process(text, c)).content;
}

describe('StyleFilter: shape', () => {
  it('is post-stage and skips on error', () => {
    const f = del('x');
    expect(f.name).toBe('style');
    expect([...f.stages]).toEqual(['post']);
    expect(f.onError).toBe('skip');
  });

  it('onError can be set from config', () => {
    expect(new StyleFilter({ phrases: [], onError: 'fail-closed' }).onError).toBe('fail-closed');
  });

  it('rejects malformed phrase entries at construction', () => {
    expect(() => new StyleFilter({ phrases: [{ pattern: '' }] })).toThrow(ConfigError);
    expect(() => new StyleFilter({ phrases: [{ pattern: ' , ' }] })).toThrow(ConfigError);
    expect(() => new StyleFilter({ phrases: [{ pattern: 'a', replacement: 5 as unknown as string }] })).toThrow(ConfigError);
    expect(() => new StyleFilter({ phrases: [{ pattern: 'a', replacement: 'b' }, { pattern: 'A', replacement: 'c' }] })).toThrow(ConfigError);
  });

  it('every default phrase compiles and is a literal phrase', () => {
    expect(DEFAULT_PHRASES.length).toBeGreaterThan(15);
    expect(() => new StyleFilter({ phrases: DEFAULT_PHRASES })).not.toThrow();
  });
});

describe('StyleFilter: phrase removal with case and punctuation repair (STY-01, defect 8)', () => {
  const f = del('Furthermore', 'Moreover');

  it('"Furthermore, we ship." -> "We ship." (re-capitalized)', async () => {
    expect(await edit('Furthermore, we ship.', f)).toBe('We ship.');
  });

  it('is case-insensitive on the phrase', async () => {
    expect(await edit('FURTHERMORE, we ship.', f)).toBe('We ship.');
    expect(await edit('furthermore, we ship.', f)).toBe('We ship.');
  });

  it('after a sentence terminator: "We ship. Moreover, it works." -> "We ship. It works."', async () => {
    expect(await edit('We ship. Moreover, it works.', f)).toBe('We ship. It works.');
    expect(await edit('Why? Moreover, it works!', f)).toBe('Why? It works!');
  });

  it('stacked connectors: "Moreover, furthermore, we ship."', async () => {
    expect(await edit('Moreover, furthermore, we ship.', f)).toBe('We ship.');
  });

  it('mid-sentence, comma on both sides: removed with ONE space and no orphan comma', async () => {
    expect(await edit('The app, moreover, ships.', f)).toBe('The app ships.');
    expect(await edit('We ship it, moreover, quickly.', f)).toBe('We ship it quickly.');
  });

  it('mid-sentence, comma only after: "We ship moreover, the app" -> "We ship the app"', async () => {
    expect(await edit('We ship moreover, the app.', f)).toBe('We ship the app.');
  });

  it('mid-sentence, comma only before keeps that comma: "We ship, moreover the app"', async () => {
    expect(await edit('We ship, moreover the app.', f)).toBe('We ship, the app.');
  });

  it('phrase right before the terminator or end of text leaves no orphan comma or space', async () => {
    expect(await edit('We ship, moreover.', f)).toBe('We ship.');
    expect(await edit('We ship it moreover.', f)).toBe('We ship it.');
    expect(await edit('We ship, moreover', f)).toBe('We ship');
    expect(await edit('We ship moreover', f)).toBe('We ship');
  });

  it('a phrase glued into a longer word is not matched', async () => {
    expect(await edit('Furthermoreover is not a word, and neither is unmoreover.', f)).toBe(
      'Furthermoreover is not a word, and neither is unmoreover.',
    );
  });

  it('text that is only a banned phrase returns the empty string and does not throw', async () => {
    expect(await edit('Furthermore,', f)).toBe('');
    expect(await edit('Moreover.', f)).toBe('');
    expect(await edit('  Moreover,  ', f)).toBe('  ');
  });

  it('multi-word phrases match across any run of spaces/tabs and with a curly apostrophe', async () => {
    const g = del("it's worth noting that");
    expect(await edit("It's  worth\tnoting that we ship.", g)).toBe('We ship.');
    expect(await edit('It’s worth noting that we ship.', g)).toBe('We ship.');
  });

  it('metadata carries counts only', async () => {
    const r = await f.process('Furthermore, a. Moreover, b.', ctx());
    expect(r.modified).toBe(true);
    expect(r.metadata.phrases_removed).toBe(2);
    expect(r.metadata.phrases_replaced).toBe(0);
    for (const v of Object.values(r.metadata)) expect(['number', 'string', 'boolean']).toContain(typeof v);
    expect(JSON.stringify(r.metadata)).not.toMatch(/furthermore|moreover/i);
  });

  it('unchanged text reports modified=false', async () => {
    const r = await f.process('Nothing to see here.', ctx());
    expect(r).toMatchObject({ content: 'Nothing to see here.', modified: false });
  });
});

describe('StyleFilter: replacements (STY-02)', () => {
  const f = new StyleFilter({ phrases: [{ pattern: 'delve into', replacement: 'dig into' }, { pattern: 'utilize', replacement: 'use' }] });

  it('preserves casing: lower, Capitalized, UPPER', async () => {
    expect(await edit('We delve into it.', f)).toBe('We dig into it.');
    expect(await edit('Delve into it.', f)).toBe('Dig into it.');
    expect(await edit('DELVE INTO IT.', f)).toBe('DIG INTO IT.');
  });

  it('replacement does not disturb surrounding punctuation or spacing', async () => {
    expect(await edit('First, utilize (carefully) the tool; then utilize it again.', f)).toBe(
      'First, use (carefully) the tool; then use it again.',
    );
  });

  it('counts replaced vs removed', async () => {
    const r = await f.process('We utilize it and delve into it.', ctx());
    expect(r.metadata.phrases_replaced).toBe(2);
    expect(r.metadata.phrases_removed).toBe(0);
  });

  it('longest phrase wins when entries overlap', async () => {
    const g = new StyleFilter({ phrases: [{ pattern: 'delve', replacement: 'dig' }, { pattern: 'delve into', replacement: 'explore' }] });
    expect(await edit('We delve into it and delve.', g)).toBe('We explore it and dig.');
  });
});

describe('StyleFilter: statelessness', () => {
  it('same phrase 3x, called twice on one instance: identical results (no lastIndex state)', async () => {
    const f = del('Furthermore');
    const text = 'Furthermore, a. Furthermore, b. Furthermore, c.';
    const first = await edit(text, f);
    const second = await edit(text, f);
    expect(first).toBe('A. B. C.');
    expect(second).toBe(first);
    const r1 = await f.process(text, ctx());
    const r2 = await f.process(text, ctx());
    expect(r2).toEqual(r1);
  });

  it('two instances with different phrase lists do not interfere', async () => {
    const a = del('alpha');
    const b = del('beta');
    expect(await edit('See alpha beta.', a)).toBe('See beta.');
    expect(await edit('See alpha beta.', b)).toBe('See alpha.');
  });
});

describe('StyleFilter: persona banned phrases via ctx (defect 9)', () => {
  it('extraBannedPhrases are removed as well', async () => {
    const f = del('furthermore');
    const out = await edit('Obviously, this works. Furthermore, it is trivially fast.', f, ctx({ extraBannedPhrases: ['obviously', 'trivially'] }));
    expect(out).toBe('This works. It is fast.');
  });

  it('extra phrases are not remembered between calls', async () => {
    const f = del('furthermore');
    await edit('Obviously, x.', f, ctx({ extraBannedPhrases: ['obviously'] }));
    expect(await edit('Obviously, x.', f)).toBe('Obviously, x.');
  });

  it('blank or non-string extras are ignored, not fatal', async () => {
    const f = del('furthermore');
    const bad = ['', '  ', 5 as unknown as string];
    expect(await edit('Plain text.', f, ctx({ extraBannedPhrases: bad }))).toBe('Plain text.');
  });

  it('regex metacharacters in a persona phrase are literal', async () => {
    const f = del('furthermore');
    expect(await edit('We (really) need C++ here.', f, ctx({ extraBannedPhrases: ['(really)', 'c++'] }))).toBe('We need here.');
  });
});

describe('StyleFilter: protected spans are byte-identical (STY-04)', () => {
  const f = new StyleFilter({ phrases: [{ pattern: 'furthermore' }, { pattern: 'delve into', replacement: 'dig into' }] });

  it('fences, inline code and URLs', async () => {
    const text =
      'Furthermore, run `furthermore delve into` at https://example.com/furthermore/delve-into and\n' +
      '```\nfurthermore, delve into   it\n```\nFurthermore, done.';
    expect(await edit(text, f)).toBe(
      'Run `furthermore delve into` at https://example.com/furthermore/delve-into and\n' +
        '```\nfurthermore, delve into   it\n```\nDone.',
    );
  });

  it('blockquote lines', async () => {
    expect(await edit('> Furthermore, quoted words\nFurthermore, plain words', f)).toBe('> Furthermore, quoted words\nPlain words');
  });

  it('an unterminated fence protects the rest of the text', async () => {
    const t = 'Furthermore, hi.\n```\nfurthermore, keep me';
    expect(await edit(t, f)).toBe('Hi.\n```\nfurthermore, keep me');
  });

  it('a phrase before inline code keeps the code and its spacing', async () => {
    expect(await edit('Furthermore, `x` works and delve into `y`.', f)).toBe('`x` works and dig into `y`.');
  });
});

describe('StyleFilter: markdown structure (whitespace handling)', () => {
  const f = del('moreover', 'additionally');

  it('bullets and newlines are preserved; list items are re-capitalized', async () => {
    const text = '- Moreover, item one\n- Additionally, item two\n\n1. Moreover, step\n';
    expect(await edit(text, f)).toBe('- Item one\n- Item two\n\n1. Step\n');
  });

  it('only edit sites are touched: indentation, double spaces and trailing hard-break spaces survive elsewhere', async () => {
    const text = '    indented  line  \nMoreover, text   with   gaps  \n\n\n  tail';
    expect(await edit(text, f)).toBe('    indented  line  \nText   with   gaps  \n\n\n  tail');
  });

  it('CRLF line endings survive', async () => {
    expect(await edit('One.\r\nMoreover, two.\r\n', f)).toBe('One.\r\nTwo.\r\n');
  });

  it('a heading keeps its marker and is capitalized', async () => {
    expect(await edit('## Moreover, the plan\n', f)).toBe('## The plan\n');
  });
});

describe('StyleFilter: sentence rhythm (STY-03)', () => {
  const none = { phrases: [] };
  const flatLong = [1, 2, 3, 4, 5, 6]
    .map((n) => `The ${['red', 'blue', 'green', 'grey', 'gold', 'pink'][n - 1]} team shipped the new release on Monday, and customers noticed the change.`)
    .join(' ');
  const flatShort = 'The cat sat down. The dog ran off. The bird flew by. The fish swam on. The cow ate hay. The pig rolled around.';

  it('profile absent: the rhythm step is skipped and the trace says so', async () => {
    const r = await new StyleFilter(none).process(flatLong, ctx());
    expect(r.content).toBe(flatLong);
    expect(r.metadata.rhythm).toBe('skipped');
    const viaPipeline = await new FilterPipeline().use(new StyleFilter(none)).run(flatLong, ctx());
    expect(viaPipeline.trace[0]?.metadata.rhythm).toBe('skipped');
  });

  it('a flat run of long sentences (6, within +-15%) is split at clause conjunctions on every second sentence', async () => {
    const f = new StyleFilter(none);
    const r = await f.process(flatLong, ctx({ profile: profile(8, 6) }));
    expect(r.modified).toBe(true);
    expect(r.metadata.rhythm).toBe('applied');
    expect(r.metadata.rhythm_runs).toBe(1);
    expect(r.metadata.rhythm_edits).toBe(3);
    expect(r.content.match(/Monday\. And customers/g)).toHaveLength(3);
    // sentences 0, 2, 4 are untouched
    expect(r.content.startsWith('The red team shipped the new release on Monday, and customers noticed the change. The blue team shipped the new release on Monday. And customers noticed the change.')).toBe(true);
  });

  it('a flat run of short sentences is merged in pairs with a semicolon', async () => {
    const r = await new StyleFilter(none).process(flatShort, ctx({ profile: profile(20, 10) }));
    expect(r.content).toBe(
      'The cat sat down. The dog ran off; the bird flew by. The fish swam on; the cow ate hay. The pig rolled around.',
    );
    expect(r.metadata.rhythm_edits).toBe(2);
  });

  it('is deterministic: same input, same output, on one instance and across instances', async () => {
    const c = ctx({ profile: profile(8, 6) });
    const f = new StyleFilter(none);
    const a = await f.process(flatLong, c);
    const b = await f.process(flatLong, c);
    const d = await new StyleFilter(none).process(flatLong, c);
    expect(b).toEqual(a);
    expect(d).toEqual(a);
  });

  it('a run shorter than the minimum (3 sentences) is left alone', async () => {
    const t = 'The cat sat down. The dog ran off. The bird flew by.';
    const r = await new StyleFilter(none).process(t, ctx({ profile: profile(20, 10) }));
    expect(r.content).toBe(t);
    expect(r.metadata.rhythm_edits).toBe(0);
  });

  it('sentences that vary by more than 15% are not a run', async () => {
    const t = 'Go now. The dog ran off to the far field today. Stop. It rained all through the long night and the next day.';
    const r = await new StyleFilter(none).process(t, ctx({ profile: profile(20, 10) }));
    expect(r.content).toBe(t);
    expect(r.metadata.rhythm_runs).toBe(0);
  });

  it('an outlier inside a flat stretch breaks the run', async () => {
    const t = 'One two three four five. Six seven eight nine ten. Eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty. Aa bb cc dd ee. Ff gg hh ii jj.';
    const r = await new StyleFilter(none).process(t, ctx({ profile: profile(20, 10) }));
    expect(r.content).toBe(t);
  });

  it('an author whose own variance is tiny (sd/avg <= 15%) keeps uniform rhythm: reported as natural, no edits', async () => {
    const r = await new StyleFilter(none).process(flatShort, ctx({ profile: profile(10, 1) }));
    expect(r.content).toBe(flatShort);
    expect(r.metadata.rhythm).toBe('natural');
  });

  it('an unusable profile (avg <= 0 or NaN) is treated like an absent one', async () => {
    for (const p of [profile(0, 0), profile(Number.NaN, 3)]) {
      const r = await new StyleFilter(none).process(flatShort, ctx({ profile: p }));
      expect(r.content).toBe(flatShort);
      expect(r.metadata.rhythm).toBe('skipped');
    }
  });

  it('abbreviations and decimals do not create sentence boundaries', async () => {
    const t = 'Dr. Smith paid 3.5 dollars. Mr. Jones paid 4.5 dollars. Ms. Lee paid 5.5 dollars. Prof. Kay paid 6.5 dollars.';
    const r = await new StyleFilter(none).process(t, ctx({ profile: profile(20, 10) }));
    // 4 real sentences of equal length -> merge candidates, never a split at "Dr."/"Mr."
    expect(r.content).not.toMatch(/Dr\.\s*;|Mr\.\s*;/);
    expect(r.content.startsWith('Dr. Smith paid 3.5 dollars.')).toBe(true);
  });

  it('never edits headings, list items or table rows, and never touches fenced code', async () => {
    const t = ['## ' + flatShort, '- ' + flatShort, '| ' + flatShort + ' |', '```', flatShort, '```', '> ' + flatShort].join('\n');
    const r = await new StyleFilter(none).process(t, ctx({ profile: profile(20, 10) }));
    expect(r.content).toBe(t);
  });

  it('paragraphs (lines) are processed independently', async () => {
    const t = `${flatShort}\n\nShort one here. Another short one.`;
    const r = await new StyleFilter(none).process(t, ctx({ profile: profile(20, 10) }));
    expect(r.content.endsWith('\n\nShort one here. Another short one.')).toBe(true);
    expect(r.content.startsWith('The cat sat down. The dog ran off; the bird flew by.')).toBe(true);
  });

  it('phrase edits run before the rhythm check and compose', async () => {
    const f = del('Furthermore');
    const r = await f.process(`Furthermore, ${flatShort.charAt(0).toLowerCase()}${flatShort.slice(1)}`, ctx({ profile: profile(20, 10) }));
    expect(r.content.startsWith('The cat sat down.')).toBe(true);
  });
});

describe('StyleFilter: through the pipeline', () => {
  it('never throws on awkward input and reports a trace entry', async () => {
    const f = new StyleFilter({ phrases: DEFAULT_PHRASES });
    for (const t of ['', ' ', '\n\n', '```', '`', '>', 'a'.repeat(5000), '\u0000\ud800 x', '. . . !!!']) {
      const out = await new FilterPipeline().use(f).run(t, ctx({ profile: profile(12, 6) }));
      expect(out.trace[0]?.error).toBeUndefined();
    }
  });

  it('applies the default phrase list sensibly', async () => {
    const f = new StyleFilter({ phrases: DEFAULT_PHRASES });
    expect(await edit('It is important to note that the build is green.', f)).toBe('The build is green.');
    expect(await edit("In today's fast-paced world, teams delve into data.", f)).toMatch(/^Teams dig into data\.$/);
  });
});
