import { describe, expect, it } from 'vitest';
import { chunk } from '../../src/ingestion/chunker.js';
import { ConfigError, InputTooLargeError } from '../../src/models/errors.js';

const cfg = { size: 100, overlap: 20 };
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const words = (n: number): string => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');

describe('chunk: shape', () => {
  it('returns one chunk for text shorter than size', () => {
    expect(chunk('Hello there.', cfg)).toEqual(['Hello there.']);
  });

  it('text of exactly size characters is one chunk; size + 1 is two', () => {
    const exact = 'a'.repeat(50) + ' ' + 'b'.repeat(49); // 100 chars
    expect(exact.length).toBe(100);
    expect(chunk(exact, cfg)).toEqual([exact]);
    const over = exact + 'c';
    expect(chunk(over, cfg).length).toBe(2);
  });

  it('returns [] for empty and whitespace-only text', () => {
    expect(chunk('', cfg)).toEqual([]);
    expect(chunk('   \n\t \r\n  ', cfg)).toEqual([]);
  });

  it('never returns an empty or untrimmed chunk and never exceeds size', () => {
    const text = `${words(200)}\n\n\n\n${words(50)}   \n  ${words(80)}`;
    const out = chunk(text, cfg);
    expect(out.length).toBeGreaterThan(3);
    for (const c of out) {
      expect(c).not.toBe('');
      expect(c).toBe(c.trim());
      expect(c.length).toBeLessThanOrEqual(cfg.size);
    }
  });

  it('is deterministic', () => {
    const text = words(500);
    expect(chunk(text, cfg)).toEqual(chunk(text, cfg));
  });
});

describe('chunk: boundaries', () => {
  it('prefers a paragraph break over a sentence break', () => {
    const p1 = 'First paragraph has a sentence. And another one here.';
    const p2 = 'Second paragraph begins and carries on for a good while longer than the window.';
    const out = chunk(`${p1}\n\n${p2}`, { size: 80, overlap: 10 });
    expect(out[0]).toBe(p1);
  });

  it('prefers a sentence break over a word break', () => {
    const text = 'Short one. Then a much longer second sentence that keeps going and going well past the end.';
    const out = chunk(text, { size: 60, overlap: 5 });
    expect(out[0]).toBe('Short one.');
  });

  it('does not cut mid-word when a space exists', () => {
    const text = words(300);
    const out = chunk(text, cfg);
    const vocab = new Set(text.split(' '));
    for (const c of out) for (const w of c.split(' ')) expect(vocab.has(w)).toBe(true);
  });

  it('a very long sentence with spaces is cut on word boundaries', () => {
    const sentence = Array.from({ length: 900 }, () => 'alpha').join(' ') + '.'; // ~5.4k chars, one sentence
    const out = chunk(sentence, { size: 200, overlap: 30 });
    expect(out.length).toBeGreaterThan(20);
    for (const c of out) {
      expect(c.length).toBeLessThanOrEqual(200);
      for (const w of c.split(' ')) expect(['alpha', 'alpha.']).toContain(w);
    }
  });

  it('hard-cuts a 5k-char run with no break opportunity, every piece within size', () => {
    const blob = 'x'.repeat(5000);
    const out = chunk(blob, { size: 200, overlap: 30 });
    expect(out.length).toBeGreaterThan(5000 / 200);
    for (const c of out) expect(c.length).toBeLessThanOrEqual(200);
    expect(out[0]).toBe('x'.repeat(200));
    expect(out.join('').length).toBeGreaterThanOrEqual(5000);
  });

  it('treats CRLF and lone CR as newlines (no \\r in output; paragraph break honoured)', () => {
    const p1 = 'Alpha paragraph with some text.';
    const p2 = 'Beta paragraph with other text that is long enough to overflow the window easily.';
    const out = chunk(`${p1}\r\n\r\n${p2}\r${'tail '.repeat(30)}`, { size: 60, overlap: 5 });
    expect(out[0]).toBe(p1);
    for (const c of out) expect(c).not.toContain('\r');
  });

  it('does not split surrogate pairs on a hard cut', () => {
    for (let size = 3; size < 12; size++) {
      for (const overlap of [0, 1, size - 1]) {
        const text = '😀'.repeat(60);
        const out = chunk(text, { size, overlap });
        for (const c of out) {
          expect(c).not.toMatch(LONE_SURROGATE);
          expect(c.length).toBeGreaterThan(0);
        }
        expect(out.length).toBeGreaterThan(1);
      }
    }
  });

  it('size 1 with astral characters still makes progress and stays well formed', () => {
    const out = chunk('😀😀😀', { size: 1, overlap: 0 });
    expect(out).toEqual(['😀', '😀', '😀']);
  });
});

