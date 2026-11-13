// Filter plumbing shared by the pipeline and the concrete filters. The Filter/FilterResult/TraceEntry TYPES live
// in src/models/types.ts (single declaration site); this module only re-exports them and validates results at runtime.
export type {
  Filter,
  FilterResult,
  FilterSpec,
  OnError,
  PipelineContext,
  PipelineOutput,
  Stage,
  TraceEntry,
} from '../models/types.js';

import type { FilterResult } from '../models/types.js';

/** A result that changed nothing. */
export function unchanged(text: string, metadata: FilterResult['metadata'] = {}): FilterResult {
  return { content: text, modified: false, metadata };
}

/**
 * Runtime check of what a filter returned. Returns a short, input-free reason when the value is not a valid
 * `FilterResult`, or `null` when it is. TypeScript cannot vouch for third-party or JS filters, and a non-string
 * `content` flowing on to the LLM or the caller would defeat every downstream filter.
 */
export function describeInvalidResult(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return 'result is not an object';
  const r = value as Record<string, unknown>;
  if (typeof r.content !== 'string') return 'content is not a string';
  if (typeof r.modified !== 'boolean') return 'modified is not a boolean';
  const meta = r.metadata;
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return 'metadata is not an object';
  for (const v of Object.values(meta as Record<string, unknown>)) {
    if (typeof v !== 'number' && typeof v !== 'string' && typeof v !== 'boolean') {
      return 'metadata values must be number, string or boolean';
    }
  }
  return null;
}
