// Single declaration site for every shared type (FND-02).
// Sections 1-7 are .planning/CONTRACTS.md verbatim (error classes live in ./errors.ts); section 8 is Phase 1 additive (config shapes).

import type { FeatureName } from '../../config/scorer.js';

// ---------- 1. filters ----------
export type Stage = 'pre' | 'post';
export type OnError = 'fail-closed' | 'skip';

export interface PipelineContext {
  authorId: string;
  personaKey: string;
  stage: Stage;
  profile?: StylometricProfile; // set by orchestrator before post stage
  extraBannedPhrases?: readonly string[]; // from persona
  metadata?: Record<string, unknown>;
}

export interface FilterResult {
  content: string;
  modified: boolean;
  metadata: Record<string, number | string | boolean>; // counts/flags only, never matched text
}

export interface Filter {
  readonly name: string;
  readonly stages: readonly Stage[];
  readonly onError: OnError;
  process(text: string, ctx: PipelineContext): Promise<FilterResult>;
}

export interface TraceEntry {
  filter: string;
  modified: boolean;
  ms: number;
  metadata: FilterResult['metadata'];
  error?: string;
}
export interface PipelineOutput {
  text: string;
  trace: TraceEntry[];
}

// ---------- 2. source axis ----------
export interface StylometricProfile {
  authorId: string;
  displayName: string;
  avgSentenceLength: number;
  sentenceLengthStdDev: number;
  lexicalDensityRatio: number; // unique words / total words
  preferredPunctuation: string[]; // top 3 by frequency of ; : — ( ! ?
  hedgingFrequency: number; // hedges per 100 words
  activePassiveRatio: number; // heuristic
  commonTransitionWords: string[]; // top 5
  vectorCollectionName: string;
  corpusWordCount: number;
}
export interface Chunk {
  id: string;
  authorId: string;
  text: string;
  index: number;
}
export interface ScoredChunk extends Chunk {
  score: number;
}

export interface Embedder {
  readonly dim: number;
  embed(texts: string[]): Promise<number[][]>;
}
export interface VectorStore {
  upsert(collection: string, items: { id: string; vector: number[]; chunk: Chunk }[]): Promise<void>;
  query(collection: string, vector: number[], k: number): Promise<ScoredChunk[]>;
  deleteCollection(collection: string): Promise<void>;
  /** Optional atomic replace: afterwards the collection holds exactly `items`; on rejection the old contents are unchanged. */
  replaceCollection?(collection: string, items: { id: string; vector: number[]; chunk: Chunk }[]): Promise<void>;
  save?(path: string): Promise<void>;
  load?(path: string): Promise<void>;
}

// ---------- 3. target axis ----------
export interface TargetPersonaConfig {
  key: string;
  name: string;
  cognitiveLoad: string;
  informationDensity: string;
  structuralMandates: string[];
  bannedPhrases: string[];
}

// ---------- 4. LLM ----------
export interface LlmRequest {
  system: string;
  user: string;
  maxTokens: number;
  temperature: number;
}
export interface LlmClient {
  complete(req: LlmRequest): Promise<string>;
}

// ---------- 5. orchestrator ----------
export interface GenerateOptions {
  exemplarCount?: number;
  maxTokens?: number;
  temperature?: number;
}
export interface GenerateResult {
  text: string;
  trace: TraceEntry[];
  promptTokensEstimate: number;
}

// ---------- 6. LLM providers ----------
export type ProviderConfig =
  | { provider: 'anthropic'; model: string; apiKeyEnv: string } // default ANTHROPIC_API_KEY
  | { provider: 'openai-compat'; model: string; baseUrl: string; apiKeyEnv?: string }; // e.g. http://localhost:11434/v1

// ---------- 7. v2 contracts ----------
export interface ScoreBreakdown {
  score: number;
  /**
   * One entry per feature. `weight` is the weight actually applied (configured weights normalized over the features
   * that could be computed; 0 for a feature left out), `contribution = value * weight`, and the contributions sum to
   * `score` (except for the `insufficient_text` result, whose score is the neutral 0.5 and whose contributions are 0).
   */
  features: Record<string, { value: number; weight: number; contribution: number }>;
  /** Phase 7, additive. `insufficient_text`, `low_confidence` (< 50 words), `unavailable:<feature>`. */
  flags?: string[];
  /** Phase 7, additive. What was measured (protected spans excluded). */
  stats?: { words: number; sentences: number; paragraphs: number };
}
/**
 * An external AI-text detector. `score` resolves to a number in [0,1] where 1 means "reads machine-generated" and 0
 * means "reads human-written" (the direction of the local heuristic). A detector that reports P(human) must be
 * inverted by the adapter: the ensemble averages whatever it gets and cannot tell the directions apart. `signal` aborts
 * when the ensemble gives up on this call (timeout): stop work, close sockets and drop the text.
 */
