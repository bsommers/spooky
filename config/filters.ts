// Filter configuration as data (no code, no eval). The pipeline is an ORDERED list: execution order is list order.
import type { FilterSpec } from '../src/models/types.js';

/** Filter names the engine knows how to build. Config naming anything else is rejected at load. */
export const KNOWN_FILTER_NAMES: readonly string[] = ['confidentiality', 'style'];

/**
 * Default pipeline (PROJECT.md D6): confidentiality on the user input before the LLM call; after generation the
 * style editor runs, then confidentiality runs again so the style pass or the model cannot reintroduce a secret.
 */
export const DEFAULT_PIPELINE: readonly FilterSpec[] = [
  { name: 'confidentiality', stage: 'pre', onError: 'fail-closed', enabled: true },
  { name: 'style', stage: 'post', onError: 'skip', enabled: true },
  { name: 'confidentiality', stage: 'post', onError: 'fail-closed', enabled: true },
];

const runsAtPost = (f: FilterSpec): boolean => f.enabled && (f.stage === 'post' || f.stage === 'both');

/**
 * Index of the first enabled entry at the post stage that sits AFTER the last enabled, fail-closed confidentiality
 * entry at that stage, or -1 when confidentiality is last (or absent: that is reported by a separate check). Such a
 * filter would edit already-redacted text and nothing would re-check its output, so it is a config error.
 */
export function firstFilterAfterFinalConfidentiality(pipeline: readonly FilterSpec[]): number {
  let last = -1;
  pipeline.forEach((f, i) => {
    if (f.name === 'confidentiality' && f.onError === 'fail-closed' && runsAtPost(f)) last = i;
  });
  if (last === -1) return -1;
  return pipeline.findIndex((f, i) => i > last && runsAtPost(f));
}
