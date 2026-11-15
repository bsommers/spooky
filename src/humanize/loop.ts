// The humanizer loop (HUM-01..04): bounded, score-driven, every edit verified before it is kept.
//
//   text -> score -> at or below target? done
//        -> pick the 2 worst features -> deterministic edits (rhythm, cliches), then one model pass
//        -> confidentiality -> meaning guard -> rescore -> improved? keep : revert -> next iteration (at most maxIterations)
//
// Every candidate is a COPY: the best text so far is only replaced by a candidate that passed the meaning guard and
// scored strictly lower, so the result is the best-scoring version seen, never merely the last. A model failure keeps the
// prior text (onError: skip) and is recorded. Confidentiality runs on every candidate BEFORE it is scored or compared,
// and once more on the final text, so nothing the model invented can survive. The trace holds numbers and fixed words only.
import type { FeatureName } from '../../config/scorer.js';
import { FEATURE_NAMES } from '../../config/scorer.js';
import type { RetryOptions } from '../llm/retry.js';
import type { HumanizeResult, HumanizeStep, LlmClient, ScoreBreakdown, StylometricProfile, TraceEntry } from '../models/types.js';
import { selectTargets } from '../scoring/targets.js';
import { checkMeaning } from './guard.js';
import { deterministicRewrite } from './rewrite.js';
import { rewriteWithLlm } from './rewriteLlm.js';

/** What the loop needs from its host. */
export interface HumanizeLoopDeps {
  /** The scorer to drive and to judge with (the local heuristic). */
  score(text: string): ScoreBreakdown;
  /** Redact secrets. Throws when the redaction cannot be shown to have run (fail closed: the loop aborts). */
  redact(text: string): Promise<{ text: string; modified: boolean }>;
  /** The model; created lazily so a deterministic-only run never needs a key. A throw is a model failure: skipped. */
  llm?: () => LlmClient;
  profile?: StylometricProfile;
  retry?: RetryOptions;
}

export interface HumanizeLoopOptions {
  target: number;
  maxIterations: number;
  /** Make model calls (needs `deps.llm`). */
  useLlm: boolean;
  maxTokens: number;
  temperature: number;
}

const EPS = 1e-9;
const featureValues = (b: ScoreBreakdown): Record<string, number> => Object.fromEntries(FEATURE_NAMES.map((n) => [n, b.features[n]?.value ?? 0]));
const deltas = (a: Record<string, number>, b: Record<string, number>): Record<string, number> => Object.fromEntries(FEATURE_NAMES.map((n) => [n, round((b[n] ?? 0) - (a[n] ?? 0))]));
const round = (n: number): number => Math.round(n * 1e6) / 1e6;

/** Fixed, text-free class name of a thrown error (a message can embed the text being processed). */
const errorClass = (err: unknown): string => (err instanceof Error ? err.name : 'non-Error value thrown');

