// Ensemble of the local heuristic and any named external detectors (SCR-03): a weighted mean over the members that
// produced a valid score. A detector that throws, times out or returns something that is not a finite number in
// [0,1] is EXCLUDED and recorded (reason = error class name or a fixed word, never a message: messages can echo
// text); if every detector fails the result is the local score alone. The local scorer is a member named `local`.
import { DEFAULT_DETECTOR_TIMEOUT_MS } from '../../config/scorer.js';
import { ConfigError } from '../models/errors.js';
import type { AiLikenessScorer, DetectorAdapter, EnsembleExclusion, EnsembleMember, ScoreBreakdown } from '../models/types.js';
import { LOCAL_NAME, assertDetectorAdapter, checkDetectorScore } from './detectorAdapter.js';

export interface EnsembleOptions {
  /** Weight per member name (`local` and detector names). Missing = 1. Must be finite and non-negative. */
  weights?: Readonly<Record<string, number>>;
  /** Per-detector time limit. Default 10 s. */
  timeoutMs?: number;
}

export interface EnsembleResult {
  /** Weighted mean of the valid members, in [0,1]. */
  score: number;
  /** The local scorer's own breakdown. */
  local: ScoreBreakdown;
  /** Members that contributed, `local` first then detectors in the order given. `weight` is normalized (sums to 1). */
  members: EnsembleMember[];
  /** Detectors that did not contribute, with a short reason. */
  excluded: EnsembleExclusion[];
}

/** Reason recorded for a failure: the error's class name only. */
function reasonOf(err: unknown): string {
  return err instanceof Error ? `error:${err.name}` : 'error:non-Error';
}

/** Run `adapter.score(text)` with a timeout; resolves to a valid score or an exclusion reason. */
async function callAdapter(adapter: DetectorAdapter, text: string, timeoutMs: number): Promise<{ score: number } | { reason: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    const raced = await Promise.race([(async () => adapter.score(text))(), timeout]); // the async wrapper turns a synchronous throw into a rejection
    if (raced === 'timeout') return { reason: 'timeout' };
    const score = checkDetectorScore(raced);
    return score === undefined ? { reason: 'invalid_score' } : { score };
  } catch (err) {
    return { reason: reasonOf(err) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Score `text` with `local` and every adapter. Adapters are called concurrently; results keep adapter order.
 * Blank text is never sent to a detector (nothing to detect): the adapters are recorded as excluded `empty_text`.
 * `ConfigError` for a bad adapter, duplicate names, or a bad weight, before anything is called.
 */
export async function runEnsemble(text: string, local: AiLikenessScorer, adapters: readonly DetectorAdapter[] = [], options: EnsembleOptions = {}): Promise<EnsembleResult> {
  const names = new Set<string>([LOCAL_NAME]);
  for (const a of adapters) {
    assertDetectorAdapter(a);
    if (names.has(a.name)) throw new ConfigError(`ensemble: duplicate detector name "${a.name}"`);
    names.add(a.name);
  }
  const weights = options.weights ?? {};
  const weightOf = (name: string): number => {
    const w = Object.hasOwn(weights, name) ? (weights[name] as number) : 1;
    if (typeof w !== 'number' || !Number.isFinite(w) || w < 0) throw new ConfigError(`ensemble: weight of "${name}" must be a finite non-negative number`);
    return w;
  };
  const wanted = [LOCAL_NAME, ...adapters.map((a) => a.name)].map((name) => [name, weightOf(name)] as const);
  const timeoutMs = options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_DETECTOR_TIMEOUT_MS;

  const breakdown = local.score(text);
  const valid: { name: string; score: number; weight: number }[] = [{ name: LOCAL_NAME, score: breakdown.score, weight: wanted[0]?.[1] ?? 1 }];
  const excluded: EnsembleExclusion[] = [];
  if (text.trim() === '') {
    for (const a of adapters) excluded.push({ name: a.name, reason: 'empty_text' });
  } else {
    const outcomes = await Promise.all(adapters.map((a) => callAdapter(a, text, timeoutMs)));
    outcomes.forEach((o, i) => {
      const name = (adapters[i] as DetectorAdapter).name;
      if ('score' in o) valid.push({ name, score: o.score, weight: weightOf(name) });
      else excluded.push({ name, reason: o.reason });
    });
  }

  // All weights zero (e.g. local weight 0 and every detector failed): fall back to an equal mean rather than divide by zero.
  const total = valid.reduce((s, m) => s + m.weight, 0);
  const members: EnsembleMember[] = valid.map((m) => ({ name: m.name, score: m.score, weight: total > 0 ? m.weight / total : 1 / valid.length }));
  const score = members.reduce((s, m) => s + m.score * m.weight, 0);
  return { score: Math.min(1, Math.max(0, score)), local: breakdown, members, excluded };
}
