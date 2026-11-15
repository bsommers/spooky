import { describe, expect, it } from 'vitest';
import { ConfigError, DetectorsFailedError } from '../../../src/models/errors.js';
import type { AiLikenessScorer, DetectorAdapter } from '../../../src/models/types.js';
import { runEnsemble } from '../../../src/scoring/ensemble.js';
import { HeuristicScorer } from '../../../src/scoring/scorer.js';

const fixedLocal = (score: number): AiLikenessScorer => ({ score: () => ({ score, features: {} }) });
const detector = (name: string, result: () => unknown): DetectorAdapter => ({ name, score: async () => result() as number });
const TEXT = 'Some text to score.';

describe('runEnsemble', () => {
  it('with no adapters the score is the local score', async () => {
    const r = await runEnsemble(TEXT, fixedLocal(0.4));
    expect(r.score).toBe(0.4);
    expect(r.members).toEqual([{ name: 'local', score: 0.4, weight: 1 }]);
    expect(r.excluded).toEqual([]);
  });

  it('is the mean of local and the adapters by default', async () => {
    const r = await runEnsemble(TEXT, fixedLocal(0.2), [detector('a', () => 0.4), detector('b', () => 0.9)]);
    expect(r.score).toBeCloseTo(0.5, 12);
    expect(r.members.map((m) => m.name)).toEqual(['local', 'a', 'b']);
    expect(r.members.reduce((s, m) => s + m.weight, 0)).toBeCloseTo(1, 12);
  });

  it('uses configured weights (normalized), and a zero weight drops a member from the mean', async () => {
    const r = await runEnsemble(TEXT, fixedLocal(0), [detector('a', () => 1)], { weights: { local: 1, a: 3 } });
    expect(r.score).toBeCloseTo(0.75, 12);
    const z = await runEnsemble(TEXT, fixedLocal(0.3), [detector('a', () => 1)], { weights: { a: 0 } });
    expect(z.score).toBeCloseTo(0.3, 12);
  });

  it('an adapter that throws is excluded and recorded (class name only, never the message); the rest still count', async () => {
    class Boom extends Error {}
    const r = await runEnsemble(TEXT, fixedLocal(0.5), [
      detector('ok', () => 0.7),
      { name: 'bad', score: async () => { throw new Boom('secret-token-in-message'); } },
      { name: 'sync', score: () => { throw new TypeError('x'); } },
      { name: 'weird', score: async () => { throw 'a string'; } }, // eslint-disable-line @typescript-eslint/only-throw-error
    ]);
    expect(r.score).toBeCloseTo(0.6, 12);
    expect(r.excluded).toEqual([
      { name: 'bad', reason: 'error:Error' }, // `Boom` has no own name: the class name of Error subclasses is `Error` unless set
      { name: 'sync', reason: 'error:TypeError' },
      { name: 'weird', reason: 'error:non-Error' },
    ]);
    expect(JSON.stringify(r)).not.toContain('secret-token');
  });

  it('when every adapter fails the result is the local scorer alone', async () => {
    const r = await runEnsemble(TEXT, fixedLocal(0.35), [detector('a', () => { throw new Error('down'); }), detector('b', () => Number.NaN)]);
    expect(r.score).toBe(0.35);
    expect(r.members).toEqual([{ name: 'local', score: 0.35, weight: 1 }]);
    expect(r.excluded.map((e) => e.name)).toEqual(['a', 'b']);
  });

  it('rejects a score of 1.2, -0.1, NaN, Infinity, a string, null and undefined as invalid_score', async () => {
    const bad: unknown[] = [1.2, -0.1, Number.NaN, Number.POSITIVE_INFINITY, '0.5', null, undefined];
    const r = await runEnsemble(TEXT, fixedLocal(0.5), bad.map((v, i) => detector(`d${i}`, () => v)));
    expect(r.members).toHaveLength(1);
    expect(r.excluded).toEqual(bad.map((_, i) => ({ name: `d${i}`, reason: 'invalid_score' })));
    expect(r.score).toBe(0.5);
  });

  it('accepts the boundary scores 0 and 1', async () => {
    const r = await runEnsemble(TEXT, fixedLocal(0.5), [detector('lo', () => 0), detector('hi', () => 1)]);
    expect(r.excluded).toEqual([]);
    expect(r.score).toBeCloseTo(0.5, 12);
  });

  it('a detector that never answers is excluded as a timeout', async () => {
    const r = await runEnsemble(TEXT, fixedLocal(0.5), [{ name: 'slow', score: () => new Promise<number>(() => undefined) }], { timeoutMs: 20 });
    expect(r.excluded).toEqual([{ name: 'slow', reason: 'timeout' }]);
  });

  it('blank text is never sent to a detector', async () => {
    let calls = 0;
    const r = await runEnsemble('  \n ', new HeuristicScorer(), [{ name: 'a', score: async () => (calls++, 0.9) }]);
    expect(calls).toBe(0);
    expect(r.excluded).toEqual([{ name: 'a', reason: 'empty_text' }]);
    expect(r.score).toBe(0.5);
  });

  it('local weight 0 with every detector failed is an error, not a silent local score', async () => {
    const bad = detector('a', () => { throw new Error('x'); });
    const err = await runEnsemble(TEXT, fixedLocal(0.6), [bad], { weights: { local: 0 } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DetectorsFailedError);
    expect((err as DetectorsFailedError).excluded).toEqual([{ name: 'a', reason: 'error:Error' }]);
    expect((err as Error).message).not.toContain('x"');
    // all weights zero while a detector did answer is the same: nothing carries weight
    await expect(runEnsemble(TEXT, fixedLocal(0.6), [detector('b', () => 0.2)], { weights: { local: 0, b: 0 } })).rejects.toThrow(DetectorsFailedError);
    // local weight 0 is fine while a weighted detector answers
    expect((await runEnsemble(TEXT, fixedLocal(0.6), [detector('b', () => 0.2)], { weights: new Map([['local', 0]]) })).score).toBe(0.2);
  });

  it('rejects weights that name no member (typos), including __proto__, and weight sets whose sum overflows', async () => {
    const a = detector('a', () => 0.5);
    await expect(runEnsemble(TEXT, fixedLocal(0.5), [a], { weights: { aa: 2 } })).rejects.toThrow(/not a member/);
    await expect(runEnsemble(TEXT, fixedLocal(0.5), [a], { weights: JSON.parse('{"__proto__": 3}') as Record<string, number> })).rejects.toThrow(/not a member/);
    await expect(runEnsemble(TEXT, fixedLocal(0.5), [a], { weights: new Map([['nope', 1]]) })).rejects.toThrow(/not a member/);
    await expect(runEnsemble(TEXT, fixedLocal(0.5), [a], { weights: { local: 1e308, a: 1e308 } })).rejects.toThrow(/not finite/);
    await expect(runEnsemble(TEXT, fixedLocal(0.5), [{ name: '__proto__', score: async () => 0.5 }])).rejects.toThrow(ConfigError);
  });

  it('rejects bad adapters, duplicate names, the reserved name and bad weights before calling anything', async () => {
    let called = false;
    const spy = { name: 'spy', score: async () => ((called = true), 0.5) };
    await expect(runEnsemble(TEXT, fixedLocal(0.5), [spy, spy])).rejects.toThrow(ConfigError);
    await expect(runEnsemble(TEXT, fixedLocal(0.5), [spy, { name: 'local', score: async () => 0.5 }])).rejects.toThrow(ConfigError);
    await expect(runEnsemble(TEXT, fixedLocal(0.5), [{ name: 'Bad Name', score: async () => 0.5 }])).rejects.toThrow(ConfigError);
    await expect(runEnsemble(TEXT, fixedLocal(0.5), [{ name: 'x' } as unknown as DetectorAdapter])).rejects.toThrow(ConfigError);
    await expect(runEnsemble(TEXT, fixedLocal(0.5), [spy], { weights: { spy: -1 } })).rejects.toThrow(ConfigError);
    await expect(runEnsemble(TEXT, fixedLocal(0.5), [spy], { weights: { spy: Number.NaN } })).rejects.toThrow(ConfigError);
    expect(called).toBe(false);
  });
});
