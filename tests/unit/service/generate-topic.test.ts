// Unit: the `generate` operation's input schema and rendering for the two modes (topic mode: docs/SURFACES.md).
import { describe, expect, it } from 'vitest';
import { TOPIC_CAVEAT, TOPIC_LENGTHS } from '../../../config/topic.js';
import { InputError } from '../../../src/service/errors.js';
import { operation, parseInput } from '../../../src/service/operations.js';
import { generateOutput } from '../../../src/service/schemas.js';

const gen = operation('generate');
const ok = { authorId: 'ann', persona: 'exec', text: 'Why small teams ship faster' };
const issue = (input: unknown): string => {
  try {
    parseInput(gen, input);
  } catch (e) {
    expect(e).toBeInstanceOf(InputError);
    return (e as InputError).message;
  }
  return '';
};

describe('generate input: backwards compatible, two modes', () => {
  it('a rewrite request with no mode is still valid, and mode "rewrite" is too', () => {
    expect(parseInput(gen, ok)).toEqual(ok);
    expect(parseInput(gen, { ...ok, mode: 'rewrite' }).mode).toBe('rewrite');
  });

  it('topic mode takes notes and a length', () => {
    for (const length of TOPIC_LENGTHS) expect(parseInput(gen, { ...ok, mode: 'topic', notes: 'Fact: 12 releases.', length }).length).toBe(length);
    expect(parseInput(gen, { ...ok, mode: 'topic' }).notes).toBeUndefined();
  });

  it('notes and length without mode "topic" are usage errors that say so (also with mode "rewrite")', () => {
    expect(issue({ ...ok, notes: 'n' })).toContain('notes need mode "topic"');
    expect(issue({ ...ok, mode: 'rewrite', notes: 'n' })).toContain('notes need mode "topic"');
    expect(issue({ ...ok, length: 'short' })).toContain('length needs mode "topic"');
    expect(issue({ ...ok, mode: 'rewrite', length: 'short' })).toContain('length needs mode "topic"');
  });

  it('rejects an unknown mode, an unknown length, non-string notes, NUL in notes and unknown fields', () => {
    expect(issue({ ...ok, mode: 'research' })).toContain('mode');
    expect(issue({ ...ok, mode: 'topic', length: 'epic' })).toContain('length');
    expect(issue({ ...ok, mode: 'topic', notes: 5 })).toContain('notes');
    expect(issue({ ...ok, mode: 'topic', notes: 'a\u0000b' })).toContain('NUL');
    expect(issue({ ...ok, mode: 'topic', sources: ['http://example.com'] })).not.toBe('');
    expect(issue({ ...ok, mode: 'topic', url: 'http://example.com' })).not.toBe('');
  });

  it('humanize options still validate in topic mode (target needs humanize)', () => {
    expect(issue({ ...ok, mode: 'topic', target: 0.2 })).toContain('target needs humanize');
    expect(parseInput(gen, { ...ok, mode: 'topic', humanize: true, target: 0.2 }).target).toBe(0.2);
  });
});

describe('generate output and text rendering', () => {
  const base = { text: 'Body.', trace: [], promptTokensEstimate: 1 };

  it('rewrite results have no caveat and print only the text', () => {
    const out = generateOutput.parse({ ...base, mode: 'rewrite' });
    expect(gen.render(out as never)).toBe('Body.');
  });

  it('topic results carry the caveat, and the text rendering prints it after the text', () => {
    const out = generateOutput.parse({ ...base, mode: 'topic', caveat: TOPIC_CAVEAT });
    expect(gen.render(out as never)).toBe(`Body.\n\nnote: ${TOPIC_CAVEAT}`);
  });

  it('the caveat says facts are not verified, that nothing was looked up, and to check before use', () => {
    expect(TOPIC_CAVEAT).toMatch(/not verified/i);
    expect(TOPIC_CAVEAT).toMatch(/nothing was looked up/i);
    expect(TOPIC_CAVEAT).toMatch(/check/i);
  });

  it('the operation description says topic mode does no research', () => {
    expect(gen.description).toMatch(/no web search/i);
    expect(gen.description).toMatch(/may state things that are wrong/i);
  });
});
