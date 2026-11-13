import { describe, expect, it } from 'vitest';
import { extractProfile, vectorCollectionName } from '../../src/ingestion/stylometry.js';
import { GhostwriterError, ProfileError } from '../../src/models/errors.js';

const profile = (text: string) => extractProfile('a1', 'Ada', text);
const METRICS = [
  'avgSentenceLength',
  'sentenceLengthStdDev',
  'lexicalDensityRatio',
  'hedgingFrequency',
  'activePassiveRatio',
] as const;

describe('extractProfile: sentence statistics', () => {
  it('computes exact average and (population) standard deviation for a known set', () => {
    const p = profile('Go now. Go there now please. Go there now please and wait.'); // 2, 4, 6 words
    expect(p.avgSentenceLength).toBe(4);
    expect(p.sentenceLengthStdDev).toBeCloseTo(Math.sqrt(8 / 3), 10);
    expect(p.corpusWordCount).toBe(12);
  });

  it('a single sentence has stddev 0', () => {
    const p = profile('Just one sentence with seven words here.');
    expect(p.avgSentenceLength).toBe(7);
    expect(p.sentenceLengthStdDev).toBe(0);
  });

  it('text without any punctuation is one sentence', () => {
    const p = profile('no punctuation at all in this text');
    expect(p.avgSentenceLength).toBe(7);
    expect(p.corpusWordCount).toBe(7);
  });

  it('splits on ! ? and ellipsis, not on a decimal point inside a number', () => {
    const p = profile('Version 3.14 shipped! Did it work? Yes... it did.');
    expect(p.avgSentenceLength).toBeCloseTo(10 / 4, 10);
  });

  it('treats bullet lines and blank-line paragraphs as separate sentences even without terminal punctuation', () => {
    const p = profile('Summary\n\n- ship the build\n- fix the bug now\n* review the plan today');
    // "Summary" (1), "- ship the build" (3), "- fix the bug now" (4), "* review the plan today" (4)
    expect(p.avgSentenceLength).toBe(3);
  });

  it('does not split hard-wrapped lines inside one sentence', () => {
    const p = profile('This sentence is wrapped\nacross two lines.');
    expect(p.avgSentenceLength).toBe(7);
  });
});

describe('extractProfile: lexical density', () => {
  it('is unique words / total words, case-insensitive', () => {
    const p = profile('The cat saw the dog. The dog saw the cat.'); // 10 words, 4 unique
    expect(p.lexicalDensityRatio).toBeCloseTo(0.4, 10);
  });
});

describe('extractProfile: hedging', () => {
  it('counts hedges per 100 words', () => {
    const p = profile('Perhaps it might work. I think so.'); // 7 words; perhaps, might, I think
    expect(p.hedgingFrequency).toBeCloseTo((3 / 7) * 100, 8);
  });

  it('does not count a hedge inside a longer word', () => {
    expect(profile('The mighty perhapsburg army marched on.').hedgingFrequency).toBe(0);
  });

  it('is case-insensitive', () => {
    expect(profile('PERHAPS. Maybe. Might!').hedgingFrequency).toBeCloseTo(100, 8);
  });

  it('is 0 for assertive text', () => {
    expect(profile('Ship it. Fix it. Done.').hedgingFrequency).toBe(0);
  });
});

describe('extractProfile: punctuation and transitions', () => {
  it('reports the top 3 of ; : — ( ! ? by frequency, ties by that fixed order', () => {
    const text = 'Wait; what? Yes! Really? Sure! Fine (ok) (ok) (ok): done; done; done;';
    // ; x4  ( x3  ! x2  ? x2  : x1
    expect(profile(text).preferredPunctuation).toEqual([';', '(', '!']);
  });

  it('lists only punctuation that occurs', () => {
    expect(profile('Plain words only here.').preferredPunctuation).toEqual([]);
    expect(profile('One — two — three.').preferredPunctuation).toEqual(['—']);
  });

  it('reports top 5 transition words by count, ties by list order', () => {
    const text =
      'However, we left. However, they stayed. Therefore we met. Therefore we ate. Moreover it rained. Thus it ended. ' +
      'Furthermore nobody cared. Also nobody knew. However it is fine.';
    const t = profile(text).commonTransitionWords;
    expect(t.slice(0, 2)).toEqual(['however', 'therefore']);
    expect(t.length).toBeLessThanOrEqual(5);
    expect(new Set(t).size).toBe(t.length);
  });

  it('counts multi-word transitions', () => {
    expect(profile('On the other hand, we waited. On the other hand, we left.').commonTransitionWords).toEqual([
      'on the other hand',
    ]);
  });

  it('is empty when there are none', () => {
    expect(profile('Cats sleep. Dogs bark.').commonTransitionWords).toEqual([]);
  });
});

