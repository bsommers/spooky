// The operations registry (Phase 9): the ONE declaration of what the ghostwriter can do. The CLI, the HTTP API, the MCP
// server and the OpenAPI document are adapters over this array; none of them declares an operation of its own, and
// tests/integration/surfaces-parity.test.ts fails when a surface and the registry disagree.
//
//   const out = await invokeOperation(operation('generate'), engine, { authorId, persona, text });
//
// An operation's input is a strict zod object (unknown fields are an error, on every surface); its handler is a thin call
// into the Engine. Output is always an object, reported as `{ ok: true, ...output }` by every surface.
//
// Capability discovery: an operation exists here when the Engine has the capability. A capability planned but not built
// is listed in `PENDING_CAPABILITIES` (never faked as an operation); the parity test enumerates it and fails the moment
// the Engine gains the method without a registry entry, so a pending capability cannot be forgotten.
import { z } from 'zod';
import { HEURISTIC_HELD_OUT_AUC } from '../../config/humanize.js';
import type { Engine } from '../engine.js';
import type { ConfigView } from '../config/view.js';
import type { StylometricProfile } from '../models/types.js';
import { InputError } from './errors.js';
import * as S from './schemas.js';

export type OperationName = 'ingest' | 'generate' | 'score' | 'humanize' | 'profile' | 'authors' | 'personas' | 'filters' | 'config_get' | 'capabilities';

/** How an operation appears on the command line (the parity test checks the real commander program against this). */
export interface CliBinding {
  /** `['config', 'get']` for `ghostwriter config get`. */
  command: readonly string[];
  /** Positional arguments, in order; each fills the named input field. */
  arguments: readonly { name: string; field: string; description: string }[];
  /** Flags the command must expose (beyond the common --config / --state-dir / --json). */
  flags: readonly string[];
  /** `true`: the generic builder creates the command from this binding. `false`: hand-written (reads a file or stdin). */
  derived: boolean;
}

export interface Operation<I extends z.ZodObject = z.ZodObject, O extends z.ZodObject = z.ZodObject> {
  readonly name: OperationName;
  readonly description: string;
  readonly input: I;
  readonly output: O;
  /** Changes persisted state. Only `ingest` does; it is the one MCP tool annotated `readOnlyHint: false`. */
  readonly mutates: boolean;
  /** Sends text to a service outside this process when asked to (the model, or a named detector). */
  readonly openWorld: boolean;
  /** Reads the persisted state, so a server refreshes it first when another process wrote it. */
  readonly readsState: boolean;
  /** `Engine` method this operation is a thin call to; `null` for a service-level operation (capabilities). */
  readonly engineMethod: string | null;
  readonly http: { readonly method: 'GET' | 'POST'; readonly path: string };
  readonly cli: CliBinding;
  /** Text-mode rendering for the CLI; `--json`, HTTP and MCP use the data itself. */
  render(out: z.output<O>): string;
  handler(engine: Engine, input: z.output<I>): Promise<z.output<O>> | z.output<O>;
}

export type AnyOperation = Operation;

/** A capability that is planned but not built. Enumerated by the parity test and by `capabilities`; has no adapters. */
export interface PendingCapability {
  readonly name: string;
  readonly phase: number;
  readonly summary: string;
  /** The `Engine` method that will exist once it is built; when it appears, the registry must gain the operation. */
  readonly engineMethod: string;
}

/** Planned but not built. Empty since Phase 8 built `humanize`; kept so the next planned capability has a place to be listed. */
export const PENDING_CAPABILITIES: readonly PendingCapability[] = [];

/** Said on every surface next to a humanizer result: what the scores mean. */
export const HUMANIZE_CAVEAT = `Scores are from the local heuristic, a weak and confounded proxy (held-out AUC ${HEURISTIC_HELD_OUT_AUC}, docs/CALIBRATION.md), not a detector verdict. A lower score is not evidence that any real detector would pass the text. No external detector has been tested (docs/HUMANIZING.md).`;

function define<I extends z.ZodObject, O extends z.ZodObject>(op: Operation<I, O>): Operation<I, O> {
  return op;
}

