import { describe, expect, it } from 'vitest';
import { ConfigError, UnknownPersonaError } from '../../src/models/errors.js';
import type { TargetPersonaConfig } from '../../src/models/types.js';
import { TargetManager } from '../../src/registry/targetManager.js';

const persona = (key: string, extra: Partial<TargetPersonaConfig> = {}): TargetPersonaConfig => ({
  key,
  name: `Persona ${key}`,
  cognitiveLoad: 'low',
  informationDensity: 'medium',
  structuralMandates: ['short paragraphs'],
  bannedPhrases: ['delve'],
  ...extra,
});

const map = (...keys: string[]): Record<string, TargetPersonaConfig> =>
  Object.fromEntries(keys.map((k) => [k, persona(k)]));

describe('TargetManager.get', () => {
  it('returns the persona for a known key', () => {
    const tm = new TargetManager(map('exec', 'student'));
    expect(tm.get('exec')).toEqual(persona('exec'));
    expect(tm.get('student').name).toBe('Persona student');
  });

  it('throws UnknownPersonaError for an unknown key, with .valid sorted', () => {
    const tm = new TargetManager(map('zeta', 'alpha', 'mid'));
    let caught: unknown;
    try {
      tm.get('nope');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnknownPersonaError);
    const e = caught as UnknownPersonaError;
    expect(e.code).toBe('UNKNOWN_PERSONA');
    expect(e.key).toBe('nope');
    expect(e.valid).toEqual(['alpha', 'mid', 'zeta']);
    expect(e.message).toContain('alpha, mid, zeta');
  });

  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty', ''])(
    'does not resolve inherited or empty key %j',
    (key) => {
      const tm = new TargetManager(map('exec'));
      expect(() => tm.get(key)).toThrow(UnknownPersonaError);
    },
  );

  it('an empty manager throws UnknownPersonaError with an empty valid list', () => {
    const tm = new TargetManager({});
    try {
      tm.get('x');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownPersonaError);
      expect((err as UnknownPersonaError).valid).toEqual([]);
    }
  });
});

describe('TargetManager.list', () => {
  it('returns every persona sorted by key regardless of insertion order', () => {
    const tm = new TargetManager(map('zeta', 'alpha', 'mid'));
    expect(tm.list().map((p) => p.key)).toEqual(['alpha', 'mid', 'zeta']);
  });

  it('is empty for an empty manager', () => {
    expect(new TargetManager({}).list()).toEqual([]);
  });

  it('returns a fresh array each call', () => {
    const tm = new TargetManager(map('a', 'b'));
    const first = tm.list();
    first.pop();
    expect(tm.list()).toHaveLength(2);
  });
});

describe('TargetManager construction', () => {
  it('rejects a persona whose key differs from its map key (ConfigError, path-qualified)', () => {
    let caught: unknown;
    try {
      new TargetManager({ exec: persona('student') });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    const e = caught as ConfigError;
    expect(e.code).toBe('CONFIG_INVALID');
    expect(e.issues).toEqual([{ path: 'personas.exec.key', message: expect.stringContaining('student') }]);
  });

  it('reports every mismatch, not only the first', () => {
    try {
      new TargetManager({ a: persona('x'), b: persona('y') });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).issues.map((i) => i.path)).toEqual(['personas.a.key', 'personas.b.key']);
    }
  });

  it('is isolated from later mutation of the input map and of returned personas', () => {
    const input = map('exec');
    const tm = new TargetManager(input);
    input['exec']!.structuralMandates.push('injected');
    delete input['exec'];
    expect(tm.get('exec').structuralMandates).toEqual(['short paragraphs']);

    const got = tm.get('exec');
    got.bannedPhrases.push('mutated');
    got.name = 'changed';
    expect(tm.get('exec').bannedPhrases).toEqual(['delve']);
    expect(tm.get('exec').name).toBe('Persona exec');
  });
});