export interface DetectorAdapter {
  readonly name: string;
  score(text: string, signal?: AbortSignal): Promise<number>; // [0,1], 1 = machine-generated
}
export interface AiLikenessScorer {
  score(text: string): ScoreBreakdown;
}

// ---------- 8. config shapes (Phase 1 additive; not in CONTRACTS.md) ----------
/** Where a configured filter runs. `both` = pre and post. Config-level only; `Filter.stages` stays `Stage[]`. */
export type FilterStageSpec = Stage | 'both';

/** One entry of the ordered `filters.pipeline` list. Order of the list is execution order. */
export interface FilterSpec {
  name: string;
  stage: FilterStageSpec;
  onError: OnError;
  enabled: boolean;
}

/** A user-defined redaction rule. Same shape as the confidentiality filter's `CustomRule`; validated when the config loads. */
export interface CustomRuleConfig {
  /** Becomes the placeholder type `[REDACTED:<name>]`; lowercase letters, digits, underscore. */
  name: string;
  /** Regex source with bounded quantifiers only (see the confidentiality filter's ReDoS budget). */
  pattern: string;
  caseInsensitive?: boolean;
}

/** Confidentiality filter options carried by the config (Phase 2 IN-01). Absent section = built-in rules only. */
export interface ConfidentialityConfig {
  /** Literal terms to redact (never regex). */
  blocklist: string[];
  /** Applies to the blocklist only. */
  caseInsensitive: boolean;
  customRules: CustomRuleConfig[];
}

/** One external detector reachable over HTTP (Phase 7). Declared here, called only when a score request names it. */
export interface DetectorConfig {
  /** Lower-case id used by `--detector <name>`; `local` is reserved. */
  name: string;
  /**
   * https endpoint (http only for localhost / 127.0.0.0/8 / ::1) that accepts `POST {"text": "..."}` and answers
   * `{"score": <0..1>}` where 1 = machine-generated and 0 = human-written, the same direction as the local score. A
   * service that returns P(human) must be fronted by a shim that inverts it; there is no `invert` option.
   */
  url: string;
  /** Environment variable that holds a bearer token. Never the token itself. */
  apiKeyEnv?: string;
  /** Weight in the ensemble mean. */
  weight: number;
  timeoutMs: number;
}

/** AI-likeness scorer settings (Phase 7). Absent section = built-in defaults, no external detectors. */
export interface ScorerConfig {
  /** Per-feature weights; any non-negative set with a positive sum, normalized when the scorer is built. */
  weights: Record<FeatureName, number>;
  /** Weight of the local heuristic in the ensemble mean. */
  localWeight: number;
  detectors: DetectorConfig[];
}

export interface Config {
  limits: { maxInputChars: number };
  chunk: { size: number; overlap: number };
  llm: {
    model: string;
    maxTokens: number;
    temperature: number;
    maxRetries: number;
    /** Provider selection; absent = `anthropic`. The API key is never configured, only the env var NAME that holds it. */
    provider?: 'anthropic' | 'openai-compat';
    /** Required for `openai-compat` (http/https origin + path), rejected otherwise. */
    baseUrl?: string;
    /** Environment variable that holds the key. Anthropic default: ANTHROPIC_API_KEY. Optional for openai-compat. */
    apiKeyEnv?: string;
  };
  filters: { pipeline: FilterSpec[] };
  personas: TargetPersonaConfig[];
  confidentiality?: ConfidentialityConfig;
  scorer?: ScorerConfig;
}

/** One path-qualified config problem, e.g. `{ path: 'llm.model', message: 'required' }`. */
export interface ConfigIssue {
  path: string;
  message: string;
}

// ---------- 9. scoring (Phase 7 additive) ----------
/** A member of the score ensemble that produced a valid score. `weight` is normalized over the contributing members. */
export interface EnsembleMember {
  /** `local` for the built-in heuristic, else the detector's name. */
  name: string;
  score: number;
  weight: number;
}
/** A requested detector that did not contribute. `reason` is a fixed word or `error:<ClassName>`; never a message. */
export interface EnsembleExclusion {
  name: string;
  reason: string;
}
export interface ScoreOptions {
  /** Names of configured / registered detectors to include. Absent or empty = the local heuristic only, nothing leaves the process. */
  detectors?: readonly string[];
}
export interface ScoreResult {
  /** Ensemble score in [0,1] (equals `local.score` when no detector contributed). */
  score: number;
  /** The local heuristic's breakdown, computed on the redacted text. */
  local: ScoreBreakdown;
  members: EnsembleMember[];
  excluded: EnsembleExclusion[];
  /** Confidentiality trace of the redaction that ran first. */
  trace: TraceEntry[];
}
