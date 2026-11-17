// Humanizer calibration (Phase 8): runs the deterministic humanizer (no model call) over the labeled calibration corpus and
// compares the measured numbers with the line recorded in docs/HUMANIZING.md. The doc must say what the code does; if the
// edits or the scorer change, this test fails until the doc is regenerated with the numbers it prints. The numbers are
// reported as measured: a small drop is documented, the fixtures are never tuned to make it larger.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HEURISTIC_HELD_OUT_AUC } from '../../config/humanize.js';
import { loadConfig } from '../../src/config/load.js';
import { Engine } from '../../src/engine.js';
import { loadCorpus, packageRoot, splitOf } from '../../scripts/calibrate.js';

const MARKER = /<!-- humanize-calibration: ([^>]*?) -->/;

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const r3 = (x: number): string => x.toFixed(3);

/** P(AI scores higher than human) over a pair of score lists, ties half (the Mann-Whitney AUC). */
function auc(ai: number[], human: number[]): number {
  let wins = 0;
  for (const a of ai) for (const h of human) wins += a > h ? 1 : a === h ? 0.5 : 0;
  return wins / (ai.length * human.length);
}

interface Side {
  n: number;
  before: number[];
  after: number[];
  reached: number;
  improved: number;
  attempts: number;
  rejections: number;
  iterations: number;
}

async function measure(): Promise<{ ai: Side; human: Side; testAucBefore: number; testAucAfter: number; wordsRatio: number }> {
  const engine = new Engine({ config: loadConfig({ llm: { model: '(not configured)' } }) });
  const corpus = loadCorpus();
  const run = async (label: 'ai' | 'human') => {
    const side: Side = { n: 0, before: [], after: [], reached: 0, improved: 0, attempts: 0, rejections: 0, iterations: 0 };
    const rows: { split: string; before: number; after: number; ratio: number }[] = [];
    for (const s of corpus.filter((x) => x.label === label)) {
      const r = await engine.humanize(s.text, { llm: false });
      side.n++;
      side.before.push(r.initialScore);
      side.after.push(r.finalScore);
      if (r.reachedTarget) side.reached++;
      if (r.finalScore < r.initialScore) side.improved++;
      side.attempts += r.steps.length;
      side.rejections += r.guardRejections;
      side.iterations += r.iterations;
      rows.push({ split: splitOf(s), before: r.initialScore, after: r.finalScore, ratio: r.text.split(/\s+/).length / s.text.split(/\s+/).length });
    }
    return { side, rows };
  };
  const ai = await run('ai');
  const human = await run('human');
  const test = (rows: { split: string }[], key: 'before' | 'after') => (rows as { split: string; before: number; after: number }[]).filter((r) => r.split === 'test').map((r) => r[key]);
  return {
    ai: ai.side,
    human: human.side,
    // the held-out split, scoring AI texts after humanizing against the human texts as they were
    testAucBefore: auc(test(ai.rows, 'before'), test(human.rows, 'before')),
    testAucAfter: auc(test(ai.rows, 'after'), test(human.rows, 'before')),
    wordsRatio: mean(ai.rows.map((r) => r.ratio)),
  };
}

function marker(m: Awaited<ReturnType<typeof measure>>): string {
  const pct = (a: number, b: number): string => `${Math.round((100 * a) / Math.max(1, b))}%`;
  return [
    `ai=${m.ai.n}`,
    `aiBefore=${r3(mean(m.ai.before))}`,
    `aiAfter=${r3(mean(m.ai.after))}`,
    `aiReachedTarget=${pct(m.ai.reached, m.ai.n)}`,
    `aiImproved=${pct(m.ai.improved, m.ai.n)}`,
    `aiGuardRejections=${m.ai.rejections}/${m.ai.attempts}`,
    `human=${m.human.n}`,
    `humanBefore=${r3(mean(m.human.before))}`,
    `humanAfter=${r3(mean(m.human.after))}`,
    `humanGuardRejections=${m.human.rejections}/${m.human.attempts}`,
    `testAucBefore=${r3(m.testAucBefore)}`,
    `testAucAfter=${r3(m.testAucAfter)}`,
    `wordsRatio=${r3(m.wordsRatio)}`,
  ].join(' ');
}

describe('humanizer calibration over the labeled corpus (deterministic edits only)', () => {
  it('measures a real, honest result, and docs/HUMANIZING.md records exactly these numbers', async () => {
    const m = await measure();
    const doc = readFileSync(join(packageRoot(), 'docs', 'HUMANIZING.md'), 'utf8');
    const recorded = MARKER.exec(doc)?.[1];
    // To refresh the doc, replace the marker comment with this line (and the prose table with the same numbers):
    expect(recorded, `<!-- humanize-calibration: ${marker(m)} -->`).toBe(marker(m));
    // The AUC quoted in every caveat (config/humanize.ts) is the one measured here, not a hard-coded copy that can drift.
    expect(r3(HEURISTIC_HELD_OUT_AUC)).toBe(r3(m.testAucBefore));
    // The loop must never make a text WORSE on the scorer it optimizes, and must keep the length.
    for (const [a, b] of m.ai.after.map((x, i) => [x, m.ai.before[i] as number] as const)) expect(a).toBeLessThanOrEqual(b + 1e-9);
    expect(m.wordsRatio).toBeGreaterThan(0.9);
    expect(m.wordsRatio).toBeLessThan(1.1);
  });
});
