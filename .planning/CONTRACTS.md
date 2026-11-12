# Contracts (single source of truth; all phases import from `src/models/types.ts`)

```ts
// ---------- filters ----------
export type Stage = 'pre' | 'post';
export type OnError = 'fail-closed' | 'skip';

export interface PipelineContext {
  authorId: string;
  personaKey: string;
  stage: Stage;
  profile?: StylometricProfile;          // set by orchestrator before post stage
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

export interface TraceEntry { filter: string; modified: boolean; ms: number; metadata: FilterResult['metadata']; error?: string }
export interface PipelineOutput { text: string; trace: TraceEntry[] }

// ---------- source axis ----------
export interface StylometricProfile {
  authorId: string; displayName: string;
  avgSentenceLength: number; sentenceLengthStdDev: number;
  lexicalDensityRatio: number;            // unique words / total words
  preferredPunctuation: string[];         // top 3 by frequency of ; : — ( ! ?
  hedgingFrequency: number;               // hedges per 100 words
  activePassiveRatio: number;             // heuristic
  commonTransitionWords: string[];        // top 5
  vectorCollectionName: string;
  corpusWordCount: number;
}
export interface Chunk { id: string; authorId: string; text: string; index: number }
export interface ScoredChunk extends Chunk { score: number }

export interface Embedder { readonly dim: number; embed(texts: string[]): Promise<number[][]> }
export interface VectorStore {
  upsert(collection: string, items: { id: string; vector: number[]; chunk: Chunk }[]): Promise<void>;
  query(collection: string, vector: number[], k: number): Promise<ScoredChunk[]>;
  deleteCollection(collection: string): Promise<void>;
  save?(path: string): Promise<void>; load?(path: string): Promise<void>;
}

// ---------- target axis ----------
export interface TargetPersonaConfig {
  key: string; name: string; cognitiveLoad: string; informationDensity: string;
  structuralMandates: string[]; bannedPhrases: string[];
}

// ---------- LLM ----------
export interface LlmRequest { system: string; user: string; maxTokens: number; temperature: number }
export interface LlmClient { complete(req: LlmRequest): Promise<string> }

// ---------- orchestrator ----------
export interface GenerateOptions { exemplarCount?: number; maxTokens?: number; temperature?: number }
export interface GenerateResult { text: string; trace: TraceEntry[]; promptTokensEstimate: number }
```

## Errors (all extend `GhostwriterError { code: string }`)
`ConfigError(CONFIG_INVALID)`, `FilterFailedError(FILTER_FAILED, filter)`, `UnknownPersonaError(UNKNOWN_PERSONA, valid[])`, `UnknownAuthorError(UNKNOWN_AUTHOR)`, `InputTooLargeError(INPUT_TOO_LARGE)`, `LlmError(LLM_FAILED, attempts)`.

## CLI exit codes
0 ok · 2 usage/config · 3 unknown persona/author · 4 filter failed (fail-closed) · 5 LLM failed · 6 input too large.

## Surface parity (uniform surfaces)
| Capability | Library | CLI |
|---|---|---|
| ingest corpus | `engine.ingest(authorId, name, text)` | `ghostwriter ingest --author --name <file>` |
| show profile | `engine.getProfile(id)` | `ghostwriter profile <id> [--json]` |
| list personas | `engine.listPersonas()` | `ghostwriter personas` |
| list filters | `engine.listFilters()` | `ghostwriter filters` |
| generate | `engine.generate(...)` | `ghostwriter generate --author --persona [--json]` |

## Pipeline semantics
- Pre stage runs Confidentiality (and any `pre`/`both` filter). Post stage runs Style then Confidentiality again (`both`).
- `fail-closed`: error -> throw `FilterFailedError`; `skip`: record `error` in trace, continue with previous text.
- Trace metadata must never contain matched values.

## LLM providers
```ts
export type ProviderConfig =
  | { provider: 'anthropic'; model: string; apiKeyEnv: string }                        // default ANTHROPIC_API_KEY
  | { provider: 'openai-compat'; model: string; baseUrl: string; apiKeyEnv?: string }; // e.g. http://localhost:11434/v1
```

## v2 contracts
```ts
export interface ScoreBreakdown { score: number; features: Record<string, { value: number; weight: number; contribution: number }> }
export interface DetectorAdapter { readonly name: string; score(text: string): Promise<number> } // [0,1]
export interface AiLikenessScorer { score(text: string): ScoreBreakdown }
```
