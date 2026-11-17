import { describe, expect, it } from 'vitest';
import { DEFAULT_SCORER_WEIGHTS, FEATURE_NAMES } from '../../../config/scorer.js';
import { loadConfig } from '../../../src/config/load.js';
import { ConfigError } from '../../../src/models/errors.js';
import { HeuristicScorer, normalizeWeights } from '../../../src/scoring/scorer.js';
import { mulberry32, pick, randomText } from '../../helpers/prng.js';

const prose =
  'The harbour was quiet at dawn. Gulls wheeled over the empty slips, and somewhere a rope creaked against a post. ' +
  'Nobody had expected the ferry to run, yet it did: slow, grey, half-lit, and entirely indifferent to the weather. ' +
  'Maria watched it come in. She had waited eleven years for this boat, and now that it was here she found she could not move. ' +
  'Why? She could not say.\n\n' +
  'Moreover, the schedule had changed. Furthermore, the crew had changed too, and it plays a crucial role in the ever-evolving landscape of the town.\n\n' +
  'In the end she walked down to the pier.';

const sum = (b: { features: Record<string, { contribution: number }> }): number => Object.values(b.features).reduce((a, f) => a + f.contribution, 0);

describe('HeuristicScorer', () => {
  const scorer = new HeuristicScorer();

  it('returns a score in [0,1] with one breakdown entry per feature, in order', () => {
    const b = scorer.score(prose);
    expect(b.score).toBeGreaterThanOrEqual(0);
    expect(b.score).toBeLessThanOrEqual(1);
    expect(Object.keys(b.features)).toEqual([...FEATURE_NAMES]);
    expect(b.stats?.paragraphs).toBe(3);
  });

  it('is deterministic: the same text twice gives an identical breakdown', () => {
    expect(scorer.score(prose)).toEqual(scorer.score(prose));
    expect(new HeuristicScorer().score(prose)).toEqual(scorer.score(prose));
  });

  it('breakdown contributions sum to the score (within 1e-9) and weights sum to 1', () => {
    for (const text of [prose, prose.repeat(3), 'Short but real text with enough words in it to measure a few things. Another one here. And a third.']) {
      const b = scorer.score(text);
      expect(Math.abs(sum(b) - b.score)).toBeLessThan(1e-9);
      expect(Object.values(b.features).reduce((a, f) => a + f.weight, 0)).toBeCloseTo(1, 9);
      for (const f of Object.values(b.features)) expect(f.contribution).toBeCloseTo(f.value * f.weight, 12);
    }
  });

  it('empty or blank text: score 0.5, flag insufficient_text, nothing contributes', () => {
    for (const text of ['', '   \n\t\n', '```\nonly code\n```']) {
      const b = scorer.score(text);
      expect(b.score).toBe(0.5);
      expect(b.flags).toContain('insufficient_text');
      expect(sum(b)).toBe(0);
      expect(Object.values(b.features).every((f) => f.weight === 0 && f.value === 0.5)).toBe(true);
    }
  });

  it('text under 50 words is scored but flagged low_confidence; longer text is not', () => {
    const short = 'One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty. Another short one here. And a last one.';
    const b = scorer.score(short);
    expect(b.flags).toContain('low_confidence');
    expect(b.flags).not.toContain('insufficient_text');
    expect(scorer.score(prose).flags).not.toContain('low_confidence');
  });

  it('a feature that cannot be computed is left out and the others renormalize', () => {
    const oneParagraph = prose.replace(/\n\n/g, ' ');
    const b = scorer.score(oneParagraph);
    expect(b.flags).toContain('unavailable:paragraphUniformity');
    expect(b.features.paragraphUniformity).toEqual({ value: 0.5, weight: 0, contribution: 0 });
    expect(Math.abs(sum(b) - b.score)).toBeLessThan(1e-9);
  });

  it('mechanical machine-like prose scores higher than varied human-like prose', () => {
    const mech = Array.from({ length: 4 }, () => 'Moreover, it plays a crucial role in the ever-evolving landscape of modern business. Furthermore, it fosters a robust and comprehensive approach to growth. Additionally, it is important to note that stakeholders benefit.').join('\n\n');
    expect(scorer.score(mech).score).toBeGreaterThan(scorer.score(prose).score);
  });

  it('score is finite and within [0,1] for 1000 seeded random strings', () => {
    const rnd = mulberry32(7);
    const alphabet = ['a', 'b', 'the ', 'word ', '. ', ', ', '\n', '\n\n', '```', '`', '>', '# ', '- ', '1. ', 'https://x.io/', '—', '"', 'Dr. ', 'e.g. ', '3.5', '...', 'éè', '😀', ' ', 'moreover ', 'delve '];
    for (let i = 0; i < 1000; i++) {
      const text = randomText(rnd, alphabet, Math.floor(rnd() * 600));
      const b = scorer.score(text);
      expect(Number.isFinite(b.score), `case ${i}`).toBe(true);
      expect(b.score).toBeGreaterThanOrEqual(0);
      expect(b.score).toBeLessThanOrEqual(1);
      for (const f of Object.values(b.features)) {
        expect(Number.isFinite(f.value) && Number.isFinite(f.weight) && Number.isFinite(f.contribution)).toBe(true);
      }
      if (!b.flags?.includes('insufficient_text')) expect(Math.abs(sum(b) - b.score)).toBeLessThan(1e-9);
    }
    expect(pick(rnd, alphabet)).toBeTypeOf('string');
  });

  it('rejects a non-string input with a ConfigError', () => {
    expect(() => scorer.score(42 as unknown as string)).toThrow(ConfigError);
  });
});

