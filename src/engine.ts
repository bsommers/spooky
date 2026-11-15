// Engine facade (ORC-01): the library surface of the ghostwriter. Every capability the CLI offers is a method here
// (.planning/CONTRACTS.md "Surface parity"); the CLI is a thin adapter over this class.
//
//   const engine = await Engine.create({ config, stateDir });   // restores earlier ingests when stateDir is set
//   await engine.ingest('ann', 'Ann Author', corpusText);
//   const { text, trace } = await engine.generate('ann', 'executive', draft);
//
// Without `stateDir` the engine is purely in-memory. With it, ingests are written to `<stateDir>/store.json` and
// `<stateDir>/profiles.json` (0600, atomic) and `Engine.create` / `load()` restores them, so ingest and generate can
// run in different processes.
//
// `engine.score(text, { detectors? })` rates how machine-written a text reads (local heuristic, optionally averaged
// with named external detectors) after the text went through the confidentiality filter; no LLM and no state needed.
//
// The LLM client is created lazily, on the first `generate`, from `config.llm` (provider, model, key env var NAME).
// Commands that never call a model (ingest, profile, personas, filters) therefore work with no API key. API keys are
// only ever read from the environment, by `createLlmClient`.
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadConfig } from './config/load.js';
import { buildConfigView } from './config/view.js';
import type { ConfigView } from './config/view.js';
import { HashEmbedder } from './embedding/hashEmbedder.js';
import type { FilterPipeline } from './filters/pipeline.js';
import { buildPipeline } from './filters/registry.js';
import type { FilterFactories } from './filters/registry.js';
import { createLlmClient } from './llm/factory.js';
import { DEFAULT_DETECTOR_TIMEOUT_MS } from '../config/scorer.js';
import { DEFAULT_HUMANIZE, MAX_HUMANIZE_ITERATIONS } from '../config/humanize.js';
import { HumanizeFilter } from './filters/humanize.js';
import type { FetchLike } from './llm/http.js';
import type { CreateLlmClientOptions } from './llm/factory.js';
import type { RetryOptions } from './llm/retry.js';
import { ConfigError, FilterFailedError, InputTooLargeError } from './models/errors.js';
import type { Config, DetectorAdapter, Embedder, EngineGenerateOptions, FilterSpec, GenerateResult, HumanizeOptions, HumanizeResult, LlmClient, ProviderConfig, ScoreOptions, ScoreResult, StylometricProfile, TargetPersonaConfig, TraceEntry, VectorStore } from './models/types.js';
import { Orchestrator } from './orchestration/orchestrator.js';
import { HttpDetectorAdapter, assertDetectorAdapter } from './scoring/detectorAdapter.js';
import { runEnsemble } from './scoring/ensemble.js';
import { HeuristicScorer } from './scoring/scorer.js';
import { SourceManager } from './registry/sourceManager.js';
import { withStateLock } from './registry/stateLock.js';
import type { StateLockOptions } from './registry/stateLock.js';
import type { SourceLimits } from './registry/sourceManager.js';
import { TargetManager, findBannedPhrases } from './registry/targetManager.js';
import { InMemoryVectorStore } from './store/inMemoryVectorStore.js';

export const STORE_FILE = 'store.json';
export const PROFILES_FILE = 'profiles.json';
const DEFAULT_ANTHROPIC_KEY_ENV = 'ANTHROPIC_API_KEY';

export interface EngineOptions {
  /** A loaded `Config` or the raw object; it is (re)validated by `loadConfig`, so a hand-built config cannot skip the checks. */
  config: Config;
  /** Directory for persisted ingests. Absent = in-memory only. Created (0700) on first save. */
  stateDir?: string;
  /** Inject a client (tests, custom providers). Absent = created lazily from `config.llm`. */
  llm?: LlmClient;
  /** Environment used to find the API key. Default `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Extra options for the lazily created real client (timeouts, size cap, fetch). */
  llmClientOptions?: Omit<CreateLlmClientOptions, 'env'>;
  /** Retry tuning for the orchestrator's LLM call (backoff, fake sleep). `maxRetries` defaults to `config.llm.maxRetries`. */
  retry?: RetryOptions;
  /** Custom filter factories (replace the config-derived built-ins). */
  factories?: FilterFactories;
  embedder?: Embedder;
  /** Vector store; needs save()/load() when `stateDir` is set. Default `InMemoryVectorStore`. */
  store?: VectorStore;
  sourceLimits?: SourceLimits;
  /** Wait / stale / poll tuning for the cross-process state-directory lock taken by `ingest` (only with `stateDir`). */
  stateLock?: StateLockOptions;
  /**
   * Extra score detectors (library use, tests). Registered next to the ones declared in `config.scorer.detectors`; the same
   * name replaces the declared one. Registering never calls anything: a detector runs only when `score()` names it.
   */
  detectors?: readonly DetectorAdapter[];
  /** `fetch` for the HTTP detectors declared in config (tests). Default: global `fetch`. */
  detectorFetch?: FetchLike;
}