export async function runHumanizeLoop(input: string, deps: HumanizeLoopDeps, options: HumanizeLoopOptions): Promise<HumanizeResult> {
  const started = performance.now();
  let best = input;
  let bestScore = deps.score(best);
  const initial = bestScore;
  const initialValues = featureValues(initial);
  const steps: HumanizeStep[] = [];
  const trace: TraceEntry[] = [];
  let iterations = 0;
  let llmCalls = 0;
  let guardRejections = 0;
  let detFailedFrom: string | null = null; // the deterministic edits were reverted from this text: they would repeat

  const record = (step: HumanizeStep, ms: number): void => {
    steps.push(step);
    trace.push({
      filter: 'humanize',
      modified: step.kept,
      ms,
      metadata: {
        iteration: step.iteration,
        step: step.step,
        features: step.features.join(','),
        scoreBefore: round(step.scoreBefore),
        scoreAfter: round(step.scoreAfter),
        outcome: step.outcome,
        redacted: step.redacted,
        guard: step.guard.join(','),
        ...Object.fromEntries(Object.entries(step.featureDeltas).map(([k, v]) => [`delta_${k}`, v])),
        ...(step.error === undefined ? {} : { error: step.error }),
      },
      ...(step.error === undefined ? {} : { error: step.error }),
    });
  };

  /** Redact, guard, rescore a candidate; keep it when it is strictly better. Returns whether it was kept. */
  const tryCandidate = async (iteration: number, step: HumanizeStep['step'], features: readonly FeatureName[], raw: string): Promise<boolean> => {
    const t0 = performance.now();
    const red = await deps.redact(raw); // a throw here aborts the whole run: fail closed
    const candidate = red.text;
    const base = { iteration, step, features: [...features], scoreBefore: bestScore.score, redacted: red.modified, featureDeltas: {} as Record<string, number> };
    const guard = checkMeaning(input, candidate);
    if (!guard.ok) {
      guardRejections++;
      record({ ...base, scoreAfter: bestScore.score, kept: false, outcome: 'guard_rejected', guard: guard.violations }, performance.now() - t0);
      return false;
    }
    const scored = deps.score(candidate);
    const improved = scored.score < bestScore.score - EPS;
    record(
      {
        ...base,
        scoreAfter: scored.score,
        kept: improved,
        outcome: improved ? 'improved' : 'no_improvement',
        guard: [],
        featureDeltas: deltas(featureValues(bestScore), featureValues(scored)),
      },
      performance.now() - t0,
    );
    if (improved) {
      best = candidate;
      bestScore = scored;
    }
    return improved;
  };

  for (let iteration = 1; iteration <= options.maxIterations && bestScore.score > options.target + EPS; iteration++) {
    iterations = iteration;
    const features = selectTargets(bestScore);
    let progressed = false;

    if (detFailedFrom !== best) {
      const from: string = best;
      const det = deterministicRewrite(best, features);
      if (det.text === best) detFailedFrom = from; // nothing to edit: not a step, nothing to record
      else if (await tryCandidate(iteration, 'deterministic', features, det.text)) progressed = true;
      else detFailedFrom = from;
    }

    if (options.useLlm && deps.llm !== undefined && bestScore.score > options.target + EPS) {
      llmCalls++;
      const t0 = performance.now();
      let answer: string | undefined;
      try {
        answer = await rewriteWithLlm(deps.llm(), { text: best, features, profile: deps.profile }, { maxTokens: options.maxTokens, temperature: options.temperature, ...(deps.retry === undefined ? {} : { retry: deps.retry }) });
      } catch (err) {
        record(
          { iteration, step: 'llm', features, scoreBefore: bestScore.score, scoreAfter: bestScore.score, kept: false, outcome: 'llm_error', redacted: false, guard: [], featureDeltas: {}, error: errorClass(err) },
          performance.now() - t0,
        );
      }
      if (answer !== undefined && (await tryCandidate(iteration, 'llm', features, answer))) progressed = true;
    }

    // Nothing kept and nothing left that could change the outcome (no model pass, deterministic edits exhausted): stop early.
    if (!progressed && (!options.useLlm || deps.llm === undefined) && detFailedFrom === best) break;
  }

  // The final text goes through confidentiality once more (HUM-03), whatever happened above.
  const final = await deps.redact(best);
  if (final.text !== best) {
    best = final.text;
    bestScore = deps.score(best);
  }
  trace.push({ filter: 'confidentiality', modified: final.modified, ms: performance.now() - started, metadata: { stage: 'humanize-final' } });

  const after = featureValues(bestScore);
  return {
    text: best,
    initialScore: initial.score,
    finalScore: bestScore.score,
    reachedTarget: bestScore.score <= options.target + EPS,
    iterations,
    llmCalls,
    guardRejections,
    featureDeltas: deltas(initialValues, after),
    featuresBefore: initialValues,
    featuresAfter: after,
    steps,
    trace,
  };
}
