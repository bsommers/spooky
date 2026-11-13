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

## Config shapes (src/models/types.ts section 8; loaded and validated by `loadConfig`)
```ts
export type FilterStageSpec = Stage | 'both';            // where a configured filter runs; config level only
export interface FilterSpec { name: string; stage: FilterStageSpec; onError: OnError; enabled: boolean }   // one entry of the ordered filters.pipeline
export interface ConfigIssue { path: string; message: string }   // e.g. { path: 'llm.model', message: 'is required' }
export interface CustomRuleConfig { name: string; pattern: string; caseInsensitive?: boolean }
export interface ConfidentialityConfig { blocklist: string[]; caseInsensitive: boolean; customRules: CustomRuleConfig[] }
export interface Config {
  limits: { maxInputChars: number };
  chunk: { size: number; overlap: number };
  llm: { model: string; maxTokens: number; temperature: number; maxRetries: number;
         provider?: 'anthropic' | 'openai-compat'; baseUrl?: string; apiKeyEnv?: string };  // apiKeyEnv = variable NAME, never a key
  filters: { pipeline: FilterSpec[] };
  personas: TargetPersonaConfig[];
  confidentiality?: ConfidentialityConfig;   // absent = built-in rules only; reaches the filter via buildPipeline(cfg, stage)
}
```
Rules: `loadConfig` throws `ConfigError` with one `ConfigIssue` per problem (path-qualified); unknown keys are rejected; confidentiality must stay enabled, fail-closed and last at `post`; `openai-compat` requires `llm.baseUrl` (http/https), `baseUrl` is rejected for `anthropic`; custom rules are compiled eagerly (ReDoS/size budget) so a bad rule fails at load.

## Errors (all extend `GhostwriterError { code: string }`)
`ConfigError(CONFIG_INVALID, issues: ConfigIssue[])`, `FilterFailedError(FILTER_FAILED, filter)`, `UnknownPersonaError(UNKNOWN_PERSONA, valid[])`, `UnknownAuthorError(UNKNOWN_AUTHOR)`, `InputTooLargeError(INPUT_TOO_LARGE)`, `LlmError(LLM_FAILED, attempts)`,
`ProfileError(PROFILE_INVALID)` (a corpus that yields no profile, or a profile record that fails validation; names the field, never the value),
`StateLockedError(STATE_LOCKED)` (the state directory lock was not free within the bounded wait),
`StoreCorruptError(STORE_CORRUPT)` (a persisted state file, vector store or profiles, that is unreadable, invalid, incomplete or inconsistent; never carries file content).

## CLI exit codes
0 ok · 1 unexpected/file-system error (reported by class name or errno only) · 2 usage/config/input (`CONFIG_INVALID`, `PROFILE_INVALID`, commander usage errors, unreadable input file, no API key for the selected provider) · 3 unknown persona/author · 4 filter failed (fail-closed) · 5 LLM failed · 6 input too large · 7 persisted state corrupt (`STORE_CORRUPT`) · 8 state directory locked by another process (`STATE_LOCKED`).

`--json` prints exactly one document on stdout: `{ ok: true, ...data }` or `{ ok: false, error: { code, message } }` (code = the error's `code`, `USAGE` for usage errors, `IO_ERROR`/`INTERNAL` for exit 1). Without `--json`: result on stdout, `error: <message>` on stderr. Logs and warnings never go to stdout.

## Surface parity (uniform surfaces)
| Capability | Library | CLI |
|---|---|---|
| ingest corpus | `engine.ingest(authorId, name, text)` | `ghostwriter ingest --author --name <file>` |
| show profile | `engine.getProfile(id)` | `ghostwriter profile <id> [--json]` |
| list personas | `engine.listPersonas()` | `ghostwriter personas` |
| list filters | `engine.listFilters()` | `ghostwriter filters` |
| generate | `engine.generate(authorId, personaKey, input, options?)` | `ghostwriter generate --author --persona [--json]` |

`tests/integration/parity.test.ts` parses this table: every row needs an `Engine` method and a CLI command with the listed flags, and neither surface may have a capability the table lacks. (`Engine.create(options)` / `engine.load()` restore persisted state; the CLI does that implicitly.) Input for `ingest`/`generate` comes from `<file>`, `--file <path>` or stdin; every command accepts `--config`, `--state-dir`, `--json`.

## Persistence (state directory)
`Engine({ stateDir })` / `--state-dir` (default `$GHOSTWRITER_STATE_DIR`, else `$XDG_STATE_HOME/ghostwriter`, else `~/.local/state/ghostwriter`) holds `store.json` (vector store, chunk text) and `profiles.json` (`{format:'ghostwriter-profiles', version:1, profiles[]}`). Both: mode 0600 in a 0700 directory, atomic temp-file + rename, byte-deterministic, written only after redaction. Saved after every ingest/remove inside `SourceManager`'s serialization queue (as are `load()`, `save()`, `restoreProfiles()`); loading validates everything and throws `StoreCorruptError` (or `InputTooLargeError`). Concurrent writers: `Engine.ingest` (hence `ghostwriter ingest`) takes an advisory lock `<stateDir>/.lock` (created `O_EXCL`, mode 0600, holds `{pid, host, token, at}`) around a fresh `load()` + ingest + save, so overlapping ingests are merged, not overwritten. A lock whose pid is gone (same host) or older than `stateLock.staleMs` (default 15 min) is reclaimed; waiting is bounded by `stateLock.waitMs` (default 30 s) and then fails with `StateLockedError` (`STATE_LOCKED`, exit 8). Readers (`generate`, `profile`) do not lock. The file-level order is store first on ingest and profiles first on remove, so a crash between the two writes never leaves a profile without chunks; a failed persist restores the in-memory state to what a restart would load.

## Engine / orchestrator
```ts
Engine.create(options: EngineOptions): Promise<Engine>     // new Engine(options) = no disk access
engine.generate(authorId, personaKey, input, options?: GenerateOptions): Promise<GenerateResult>
```
Flow: size cap (`config.limits.maxInputChars`) -> persona lookup -> author lookup -> (lazy) LLM client -> PRE pipeline -> retrieve with the redacted query -> `buildPrompt` -> `withRetry(llm.complete)` -> empty/non-string/oversized answer = `LlmError` -> POST pipeline -> `findBannedPhrases` -> trace entry `persona-banned` (`{found:true,count}`) only when a banned phrase survives. Trace order: pre filters, `llm` (`{attempts, exemplars, chars}`), post filters, `persona-banned`. A pipeline whose trace has no successful `confidentiality` entry is `FilterFailedError`.

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
