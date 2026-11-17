// Command line adapter over the Engine (ORC-05). Five commands, one per row of the CONTRACTS "Surface parity" table:
//
//   ghostwriter ingest   --author <id> --name <name> [file | --file <path>]   (stdin when no file)
//   ghostwriter generate --author <id> --persona <key> [file | --file <path>] (stdin when no file)
//   ghostwriter score    [file | --file <path>] [--detector <name>]...        (stdin when no file)
//   ghostwriter humanize [file | --file <path>] [--author <id>] [--target <t>] [--max-iterations <n>] [--no-llm]
//   ghostwriter generate ... [--humanize [--target <t>]]                      (humanizer loop on the result)
//   ghostwriter generate --author <id> --persona <key> --topic <text> [--notes-file <path>] [--length short|medium|long]
//                                                                           (write NEW text about a topic; no research)
//   ghostwriter personas | filters | authors | profile <id> | config get | capabilities
//   ghostwriter serve [--host --port --token-env --allow-origin --max-body --mcp]   (HTTP API, src/api)
//   ghostwriter mcp [--stdio | --http]                                              (MCP server, src/mcp)
//
// Every command that runs an operation reads it from the registry (src/service/operations.ts): the input is validated by
// the operation's schema and the handler runs through `invokeOperation`, the same path the HTTP API and MCP use.
//
// Contract: the result (and only the result) goes to stdout; logs, warnings and errors go to stderr. `--json` makes
// stdout a single JSON document `{ok, ...data}` / `{ok:false, error:{code,message}}` so scripts never parse prose.
// Exit codes are documented in .planning/CONTRACTS.md. API keys are read from the environment variable the config
// names, by the engine; this file never sees, prints or logs one. Unexpected errors are reported by class name only,
// because their messages can embed text from the draft being processed.
import { readFile, stat } from 'node:fs/promises';
import { Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import { TOPIC_LENGTHS } from '../../config/topic.js';
import { loadConfig } from '../config/load.js';
import { Engine, defaultStateDir } from '../engine.js';
import type { EngineOptions } from '../engine.js';
import { ConfigError, GhostwriterError, InputTooLargeError } from '../models/errors.js';
import type { Config } from '../models/types.js';
import { EXIT_CODES, SurfaceError, describeError } from '../service/errors.js';
import { OPERATIONS, invokeOperation, operation, successDocument } from '../service/operations.js';
import type { AnyOperation } from '../service/operations.js';
import { registerMcp } from './mcp.js';
import { registerServe } from './serve.js';

export { EXIT_CODES };

/** Largest corpus (characters) the engine accepts by default; the byte cap for reading is 4 bytes per character. */
const MAX_CORPUS_CHARS = 10_000_000;
const MAX_CONFIG_BYTES = 1024 * 1024;

export interface CliIo {
  /** Text sink for the result (stdout). */
  stdout: (text: string) => void;
  /** Text sink for logs and errors (stderr). */
  stderr: (text: string) => void;
  /** Where piped input comes from. Default process.stdin. */
  stdin: AsyncIterable<Buffer | string>;
  /** True when stdin is an interactive terminal (then "read stdin" would hang, so it is a usage error). */
  stdinIsTTY: boolean;
  env: Readonly<Record<string, string | undefined>>;
  /** Aborts a long-running command (`serve`, `mcp`). Default: SIGINT / SIGTERM of this process. */
  signal?: AbortSignal;
}

/** What `serve` and `mcp` need from this file; they live in their own modules. */
export interface CliContext {
  io: CliIo;
  deps: CliDeps;
  settings: CliSettings;
  /** Adds --config / --state-dir / --json. */
  common(cmd: Command): Command;
  /** Resolve the config, then build the engine; `persisted` also restores the state directory. */
  start(opts: CommonOpts & LlmOpts, needsModel: boolean, persisted: boolean): Promise<{ config: Config; engine: Engine }>;
}

/** Test/embedding hooks; the real binary passes none. */
export type CliDeps = Pick<EngineOptions, 'llm' | 'retry' | 'llmClientOptions' | 'factories' | 'stateLock'>;

function defaultIo(): CliIo {
  return {
    stdout: (t) => void process.stdout.write(t),
    stderr: (t) => void process.stderr.write(t),
    stdin: process.stdin,
    stdinIsTTY: process.stdin.isTTY === true,
    env: process.env,
  };
}

export interface CommonOpts {
  config?: string;
  stateDir?: string;
  json?: boolean;
}
export interface LlmOpts {
  model?: string;
  provider?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
}

const parseInt10 = (v: string): number => {
  if (!/^\d{1,9}$/.test(v)) throw new InvalidArgumentError('expected a non-negative integer');
  return Number(v);
};
const parseUnit = (v: string): number => {
  const n = Number(v);
  if (v.trim() === '' || !Number.isFinite(n) || n < 0 || n > 1) throw new InvalidArgumentError('expected a number between 0 and 1');
  return n;
};

async function readCapped(path: string, maxBytes: number): Promise<string> {
  let size: number;
  try {
    const st = await stat(path);
    if (!st.isFile()) throw new ConfigError(`${path}: not a regular file`);
    size = st.size;
    if (size > maxBytes) throw new InputTooLargeError(size, maxBytes, 'bytes');
    return (await readFile(path)).toString('utf8');
  } catch (err) {
    if (err instanceof GhostwriterError) throw err;
    // errno only: never the OS message, which can include more than the path
    throw new ConfigError(`cannot read ${path}: ${(err as NodeJS.ErrnoException).code ?? 'error'}`);
  }
}

async function readStdin(io: CliIo, maxBytes: number): Promise<string> {
  if (io.stdinIsTTY) throw new ConfigError('no input: pass a file, --file <path>, or pipe the text on stdin');
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of io.stdin) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    size += buf.length;
    if (size > maxBytes) throw new InputTooLargeError(size, maxBytes, 'bytes');
    parts.push(buf);
  }
  return Buffer.concat(parts).toString('utf8');
}