const profileText = (p: StylometricProfile): string =>
  [
    `author: ${p.authorId} (${p.displayName})`,
    `words: ${p.corpusWordCount}`,
    `avg sentence length: ${p.avgSentenceLength.toFixed(1)} (sd ${p.sentenceLengthStdDev.toFixed(1)})`,
    `lexical density: ${p.lexicalDensityRatio.toFixed(3)}`,
    `hedging per 100 words: ${p.hedgingFrequency.toFixed(2)}`,
    `active/passive ratio: ${p.activePassiveRatio.toFixed(2)}`,
    `punctuation: ${p.preferredPunctuation.join(' ') || '-'}`,
    `transitions: ${p.commonTransitionWords.join(', ') || '-'}`,
  ].join('\n');

const configText = (c: ConfigView): string => {
  const lines = [
    `llm: ${c.llm.provider} ${c.llm.model}${c.llm.baseUrlHost === undefined ? '' : ` @ ${c.llm.baseUrlHost}`}`,
    `llm key variable: ${c.llm.apiKeyEnv === undefined ? '(none)' : `${c.llm.apiKeyEnv} (${c.llm.apiKeyEnvSet === true ? 'set' : 'not set'})`}`,
    `llm: maxTokens ${c.llm.maxTokens}, temperature ${c.llm.temperature}, maxRetries ${c.llm.maxRetries}`,
    `limits: maxInputChars ${c.limits.maxInputChars}`,
    `chunk: size ${c.chunk.size}, overlap ${c.chunk.overlap}`,
    `filters: ${c.filters.map((f) => `${f.name}${f.enabled ? '' : ' (disabled)'}`).join(', ')}`,
    `personas: ${c.personas.join(', ')}`,
    `confidentiality: ${c.confidentiality.blocklistTerms} blocklist term(s), ${c.confidentiality.customRules} custom rule(s)`,
    `scorer: localWeight ${c.scorer.localWeight}`,
    `state directory: ${c.stateDir ?? '(none, in memory only)'}`,
  ];
  for (const d of c.scorer.detectors) lines.push(`  detector ${d.name}: ${d.scheme}://${d.host}${d.apiKeyEnv === undefined ? '' : ` key ${d.apiKeyEnv} (${d.apiKeyEnvSet === true ? 'set' : 'not set'})`}`);
  return lines.join('\n');
};

const ingest = define({
  name: 'ingest',
  description: "Profile and store an author's corpus. Secrets are redacted before anything is stored. Replaces an earlier ingest of the same author id.",
  input: S.ingestInput,
  output: S.ingestOutput,
  mutates: true,
  openWorld: false,
  readsState: false,
  engineMethod: 'ingest',
  http: { method: 'POST', path: '/api/ingest' },
  cli: { command: ['ingest'], arguments: [], flags: ['--author', '--name', '--file'], derived: false },
  render: (o) => `ingested ${o.profile.authorId}: ${o.profile.corpusWordCount} words`,
  async handler(engine, input) {
    return { profile: await engine.ingest(input.authorId, input.name, input.text) };
  },
});

const generate = define({
  name: 'generate',
  description:
    "Rewrite a draft in an ingested author's voice for a target persona (mode rewrite, the default), or write NEW text about a topic in that voice (mode topic: text is the topic; optional notes are facts and source material you supply, optional length is short, medium or long). Topic mode does no research and has no web search: the model writes from the topic, the notes and its own knowledge, may state things that are wrong, and the result carries a fixed caveat that facts are not verified. Calls the configured language model; the draft (or topic and notes) is redacted first and the result is checked again. With humanize, the result is then run through the humanizer loop (up to maxIterations more model calls; scored by a weak local heuristic).",
  input: S.generateInput,
  output: S.generateOutput,
  mutates: false,
  openWorld: true,
  readsState: true,
  engineMethod: 'generate',
  http: { method: 'POST', path: '/api/generate' },
  cli: { command: ['generate'], arguments: [], flags: ['--author', '--persona', '--file', '--topic', '--notes-file', '--length', '--exemplars', '--max-tokens', '--temperature', '--humanize', '--target'], derived: false },
  render: (o) => (o.caveat === undefined ? o.text : `${o.text}\n\nnote: ${o.caveat}`),
  async handler(engine, input) {
    const mode = input.mode ?? 'rewrite';
    const r = await engine.generate(input.authorId, input.persona, input.text, {
      ...(input.mode === undefined ? {} : { mode: input.mode }),
      ...(input.notes === undefined ? {} : { notes: input.notes }),
      ...(input.length === undefined ? {} : { length: input.length }),
      ...(input.exemplars === undefined ? {} : { exemplarCount: input.exemplars }),
      ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
      ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
      ...(input.humanize === true ? { humanize: true } : {}),
      ...(input.target === undefined ? {} : { target: input.target }),
    });
    return { text: r.text, trace: r.trace, promptTokensEstimate: r.promptTokensEstimate, mode, ...(r.caveat === undefined ? {} : { caveat: r.caveat }) };
  },
});

