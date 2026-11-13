import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/load.js';
import { ConfigError, GhostwriterError } from '../../src/models/errors.js';

const persona = (key: string) => ({
  key,
  name: `Persona ${key}`,
  cognitiveLoad: 'low',
  informationDensity: 'medium',
  structuralMandates: ['short paragraphs'],
  bannedPhrases: ['delve'],
});

const minimal = () => ({ llm: { model: 'test-model' } });

function failure(raw: unknown): ConfigError {
  try {
    loadConfig(raw);
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return err as ConfigError;
  }
  throw new Error('expected loadConfig to throw');
}

describe('loadConfig: valid input', () => {
  it('applies documented defaults when only llm.model is given', () => {
    const cfg = loadConfig(minimal());
    expect(cfg.limits).toEqual({ maxInputChars: 200000 });
    expect(cfg.chunk).toEqual({ size: 800, overlap: 100 });
    expect(cfg.llm).toEqual({ model: 'test-model', maxTokens: 1500, temperature: 0.7, maxRetries: 2 });
  });

  it('default pipeline is an ordered list of {name,stage,onError,enabled}', () => {
    const { filters } = loadConfig(minimal());
    expect(filters.pipeline.length).toBeGreaterThan(0);
    for (const f of filters.pipeline) {
      expect(Object.keys(f).sort()).toEqual(['enabled', 'name', 'onError', 'stage']);
    }
    const first = filters.pipeline[0];
    expect(first?.name).toBe('confidentiality');
    expect(first?.onError).toBe('fail-closed');
  });

  it('default pipeline runs confidentiality pre, then style, then confidentiality again post (D6)', () => {
    const { filters } = loadConfig(minimal());
    expect(filters.pipeline.map((f) => `${f.name}:${f.stage}`)).toEqual([
      'confidentiality:pre',
      'style:post',
      'confidentiality:post',
    ]);
  });

  it('default personas are present, valid and have unique keys', () => {
    const { personas } = loadConfig(minimal());
    expect(personas.length).toBeGreaterThan(0);
    const keys = personas.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('accepts and preserves a fully specified config', () => {
    const raw = {
      limits: { maxInputChars: 5000 },
      chunk: { size: 400, overlap: 50 },
      llm: { model: 'm', maxTokens: 900, temperature: 0.2, maxRetries: 1 },
      filters: {
        pipeline: [
          { name: 'style', stage: 'post', onError: 'skip', enabled: false },
          { name: 'confidentiality', stage: 'both', onError: 'fail-closed', enabled: true },
        ],
      },
      personas: [persona('a'), persona('b')],
    };
    const cfg = loadConfig(raw);
    expect(cfg).toEqual(raw);
  });

  it('enabled defaults to true and onError defaults to fail-closed when omitted', () => {
    const cfg = loadConfig({
      ...minimal(),
      filters: { pipeline: [{ name: 'confidentiality', stage: 'both' }] },
    });
    expect(cfg.filters.pipeline).toEqual([
      { name: 'confidentiality', stage: 'both', onError: 'fail-closed', enabled: true },
    ]);
  });

  it('allows the same filter to appear more than once (ordered list, not a set)', () => {
    const cfg = loadConfig({
      ...minimal(),
      filters: {
        pipeline: [
          { name: 'confidentiality', stage: 'pre' },
          { name: 'confidentiality', stage: 'post' },
        ],
      },
    });
    expect(cfg.filters.pipeline).toHaveLength(2);
  });

  it('does not mutate its input', () => {
    const raw = { ...minimal(), personas: [persona('a')] };
    const snapshot = JSON.stringify(raw);
    loadConfig(raw);
    expect(JSON.stringify(raw)).toBe(snapshot);
  });

  it('returns a fresh object each call: mutating one result never leaks into the next', () => {
    const a = loadConfig(minimal());
    a.filters.pipeline.length = 0;
    a.personas.length = 0;
    a.chunk.size = 1;
    const b = loadConfig(minimal());
    expect(b.filters.pipeline.length).toBeGreaterThan(0);
    expect(b.personas.length).toBeGreaterThan(0);
    expect(b.chunk.size).toBe(800);
  });
});

describe('loadConfig: invalid input fails fast with path-qualified errors', () => {
  it('missing llm.model -> ConfigError naming llm.model', () => {
    const err = failure({ llm: { maxTokens: 10 } });
    expect(err.code).toBe('CONFIG_INVALID');
    expect(err.message).toContain('llm.model');
    expect(err.issues.map((i) => i.path)).toContain('llm.model');
  });

  it('empty llm.model is rejected', () => {
    expect(failure({ llm: { model: '' } }).message).toContain('llm.model');
  });

  it('missing llm section entirely is rejected and names llm', () => {
    expect(failure({}).message).toContain('llm');
  });

  it('calling with no argument is a ConfigError, not a crash', () => {
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  it('negative chunk.size is rejected', () => {
    const err = failure({ ...minimal(), chunk: { size: -1, overlap: 0 } });
    expect(err.message).toContain('chunk.size');
  });

  it('zero and fractional chunk.size are rejected', () => {
    expect(failure({ ...minimal(), chunk: { size: 0, overlap: 0 } }).message).toContain('chunk.size');
    expect(failure({ ...minimal(), chunk: { size: 10.5, overlap: 0 } }).message).toContain('chunk.size');
  });

  it('chunk.overlap must be smaller than chunk.size', () => {
    const err = failure({ ...minimal(), chunk: { size: 100, overlap: 100 } });
    expect(err.issues.map((i) => i.path)).toContain('chunk.overlap');
  });

  it('negative chunk.overlap is rejected', () => {
    expect(failure({ ...minimal(), chunk: { size: 100, overlap: -1 } }).message).toContain('chunk.overlap');
  });

  it('non-positive limits.maxInputChars is rejected', () => {
    expect(failure({ ...minimal(), limits: { maxInputChars: 0 } }).message).toContain('limits.maxInputChars');
  });

  it('llm.maxRetries is bounded (ORC-02: max 2) and non-negative', () => {
    expect(failure({ llm: { model: 'm', maxRetries: 3 } }).message).toContain('llm.maxRetries');
    expect(failure({ llm: { model: 'm', maxRetries: -1 } }).message).toContain('llm.maxRetries');
  });

  it('llm.temperature outside [0,2] is rejected', () => {
    expect(failure({ llm: { model: 'm', temperature: 3 } }).message).toContain('llm.temperature');
    expect(failure({ llm: { model: 'm', temperature: -0.1 } }).message).toContain('llm.temperature');
  });

  it('unknown filter name is rejected with the exact path-qualified message', () => {
    const err = failure({
      ...minimal(),
      filters: {
        pipeline: [
          { name: 'confidentiality', stage: 'pre' },
          { name: 'foo', stage: 'post' },
        ],
      },
    });
    expect(err.issues).toContainEqual({
      path: 'filters.pipeline[1].name',
      message: 'unknown filter "foo"',
    });
    expect(err.message).toContain('filters.pipeline[1].name: unknown filter "foo"');
  });

  describe('confidentiality invariant (D6/FLT-03)', () => {
    const conf = (over: Record<string, unknown> = {}) => ({ name: 'confidentiality', stage: 'both', ...over });
    const withPipeline = (pipeline: unknown[]) => ({ ...minimal(), filters: { pipeline } });

    it('rejects an empty pipeline', () => {
      const err = failure(withPipeline([]));
      expect(err.issues).toContainEqual({
        path: 'filters.pipeline',
        message: 'confidentiality must be enabled and fail-closed at stage "pre"',
      });
      expect(err.message).toContain('stage "post"');
    });

    it('rejects a disabled confidentiality filter', () => {
      expect(failure(withPipeline([conf({ enabled: false })])).message).toContain('confidentiality must be enabled');
    });

    it('rejects confidentiality with onError skip, naming the path', () => {
      const err = failure(withPipeline([conf({ onError: 'skip' })]));
      expect(err.issues).toContainEqual({
        path: 'filters.pipeline[0].onError',
        message: 'confidentiality must be fail-closed',
      });
    });

    it('rejects a pipeline that covers only one stage', () => {
      const pre = failure(withPipeline([conf({ stage: 'pre' })]));
      expect(pre.message).toContain('stage "post"');
      const post = failure(withPipeline([conf({ stage: 'post' })]));
      expect(post.message).toContain('stage "pre"');
    });

    it('rejects a pipeline with only non-confidentiality filters', () => {
      expect(failure(withPipeline([{ name: 'style', stage: 'post' }])).message).toContain('confidentiality');
    });

    it('accepts separate pre and post entries, and a single "both" entry', () => {
      expect(() => loadConfig(withPipeline([conf({ stage: 'pre' }), conf({ stage: 'post' })]))).not.toThrow();
      expect(() => loadConfig(withPipeline([conf()]))).not.toThrow();
    });
  });

  it('invalid stage and onError values are rejected', () => {
    const err = failure({
      ...minimal(),
      filters: { pipeline: [{ name: 'style', stage: 'during', onError: 'explode' }] },
    });
    const paths = err.issues.map((i) => i.path);
    expect(paths).toContain('filters.pipeline[0].stage');
    expect(paths).toContain('filters.pipeline[0].onError');
  });

  it('empty persona list is rejected', () => {
    const err = failure({ ...minimal(), personas: [] });
    expect(err.issues.map((i) => i.path)).toContain('personas');
  });

  it('persona with a duplicate key is rejected and names the key and its position', () => {
    const err = failure({ ...minimal(), personas: [persona('a'), persona('b'), persona('a')] });
    expect(err.issues).toContainEqual({ path: 'personas[2].key', message: 'duplicate persona key "a"' });
  });

  it('persona with an empty banned phrase is rejected (would match everywhere)', () => {
    const p = { ...persona('a'), bannedPhrases: [''] };
    expect(failure({ ...minimal(), personas: [p] }).message).toContain('personas[0].bannedPhrases[0]');
  });

  it('persona key that is not CLI-safe is rejected', () => {
    expect(failure({ ...minimal(), personas: [persona('has space')] }).message).toContain('personas[0].key');
  });

  it('unknown top-level and nested keys are rejected (typos fail at startup)', () => {
    expect(failure({ ...minimal(), chunks: {} }).issues).toContainEqual({
      path: 'chunks',
      message: 'unknown key',
    });
    expect(failure({ llm: { model: 'm', modle: 'x' } }).issues).toContainEqual({
      path: 'llm.modle',
      message: 'unknown key',
    });
  });

  it('non-object config is rejected', () => {
    for (const bad of ['string', 42, null, [], true]) {
      expect(() => loadConfig(bad)).toThrow(ConfigError);
    }
  });

  it('reports every problem at once, not just the first', () => {
    const err = failure({ llm: {}, chunk: { size: -5, overlap: 0 }, personas: [] });
    const paths = err.issues.map((i) => i.path);
    expect(paths).toEqual(expect.arrayContaining(['llm.model', 'chunk.size', 'personas']));
  });

  it('ConfigError is a GhostwriterError', () => {
    expect(failure({})).toBeInstanceOf(GhostwriterError);
  });
});
