import { describe, expect, it } from 'vitest';
import { ConfigError, UnknownPersonaError } from '../../src/models/errors.js';
import type { TargetPersonaConfig } from '../../src/models/types.js';
import { TargetManager, findBannedPhrases } from '../../src/registry/targetManager.js';

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

describe('findBannedPhrases', () => {
  const withBanned = (...bannedPhrases: string[]): TargetPersonaConfig => persona('p', { bannedPhrases });

  it('returns [] when nothing matches, and for an empty banned list or empty text', () => {
    expect(findBannedPhrases('a clean sentence', withBanned('delve', 'synergy'))).toEqual([]);
    expect(findBannedPhrases('delve', withBanned())).toEqual([]);
    expect(findBannedPhrases('', withBanned('delve'))).toEqual([]);
  });

  it('is case-insensitive and reports the phrase as configured, not as found', () => {
    expect(findBannedPhrases('We DELVE into Synergy.', withBanned('delve', 'Synergy'))).toEqual(['delve', 'Synergy']);
  });

  it('treats regex metacharacters literally', () => {
    const p = withBanned('a.c', 'what?', '(x+)+', '[draft]', 'cost $5', 'a|b', '^start', 'end$', 'back\\slash', '*');
    expect(findBannedPhrases('abc', p)).toEqual([]); // "a.c" must not match "abc"
    expect(findBannedPhrases('what', p)).toEqual([]);
    expect(findBannedPhrases('xxxx', p)).toEqual([]);
    expect(findBannedPhrases('a', p)).toEqual([]);
    expect(findBannedPhrases('a.c what? (x+)+ [draft] cost $5 a|b ^start end$ back\\slash *', p)).toEqual([
      'a.c',
      'what?',
      '(x+)+',
      '[draft]',
      'cost $5',
      'a|b',
      '^start',
      'end$',
      'back\\slash',
      '*',
    ]);
  });

  it('reports each configured phrase once, in configured order, however often it occurs', () => {
    const p = withBanned('beta', 'alpha', 'beta');
    expect(findBannedPhrases('alpha beta beta alpha', p)).toEqual(['beta', 'alpha']);
  });

  it('matches multi-word phrases and phrases inside longer words (literal substring)', () => {
    expect(findBannedPhrases('Let us circle back later', withBanned('circle back'))).toEqual(['circle back']);
    expect(findBannedPhrases('it delves deep', withBanned('delve'))).toEqual(['delve']);
  });

  it('ignores empty and whitespace-only phrases rather than matching everything', () => {
    expect(findBannedPhrases('anything', withBanned('', 'zzz'))).toEqual([]);
    expect(findBannedPhrases('anything', withBanned('   '))).toEqual([]);
  });

  it('matches non-ASCII phrases case-insensitively', () => {
    expect(findBannedPhrases('Fresh Éclair', withBanned('éclair'))).toEqual(['éclair']);
  });

  it.each([
    ['zero-width space', 'circ\u200ble back'],
    ['soft hyphen', 'circle\u00ad back'],
    ['fullwidth letters', '\uff43\uff49\uff52\uff43\uff4c\uff45 back'],
    ['NBSP', 'circle\u00a0back'],
    ['double space', 'circle  back'],
    ['newline', 'circle\nback'],
    ['invisible next to the space', 'circle\u200b back'],
    ['mixed case', 'CiRcLe BaCk'],
  ])('matches a phrase hidden by %s', (_name, text) => {
    expect(findBannedPhrases(`let us ${text} later`, withBanned('circle back'))).toEqual(['circle back']);
  });

  it('matches a single-word phrase split by a soft hyphen or zero-width joiner', () => {
    expect(findBannedPhrases('we de\u00adlve and del\u200dve', withBanned('delve'))).toEqual(['delve']);
  });

  it('normalizes the configured phrase too, and ignores phrases that are empty after normalization', () => {
    expect(findBannedPhrases('circle back', withBanned('circle\u00a0\u00a0back'))).toEqual(['circle\u00a0\u00a0back']);
    expect(findBannedPhrases('anything', withBanned('\u200b', '\u00ad \n'))).toEqual([]);
  });

  it('does not match words that merely look related', () => {
    expect(findBannedPhrases('circles and backs', withBanned('circle back'))).toEqual([]);
  });

  it('treats a pathological phrase as a literal, so there is no pattern to backtrack on', () => {
    const p = withBanned('(a+)+$');
    expect(findBannedPhrases('a'.repeat(50_000) + '!', p)).toEqual([]);
    expect(findBannedPhrases('x (a+)+$ y', p)).toEqual(['(a+)+$']);
  });
});
