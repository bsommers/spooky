// HumanizeFilter (HUM-01): the humanizer loop as a post-stage filter. It belongs after the style filter and before the
// final confidentiality filter; the loop also runs confidentiality on every candidate itself (src/humanize/loop.ts), so the
// output is redacted even when a host places it elsewhere. `onError: skip` by default: a humanizer failure must never block
// the text (a confidentiality failure still does, because it is thrown by the host's `redact`, which the loop does not catch).
//
//   const f = new HumanizeFilter({ ...deps, target: 0.3, maxIterations: 3 });
//   const { text, steps } = await f.run(draft, profile);   // the full result
//   pipeline.register(f);                                   // or as a pipeline stage: process() returns the text + counts
import type { Filter, FilterResult, OnError, PipelineContext, Stage, StylometricProfile } from '../models/types.js';
import type { HumanizeResult } from '../models/types.js';
import { runHumanizeLoop } from '../humanize/loop.js';
import type { HumanizeLoopDeps, HumanizeLoopOptions } from '../humanize/loop.js';

export interface HumanizeFilterOptions extends Partial<HumanizeLoopOptions> {
  deps: HumanizeLoopDeps;
  onError?: OnError;
}

export class HumanizeFilter implements Filter {
  readonly name = 'humanize';
  readonly stages: readonly Stage[] = ['post'];
  readonly onError: OnError;
  readonly #deps: HumanizeLoopDeps;
  readonly #options: HumanizeLoopOptions;

  constructor(options: HumanizeFilterOptions) {
    this.onError = options.onError ?? 'skip';
    this.#deps = options.deps;
    this.#options = {
      target: options.target ?? 0.3,
      maxIterations: options.maxIterations ?? 3,
      useLlm: options.useLlm ?? true,
      maxTokens: options.maxTokens ?? 1500,
      temperature: options.temperature ?? 0.7,
    };
  }

  /** Run the loop with the full result. `profile` steers the model pass. */
  run(text: string, profile?: StylometricProfile, override: Partial<HumanizeLoopOptions> = {}): Promise<HumanizeResult> {
    return runHumanizeLoop(text, { ...this.#deps, ...(profile === undefined ? {} : { profile }) }, { ...this.#options, ...override });
  }

  async process(text: string, ctx: PipelineContext): Promise<FilterResult> {
    const r = await this.run(text, ctx.profile);
    return {
      content: r.text,
      modified: r.text !== text,
      metadata: {
        score_before: Math.round(r.initialScore * 1e6) / 1e6,
        score_after: Math.round(r.finalScore * 1e6) / 1e6,
        iterations: r.iterations,
        llm_calls: r.llmCalls,
        guard_rejections: r.guardRejections,
        reached_target: r.reachedTarget,
      },
    };
  }
}
