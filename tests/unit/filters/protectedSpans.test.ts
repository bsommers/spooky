import { describe, expect, it } from 'vitest';
import { join, splitProtected } from '../../../src/filters/protectedSpans.js';
import { mulberry32, randomText } from '../../helpers/prng.js';

const prot = (text: string) =>
  splitProtected(text)
    .filter((s) => s.protected)
    .map((s) => s.text);

describe('splitProtected / join', () => {
  it('empty text has no segments; join of nothing is empty', () => {
    expect(splitProtected('')).toEqual([]);
    expect(join([])).toBe('');
  });

  it('plain prose is one unprotected segment', () => {
    expect(splitProtected('just words.')).toEqual([{ protected: false, text: 'just words.' }]);
  });

  it('protects a fenced code block including the fences, and keeps surrounding prose', () => {
    const t = 'before\n```ts\nconst a = 1;\n```\nafter';
    expect(splitProtected(t)).toEqual([
      { protected: false, text: 'before\n' },
      { protected: true, text: '```ts\nconst a = 1;\n```\n' },
      { protected: false, text: 'after' },
    ]);
  });

  it('~~~ fences work and a shorter inner fence does not close a longer one', () => {
    expect(prot('~~~\nx\n~~~\nz')).toEqual(['~~~\nx\n~~~\n']);
    expect(prot('````\n```\nstill code\n```\n````\nprose')).toEqual(['````\n```\nstill code\n```\n````\n']);
  });

  it('an unterminated fence protects to the end of the text (fail safe)', () => {
    expect(prot('intro\n```\nnever closed\nmore')).toEqual(['```\nnever closed\nmore']);
  });

  it('protects inline code, including multi-backtick spans containing a single backtick', () => {
    expect(prot('use `foo()` here')).toEqual(['`foo()`']);
    expect(prot('use ``a ` b`` here')).toEqual(['``a ` b``']);
  });

  it('an unmatched backtick is literal text', () => {
    expect(splitProtected("it`s fine")).toEqual([{ protected: false, text: "it`s fine" }]);
  });

  it('protects URLs but not the sentence punctuation that follows them', () => {
    expect(prot('See https://example.com/a?b=1&c=2. Next')).toEqual(['https://example.com/a?b=1&c=2']);
    expect(prot('(see https://example.com/x_(y))')).toEqual(['https://example.com/x_(y)']);
    expect(prot('[docs](https://example.com/docs) ok')).toEqual(['https://example.com/docs']);
    expect(prot('a ftp://host/file, b')).toEqual(['ftp://host/file']);
  });

  it('protects blockquote lines (quoted blocks)', () => {
    expect(prot('intro\n> quoted line\n> second\nafter')).toEqual(['> quoted line\n> second\n']);
  });

  it('does not treat > in the middle of a line as a quote', () => {
    expect(splitProtected('a > b')).toEqual([{ protected: false, text: 'a > b' }]);
  });

  it('merges adjacent protected ranges and never emits empty or same-kind neighbours', () => {
    const segs = splitProtected('`a``b` and https://x.y/z');
    for (let i = 0; i < segs.length; i++) {
      expect(segs[i]?.text.length).toBeGreaterThan(0);
      if (i > 0) expect(segs[i]?.protected).not.toBe(segs[i - 1]?.protected);
    }
  });

  it('round-trip property: join(split(x)) === x for 2000 random markdown-ish strings', () => {
    const rnd = mulberry32(42);
    const alphabet = ['`', '``', '```', '~~~', '\n', '\n', ' ', '> ', 'http://a.b/c', 'https://x.y/z?q=1', ').', 'word', 'The ', 'é', '\r\n', '\t', '[', ']('];
    for (let i = 0; i < 2000; i++) {
      const x = randomText(rnd, alphabet, Math.floor(rnd() * 120));
      expect(join(splitProtected(x))).toBe(x);
    }
  });

  it('is linear: 1MB of backticks and urls splits quickly', () => {
    const t = ('`a` http://x.y/z\n> q\n```\nc\n```\n' + '`'.repeat(30)).repeat(8000);
    const start = performance.now();
    expect(join(splitProtected(t))).toBe(t);
    expect(performance.now() - start).toBeLessThan(2000);
  });
});