describe('scorer weights', () => {
  it('defaults sum to 1 and are what an unconfigured scorer uses', () => {
    expect(Object.values(DEFAULT_SCORER_WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect({ ...new HeuristicScorer().weights }).toEqual(normalizeWeights());
  });

  it('weights that do not sum to 1 are normalized', () => {
    const w = normalizeWeights({ burstiness: 10, lexicalDiversity: 0, cliche: 0, punctuation: 0, repetition: 0, paragraphUniformity: 10 });
    expect(w.burstiness).toBeCloseTo(0.5, 12);
    expect(w.paragraphUniformity).toBeCloseTo(0.5, 12);
    expect(Object.values(w).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
  });

  it('a negative, NaN, infinite or non-number weight is rejected', () => {
    for (const bad of [-0.1, Number.NaN, Number.POSITIVE_INFINITY, '1' as unknown as number]) {
      expect(() => normalizeWeights({ cliche: bad })).toThrow(ConfigError);
    }
  });

  it('an unknown feature name and an all-zero set are rejected', () => {
    expect(() => normalizeWeights({ vibes: 1 })).toThrow(/unknown feature/);
    expect(() => normalizeWeights({ burstiness: 0, lexicalDiversity: 0, cliche: 0, punctuation: 0, repetition: 0, paragraphUniformity: 0 })).toThrow(/positive/);
  });

  it('the weights in effect change the score (single-feature weight reproduces that feature)', () => {
    const only = new HeuristicScorer({ burstiness: 1, lexicalDiversity: 0, cliche: 0, punctuation: 0, repetition: 0, paragraphUniformity: 0 }).score(prose);
    expect(only.score).toBeCloseTo(only.features.burstiness?.value ?? Number.NaN, 12);
    expect(only.score).not.toBeCloseTo(new HeuristicScorer().score(prose).score, 3);
  });
});

describe('scorer config (scorer.weights)', () => {
  const base = { llm: { model: 'm' } };

  it('is absent by default and accepts a partial weights object filled from the defaults', () => {
    expect(loadConfig(base).scorer).toBeUndefined();
    const cfg = loadConfig({ ...base, scorer: { weights: { cliche: 0.5 } } });
    expect(cfg.scorer?.weights).toEqual({ ...DEFAULT_SCORER_WEIGHTS, cliche: 0.5 });
    expect(cfg.scorer?.localWeight).toBe(1);
    expect(cfg.scorer?.detectors).toEqual([]);
  });

  it('rejects a negative weight, an unknown key and an all-zero set with path-qualified errors', () => {
    const msg = (scorer: unknown): string => {
      try {
        loadConfig({ ...base, scorer });
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        return (err as ConfigError).message;
      }
      throw new Error('expected a ConfigError');
    };
    expect(msg({ weights: { cliche: -1 } })).toMatch(/scorer\.weights\.cliche: must be a non-negative number/);
    expect(msg({ weights: { vibes: 1 } })).toMatch(/scorer\.weights\.vibes: unknown key/);
    expect(msg({ weights: Object.fromEntries(FEATURE_NAMES.map((n) => [n, 0])) })).toMatch(/at least one weight must be positive/);
  });

  it('feeds the scorer: configured weights are what HeuristicScorer applies', () => {
    const cfg = loadConfig({ ...base, scorer: { weights: { burstiness: 3, lexicalDiversity: 1, cliche: 0, punctuation: 0, repetition: 0, paragraphUniformity: 0 } } });
    const s = new HeuristicScorer(cfg.scorer?.weights);
    expect(s.weights.burstiness).toBeCloseTo(0.75, 12);
  });

  it('validates detector entries (name, url policy, key egress, duplicates)', () => {
    const det = (o: Record<string, unknown>) => ({ name: 'acme', url: 'https://detect.example/v1', ...o });
    const fails = (detectors: unknown[]): boolean => {
      try {
        loadConfig({ ...base, scorer: { detectors } });
        return false;
      } catch (err) {
        return err instanceof ConfigError;
      }
    };
    expect(fails([det({})])).toBe(false);
    expect(fails([det({ name: 'local' })])).toBe(true);
    expect(fails([det({ name: 'Bad Name' })])).toBe(true);
    expect(fails([det({ url: 'file:///etc/passwd' })])).toBe(true);
    expect(fails([det({ url: 'http://detect.example/v1', apiKeyEnv: 'DETECT_KEY' })])).toBe(true);
    expect(fails([det({ url: 'http://localhost:8080/score', apiKeyEnv: 'DETECT_KEY' })])).toBe(false);
    expect(fails([det({ apiKeyEnv: 'sk-live-not-a-name' })])).toBe(true);
    expect(fails([det({ weight: -1 })])).toBe(true);
    expect(fails([det({}), det({})])).toBe(true);
    // egress: keyless remote / private-address http is refused too (the text is the user's prose); loopback http is fine
    for (const u of ['http://detect.example/v1', 'http://169.254.169.254/latest', 'http://10.0.0.5/score', 'http://192.168.1.2/score']) expect(fails([det({ url: u })]), u).toBe(true);
    for (const u of ['http://localhost:8080/score', 'http://127.0.0.1:9/score', 'http://[::1]:9/score']) expect(fails([det({ url: u })]), u).toBe(false);
    // apiKeyEnv: only names that look like a service key; never another system's credential
    for (const n of ['AWS_SECRET_ACCESS_KEY', 'AWS_ACCESS_KEY_ID', 'GITHUB_TOKEN', 'DB_PASSWORD', 'PATH', 'HOME', 'lowercase_key', 'KEY', 'ACME']) expect(fails([det({ apiKeyEnv: n })]), n).toBe(true);
    for (const n of ['ACME_KEY', 'ACME_DETECTOR_API_KEY', 'GHOSTWRITER_DETECTOR_TOKEN']) expect(fails([det({ apiKeyEnv: n })]), n).toBe(false);
  });
});

describe('normalizeWeights (overflow)', () => {
  it('rejects a weight set whose sum is not finite instead of normalizing everything to 0', () => {
    expect(() => normalizeWeights({ burstiness: 1e308, cliche: 1e308 })).toThrow(/not finite/);
  });
});
