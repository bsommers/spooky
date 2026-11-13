// Command line adapter over the Engine (ORC-05). Five commands, one per row of the CONTRACTS "Surface parity" table:
//
//   ghostwriter ingest   --author <id> --name <name> [file | --file <path>]   (stdin when no file)
//   ghostwriter generate --author <id> --persona <key> [file | --file <path>] (stdin when no file)
//   ghostwriter personas | filters | profile <id>
//
// Contract: the result (and only the result) goes to stdout; logs, warnings and errors go to stderr. `--json` makes
// stdout a single JSON document `{ok, ...data}` / `{ok:false, error:{code,message}}` so scripts never parse prose.
// Exit codes are documented in .planning/CONTRACTS.md. API keys are read from the environment variable the config
// names, by the engine; this file never sees, prints or logs one. Unexpected errors are reported by class name only,
// because their messages can embed text from the draft being processed.
import { readFile, stat } from 'node:fs/promises';
import { Command, CommanderError, InvalidArgumentError } from 'commander';
import { loadConfig } from '../config/load.js';
import { Engine, defaultStateDir } from '../engine.js';
import type { EngineOptions } from '../engine.js';
import { ConfigError, GhostwriterError, InputTooLargeError } from '../models/errors.js';
import type { Config } from '../models/types.js';

/** Largest corpus (characters) the engine accepts by default; the byte cap for reading is 4 bytes per character. */
const MAX_CORPUS_CHARS = 10_000_000;
const MAX_CONFIG_BYTES = 1024 * 1024;

/** Process exit code per error `code` (.planning/CONTRACTS.md "CLI exit codes"). */
export const EXIT_CODES: Readonly<Record<string, number>> = {
  CONFIG_INVALID: 2,
  PROFILE_INVALID: 2,
  USAGE: 2,
  UNKNOWN_PERSONA: 3,
  UNKNOWN_AUTHOR: 3,
  FILTER_FAILED: 4,
  LLM_FAILED: 5,
  INPUT_TOO_LARGE: 6,
  STORE_CORRUPT: 7,
};

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
}

/** Test/embedding hooks; the real binary passes none. */
export type CliDeps = Pick<EngineOptions, 'llm' | 'retry' | 'llmClientOptions' | 'factories'>;

function defaultIo(): CliIo {
  return {
    stdout: (t) => void process.stdout.write(t),
    stderr: (t) => void process.stderr.write(t),
    stdin: process.stdin,
    stdinIsTTY: process.stdin.isTTY === true,
    env: process.env,
  };
}

interface CommonOpts {
  config?: string;
  stateDir?: string;
  json?: boolean;
}
interface LlmOpts {
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

/** Build the commander program. Exported so the parity test can enumerate the commands without running anything. */
export function buildProgram(io: CliIo, deps: CliDeps = {}, settings: { json?: boolean } = {}): Command {
  const program = new Command('ghostwriter')
    .description('Dual-axis ghostwriter: an author\'s voice for a target audience persona, behind a confidentiality-first filter pipeline.')
    .exitOverride()
    .configureOutput({
      writeOut: (s) => io.stdout(s),
      // In --json mode the usage error is reported as a JSON document on stdout instead.
      writeErr: (s) => {
        if (settings.json !== true) io.stderr(s);
      },
    });

  const common = (cmd: Command): Command =>
    cmd
      .option('--config <path>', 'JSON config file (default: $GHOSTWRITER_CONFIG, else built-in defaults)')
      .option('--state-dir <dir>', 'where ingests are stored (default: $GHOSTWRITER_STATE_DIR or ~/.local/state/ghostwriter)')
      .option('--json', 'print one JSON document {ok, ...} on stdout');

  /** Resolve the config, then build the engine; `persisted` also restores (and later saves) the state directory. */
  const start = async (opts: CommonOpts & LlmOpts, needsModel: boolean, persisted: boolean) => {
    const config = await resolveConfig(io, opts, needsModel);
    return { config, engine: await engineFor(config, opts, persisted) };
  };
  const engineFor = async (config: Config, opts: CommonOpts, persisted: boolean): Promise<Engine> => {
    const options: EngineOptions = { config, env: io.env, ...deps, ...(persisted ? { stateDir: opts.stateDir ?? defaultStateDir(io.env) } : {}) };
    return persisted ? Engine.create(options) : new Engine(options);
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
    const config = await resolveConfig(io, opts, false);
    const text = await readInput(io, file, opts.file, MAX_CORPUS_CHARS * 4);
    const engine = await engineFor(config, opts, true);
    const profile = await engine.ingest(opts.author, opts.name, text);
    if (opts.json) printJson(io, { profile });
    else out(io, `ingested ${profile.authorId}: ${profile.corpusWordCount} words`);
  });

