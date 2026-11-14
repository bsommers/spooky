// Performance budget (system tier). The whole generate() path (size cap, pre filters, retrieval, prompt, scripted model,
// post filters) on a 50 000-character draft and a 50 000-character model answer.
//
// Budget = 3 x the number measured on the dev machine (Node 26, 2026-11-14), best of 9 warm runs, so a noisy neighbour
// cannot fail the build but an algorithmic regression (a quadratic pass, a lost fast path) does:
//   50 000 chars : measured 3.7 ms  -> budget 11 ms
//  200 000 chars : measured 15 ms   -> budget 45 ms (the default maxInputChars; guards against super-linear growth)
// A slower machine may scale both with GHOSTWRITER_PERF_SCALE=<factor>. Recorded in docs/AS-BUILT.md.
import { describe, expect, it } from 'vitest';
import { Engine } from '../../src/engine.js';
import { loadConfig } from '../../src/config/load.js';
import { MockLlmClient } from '../../src/llm/mockClient.js';
import { corpus } from '../helpers/rig.js';

const SCALE = Number(process.env.GHOSTWRITER_PERF_SCALE ?? 1);
const BUDGET_50K_MS = 11 * SCALE;
const BUDGET_200K_MS = 45 * SCALE;

const para =
  'We shipped the billing fix on Friday. Furthermore, it is important to note that the deploy used key AKIAIOSFODNN7EXAMPLE and the team moved fast. Obviously, latency fell from 300 ms to 2 ms; see https://example.com/a?b=1. ';
const make = (n: number): string => para.repeat(Math.ceil(n / para.length)).slice(0, n);

async function bestOf(chars: number, runs: number): Promise<number> {
  const input = make(chars);
  const answer = make(chars);
  const engine = new Engine({ config: loadConfig({ llm: { model: 'mock' }, limits: { maxInputChars: 400_000 } }), llm: new MockLlmClient(() => answer) });
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

describe('perf budget', () => {
  it(`50k-character draft through the full pipeline finishes within ${BUDGET_50K_MS} ms`, async () => {
    expect(await bestOf(50_000, 9)).toBeLessThan(BUDGET_50K_MS);
  });

  it(`200k-character draft (default maxInputChars) finishes within ${BUDGET_200K_MS} ms`, async () => {
    expect(await bestOf(200_000, 5)).toBeLessThan(BUDGET_200K_MS);
  });
});