describe('extractProfile: active/passive', () => {
  it('is the share of sentences without a passive construction', () => {
    const p = profile('The team shipped it. The bug was fixed by Ana. The report was written. We tested the build.');
    expect(p.activePassiveRatio).toBeCloseTo(0.5, 10);
  });

  it('is 1 when nothing is passive and 0 when everything is', () => {
    expect(profile('We ship it. We fix it.').activePassiveRatio).toBe(1);
    expect(profile('It was done. It is known.').activePassiveRatio).toBe(0);
  });

  it('does not mistake adjectives and adverbs for participles', () => {
    expect(profile('The sky is red. It was even better. The ride is often fun.').activePassiveRatio).toBe(1);
  });
});

describe('extractProfile: identity, determinism, purity', () => {
  it('copies authorId and displayName and derives the collection name', () => {
    const p = extractProfile('auth-7', 'Grace H.', 'Some text here.');
    expect(p.authorId).toBe('auth-7');
    expect(p.displayName).toBe('Grace H.');
    expect(p.vectorCollectionName).toBe(vectorCollectionName('auth-7'));
    expect(vectorCollectionName('auth-7')).not.toBe(vectorCollectionName('auth-8'));
  });

  it('is deterministic and does not mutate shared state', () => {
    const text = 'Perhaps we ship; however, it was delayed. I think so (maybe)!';
    expect(profile(text)).toEqual(profile(text));
    expect(profile(text)).toEqual(profile(text));
  });

  it('ignores [REDACTED:*] placeholders so redaction does not skew the punctuation or word statistics', () => {
    const plain = profile('The key is here. We rotated it.');
    const redacted = profile('The key is [REDACTED:aws_key] here. We rotated it. [REDACTED:private_key]');
    expect(redacted.preferredPunctuation).toEqual([]);
    expect(redacted.corpusWordCount).toBe(plain.corpusWordCount);
  });
});

describe('extractProfile: degenerate and non-English input', () => {
  it.each([
    ['empty', ''],
    ['whitespace', '  \n\t  '],
    ['punctuation only', '... !!! ??? ;;;'],
    ['only a placeholder', '[REDACTED:aws_key]'],
  ])('%s -> ProfileError (typed, never NaN)', (_label, text) => {
    let caught: unknown;
    try {
      profile(text);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProfileError);
    expect(caught).toBeInstanceOf(GhostwriterError);
    expect((caught as ProfileError).code).toBe('PROFILE_INVALID');
  });

  it.each([
    ['Japanese', '私は昨日、新しい本を読みました。とても面白かったです。'],
    ['Arabic', 'ذهبت إلى السوق أمس. اشتريت بعض الفواكه.'],
    ['Cyrillic', 'Мы пошли домой. Потом мы поели. Возможно, будет дождь!'],
    ['emoji and symbols', '😀 😀 😀. ✨ ✨!'],
    ['one letter', 'a'],
  ])('%s text yields finite metrics', (_label, text) => {
    let p;
    try {
      p = profile(text);
    } catch (err) {
      expect(err).toBeInstanceOf(ProfileError); // emoji-only has no words; a typed error is acceptable, a NaN is not
      return;
    }
    for (const m of METRICS) expect(Number.isFinite(p[m])).toBe(true);
    expect(Number.isFinite(p.corpusWordCount)).toBe(true);
    expect(p.lexicalDensityRatio).toBeGreaterThan(0);
    expect(p.lexicalDensityRatio).toBeLessThanOrEqual(1);
  });

  it('rejects non-string inputs with TypeError', () => {
    expect(() => extractProfile('a', 'A', 5 as unknown as string)).toThrow(TypeError);
    expect(() => extractProfile(7 as unknown as string, 'A', 'text')).toThrow(TypeError);
    expect(() => extractProfile('a', null as unknown as string, 'text')).toThrow(TypeError);
  });

  it('handles a 1 MB single sentence quickly (linear time)', () => {
    const t0 = performance.now();
    const p = profile('word '.repeat(200_000));
    expect(p.corpusWordCount).toBe(200_000);
    expect(performance.now() - t0).toBeLessThan(5_000);
  });

  it('survives pathological punctuation and whitespace runs in linear time', () => {
    const t0 = performance.now();
    profile(`${'.'.repeat(1_000_000)}a`);
    profile(`x\n${' '.repeat(1_000_000)}y`);
    profile(`${'\n \t'.repeat(200_000)}z`);
    profile(`${'is '.repeat(100_000)}done`);
    expect(performance.now() - t0).toBeLessThan(10_000);
  });
});
