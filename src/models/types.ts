// Single declaration site for every shared type (FND-02).
// Sections 1-7 are .planning/CONTRACTS.md verbatim (error classes live in ./errors.ts); section 8 is Phase 1 additive (config shapes).

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
  features: Record<string, { value: number; weight: number; contribution: number }>;
}
export interface DetectorAdapter {
  readonly name: string;
  score(text: string): Promise<number>; // [0,1]
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

export interface Config {
  limits: { maxInputChars: number };
  chunk: { size: number; overlap: number };
  llm: { model: string; maxTokens: number; temperature: number; maxRetries: number };
  filters: { pipeline: FilterSpec[] };
  personas: TargetPersonaConfig[];
}

/** One path-qualified config problem, e.g. `{ path: 'llm.model', message: 'required' }`. */
export interface ConfigIssue {
  path: string;
  message: string;
}