/** `$GHOSTWRITER_STATE_DIR`, else `$XDG_STATE_HOME/ghostwriter`, else `~/.local/state/ghostwriter`. */
export function defaultStateDir(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const explicit = env.GHOSTWRITER_STATE_DIR;
  if (explicit !== undefined && explicit !== '') return explicit;
  const xdg = env.XDG_STATE_HOME;
  return join(xdg !== undefined && xdg !== '' ? xdg : join(homedir(), '.local', 'state'), 'ghostwriter');
}

export class Engine {
  readonly #config: Config;
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #sources: SourceManager;
  readonly #targets: TargetManager;
  readonly #orchestrator: Orchestrator;
  readonly #hasState: boolean;
  readonly #stateDir: string | undefined;
  readonly #stateLock: StateLockOptions;
  readonly #pre: FilterPipeline;
  readonly #maxInputChars: number;
  readonly #scorer: HeuristicScorer;
  readonly #detectors = new Map<string, DetectorAdapter>();
  readonly #detectorWeights = new Map<string, number>(); // a Map: a detector may legally be named like an Object.prototype key
  readonly #detectorTimeouts = new Map<string, number>();
  readonly #getLlm: () => LlmClient;
  readonly #retry: RetryOptions | undefined;

  /** Builds the engine without touching the disk. Prefer `Engine.create`, which also restores persisted state. */
  constructor(options: EngineOptions) {
    const config = loadConfig(structuredClone(options.config)); // validate + detach from the caller's object
    this.#config = config;
    const env = options.env ?? process.env;
    this.#env = env;
    const pre = buildPipeline(config, 'pre', options.factories);
    const post = buildPipeline(config, 'post', options.factories);
    const dir = options.stateDir;
    if (dir !== undefined && (typeof dir !== 'string' || dir === '')) throw new ConfigError('stateDir must be a non-empty path');
    this.#hasState = dir !== undefined;
    this.#stateDir = dir;
    this.#stateLock = { ...options.stateLock };
    this.#sources = new SourceManager({
      store: options.store ?? new InMemoryVectorStore(),
      embedder: options.embedder ?? new HashEmbedder(),
      confidentiality: pre,
      chunkCfg: config.chunk,
      ...(options.sourceLimits === undefined ? {} : { limits: options.sourceLimits }),
      ...(dir === undefined ? {} : { persistence: { storePath: join(dir, STORE_FILE), profilesPath: join(dir, PROFILES_FILE) } }),
    });
    this.#targets = new TargetManager(Object.fromEntries(config.personas.map((p) => [p.key, p])));

    this.#pre = pre;
    this.#maxInputChars = config.limits.maxInputChars;
    this.#scorer = new HeuristicScorer(config.scorer?.weights);
    this.#detectorWeights.set('local', config.scorer?.localWeight ?? 1);
    for (const d of config.scorer?.detectors ?? []) {
      this.#detectors.set(d.name, new HttpDetectorAdapter(d, { env, ...(options.detectorFetch === undefined ? {} : { fetch: options.detectorFetch }) }));
      this.#detectorWeights.set(d.name, d.weight);
      this.#detectorTimeouts.set(d.name, d.timeoutMs);
    }
    for (const d of options.detectors ?? []) {
      assertDetectorAdapter(d);
      this.#detectors.set(d.name, d);
      if (!this.#detectorWeights.has(d.name)) this.#detectorWeights.set(d.name, 1);
    }

    let client = options.llm;
    this.#getLlm = () =>
      (client ??= createLlmClient(providerConfig(config), {
        ...options.llmClientOptions,
        env,
        retry: { maxRetries: config.llm.maxRetries, ...options.llmClientOptions?.retry },
      }));
    this.#retry = options.retry;
    this.#orchestrator = new Orchestrator({
      config,
      sources: this.#sources,
      targets: this.#targets,
      pre,
      post,
      llm: this.#getLlm,
      ...(options.retry === undefined ? {} : { retry: options.retry }),
    });
  }

  /** Construct the engine and restore persisted ingests from `stateDir` (a no-op without one). */
  static async create(options: EngineOptions): Promise<Engine> {
    const engine = new Engine(options);
    await engine.load();
    return engine;
  }

  /** Re-read the persisted state. `StoreCorruptError` for bad files; a no-op when the engine has no `stateDir`. */
  async load(): Promise<void> {
    if (this.#hasState) await this.#sources.load();
  }

  /**
   * Redact, profile, chunk, embed and store a corpus (and persist it when `stateDir` is set). Returns the profile.
   * With a `stateDir` the whole read-modify-write runs under the state-directory lock and starts from a fresh read of
   * the files, so overlapping ingests from other processes are merged instead of overwritten (`StateLockedError` if the
   * lock is not free within `stateLock.waitMs`).
   */
  ingest(authorId: string, displayName: string, text: string): Promise<StylometricProfile> {
    const dir = this.#stateDir;
    if (dir === undefined) return this.#sources.ingest(authorId, displayName, text);
    return withStateLock(
      dir,
      async () => {
        await this.#sources.load();
        return this.#sources.ingest(authorId, displayName, text);
      },
      this.#stateLock,
    );
  }

  /** The stored profile of `authorId`. `UnknownAuthorError` if it was never ingested. */
  getProfile(authorId: string): StylometricProfile {
    return this.#sources.getProfile(authorId);
  }

  /** Every ingested author's profile, sorted by author id (copies). */
  listAuthors(): StylometricProfile[] {
    return this.#sources.listAuthors();
  }

  /**
   * Read-only, redacted view of the effective configuration: provider, model, endpoint HOSTS, the NAMES of key
   * environment variables (never their values), limits, filters, persona keys, scorer settings (src/config/view.ts).
   */
  getConfigView(): ConfigView {
    return buildConfigView(this.#config, this.#env);
  }

  /** Every configured persona, sorted by key. */
  listPersonas(): TargetPersonaConfig[] {
    return this.#targets.list();
  }

  /** The configured filter pipeline, in execution order (copies). */
  listFilters(): FilterSpec[] {
    return this.#config.filters.pipeline.map((f) => ({ ...f }));
  }

  /**
   * AI-likeness score of `text` in [0,1] (0 reads human, 1 reads machine-generated) with a per-feature breakdown. A
   * heuristic proxy, not a detector verdict (docs/CALIBRATION.md). The text goes through the PRE pipeline
   * (confidentiality) first, and the heuristic and every detector see only the redacted text. By default nothing leaves
   * the process; `options.detectors` names configured / registered external detectors to average in, and that SENDS
   * the redacted text to them. A detector that fails or answers outside [0,1] is excluded and recorded.
   *
   * `ConfigError` for a non-string text or an unknown detector name (checked before any filter or call),
   * `InputTooLargeError` above `limits.maxInputChars`, `FilterFailedError` if the redaction cannot be shown to have run,
   * `DetectorsFailedError` if `scorer.localWeight` is 0 and no requested detector produced a score.
   */
  async score(text: string, options: ScoreOptions = {}): Promise<ScoreResult> {
    if (typeof text !== 'string') throw new ConfigError('score: text must be a string');
    if (text.length > this.#maxInputChars) throw new InputTooLargeError(text.length, this.#maxInputChars);
    const requested = options.detectors ?? [];
    if (!Array.isArray(requested) || requested.some((n) => typeof n !== 'string')) throw new ConfigError('score: detectors must be an array of names');
    const names = [...new Set(requested)];
    const unknown = names.filter((n) => !this.#detectors.has(n));
    if (unknown.length > 0) {
      const valid = [...this.#detectors.keys()].sort();
      // The name is caller input and may be secret-shaped: report how many (and how long), never the text (like UnknownAuthorError).
      throw new ConfigError(`unknown detector${unknown.length === 1 ? '' : 's'} (${unknown.map((n) => `${n.length} characters`).join(', ')}); ${valid.length === 0 ? 'none are configured (scorer.detectors)' : `configured: ${valid.join(', ')}`}`);
    }
    const adapters = names.map((n) => this.#detectors.get(n) as DetectorAdapter);

    const pre = await this.#pre.run(text, { authorId: '(score)', personaKey: '(score)', stage: 'pre' });
    if (!pre.trace.some((t) => t.filter === 'confidentiality' && t.error === undefined)) {
      throw new FilterFailedError('confidentiality', new Error('no successful confidentiality entry in the pre trace'));
    }
    // The adapter's own abort fires first; the ensemble's limit is only the backstop for an adapter without one.
    const timeoutMs = Math.max(DEFAULT_DETECTOR_TIMEOUT_MS, ...names.map((n) => (this.#detectorTimeouts.get(n) ?? 0) + 1000));
    // Weights only for the members of this call: the ensemble rejects a weight that names no member.
    const weights = new Map<string, number>([['local', this.#detectorWeights.get('local') ?? 1]]);
    for (const n of names) weights.set(n, this.#detectorWeights.get(n) ?? 1);
    const r = await runEnsemble(pre.text, this.#scorer, adapters, { weights, timeoutMs });
    return { score: r.score, local: r.local, members: r.members, excluded: r.excluded, trace: pre.trace };
  }

  /**
   * Rewrite `input` in the voice of `authorId` for `personaKey`. See `Orchestrator.generate` for the flow and errors.
   * `options.humanize` then runs the humanizer loop (`humanize()`) on the generated text, targeting `options.target`; the
   * result's trace gains the humanizer's entries. The humanizer never fails the generation: if it cannot improve the text it
   * returns it unchanged.
   */
  async generate(authorId: string, personaKey: string, input: string, options: EngineGenerateOptions = {}): Promise<GenerateResult> {
    const { humanize, target, ...rest } = options;
    if (humanize === true || target !== undefined) this.#humanizeSettings({ ...(target === undefined ? {} : { target }) }); // validate before the model is called
    const r = await this.#orchestrator.generate(authorId, personaKey, input, rest);
    if (humanize !== true) return r;
    // The generated text already went through the post pipeline (style, then confidentiality). The humanizer runs on it and
    // re-runs confidentiality on every candidate and on its result, so the text returned here is redacted last.
    // The persona's banned phrases are enforced on every candidate (a rewrite that adds one is rejected) and re-checked on the
    // result, so the `persona-banned` trace entry (and the CLI warning built on it) describes the text actually returned.
    const persona = this.#targets.get(personaKey);
    const h = await this.#humanizeRedacted(r.text, { authorId, ...(target === undefined ? {} : { target }), ...(rest.maxTokens === undefined ? {} : { maxTokens: rest.maxTokens }), ...(rest.temperature === undefined ? {} : { temperature: rest.temperature }) }, (t) => findBannedPhrases(t, persona));
    const banned = findBannedPhrases(h.text, persona);
    const bannedEntry: TraceEntry[] = banned.length > 0 ? [{ filter: 'persona-banned', modified: false, ms: 0, metadata: { found: true, count: banned.length } }] : [];
    return { text: h.text, trace: [...r.trace.filter((t) => t.filter !== 'persona-banned'), ...h.trace, ...bannedEntry], promptTokensEstimate: r.promptTokensEstimate };
  }

  /**
   * Lower the AI-likeness score of `text` without changing what it says (docs/HUMANIZING.md). A bounded loop: score, edit
   * the two worst-scoring features (deterministic edits first, then one model call per iteration), then confidentiality,
   * the meaning guard (numbers, names, quotes, code and URLs must be unchanged) and a rescore; an edit is kept only when it
   * passed the guard and scored strictly lower. Stops at `target` (default `humanize.targetScore`, 0.3) or after
   * `maxIterations` (default 3); the best-scoring version is returned, not the last. The score that drives it is the local
   * heuristic, a weak and confounded proxy (docs/CALIBRATION.md): a lower score is not evidence about any real detector.
   *
   * The model is called only when `llm` is not false, and a model failure keeps the prior text (recorded in the trace).
   * The text goes through the PRE pipeline (confidentiality) first, so the model never sees a secret.
   *
   * `ConfigError` for a bad option, `InputTooLargeError` above `limits.maxInputChars`, `UnknownAuthorError` for an
   * unknown `authorId`, `FilterFailedError` if the redaction cannot be shown to have run.
   */
  async humanize(text: string, options: HumanizeOptions = {}): Promise<HumanizeResult> {
    if (typeof text !== 'string') throw new ConfigError('humanize: text must be a string');
    if (text.length > this.#maxInputChars) throw new InputTooLargeError(text.length, this.#maxInputChars);
    if (text.trim() === '') throw new ConfigError('humanize: text must not be blank');
    this.#humanizeSettings(options); // before anything else: a typo costs nothing
    if (options.authorId !== undefined) this.#sources.getProfile(options.authorId); // UnknownAuthorError
    const pre = await this.#pre.run(text, { authorId: options.authorId ?? '(humanize)', personaKey: '(humanize)', stage: 'pre' });
    requireConfidentiality(pre.trace);
    const r = await this.#humanizeRedacted(pre.text, options);
    return { ...r, trace: [...pre.trace, ...r.trace] };
  }

  /** Validated target / maxIterations / sampling settings, defaults from `config.humanize`. */
  #humanizeSettings(o: HumanizeOptions): { target: number; maxIterations: number; maxTokens: number; temperature: number } {
    const cfg = this.#config.humanize ?? DEFAULT_HUMANIZE;
    const target = o.target ?? cfg.targetScore;
    const maxIterations = o.maxIterations ?? cfg.maxIterations;
    const maxTokens = o.maxTokens ?? this.#config.llm.maxTokens;
    const temperature = o.temperature ?? this.#config.llm.temperature;
    if (typeof target !== 'number' || !Number.isFinite(target) || target < 0 || target > 1) throw new ConfigError('humanize: target must be a number in [0, 1]');
    if (!Number.isInteger(maxIterations) || maxIterations < 0 || maxIterations > MAX_HUMANIZE_ITERATIONS) throw new ConfigError(`humanize: maxIterations must be an integer in [0, ${MAX_HUMANIZE_ITERATIONS}]`);
    if (!Number.isInteger(maxTokens) || maxTokens < 1) throw new ConfigError('humanize: maxTokens must be a positive integer');
    if (typeof temperature !== 'number' || !Number.isFinite(temperature) || temperature < 0 || temperature > 1) throw new ConfigError('humanize: temperature must be a number in [0, 1]');
    if (o.llm !== undefined && typeof o.llm !== 'boolean') throw new ConfigError('humanize: llm must be a boolean');
    return { target, maxIterations, maxTokens, temperature };
  }

  /** The loop on text that already went through confidentiality. Every candidate is redacted again by the same pre pipeline. */
  async #humanizeRedacted(redacted: string, o: HumanizeOptions, banned?: (text: string) => readonly string[]): Promise<HumanizeResult> {
    const settings = this.#humanizeSettings(o);
    const profile = o.authorId === undefined ? undefined : this.#sources.getProfile(o.authorId);
    const redact = async (t: string): Promise<{ text: string; modified: boolean }> => {
      const out = await this.#pre.run(t, { authorId: o.authorId ?? '(humanize)', personaKey: '(humanize)', stage: 'pre' });
      requireConfidentiality(out.trace);
      return { text: out.text, modified: out.text !== t };
    };
    const filter = new HumanizeFilter({
      deps: { score: (t) => this.#scorer.score(t), redact, llm: this.#getLlm, ...(banned === undefined ? {} : { banned }), ...(this.#retry === undefined ? {} : { retry: this.#retry }) },
      ...settings,
      useLlm: o.llm !== false,
    });
    return filter.run(redacted, profile);
  }
}

/** A pipeline run without a successful confidentiality entry did not demonstrably redact: fail closed. */
function requireConfidentiality(trace: readonly { filter: string; error?: string }[]): void {
  if (!trace.some((t) => t.filter === 'confidentiality' && t.error === undefined)) {
    throw new FilterFailedError('confidentiality', new Error('no successful confidentiality entry in the trace'));
  }
}

/** `config.llm` -> the provider config for `createLlmClient`. Pure; reads no environment. */
export function providerConfig(config: Pick<Config, 'llm'>): ProviderConfig {
  const { provider = 'anthropic', model, baseUrl, apiKeyEnv } = config.llm;
  if (provider === 'openai-compat') {
    if (baseUrl === undefined) throw new ConfigError('llm.baseUrl is required for provider "openai-compat"', [{ path: 'llm.baseUrl', message: 'is required' }]);
    return { provider, model, baseUrl, ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }) };
  }
  return { provider: 'anthropic', model, apiKeyEnv: apiKeyEnv ?? DEFAULT_ANTHROPIC_KEY_ENV };
}
