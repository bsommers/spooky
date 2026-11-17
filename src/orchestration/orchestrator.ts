// Generation orchestrator (ORC-01..05): the one place the source axis, the target axis, the filters and the LLM meet.
//
// Topic mode (docs/ARCHITECTURE.md): the same flow, with the topic as the input and the optional notes as a second text; the
// topic and the notes each go through the PRE pipeline on their own, and both are in the retrieval query and the prompt only
// as redacted text. The result carries TOPIC_CAVEAT: nothing is looked up, no fact is verified.
//
//   input -> size cap -> PRE pipeline (confidentiality) -> retrieve exemplars (redacted query) -> PRE on each exemplar -> buildPrompt
//         -> LLM (bounded retry) -> POST pipeline (style, confidentiality) -> banned-phrase check -> {text, trace}
//
// Ordering is the security property. Unknown persona / author and an oversized input are rejected before any filter
// or LLM runs. The prompt and the retrieval query are built only from PRE-pipeline output, so the provider never sees
// text the confidentiality filter had a chance to redact. Everything fails closed: a filter that cannot demonstrably
// have run, an empty / non-string / oversized model answer, or exhausted retries end in a typed error and NO text.
import { GENERATE_MODES, TOPIC_CAVEAT, TOPIC_LENGTHS } from '../../config/topic.js';
import { buildPrompt } from '../pipeline/promptBuilder.js';
import { withRetry } from '../llm/retry.js';
import type { RetryOptions } from '../llm/retry.js';
import { findBannedPhrases } from '../registry/targetManager.js';
import type { TargetManager } from '../registry/targetManager.js';
import type { SourceManager } from '../registry/sourceManager.js';
import type { FilterPipeline } from '../filters/pipeline.js';
import { ConfigError, FilterFailedError, InputTooLargeError, LlmError } from '../models/errors.js';
import type { Config, GenerateOptions, GenerateResult, LlmClient, PipelineContext, PipelineOutput, ScoredChunk, TraceEntry } from '../models/types.js';

/** Exemplar chunks retrieved when `GenerateOptions.exemplarCount` is not given. */
export const DEFAULT_EXEMPLAR_COUNT = 3;
/** The retrieval query is the first this-many characters of the redacted input (bag-of-words; the rest adds cost, not signal). */
export const MAX_RETRIEVAL_QUERY_CHARS = 20_000;
/** Largest model answer accepted; the real clients enforce the same cap on the wire. */
export const MAX_LLM_OUTPUT_CHARS = 4 * 1024 * 1024;
const MAX_EXEMPLARS = 20;

export interface OrchestratorDeps {
  config: Pick<Config, 'limits' | 'chunk'> & { llm: Pick<Config['llm'], 'maxTokens' | 'temperature' | 'maxRetries'> };
  sources: Pick<SourceManager, 'getProfile' | 'retrieve'>;
  targets: Pick<TargetManager, 'get'>;
  /** Built for stage `pre`; must include the fail-closed confidentiality filter. */
  pre: FilterPipeline;
  /** Built for stage `post`; must end with the fail-closed confidentiality filter. */
  post: FilterPipeline;
  /** The client, or a function that makes it. A function is called only after persona / author / size checks passed. */
  llm: LlmClient | (() => LlmClient);
  /** Retry tuning (backoff, fake sleep in tests). `maxRetries` defaults to `config.llm.maxRetries`. */
  retry?: RetryOptions;
}

export class Orchestrator {
  readonly #d: OrchestratorDeps;

  constructor(deps: OrchestratorDeps) {
    this.#d = deps;
  }

