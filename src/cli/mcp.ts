// `ghostwriter mcp`: the MCP server over the operations registry.
//
//   ghostwriter mcp --stdio          (default) protocol on stdin/stdout; logs on stderr only
//   ghostwriter mcp --http [--host --port --token-env ...]   streamable HTTP at /mcp (no REST routes)
//
// stdout belongs to the protocol in stdio mode: this command prints nothing else there, not even with --json.
import type { Command } from 'commander';
import { serveStdio } from '../mcp/server.js';
import { defaultStateDir } from '../engine.js';
import { ConfigError } from '../models/errors.js';
import { ServiceRuntime } from '../service/runtime.js';
import { addListenOptions, startListening, stopSignal, untilAborted } from './serve.js';
import type { ListenOpts } from './serve.js';
import type { CliContext, CommonOpts } from './main.js';

export function registerMcp(program: Command, ctx: CliContext): void {
  addListenOptions(
    ctx
      .common(program.command('mcp').description('serve the operations as MCP tools (stdio by default, or streamable HTTP with --http)'))
      .option('--stdio', 'speak MCP on stdin/stdout (default)')
      .option('--http', 'speak MCP over streamable HTTP at /mcp'),
  ).action(async (opts: CommonOpts & ListenOpts & { stdio?: boolean; http?: boolean }) => {
    if (opts.stdio === true && opts.http === true) throw new ConfigError('choose one of --stdio and --http');
    const signal = stopSignal(ctx.io);
    if (opts.http === true) {
      const server = await startListening(ctx, opts, { api: false, mcp: true });
      await untilAborted(signal);
      await server.close();
      return;
    }
    const { engine } = await ctx.start(opts, false, true);
    const runtime = new ServiceRuntime(engine, { stateDir: opts.stateDir ?? defaultStateDir(ctx.io.env) });
    await runtime.markLoaded();
    ctx.io.stderr('ghostwriter MCP server on stdio\n');
    await serveStdio(runtime, { signal });
  });
}
