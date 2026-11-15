// `ghostwriter serve`: the HTTP API (and, with --mcp, MCP over streamable HTTP at /mcp) over the operations registry.
//
//   ghostwriter serve [--host 127.0.0.1] [--port 8787] [--token-env NAME] [--allow-origin URL]... [--max-body BYTES] [--mcp]
//
// The bearer token is read from the environment variable NAME (never from the command line, where `ps` would show it).
// A non-loopback --host without a token refuses to start. The listening URL goes to stderr; with --json a single
// `{ok:true, listening:{host,port,url,...}}` document goes to stdout so a script can learn the port of `--port 0`.
import type { Command } from 'commander';
import { InvalidArgumentError } from 'commander';
import { DEFAULT_HOST, isLoopbackBind } from '../api/auth.js';
import { DEFAULT_PORT, startApiServer } from '../api/server.js';
import type { ApiServer } from '../api/server.js';
import { DEFAULT_API_LIMITS } from '../api/limits.js';
import { defaultStateDir } from '../engine.js';
import { ConfigError } from '../models/errors.js';
import { ServiceRuntime } from '../service/runtime.js';
import type { CliContext, CliIo, CommonOpts } from './main.js';

export interface ListenOpts {
  host?: string;
  port?: number;
  tokenEnv?: string;
  allowOrigin: string[];
  allowHost: string[];
  maxBody?: number;
  maxIngestBody?: number;
}

const int = (v: string): number => {
  if (!/^\d{1,10}$/.test(v)) throw new InvalidArgumentError('expected a non-negative integer');
  return Number(v);
};
const collect = (v: string, prev: string[]): string[] => [...prev, v];

/** Options shared by `serve` and `mcp --http`. */
export function addListenOptions(cmd: Command): Command {
  return cmd
    .option('--host <addr>', `address to bind (default ${DEFAULT_HOST}; anything but loopback needs --token-env)`)
    .option('--port <n>', `port (default ${DEFAULT_PORT}; 0 = any free port)`, int)
    .option('--token-env <NAME>', 'NAME of the environment variable holding the bearer token (16+ characters); never the token itself')
    .option('--allow-origin <origin>', 'browser origin allowed to call cross-origin, exact, e.g. http://localhost:5173 (repeatable; never "*")', collect, [] as string[])
    .option('--allow-host <name>', 'extra Host header name accepted besides loopback and --host (repeatable)', collect, [] as string[])
    .option('--max-body <bytes>', `largest request body except ingest (default ${DEFAULT_API_LIMITS.maxBodyBytes})`, int)
    .option('--max-ingest-body <bytes>', `largest body for ingest and /mcp (default ${DEFAULT_API_LIMITS.maxIngestBodyBytes})`, int);
}

/** The process-lifetime abort signal: the injected one, else SIGINT / SIGTERM. */
export function stopSignal(io: CliIo): AbortSignal {
  if (io.signal !== undefined) return io.signal;
  const ac = new AbortController();
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => ac.abort());
  return ac.signal;
}

export const untilAborted = (signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });

/** Token from the environment variable the flag names. A named but empty variable is an error, never "no token". */
export function resolveToken(tokenEnv: string | undefined, env: CliIo['env']): string | undefined {
  if (tokenEnv === undefined) return undefined;
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(tokenEnv)) throw new ConfigError('--token-env must be the NAME of an environment variable, not the token');
  const v = env[tokenEnv];
  if (v === undefined || v === '') throw new ConfigError(`--token-env ${tokenEnv}: that environment variable is not set`);
  return v;
}

/** Start the server described by the options; resolves with the running server. Used by `serve` and `mcp --http`. */
export async function startListening(
  ctx: CliContext,
  opts: CommonOpts & ListenOpts,
  mode: { api: boolean; mcp: boolean },
): Promise<ApiServer> {
  const { io } = ctx;
  const token = resolveToken(opts.tokenEnv, io.env);
  const { engine } = await ctx.start(opts, false, true);
  const runtime = new ServiceRuntime(engine, { stateDir: opts.stateDir ?? defaultStateDir(io.env) });
  await runtime.markLoaded();
  const server = await startApiServer({
    runtime,
    ...(opts.host === undefined ? {} : { host: opts.host }),
    ...(opts.port === undefined ? {} : { port: opts.port }),
    ...(token === undefined ? {} : { token }),
    allowOrigins: opts.allowOrigin,
    allowHosts: opts.allowHost,
    limits: { ...(opts.maxBody === undefined ? {} : { maxBodyBytes: opts.maxBody }), ...(opts.maxIngestBody === undefined ? {} : { maxIngestBodyBytes: opts.maxIngestBody }) },
    api: mode.api,
    mcp: mode.mcp,
    log: (line) => io.stderr(`${line}\n`),
  });
  io.stderr(`listening on ${server.url}${mode.api ? ' (HTTP API, GET /openapi.json)' : ''}${mode.mcp ? ' (MCP at /mcp)' : ''}\n`);
  if (token === undefined) {
    io.stderr(
      `note: no API token: any process on this machine that can reach ${server.url} can use it${isLoopbackBind(server.host) ? '' : ' (and the network can)'}; set one with --token-env\n`,
    );
  }
  if (!isLoopbackBind(server.host)) io.stderr('note: traffic is plain HTTP; put TLS in front before exposing this beyond a trusted network\n');
  if (ctx.settings.json === true) {
    io.stdout(`${JSON.stringify({ ok: true, listening: { host: server.host, port: server.port, url: server.url, api: mode.api, mcp: mode.mcp, auth: token !== undefined } })}\n`);
  }
  return server;
}

export function registerServe(program: Command, ctx: CliContext): void {
  addListenOptions(ctx.common(program.command('serve').description('serve the HTTP API (OpenAPI at /openapi.json); loopback only unless a token is set')))
    .option('--mcp', 'also serve MCP over streamable HTTP at /mcp')
    .action(async (opts: CommonOpts & ListenOpts & { mcp?: boolean }) => {
      const signal = stopSignal(ctx.io);
      const server = await startListening(ctx, opts, { api: true, mcp: opts.mcp === true });
      await untilAborted(signal);
      await server.close();
    });
}