describe('chunk: overlap', () => {
  it('consecutive chunks share a tail/head no longer than overlap, on a word boundary', () => {
    const text = words(400);
    const out = chunk(text, cfg);
    expect(out.length).toBeGreaterThan(5);
    let shared = 0;
    for (let i = 1; i < out.length; i++) {
      const prev = out[i - 1] as string;
      const next = out[i] as string;
      let k = Math.min(prev.length, next.length);
      while (k > 0 && !(prev.endsWith(next.slice(0, k)) && (k === next.length || next[k] === ' '))) k--;
      expect(k).toBeLessThanOrEqual(cfg.overlap);
      if (k > 0) shared++;
    }
    expect(shared).toBeGreaterThan(out.length / 2);
  });

  it('overlap 0 partitions the text: no content repeated, none lost', () => {
    const text = words(300);
    const out = chunk(text, { size: 100, overlap: 0 });
    expect(out.join(' ')).toBe(text);
  });

  it('together the chunks cover every word of the input, in order, with no gaps', () => {
    const text = words(500);
    const out = chunk(text, cfg);
    let highest = -1;
    for (const c of out) {
      const idx = c.split(' ').map((w) => Number(w.slice(4)));
      expect(idx[0] as number).toBeLessThanOrEqual(highest + 1); // starts at or before the first unseen word
      highest = Math.max(highest, ...idx);
    }
    expect(highest).toBe(499);
  });
});

describe('chunk: validation', () => {
  it.each([
    { size: 100, overlap: 100 },
    { size: 100, overlap: 150 },
    { size: 0, overlap: 0 },
    { size: -5, overlap: 0 },
    { size: 100, overlap: -1 },
    { size: 10.5, overlap: 1 },
    { size: 100, overlap: 0.5 },
    { size: Number.NaN, overlap: 0 },
    { size: Infinity, overlap: 0 },
  ])('rejects %j with ConfigError', (bad) => {
    expect(() => chunk('text', bad)).toThrow(ConfigError);
  });

  it('rejects non-string text with TypeError', () => {
    expect(() => chunk(42 as unknown as string, cfg)).toThrow(TypeError);
  });

  it('maxChunks aborts early with InputTooLargeError instead of building the whole list', () => {
    const text = words(5000);
    let caught: unknown;
    try {
      chunk(text, { ...cfg, maxChunks: 10 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InputTooLargeError);
    expect((caught as InputTooLargeError).limit).toBe(10);
  });

  it('maxChunks equal to the chunk count is allowed', () => {
    const text = words(200);
    const n = chunk(text, cfg).length;
    expect(chunk(text, { ...cfg, maxChunks: n }).length).toBe(n);
  });

  it('rejects an invalid maxChunks with ConfigError', () => {
    expect(() => chunk('x', { ...cfg, maxChunks: 0 })).toThrow(ConfigError);
    expect(() => chunk('x', { ...cfg, maxChunks: 1.5 })).toThrow(ConfigError);
  });
});

describe('chunk: pathological input stays fast and terminates', () => {
  it('1 MB of whitespace-free text, tiny stride', () => {
    const t0 = performance.now();
    const out = chunk('y'.repeat(1_000_000), { size: 800, overlap: 799, maxChunks: 2_000_000 });
    expect(out.length).toBeGreaterThan(1000);
    expect(performance.now() - t0).toBeLessThan(15_000);
  });
});