  common(
    program
      .command('generate')
      .description('rewrite a draft in an author\'s voice for a persona (draft from a file or stdin)')
      .argument('[file]', 'draft file (default: stdin)')
      .requiredOption('--author <id>', 'author id (must have been ingested)')
      .requiredOption('--persona <key>', 'target persona key (see `ghostwriter personas`)')
      .option('--file <path>', 'draft file; "-" is stdin')
      .option('--exemplars <n>', 'writing samples to include in the prompt (0-20)', parseInt10)
      .option('--max-tokens <n>', 'maximum output tokens', parseInt10)
      .option('--temperature <t>', 'sampling temperature, 0 to 1', parseUnit)
      .option('--model <name>', 'model id (overrides llm.model; or $GHOSTWRITER_MODEL)')
      .option('--provider <name>', 'anthropic | openai-compat')
      .option('--base-url <url>', 'endpoint for openai-compat, e.g. http://localhost:11434/v1')
      .option('--api-key-env <NAME>', 'NAME of the environment variable holding the API key (never the key itself)'),
  ).action(
    async (
      file: string | undefined,
      opts: CommonOpts & LlmOpts & { author: string; persona: string; file?: string; exemplars?: number; maxTokens?: number; temperature?: number },
    ) => {
      const config = await resolveConfig(io, opts, true);
      const input = await readInput(io, file, opts.file, config.limits.maxInputChars * 4);
      const engine = await engineFor(config, opts, true);
      const result = await engine.generate(opts.author, opts.persona, input, {
        ...(opts.exemplars === undefined ? {} : { exemplarCount: opts.exemplars }),
        ...(opts.maxTokens === undefined ? {} : { maxTokens: opts.maxTokens }),
        ...(opts.temperature === undefined ? {} : { temperature: opts.temperature }),
      });
      const banned = result.trace.find((t) => t.filter === 'persona-banned');
      if (banned) io.stderr(`warning: the output still contains ${String(banned.metadata.count)} phrase(s) banned for persona "${opts.persona}"\n`);
      if (opts.json) printJson(io, { text: result.text, trace: result.trace, promptTokensEstimate: result.promptTokensEstimate });
      else out(io, result.text);
    },
  );

  common(program.command('personas').description('list the configured target personas')).action(async (opts: CommonOpts) => {
    const { engine } = await start(opts, false, false);
    const personas = engine.listPersonas();
    if (opts.json) printJson(io, { personas });
    else out(io, personas.map((p) => `${p.key}\t${p.name}`).join('\n'));
  });

  common(program.command('filters').description('list the configured filter pipeline, in execution order')).action(async (opts: CommonOpts) => {
    const { engine } = await start(opts, false, false);
    const filters = engine.listFilters();
    if (opts.json) printJson(io, { filters });
    else out(io, filters.map((f) => `${f.name}\t${f.stage}\t${f.onError}\t${f.enabled ? 'enabled' : 'disabled'}`).join('\n'));
  });

  common(program.command('profile').description('show an ingested author\'s stylometric profile').argument('<id>', 'author id')).action(
    async (id: string, opts: CommonOpts) => {
      const { engine } = await start(opts, false, true);
      const profile = engine.getProfile(id);
      if (opts.json) printJson(io, { profile });
      else {
        out(
          io,
          [
            `author: ${profile.authorId} (${profile.displayName})`,
            `words: ${profile.corpusWordCount}`,
            `avg sentence length: ${profile.avgSentenceLength.toFixed(1)} (sd ${profile.sentenceLengthStdDev.toFixed(1)})`,
            `lexical density: ${profile.lexicalDensityRatio.toFixed(3)}`,
            `hedging per 100 words: ${profile.hedgingFrequency.toFixed(2)}`,
            `active/passive ratio: ${profile.activePassiveRatio.toFixed(2)}`,
            `punctuation: ${profile.preferredPunctuation.join(' ') || '-'}`,
            `transitions: ${profile.commonTransitionWords.join(', ') || '-'}`,
          ].join('\n'),
        );
      }
    },
  );

  return program;
}

/** Map any thrown value to `{code, message, exit}`. Only typed errors and commander usage errors keep their message. */
function describeError(err: unknown): { code: string; message: string; exit: number } {
  if (err instanceof GhostwriterError) return { code: err.code, message: err.message, exit: EXIT_CODES[err.code] ?? 1 };
  const errno = (err as NodeJS.ErrnoException | undefined)?.code;
  if (typeof errno === 'string' && /^E[A-Z0-9]+$/.test(errno)) return { code: 'IO_ERROR', message: `file system error (${errno})`, exit: 1 };
  return { code: 'INTERNAL', message: `internal error (${err instanceof Error ? err.name : typeof err})`, exit: 1 };
}

/**
 * Run the CLI. Resolves to the process exit code; never throws and never calls `process.exit` (the bin does).
 * `argv` is the user part (no node / script path).
 */
export async function main(argv: readonly string[], ioOverrides: Partial<CliIo> = {}, deps: CliDeps = {}): Promise<number> {
  const io: CliIo = { ...defaultIo(), ...ioOverrides };
  const json = argv.includes('--json');
  const program = buildProgram(io, deps, { json });
  try {
    if (argv.length === 0) {
      io.stderr(program.helpInformation());
      return EXIT_CODES.USAGE as number;
    }
    await program.parseAsync([...argv], { from: 'user' });
    return 0;
  } catch (err) {
    if (err instanceof CommanderError) {
      if (err.code === 'commander.helpDisplayed' || err.code === 'commander.version' || err.code === 'commander.help') return err.exitCode === 0 ? 0 : (EXIT_CODES.USAGE as number);
      if (json) io.stdout(`${JSON.stringify({ ok: false, error: { code: 'USAGE', message: err.message.replace(/^error: /, '') } })}\n`);
      return EXIT_CODES.USAGE as number; // commander already wrote the message to stderr (text mode)
    }
    const d = describeError(err);
    if (json) io.stdout(`${JSON.stringify({ ok: false, error: { code: d.code, message: d.message } })}\n`);
    else io.stderr(`error: ${d.message}\n`);
    return d.exit;
  }
}
