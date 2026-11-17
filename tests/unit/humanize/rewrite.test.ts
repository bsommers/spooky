import { describe, expect, it } from 'vitest';
import { deterministicRewrite } from '../../../src/humanize/rewrite.js';
import { selectTargets } from '../../../src/scoring/targets.js';
import { HeuristicScorer } from '../../../src/scoring/scorer.js';

describe('deterministic rewrite steps', () => {
  it('replaces and deletes stock words, keeping case, and edits nothing else', () => {
    const r = deterministicRewrite('Notably, we delve into a pivotal topic. It is Crucial to act, additionally.', ['cliche']);
    expect(r.text).toBe('We dig into a key topic. It is Key to act, also.');
    expect(r.applied).toEqual({ replaced: 4, deleted: 1 });
  });

  it('leaves code, URLs and blockquotes byte-identical', () => {
    const t = 'We delve into `delve()` and https://example.com/delve now.\n\n> Quoted: delve pivotal.\n\n```\ndelve pivotal\n```\n';
    const r = deterministicRewrite(t, ['cliche', 'burstiness', 'punctuation']);
    expect(r.text).toContain('`delve()`');
    expect(r.text).toContain('https://example.com/delve');
    expect(r.text).toContain('> Quoted: delve pivotal.');
    expect(r.text).toContain('```\ndelve pivotal\n```');
    expect(r.text.startsWith('We dig into')).toBe(true);
  });

  it('joins two short adjacent sentences with a semicolon and lowers the second capital', () => {
    const r = deterministicRewrite('The tool is fast. It is also small. Everyone knows that.', ['punctuation']);
    expect(r.text).toContain('The tool is fast; it is also small');
    expect(r.applied.merged).toBeGreaterThan(0);
  });

  it('does not lower a capital that may be a name, and does not break at abbreviations', () => {
    const r = deterministicRewrite('Dr. Smith agreed. Bob did not. Ana left.', ['punctuation', 'burstiness']);
    expect(r.text).toBe('Dr. Smith agreed. Bob did not. Ana left.');
  });

  it('splits a long sentence at a clause conjunction, not inside a list', () => {
    const clause = 'The committee reviewed every proposal carefully over several long and tiring weeks of debate, but they never reached a final decision about any of them in the end.';
    expect(deterministicRewrite(clause, ['burstiness']).text).toContain('debate. But they never reached');
    const list = 'The committee reviewed every proposal carefully over several long weeks, held many meetings, and revised several drafts before the deadline.';
    expect(deterministicRewrite(list, ['burstiness']).text).toBe(list);
  });

  it('is pure: same input, same output; no features or nothing to edit -> unchanged', () => {
    const t = 'The tool is fast. It is also small. We delve into it, but they never saw why it mattered at all.';
    expect(deterministicRewrite(t, ['cliche', 'punctuation'])).toEqual(deterministicRewrite(t, ['cliche', 'punctuation']));
    expect(deterministicRewrite(t, []).text).toBe(t);
    expect(deterministicRewrite('Plain text here.', ['cliche', 'burstiness', 'punctuation'])).toEqual({ text: 'Plain text here.', applied: {} });
  });

  it('does not touch headings, and keeps line structure', () => {
    const t = '# Title. Short one. Another one.\n\n- item one is short. It is fine.\n';
    const r = deterministicRewrite(t, ['punctuation']);
    expect(r.text.split('\n')[0]).toBe('# Title. Short one. Another one.');
    expect(r.text.split('\n').length).toBe(t.split('\n').length);
  });
});

describe('target selection', () => {
  const scorer = new HeuristicScorer();
  it('picks the two features with the largest contribution, never a zero-weight one', () => {
    const b = scorer.score('The tool is fast. It is also small. It is very good. It is quite nice. It is rather neat. It is truly fine. It is fully done. It is always on. '.repeat(3));
    const t = selectTargets(b);
    expect(t.length).toBeLessThanOrEqual(2);
    for (const name of t) expect(b.features[name]?.contribution).toBeGreaterThan(0);
    for (const name of ['lexicalDiversity', 'repetition', 'paragraphUniformity']) expect(t).not.toContain(name);
    const contribs = t.map((n) => b.features[n]?.contribution ?? 0);
    expect([...contribs].sort((x, y) => y - x)).toEqual(contribs);
  });
  it('returns [] when nothing contributes', () => {
    expect(selectTargets({ features: {} })).toEqual([]);
  });
});

describe('cliche replacements keep the text intact (MD-02)', () => {
  const cl = (t: string) => deterministicRewrite(t, ['cliche']).text;

  it('fixes a/an agreement after a replacement', () => {
    expect(cl('We chose an intricate design.')).toBe('We chose a complex design.');
    expect(cl('An intricate design helps.')).toBe('A complex design helps.');
    expect(cl('It was a valuable tool.')).toBe('It was a useful tool.');
    expect(cl('That was an pivotal step.')).toBe('That was a key step.');
    expect(cl('Hers was a garnered prize.')).toBe('Hers was an earned prize.');
  });

  it('does not rewrite ambiguous words that were removed from the table', () => {
    for (const t of ['Add an underscore between words.', 'We are aligning with the plan.', 'The exhibited flaw shows.']) expect(cl(t)).toBe(t);
  });

  it('leaves dotted names, paths, hyphenated compounds, emails and snake_case alone', () => {
    for (const t of ['See the realm.property field.', 'Set config.realm to 1.', 'Open docs/realm/notes.', 'Mail realm@example.org now.', 'Use the key-pivotal rule and crucial_path.']) expect(cl(t)).toBe(t);
  });

  it('still replaces a word that ends a sentence', () => {
    expect(cl('We explore the realm. Then we go.')).toBe('We explore the area. Then we go.');
  });

  it('leaves quoted spans alone, and still edits the rest of the text', () => {
    const t = 'She said "this is crucial" and we delve in. The “pivotal” moment came; we delve again.';
    const r = cl(t);
    expect(r).toContain('"this is crucial"');
    expect(r).toContain('“pivotal”');
    expect(r).toContain('we dig in');
    expect(r).toContain('we dig again');
  });

  it('a quoted cliche word no longer fails the guard for the whole candidate', async () => {
    const { checkMeaning } = await import('../../../src/humanize/guard.js');
    const t = 'She said "this is crucial" and we delve in today with the whole team present.';
    expect(checkMeaning(t, cl(t)).ok).toBe(true);
  });
});
