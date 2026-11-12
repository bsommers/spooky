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