const score = define({
  name: 'score',
  description:
    'Rate how machine-written a text reads, 0 (human) to 1 (machine). A heuristic proxy, not a detector verdict. Nothing leaves the process unless detectors are named, which SENDS the redacted text to them.',
  input: S.scoreInput,
  output: S.scoreOutput,
  mutates: false,
  openWorld: true,
  readsState: false,
  engineMethod: 'score',
  http: { method: 'POST', path: '/api/score' },
  cli: { command: ['score'], arguments: [], flags: ['--file', '--detector'], derived: false },
  render(o) {
    const lines = [`score: ${o.score.toFixed(3)}`];
    if (o.local.flags !== undefined && o.local.flags.length > 0) lines.push(`flags: ${o.local.flags.join(', ')}`);
    lines.push('features (value x weight = contribution):');
    for (const [name, f] of Object.entries(o.local.features)) {
      lines.push(`  ${name.padEnd(20)} ${f.value.toFixed(3)} x ${f.weight.toFixed(3)} = ${f.contribution.toFixed(3)}`);
    }
    if (o.members.length > 1 || o.excluded.length > 0) {
      lines.push('ensemble:');
      for (const m of o.members) lines.push(`  ${m.name.padEnd(20)} ${m.score.toFixed(3)} (weight ${m.weight.toFixed(3)})`);
      for (const e of o.excluded) lines.push(`  ${e.name.padEnd(20)} excluded: ${e.reason}`);
    }
    lines.push('note: a heuristic proxy, not a detector verdict (docs/CALIBRATION.md)');
    return lines.join('\n');
  },
  async handler(engine, input) {
    const detectors = input.detectors ?? [];
    const r = await engine.score(input.text, { detectors });
    // The caller asked for an external opinion and got none: the local result is still returned, but flagged.
    const localOnly = detectors.length > 0 && r.members.every((m) => m.name === 'local') && r.excluded.some((e) => e.reason !== 'empty_text');
    return { score: r.score, local: r.local, members: r.members, excluded: r.excluded, trace: r.trace, ...(localOnly ? { localOnly: true } : {}) };
  },
});

