// Performance guard (system tier). The whole generate() path (size cap, pre filters, retrieval, prompt, scripted model,
// post filters) on a 50 000-character and a 200 000-character draft, each with an equally long model answer.
//
// The primary assertion is a RATIO, not a wall-clock number: t(200k) / t(50k) must stay below MAX_RATIO. The input is 4x
// larger, so linear growth gives about 4 (measured 3.7 ms -> 15 ms on Node 26, 2026-11-14) and a quadratic pass gives
// about 16. A ratio needs no machine-dependent constant, so CPU contention and slower Node versions scale both sides.
// An absolute ceiling is checked only when GHOSTWRITER_PERF_SCALE=<positive number> is set explicitly (opt-in, for a
// dedicated benchmark box): budgets are then 11 ms x SCALE (50k) and 45 ms x SCALE (200k). Recorded in docs/AS-BUILT.md.
import { describe, expect, it } from 'vitest';
import { Engine } from '../../src/engine.js';
import { loadConfig } from '../../src/config/load.js';
import { MockLlmClient } from '../../src/llm/mockClient.js';
import { corpus } from '../helpers/rig.js';

const MAX_RATIO = 8; // linear is about 4, quadratic about 16

/** Absolute-budget scale factor; undefined (no absolute check) unless GHOSTWRITER_PERF_SCALE is set. Throws on junk. */
function parseScale(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`GHOSTWRITER_PERF_SCALE must be a positive finite number, got "${raw}"`);
  return n;
}
const SCALE = parseScale(process.env.GHOSTWRITER_PERF_SCALE);

const para =
  'We shipped the billing fix on Friday. Furthermore, it is important to note that the deploy used key AKIAIOSFODNN7EXAMPLE and the team moved fast. Obviously, latency fell from 300 ms to 2 ms; see https://example.com/a?b=1. ';
const make = (n: number): string => para.repeat(Math.ceil(n / para.length)).slice(0, n);

async function bestOf(chars: number, runs: number): Promise<number> {
  const input = make(chars);
  const answer = make(chars);
  const engine = new Engine({ config: loadConfig({ llm: { model: 'mock' } }), llm: new MockLlmClient(() => answer) });
  await engine.ingest('terse', 'Terse Author', corpus());
  for (let i = 0; i < 2; i++) await engine.generate('terse', 'engineer', input); // warm-up (JIT)
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    const r = await engine.generate('terse', 'engineer', input);
    best = Math.min(best, performance.now() - t);
    expect(r.text).not.toContain('AKIAIOSFODNN7EXAMPLE');
  }
  return best;
}

describe('perf scaling', () => {
  it(`200k-character draft costs less than ${MAX_RATIO}x the 50k-character draft (linear is about 4x)`, async () => {
    const t50 = await bestOf(50_000, 9);
    const t200 = await bestOf(200_000, 9);
    expect(t200 / t50, `t50=${t50.toFixed(2)} ms, t200=${t200.toFixed(2)} ms`).toBeLessThan(MAX_RATIO);
    if (SCALE !== undefined) {
      expect(t50).toBeLessThan(11 * SCALE);
      expect(t200).toBeLessThan(45 * SCALE);
    }
  });

  it('rejects an invalid GHOSTWRITER_PERF_SCALE', () => {
    for (const bad of ['abc', '0', '-1', 'Infinity']) expect(() => parseScale(bad)).toThrow(/GHOSTWRITER_PERF_SCALE/);
    expect(parseScale(undefined)).toBeUndefined();
    expect(parseScale('2.5')).toBe(2.5);
  });
});