  async generate(authorId: string, personaKey: string, input: string, options: GenerateOptions = {}): Promise<GenerateResult> {
    const { config } = this.#d;
    const opts = resolveOptions(options, config);
    const mode = options.mode ?? 'rewrite';
    const label = mode === 'topic' ? 'topic' : 'input';
    if (typeof authorId !== 'string' || typeof personaKey !== 'string') throw new ConfigError('generate: authorId and personaKey must be strings');
    if (typeof input !== 'string') throw new ConfigError(`generate: ${label} must be a string`);
    if (input.length > config.limits.maxInputChars) throw new InputTooLargeError(input.length, config.limits.maxInputChars);
    if (input.trim() === '') throw new ConfigError(`generate: ${label} must not be blank`);
    // Notes: topic mode only, a string, capped like the input. Blank notes are the same as no notes.
    if (options.notes !== undefined) {
      if (mode !== 'topic') throw new ConfigError('generate: notes need mode "topic"');
      if (typeof options.notes !== 'string') throw new ConfigError('generate: notes must be a string');
      if (options.notes.length > config.limits.maxInputChars) throw new InputTooLargeError(options.notes.length, config.limits.maxInputChars);
    }
    const rawNotes = options.notes !== undefined && options.notes.trim() !== '' ? options.notes : undefined;

    // Lookups that need no filter and no network come first: a typo costs nothing.
    const persona = this.#d.targets.get(personaKey); // UnknownPersonaError
    const profile = this.#d.sources.getProfile(authorId); // UnknownAuthorError
    const llm = typeof this.#d.llm === 'function' ? this.#d.llm() : this.#d.llm; // ConfigError (e.g. missing API key)

    // 1. PRE: from here on only `safe` is used.
    const pre = await this.#d.pre.run(input, { authorId, personaKey, stage: 'pre' });
    requireConfidentiality(pre, 'pre');
    const safe = pre.text;
    // The notes get the same treatment as the input, on their own: no successful confidentiality entry = no prompt.
    let safeNotes: string | undefined;
    let notesTrace: TraceEntry[] = [];
    if (rawNotes !== undefined) {
      const preNotes = await this.#d.pre.run(rawNotes, { authorId, personaKey, stage: 'pre' });
      requireConfidentiality(preNotes, 'pre');
      safeNotes = preNotes.text;
      notesTrace = preNotes.trace;
    }

    // 2. Retrieve with the redacted query (topic and notes both say what the text is about).
    const query = (safeNotes === undefined ? safe : `${safe}\n${safeNotes}`).slice(0, MAX_RETRIEVAL_QUERY_CHARS);
    const retrieved = opts.exemplarCount === 0 ? [] : await this.#d.sources.retrieve(authorId, query, opts.exemplarCount);
    // Stored text was redacted under the ruleset of the ingest; the live ruleset (or a tampered store file) may differ,
    // so every exemplar goes through the same PRE pipeline as the input. No successful confidentiality entry = no prompt.
    const exemplars: ScoredChunk[] = [];
    for (const ex of retrieved) {
      const out = await this.#d.pre.run(ex.text, { authorId, personaKey, stage: 'pre' });
      requireConfidentiality(out, 'pre');
      exemplars.push({ ...ex, text: out.text });
    }

    // 3. Prompt.
    const prompt = buildPrompt({
      profile,
      exemplars,
      persona,
      input: safe,
      maxExemplarChars: opts.exemplarCount * config.chunk.size,
      ...(mode === 'topic' ? { mode, ...(safeNotes === undefined ? {} : { notes: safeNotes }), ...(options.length === undefined ? {} : { length: options.length }) } : {}),
    });

    // 4. LLM with bounded retry; every failure mode ends in LlmError.
    const llmStart = performance.now();
    let attempts = 0;
    const raw = await withRetry(
      async () => {
        attempts++;
        return llm.complete({ system: prompt.system, user: prompt.user, maxTokens: opts.maxTokens, temperature: opts.temperature });
      },
      { maxRetries: config.llm.maxRetries, ...this.#d.retry },
    );
    // MockLlmClient (and any third-party client) may return junk as-is; an empty answer is a failure, never a success.
    if (typeof raw !== 'string' || raw.trim() === '' || raw.length > MAX_LLM_OUTPUT_CHARS) {
      throw new LlmError(attempts, new Error(`LLM returned ${typeof raw !== 'string' ? 'a non-string' : raw.trim() === '' ? 'an empty' : 'an oversized'} answer`));
    }
    const llmEntry: TraceEntry = {
      filter: 'llm',
      modified: true,
      ms: performance.now() - llmStart,
      metadata: { attempts, exemplars: exemplars.length, chars: raw.length },
    };

    // 5. POST: style, then confidentiality again.
    const postCtx: PipelineContext = { authorId, personaKey, stage: 'post', profile, extraBannedPhrases: [...persona.bannedPhrases] };
    const post = await this.#d.post.run(raw, postCtx);
    requireConfidentiality(post, 'post');

    // 6. Persona banned phrases: reported, never silently edited (the style filter owns rewriting).
    const trace: TraceEntry[] = [...pre.trace, ...notesTrace, llmEntry, ...post.trace];
    const bannedStart = performance.now();
    const banned = findBannedPhrases(post.text, persona);
    if (banned.length > 0) {
      trace.push({ filter: 'persona-banned', modified: false, ms: performance.now() - bannedStart, metadata: { found: true, count: banned.length } });
    }

    return {
      text: post.text,
      trace,
      promptTokensEstimate: Math.ceil((prompt.system.length + prompt.user.length) / 4),
      ...(mode === 'topic' ? { caveat: TOPIC_CAVEAT } : {}),
    };
  }
}

/** A pipeline result without a successful confidentiality entry did not demonstrably redact: fail closed. */
function requireConfidentiality(out: PipelineOutput, stage: 'pre' | 'post'): void {
  if (!out.trace.some((t) => t.filter === 'confidentiality' && t.error === undefined)) {
    throw new FilterFailedError('confidentiality', new Error(`no successful confidentiality entry in the ${stage} trace`));
  }
}

function resolveOptions(o: GenerateOptions, config: OrchestratorDeps['config']): { exemplarCount: number; maxTokens: number; temperature: number } {
  if (o.mode !== undefined && !(GENERATE_MODES as readonly unknown[]).includes(o.mode)) throw new ConfigError(`generate: mode must be one of ${GENERATE_MODES.join(', ')}`);
  if (o.length !== undefined) {
    if ((o.mode ?? 'rewrite') !== 'topic') throw new ConfigError('generate: length needs mode "topic"');
    if (!(TOPIC_LENGTHS as readonly unknown[]).includes(o.length)) throw new ConfigError(`generate: length must be one of ${TOPIC_LENGTHS.join(', ')}`);
  }
  const exemplarCount = o.exemplarCount ?? DEFAULT_EXEMPLAR_COUNT;
  const maxTokens = o.maxTokens ?? config.llm.maxTokens;
  const temperature = o.temperature ?? config.llm.temperature;
  if (!Number.isInteger(exemplarCount) || exemplarCount < 0 || exemplarCount > MAX_EXEMPLARS) {
    throw new ConfigError(`generate: exemplarCount must be an integer in [0, ${MAX_EXEMPLARS}]`);
  }
  if (!Number.isInteger(maxTokens) || maxTokens < 1) throw new ConfigError('generate: maxTokens must be a positive integer');
  if (typeof temperature !== 'number' || !Number.isFinite(temperature) || temperature < 0 || temperature > 1) {
    throw new ConfigError('generate: temperature must be a number in [0, 1]');
  }
  return { exemplarCount, maxTokens, temperature };
}