/** The text to process: positional file, `--file`, or stdin (`-` too). Both a positional and `--file` is a usage error. */
async function readInput(io: CliIo, positional: string | undefined, flag: string | undefined, maxBytes: number): Promise<string> {
  if (positional !== undefined && flag !== undefined) throw new ConfigError('give the input file either as an argument or with --file, not both');
  const file = positional ?? flag;
  return file === undefined || file === '-' ? readStdin(io, maxBytes) : readCapped(file, maxBytes);
}

async function loadRawConfig(path: string | undefined, env: CliIo['env']): Promise<Record<string, unknown>> {
  const file = path ?? (env.GHOSTWRITER_CONFIG !== undefined && env.GHOSTWRITER_CONFIG !== '' ? env.GHOSTWRITER_CONFIG : undefined);
  if (file === undefined) return {};
  const text = await readCapped(file, MAX_CONFIG_BYTES);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ConfigError(`${file}: not valid JSON`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError(`${file}: config must be a JSON object`);
  return raw as Record<string, unknown>;
}

/** Config file + env + flags -> a validated Config. Only `generate` needs a model; the other commands never call one. */
async function resolveConfig(io: CliIo, opts: CommonOpts & LlmOpts, needsModel: boolean): Promise<Config> {
  const raw = await loadRawConfig(opts.config, io.env);
  const llmRaw = raw.llm;
  if (llmRaw === undefined || (llmRaw !== null && typeof llmRaw === 'object' && !Array.isArray(llmRaw))) {
    const llm: Record<string, unknown> = { ...(llmRaw as Record<string, unknown> | undefined) };
    if (opts.model !== undefined) llm.model = opts.model;
    else if (llm.model === undefined && io.env.GHOSTWRITER_MODEL) llm.model = io.env.GHOSTWRITER_MODEL;
    if (opts.provider !== undefined) llm.provider = opts.provider;
    if (opts.baseUrl !== undefined) llm.baseUrl = opts.baseUrl;
    if (opts.apiKeyEnv !== undefined) llm.apiKeyEnv = opts.apiKeyEnv;
    if (llm.model === undefined) {
      if (needsModel) {
        throw new ConfigError('invalid config: llm.model: is required (set it in --config, or pass --model, or set GHOSTWRITER_MODEL)', [
          { path: 'llm.model', message: 'is required' },
        ]);
      }
      llm.model = '(not configured)';
    }
    raw.llm = llm;
  }
  return loadConfig(raw);
}

const out = (io: CliIo, text: string): void => io.stdout(text.endsWith('\n') ? text : `${text}\n`);
const printJson = (io: CliIo, doc: Record<string, unknown>): void => io.stdout(`${JSON.stringify({ ok: true, ...doc })}\n`);

/**
 * Mutable per-run state shared by `buildProgram` and `main`. `json` is set by commander itself when it parses a
 * `--json` option (so a `--json` that is the VALUE of another option, or follows `--`, does not count); `text` collects
 * help output in JSON mode; `dispatched` records that a subcommand was reached.
 */
export interface CliSettings {
  json?: boolean;
  text?: string[];
  dispatched?: boolean;
  /** Exit code of a command that produced its result but still failed its purpose (`score` when no named detector answered). */
  exitCode?: number;
}

/** Build the commander program. Exported so the parity test can enumerate the commands without running anything. */
export function buildProgram(io: CliIo, deps: CliDeps = {}, settings: CliSettings = {}): Command {
  const program = new Command('ghostwriter')
    .description('Dual-axis ghostwriter: an author\'s voice for a target audience persona, behind a confidentiality-first filter pipeline.')
    .exitOverride()
    // Program options (only --json) are recognised before the subcommand name; after it every option belongs to the subcommand.
    .enablePositionalOptions()
    .option('--json', 'print one JSON document {ok, ...} on stdout (also for --help and usage errors)')
    .hook('preSubcommand', () => void (settings.dispatched = true))
    .configureOutput({
      // In --json mode help text is collected and returned inside the one JSON document (see `main`).
      writeOut: (s) => {
        if (settings.json === true) (settings.text ??= []).push(s);
        else io.stdout(s);
      },
      // In --json mode the usage error is reported as a JSON document on stdout instead.
      writeErr: (s) => {
        if (settings.json !== true) io.stderr(s);
      },
    });
  program.on('option:json', () => void (settings.json = true));

  const common = (cmd: Command): Command =>
    cmd
      .option('--config <path>', 'JSON config file (default: $GHOSTWRITER_CONFIG, else built-in defaults)')
      .option('--state-dir <dir>', 'where ingests are stored (default: $GHOSTWRITER_STATE_DIR or ~/.local/state/ghostwriter)')
      .option('--json', 'print one JSON document {ok, ...} on stdout')
      .on('option:json', () => void (settings.json = true));

  /** Resolve the config, then build the engine; `persisted` also restores (and later saves) the state directory. */
  const start = async (opts: CommonOpts & LlmOpts, needsModel: boolean, persisted: boolean) => {
    const config = await resolveConfig(io, opts, needsModel);
    return { config, engine: await engineFor(config, opts, persisted) };
  };
  const engineFor = async (config: Config, opts: CommonOpts, persisted: boolean): Promise<Engine> => {
    // The state directory is always named (so `config get` can report where this command's ingests live); only a
    // `persisted` command reads it (`Engine.create`). A plain `new Engine` never touches the disk until an ingest.
    const options: EngineOptions = { config, env: io.env, ...deps, stateDir: opts.stateDir ?? defaultStateDir(io.env) };
    return persisted ? Engine.create(options) : new Engine(options);
  };

  const context: CliContext = { io, deps, settings, common, start };

  /** Print the result of an operation: the one JSON document with --json, else the operation's text rendering. */
  const emit = (op: AnyOperation, data: Record<string, unknown>): void => {
    if (settings.json === true) io.stdout(`${JSON.stringify(successDocument(data))}\n`);
    else out(io, op.render(data as never));
  };

  common(
    program
      .command('ingest')
      .description('profile and store an author\'s corpus (secrets are redacted before anything is stored)')
      .argument('[file]', 'corpus file (default: stdin)')
      .requiredOption('--author <id>', 'author id: letters, digits, ".", "_", "-"')
      .requiredOption('--name <name>', 'display name')
      .option('--file <path>', 'corpus file; "-" is stdin'),
  ).action(async (file: string | undefined, opts: CommonOpts & { author: string; name: string; file?: string }) => {
    const op = operation('ingest');
    const config = await resolveConfig(io, opts, false);
    const text = await readInput(io, file, opts.file, MAX_CORPUS_CHARS * 4);
    const engine = await engineFor(config, opts, true);
    emit(op, await invokeOperation(op, engine, { authorId: opts.author, name: opts.name, text }));
  });

  common(
    program
      .command('generate')
      .description('rewrite a draft in an author\'s voice for a persona (draft from a file or stdin), or with --topic write NEW text about a topic (no web research; facts are not verified)')
      .argument('[file]', 'draft file (default: stdin); not with --topic')
      .requiredOption('--author <id>', 'author id (must have been ingested)')
      .requiredOption('--persona <key>', 'target persona key (see `ghostwriter personas`)')
      .option('--file <path>', 'draft file; "-" is stdin; not with --topic')
      .option('--topic <text>', 'write new text about this topic instead of rewriting a draft; nothing is looked up online: the model uses the topic, --notes-file and its own knowledge, and may be wrong')
      .option('--notes-file <path>', 'with --topic: a file of facts and source material to use ("-" is stdin); the only source of specific facts; same size limit as a draft')
      .addOption(new Option('--length <length>', 'with --topic: the length to aim for').choices(TOPIC_LENGTHS))
      .option('--exemplars <n>', 'writing samples to include in the prompt (0-20)', parseInt10)
      .option('--max-tokens <n>', 'maximum output tokens', parseInt10)
      .option('--temperature <t>', 'sampling temperature, 0 to 1', parseUnit)
      .option('--humanize', 'then run the humanizer loop on the result (more model calls; scored by a weak local heuristic, docs/HUMANIZING.md)')
      .option('--target <t>', 'humanizer target score, 0 to 1 (default humanize.targetScore, 0.3); needs --humanize', parseUnit)
      .option('--model <name>', 'model id (overrides llm.model; or $GHOSTWRITER_MODEL)')
      .option('--provider <name>', 'anthropic | openai-compat')
      .option('--base-url <url>', 'endpoint for openai-compat, e.g. http://localhost:11434/v1')
      .option('--api-key-env <NAME>', 'NAME of the environment variable holding the API key (never the key itself)'),
  ).action(
    async (
      file: string | undefined,
      opts: CommonOpts & LlmOpts & { author: string; persona: string; file?: string; topic?: string; notesFile?: string; length?: string; exemplars?: number; maxTokens?: number; temperature?: number; humanize?: boolean; target?: number },
    ) => {
      const op = operation('generate');
      // `--target` without `--humanize` is rejected by the operation's input schema, like on HTTP and MCP (USAGE).
      // Topic mode and draft mode do not mix: the topic is the whole input, so a draft file or stdin would be silently ignored.
      if (opts.topic !== undefined && (file !== undefined || opts.file !== undefined)) throw new SurfaceError('USAGE', '--topic and a draft file (argument or --file) cannot be combined: give either a draft to rewrite or a topic to write about');
      if (opts.topic === undefined && opts.notesFile !== undefined) throw new SurfaceError('USAGE', '--notes-file needs --topic (notes are only for writing about a topic)');
      if (opts.topic === undefined && opts.length !== undefined) throw new SurfaceError('USAGE', '--length needs --topic (it is only for writing about a topic)');
      const config = await resolveConfig(io, opts, true);
      const topic = opts.topic !== undefined;
      const input = topic ? (opts.topic as string) : await readInput(io, file, opts.file, config.limits.maxInputChars * 4);
      const notes = opts.notesFile === undefined ? undefined : await readInput(io, undefined, opts.notesFile, config.limits.maxInputChars * 4);
      const engine = await engineFor(config, opts, true);
      const data = await invokeOperation(op, engine, {
        authorId: opts.author,
        persona: opts.persona,
        text: input,
        ...(topic ? { mode: 'topic' } : {}),
        ...(notes === undefined ? {} : { notes }),
        ...(opts.length === undefined ? {} : { length: opts.length }),
        ...(opts.exemplars === undefined ? {} : { exemplars: opts.exemplars }),
        ...(opts.maxTokens === undefined ? {} : { maxTokens: opts.maxTokens }),
        ...(opts.temperature === undefined ? {} : { temperature: opts.temperature }),
        ...(opts.humanize === true ? { humanize: true } : {}),
        ...(opts.target === undefined ? {} : { target: opts.target }),
      });
      const banned = (data.trace as { filter: string; metadata: Record<string, unknown> }[]).find((t) => t.filter === 'persona-banned');
      if (banned) io.stderr(`warning: the output still contains ${String(banned.metadata.count)} phrase(s) banned for persona "${opts.persona}"\n`);
      emit(op, data);
    },
  );

  common(
    program
      .command('score')
      .description('rate how machine-written a text reads, 0 to 1 (a heuristic proxy, not a detector verdict; docs/CALIBRATION.md)')
      .argument('[file]', 'text file (default: stdin)')
      .option('--file <path>', 'text file; "-" is stdin')
      .option('--detector <name>', 'also ask a detector declared in config scorer.detectors; SENDS the redacted text to it (repeatable)', (v: string, prev: string[]) => [...prev, v], [] as string[]),
  ).action(async (file: string | undefined, opts: CommonOpts & { file?: string; detector: string[] }) => {
    const op = operation('score');
    const config = await resolveConfig(io, opts, false);
    const text = await readInput(io, file, opts.file, config.limits.maxInputChars * 4);
    const engine = await engineFor(config, opts, false);
    if (opts.detector.length > 0) io.stderr(`note: sending the redacted text to external detector(s): ${opts.detector.join(', ')}\n`);
    const data = await invokeOperation(op, engine, { text, detectors: opts.detector });
    for (const e of data.excluded as { name: string; reason: string }[]) io.stderr(`warning: detector "${e.name}" was not used (${e.reason})\n`);
    // The caller asked for an external opinion and got none: still print the local result, but do not exit 0 as if it were one.
    if (data.localOnly === true) {
      io.stderr('error: no named detector produced a score; the result below is the local heuristic alone\n');
      settings.exitCode = EXIT_CODES.DETECTORS_FAILED as number;
    }
    emit(op, data);
  });

  common(
    program
      .command('humanize')
      .description('rewrite a text to score lower on the local AI-likeness heuristic, keeping numbers, names, quotes and code (a weak proxy, not a detector verdict; docs/HUMANIZING.md)')
      .argument('[file]', 'text file (default: stdin)')
      .option('--file <path>', 'text file; "-" is stdin')
      .option('--author <id>', 'author whose voice profile steers the model pass (must have been ingested)')
      .option('--target <t>', 'stop at or below this score, 0 to 1 (default humanize.targetScore, 0.3)', parseUnit)
      .option('--max-iterations <n>', 'at most this many iterations (default humanize.maxIterations, 3)', parseInt10)
      .option('--no-llm', 'deterministic edits only: no model call')
      .option('--model <name>', 'model id (overrides llm.model; or $GHOSTWRITER_MODEL)')
      .option('--provider <name>', 'anthropic | openai-compat')
      .option('--base-url <url>', 'endpoint for openai-compat, e.g. http://localhost:11434/v1')
      .option('--api-key-env <NAME>', 'NAME of the environment variable holding the API key (never the key itself)'),
  ).action(
    async (
      file: string | undefined,
      opts: CommonOpts & LlmOpts & { file?: string; author?: string; target?: number; maxIterations?: number; llm: boolean },
    ) => {
      const op = operation('humanize');
      const config = await resolveConfig(io, opts, false);
      const text = await readInput(io, file, opts.file, config.limits.maxInputChars * 4);
      const engine = await engineFor(config, opts, opts.author !== undefined);
      const data = await invokeOperation(op, engine, {
        text,
        ...(opts.author === undefined ? {} : { authorId: opts.author }),
        ...(opts.target === undefined ? {} : { target: opts.target }),
        ...(opts.maxIterations === undefined ? {} : { maxIterations: opts.maxIterations }),
        ...(opts.llm ? {} : { llm: false }),
      });
      for (const s of data.steps as { outcome: string; step: string; error?: string }[]) {
        if (s.outcome === 'llm_error') io.stderr(`warning: the model pass failed (${s.error ?? 'error'}); the earlier text was kept\n`);
      }
      emit(op, data);
    },
  );

  // The remaining operations are fully described by their registry entry: the command, its arguments and its text
  // rendering all come from `OPERATIONS` (src/service/operations.ts), so a new registry entry gets a CLI command.
  for (const op of OPERATIONS.filter((o) => o.cli.derived)) {
    let parent: Command = program;
    for (const seg of op.cli.command.slice(0, -1)) {
      parent = parent.commands.find((c) => c.name() === seg) ?? parent.command(seg).description(`${seg} commands`);
    }
    const cmd = parent.command(op.cli.command[op.cli.command.length - 1] as string).description(op.description);
    for (const a of op.cli.arguments) cmd.argument(`<${a.name}>`, a.description);
    common(cmd).action(async (...args: unknown[]) => {
      const opts = args[op.cli.arguments.length] as CommonOpts;
      const input = Object.fromEntries(op.cli.arguments.map((a, i) => [a.field, args[i]]));
      const { engine } = await start(opts, false, op.readsState);
      emit(op, await invokeOperation(op, engine, input));
    });
  }

  registerServe(program, context);
  registerMcp(program, context);

  return program;
}

/**
 * Run the CLI. Resolves to the process exit code; never throws and never calls `process.exit` (the bin does).
 * `argv` is the user part (no node / script path).
 */
export async function main(argv: readonly string[], ioOverrides: Partial<CliIo> = {}, deps: CliDeps = {}): Promise<number> {
  const io: CliIo = { ...defaultIo(), ...ioOverrides };
  const settings: CliSettings = {};
  const program = buildProgram(io, deps, settings);
  try {
    if (argv.length === 0) {
      io.stderr(program.helpInformation());
      return EXIT_CODES.USAGE as number;
    }
    await program.parseAsync([...argv], { from: 'user' });
    return settings.exitCode ?? 0;
  } catch (err) {
    if (err instanceof CommanderError) {
      // Rejected before any subcommand was reached (unknown command, bad top-level option): commander has no
      // subcommand to ask, so this one failure path looks for the flag itself, up to `--`. A false positive only
      // turns a prose error into the JSON document.
      if (settings.json !== true && settings.dispatched !== true) {
        const end = argv.indexOf('--');
        if ((end === -1 ? argv : argv.slice(0, end)).includes('--json')) settings.json = true;
      }
      const shown = err.code === 'commander.helpDisplayed' || err.code === 'commander.version' || err.code === 'commander.help';
      if (shown && err.exitCode === 0) {
        if (settings.json === true) {
          io.stdout(`${JSON.stringify({ ok: true, [err.code === 'commander.version' ? 'version' : 'help']: (settings.text ?? []).join('') })}\n`);
        }
        return 0;
      }
      if (settings.json === true) {
        const message = shown ? 'missing command or arguments; run with --help for usage' : err.message.replace(/^error: /, '');
        io.stdout(`${JSON.stringify({ ok: false, error: { code: 'USAGE', message } })}\n`);
      }
      return EXIT_CODES.USAGE as number; // commander already wrote the message to stderr (text mode)
    }
    const d = describeError(err);
    if (settings.json === true) io.stdout(`${JSON.stringify({ ok: false, error: { code: d.code, message: d.message } })}\n`);
    else io.stderr(`error: ${d.message}\n`);
    return d.exit;
  }
}
