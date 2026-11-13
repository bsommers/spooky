// Async, ordered filter pipeline (FLT-01..03). Filters run in registration order; each sees the previous output.
import { ConfigError, FilterFailedError } from '../models/errors.js';
import type { Filter, PipelineContext, PipelineOutput, TraceEntry } from '../models/types.js';
import { describeInvalidResult } from './base.js';

const STAGES = new Set(['pre', 'post']);
const ON_ERROR = new Set(['fail-closed', 'skip']);

/** Thrown inside run() for a filter that returned something that is not a valid FilterResult. */
class InvalidResultError extends Error {}

function now(): number {
  return performance.now();
}

/**
 * Error text for the trace. Thrown errors are reduced to their class name: their message may embed the text
 * being filtered (including a secret), and the trace is meant to be safe to log. Validation reasons are ours.
 */
function traceError(err: unknown): string {
  if (err instanceof InvalidResultError) return `invalid filter result: ${err.message}`;
  if (err instanceof Error) return `${err.name}`;
  return 'non-Error value thrown';
}

export class FilterPipeline {
  private readonly filters: Filter[] = [];

  /** Names of the registered filters, in execution order. */
  get names(): string[] {
    return this.filters.map((f) => f.name);
  }

  /** Append `filter`. Throws `ConfigError` for a malformed filter or a name that is already registered. */
  register(filter: Filter): this {
    if (typeof filter?.name !== 'string' || filter.name.trim() === '') {
      throw new ConfigError('filter name must be a non-empty string');
    }
    if (!Array.isArray(filter.stages) || filter.stages.length === 0 || !filter.stages.every((s) => STAGES.has(s))) {
      throw new ConfigError(`filter "${filter.name}": stages must be a non-empty subset of pre|post`);
    }
    if (!ON_ERROR.has(filter.onError)) {
      throw new ConfigError(`filter "${filter.name}": onError must be "fail-closed" or "skip"`);
    }
    if (typeof filter.process !== 'function') {
      throw new ConfigError(`filter "${filter.name}": process must be a function`);
    }
    if (this.filters.some((f) => f.name === filter.name)) {
      throw new ConfigError(`filter "${filter.name}" is already registered`);
    }
    this.filters.push(filter);
    return this;
  }

  /** Alias of `register`. */
  use(filter: Filter): this {
    return this.register(filter);
  }

  /**
   * Run every filter whose `stages` include `ctx.stage`, in order. A `fail-closed` filter that throws (or returns
   * an invalid result) aborts the run with `FilterFailedError` and nothing is returned; a `skip` filter's failure is
   * recorded in the trace and the previous text carries on to the next filter.
   */
  async run(text: string, ctx: PipelineContext): Promise<PipelineOutput> {
    const active = this.filters.filter((f) => f.stages.includes(ctx.stage)); // snapshot: later register() calls do not affect this run
    const trace: TraceEntry[] = [];
    let current = text;
    for (const filter of active) {
      const started = now();
      try {
        const result: unknown = await filter.process(current, ctx);
        const invalid = describeInvalidResult(result);
        if (invalid !== null) throw new InvalidResultError(invalid);
        const ok = result as { content: string; metadata: TraceEntry['metadata'] };
        trace.push({
          filter: filter.name,
          modified: ok.content !== current,
          ms: now() - started,
          metadata: { ...ok.metadata },
        });
        current = ok.content;
      } catch (err) {
        if (filter.onError === 'fail-closed') throw new FilterFailedError(filter.name, err);
        trace.push({ filter: filter.name, modified: false, ms: now() - started, metadata: {}, error: traceError(err) });
      }
    }
    return { text: current, trace };
  }
}