const humanize = define({
  name: 'humanize',
  description: `Rewrite a text to score lower on the local AI-likeness heuristic while keeping numbers, names, quotes, code and URLs unchanged. Bounded loop (target score or max iterations), at most one logical model call per iteration (plus transport retries) unless llm is false; every edit is checked by a meaning guard and the confidentiality filter and kept only if it scores lower. The score is a weak, confounded proxy (held-out AUC ${HEURISTIC_HELD_OUT_AUC}), not a detector verdict; no guarantee against any real detector.`,
  input: S.humanizeInput,
  output: S.humanizeOutput,
  mutates: false,
  openWorld: true,
  readsState: true,
  engineMethod: 'humanize',
  http: { method: 'POST', path: '/api/humanize' },
  cli: { command: ['humanize'], arguments: [], flags: ['--file', '--author', '--target', '--max-iterations', '--no-llm'], derived: false },
  render(o) {
    const lines = [o.text, ''];
    lines.push(`score: ${o.initialScore.toFixed(3)} -> ${o.finalScore.toFixed(3)} (${o.reachedTarget ? 'target reached' : 'target not reached'}; ${o.iterations} iteration(s), ${o.llmCalls} model call(s), ${o.guardRejections} guard rejection(s))`);
    const moved = Object.entries(o.featureDeltas).filter(([, d]) => d !== 0);
    if (moved.length > 0) lines.push(`feature changes: ${moved.map(([k, d]) => `${k} ${d > 0 ? '+' : ''}${d.toFixed(3)}`).join(', ')}`);
    lines.push(`note: ${o.caveat}`);
    return lines.join('\n');
  },
  async handler(engine, input) {
    const r = await engine.humanize(input.text, {
      ...(input.authorId === undefined ? {} : { authorId: input.authorId }),
      ...(input.target === undefined ? {} : { target: input.target }),
      ...(input.maxIterations === undefined ? {} : { maxIterations: input.maxIterations }),
      ...(input.llm === undefined ? {} : { llm: input.llm }),
    });
    return { ...r, caveat: HUMANIZE_CAVEAT };
  },
});

const profile = define({
  name: 'profile',
  description: "Show an ingested author's stylometric profile.",
  input: S.profileInput,
  output: S.profileOutput,
  mutates: false,
  openWorld: false,
  readsState: true,
  engineMethod: 'getProfile',
  http: { method: 'GET', path: '/api/profile' },
  cli: { command: ['profile'], arguments: [{ name: 'id', field: 'authorId', description: 'author id' }], flags: [], derived: true },
  render: (o) => profileText(o.profile),
  handler: (engine, input) => ({ profile: engine.getProfile(input.authorId) }),
});

const authors = define({
  name: 'authors',
  description: 'List every ingested author with their stylometric profile, sorted by author id.',
  input: S.emptyInput,
  output: S.authorsOutput,
  mutates: false,
  openWorld: false,
  readsState: true,
  engineMethod: 'listAuthors',
  http: { method: 'GET', path: '/api/authors' },
  cli: { command: ['authors'], arguments: [], flags: [], derived: true },
  render: (o) => o.authors.map((a) => `${a.authorId}\t${a.displayName}\t${a.corpusWordCount} words`).join('\n'),
  handler: (engine) => ({ authors: engine.listAuthors() }),
});

const personas = define({
  name: 'personas',
  description: 'List the configured target personas.',
  input: S.emptyInput,
  output: S.personasOutput,
  mutates: false,
  openWorld: false,
  readsState: false,
  engineMethod: 'listPersonas',
  http: { method: 'GET', path: '/api/personas' },
  cli: { command: ['personas'], arguments: [], flags: [], derived: true },
  render: (o) => o.personas.map((p) => `${p.key}\t${p.name}`).join('\n'),
  handler: (engine) => ({ personas: engine.listPersonas() }),
});

const filters = define({
  name: 'filters',
  description: 'List the configured filter pipeline, in execution order.',
  input: S.emptyInput,
  output: S.filtersOutput,
  mutates: false,
  openWorld: false,
  readsState: false,
  engineMethod: 'listFilters',
  http: { method: 'GET', path: '/api/filters' },
  cli: { command: ['filters'], arguments: [], flags: [], derived: true },
  render: (o) => o.filters.map((f) => `${f.name}\t${f.stage}\t${f.onError}\t${f.enabled ? 'enabled' : 'disabled'}`).join('\n'),
  handler: (engine) => ({ filters: engine.listFilters() }),
});

const configGet = define({
  name: 'config_get',
  description:
    'Show the effective configuration, redacted: provider, model, endpoint hosts, the NAMES of key environment variables (never values), limits, filters, persona keys, scorer settings, the state directory path (where ingests are kept; omitted when in memory only). Read-only.',
  input: S.emptyInput,
  output: S.configOutput,
  mutates: false,
  openWorld: false,
  readsState: false,
  engineMethod: 'getConfigView',
  http: { method: 'GET', path: '/api/config' },
  cli: { command: ['config', 'get'], arguments: [], flags: [], derived: true },
  render: (o) => configText(o.config),
  handler: (engine) => ({ config: engine.getConfigView() }),
});

