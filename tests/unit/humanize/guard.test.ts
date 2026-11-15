import { describe, expect, it } from 'vitest';
import { checkMeaning } from '../../../src/humanize/guard.js';

const base = 'Last spring Ana Lopez moved to Lisbon with 3 cats and paid 1,200 euros on 2024-05-01. She said "we leave at dawn" and read https://example.com/a?b=1 aloud. Call `parseFoo()` first.';

describe('meaning guard (HUM-02)', () => {
  it('numbers, dates, names, quotes, URLs and code identical -> pass, even when the prose around them changes', () => {
    const after = 'In the spring, Ana Lopez relocated to Lisbon with 3 cats; she paid 1,200 euros on 2024-05-01. She said "we leave at dawn" and read https://example.com/a?b=1 aloud. Call `parseFoo()` first.';
    expect(checkMeaning(base, after)).toEqual({ ok: true, violations: [] });
  });

  it('identical text passes', () => {
    expect(checkMeaning(base, base).ok).toBe(true);
  });

  it('a changed number is rejected (dropped and added)', () => {
    const r = checkMeaning(base, base.replace('3 cats', '4 cats'));
    expect(r.ok).toBe(false);
    expect(r.violations).toEqual(expect.arrayContaining(['number_dropped', 'number_added']));
  });

  it('a dropped number is rejected', () => {
    expect(checkMeaning(base, base.replace('3 cats', 'some cats')).violations).toContain('number_dropped');
  });

  it('an added number is rejected', () => {
    const r = checkMeaning(base, `${base} It took 7 days.`);
    expect(r.ok).toBe(false);
    expect(r.violations).toEqual(['number_added']);
  });

  it('a dropped proper noun is rejected', () => {
    const r = checkMeaning(base, base.replace('Lisbon', 'the city'));
    expect(r.ok).toBe(false);
    expect(r.violations).toContain('entity_dropped');
  });

  it('a dropped acronym is rejected; a hallucinated name is rejected', () => {
    expect(checkMeaning('We filed it with the FBI today in town.', 'We filed it with them today in town.').violations).toContain('entity_dropped');
    expect(checkMeaning('We met the mayor today in town.', 'We met the mayor Hector Ruiz today in town.').violations).toContain('entity_added');
  });

  it('a sentence-initial capital is not an entity (a rewrite may reorder or drop the opening word)', () => {
    expect(checkMeaning('Notably, the model works on small inputs.', 'The model works on small inputs.').ok).toBe(true);
  });

  it('a changed quote, URL, code span or fenced block is rejected', () => {
    expect(checkMeaning(base, base.replace('we leave at dawn', 'we leave at noon')).violations).toContain('quote_changed');
    expect(checkMeaning(base, base.replace('example.com', 'example.org')).violations).toContain('protected_changed');
    expect(checkMeaning(base, base.replace('parseFoo()', 'parseBar()')).violations).toContain('protected_changed');
    const fenced = 'Run this:\n\n```sh\nnpm run build\n```\n\nThen wait.';
    expect(checkMeaning(fenced, fenced.replace('build', 'test')).violations).toContain('protected_changed');
    expect(checkMeaning(fenced, fenced.replace('Then wait', 'Then rest')).ok).toBe(true);
  });

  it('a code identifier in plain prose must survive', () => {
    expect(checkMeaning('The max_retries setting and the getUser call matter here.', 'The retry setting and the getUser call matter here.').violations).toContain('identifier_dropped');
  });

  it('an empty answer and a length blow-up or collapse are rejected', () => {
    expect(checkMeaning(base, '   ').violations).toEqual(['empty']);
    expect(checkMeaning(base, 'ok').violations).toContain('length_out_of_bounds');
    expect(checkMeaning('word '.repeat(10), 'word '.repeat(40)).violations).toContain('length_out_of_bounds');
  });

  it('redaction placeholders are ignored by the number and entity checks', () => {
    const before = 'The key is [REDACTED:aws_key] today in the field.';
    expect(checkMeaning(before, 'Today the key is [REDACTED:aws_key] in the field.').ok).toBe(true);
    expect(checkMeaning(before, 'The key is in the field today.').ok).toBe(true);
  });

  it('violations are fixed codes, never text', () => {
    const r = checkMeaning('Pay 9999 to Zelda Quux.', 'Pay 1 to someone.');
    expect(JSON.stringify(r)).not.toMatch(/9999|Zelda|Quux/);
  });
});