const capabilities = define({
  name: 'capabilities',
  description: 'List the operations this service offers (the same list on every surface) and the capabilities planned but not built yet.',
  input: S.emptyInput,
  output: S.capabilitiesOutput,
  mutates: false,
  openWorld: false,
  readsState: false,
  engineMethod: null,
  http: { method: 'GET', path: '/api/capabilities' },
  cli: { command: ['capabilities'], arguments: [], flags: [], derived: true },
  render: (o) =>
    [
      ...o.operations.map((op) => `${op.name}\t${op.http.method} ${op.http.path}\t${op.cli}\t${op.mutates ? 'writes' : 'read-only'}`),
      ...o.pending.map((p) => `${p.name}\tpending (phase ${p.phase})`),
    ].join('\n'),
  handler: () => describeCapabilities(),
});

/** The registry: ordered, unique names, the single declaration every adapter reads. */
export const OPERATIONS: readonly AnyOperation[] = [ingest, generate, score, humanize, profile, authors, personas, filters, configGet, capabilities] as unknown as readonly AnyOperation[];

const BY_NAME = new Map(OPERATIONS.map((o) => [o.name as string, o]));

export function findOperation(name: string): AnyOperation | undefined {
  return BY_NAME.get(name);
}

export function operation(name: OperationName): AnyOperation {
  const op = BY_NAME.get(name);
  if (op === undefined) throw new Error(`no such operation: ${name}`);
  return op;
}

/** `ghostwriter config get` for display. */
export const cliLine = (op: AnyOperation): string => `ghostwriter ${op.cli.command.join(' ')}`;

/** The shape returned by the `capabilities` operation, built from a registry (default: the real one). */
export function describeCapabilities(ops: readonly AnyOperation[] = OPERATIONS, pending: readonly PendingCapability[] = PENDING_CAPABILITIES): z.output<typeof S.capabilitiesOutput> {
  return {
    operations: ops.map((op) => ({ name: op.name, description: op.description, mutates: op.mutates, http: { ...op.http }, cli: cliLine(op), mcpTool: op.name })),
    pending: pending.map((p) => ({ name: p.name, phase: p.phase, summary: p.summary })),
  };
}

const MAX_ISSUES = 8;
const MAX_PATH = 80;
const MAX_MESSAGE = 200;
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}...` : s);

/** Validate untrusted input against an operation's schema. Throws `InputError` (USAGE) with path-qualified, bounded messages. */
export function parseInput(op: AnyOperation, raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) raw = {};
  const r = op.input.safeParse(raw);
  if (r.success) return r.data as Record<string, unknown>;
  const issues = r.error.issues.slice(0, MAX_ISSUES).map((i) => {
    const path = clip(i.path.map(String).join('.') || '(input)', MAX_PATH);
    // zod echoes an unknown key by name; the name is attacker-chosen, so only identifier-shaped, short names are repeated.
    const message =
      i.code === 'unrecognized_keys'
        ? `unknown field${i.keys.length === 1 ? '' : 's'}: ${i.keys.slice(0, 5).map((k) => (/^[A-Za-z0-9_.-]{1,40}$/.test(k) ? k : '(unprintable)')).join(', ')}`
        : clip(i.message, MAX_MESSAGE);
    return { path, message };
  });
  const more = r.error.issues.length - issues.length;
  const text = `invalid input for ${op.name}: ${issues.map((i) => (i.path === '(input)' ? i.message : `${i.path}: ${i.message}`)).join('; ')}${more > 0 ? `; and ${more} more` : ''}`;
  throw new InputError(text, issues);
}

/** Validate `raw` and run the operation's handler. The single execution path of every surface. */
export async function invokeOperation(op: AnyOperation, engine: Engine, raw: unknown): Promise<Record<string, unknown>> {
  const input = parseInput(op, raw);
  return (await op.handler(engine, input)) as Record<string, unknown>;
}

/** The success document every surface reports. */
export const successDocument = (data: Record<string, unknown>): Record<string, unknown> => ({ ok: true, ...data });
