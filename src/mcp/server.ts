// MCP server (Phase 9) over stdio or streamable HTTP, built on the official SDK (MIT; docs/MCP.md has the licence audit).
//
// The low-level `Server` is used on purpose: the registry owns input validation and error mapping, and routing the
// calls through the SDK's high-level tool wrapper would validate twice and phrase failures differently from the CLI
// and the HTTP API. Every tool call goes to `callTool`, which runs the same `ServiceRuntime` path as the other surfaces.
//
// stdio: stdout carries protocol frames and nothing else; this module never writes to it. Diagnostics go to stderr.
// HTTP: stateless (a fresh server and transport per request, JSON responses), so no session state exists to hijack.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Readable, Writable } from 'node:stream';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { DEFAULT_API_LIMITS } from '../api/limits.js';
import { OPERATIONS } from '../service/operations.js';
import type { AnyOperation } from '../service/operations.js';
import type { ServiceRuntime } from '../service/runtime.js';
import { packageVersion } from '../service/version.js';
import { callTool, toolDefinitions } from './tools.js';

export const MCP_INSTRUCTIONS =
  'Ghostwriter: rewrite drafts in an ingested author\'s voice for a target persona, and score how machine-written a text reads. ' +
  'Tools take author ids, never file paths. Text you pass may be redacted for secrets before it is used. ' +
  '`ingest` is the only tool that changes stored state.';

/** `inflight` (optional) collects the promise of every running tool call so a caller can wait for the work to finish. */
export function createMcpServer(runtime: ServiceRuntime, ops: readonly AnyOperation[] = OPERATIONS, inflight?: Set<Promise<unknown>>): Server {
  const server = new Server({ name: 'ghostwriter', version: packageVersion() }, { capabilities: { tools: {} }, instructions: MCP_INSTRUCTIONS });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: toolDefinitions(ops) }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const running = callTool(runtime, request.params.name, request.params.arguments, ops);
    inflight?.add(running);
    let result;
    try {
      result = await running;
    } finally {
      inflight?.delete(running);
    }
    if (result === undefined) throw new McpError(ErrorCode.InvalidParams, 'unknown tool');
    return result;
  });
  return server;
}

export interface StdioOptions {
  stdin?: Readable;
  stdout?: Writable;
  /** Largest single message, bytes (the SDK default is 10 MB). */
  maxMessageBytes?: number;
  signal?: AbortSignal;
}

/** Serve over stdio until the client closes stdin or `signal` aborts. Resolves when the connection has closed. */
export async function serveStdio(runtime: ServiceRuntime, options: StdioOptions = {}, ops: readonly AnyOperation[] = OPERATIONS): Promise<void> {
  const server = createMcpServer(runtime, ops);
  const transport = new StdioServerTransport(options.stdin, options.stdout, { maxBufferSize: options.maxMessageBytes ?? DEFAULT_API_LIMITS.maxIngestBodyBytes });
  const closed = new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
  });

  // Requests received but not yet answered (answered = the reply has been written). End of input must wait for them: a
  // one-shot client (`printf '<request>\n' | ghostwriter mcp`) closes stdin right after writing, and still wants its reply.
  // The hooks go in BEFORE `connect`: input that is already buffered is delivered as soon as the transport starts.
  const unanswered = new Set<string | number>();
  let whenIdle: (() => void) | undefined;
  let tracked: ((message: JSONRPCMessage) => void) | undefined;
  Object.defineProperty(transport, 'onmessage', {
    configurable: true,
    get: () => tracked,
    set: (h: ((message: JSONRPCMessage) => void) | undefined) => {
      tracked =
        h === undefined
          ? undefined
          : (message): void => {
              if ('method' in message && 'id' in message) unanswered.add(message.id);
              h(message);
            };
    },
  });
  const send = transport.send.bind(transport);
  transport.send = async (message) => {
    try {
      await send(message);
    } finally {
      if ('id' in message && message.id !== undefined && ('result' in message || 'error' in message)) {
        unanswered.delete(message.id);
        if (unanswered.size === 0) whenIdle?.();
      }
    }
  };
  const drained = async (): Promise<void> => {
    while (unanswered.size > 0) await new Promise<void>((resolve) => (whenIdle = resolve));
  };

  // The SDK transport does not notice the client hanging up; end of input means the session is over once the replies are out.
  const input = options.stdin ?? process.stdin;
  let ending = false;
  const onEnd = (): void => {
    if (ending) return;
    ending = true;
    void drained().then(() => server.close());
  };
  input.once('end', onEnd);
  input.once('close', onEnd);
  await server.connect(transport);
  // An abort (SIGINT / SIGTERM) is a shutdown request: do not wait for work in progress.
  const onAbort = (): void => void server.close();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted === true) onAbort();
  await closed;
  options.signal?.removeEventListener('abort', onAbort);
}

/** Handle one streamable-HTTP MCP request (POST). `body` is the already size-limited, parsed JSON. */
export async function handleMcpHttp(runtime: ServiceRuntime, req: IncomingMessage, res: ServerResponse, body: unknown, ops: readonly AnyOperation[] = OPERATIONS): Promise<void> {
  const inflight = new Set<Promise<unknown>>();
  const server = createMcpServer(runtime, ops, inflight);
  const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
  const closed = new Promise<void>((resolve) => {
    res.on('close', () => {
      void transport.close();
      void server.close();
      resolve();
    });
  });
  await server.connect(transport);
  const handled = transport.handleRequest(req, res, body);
  handled.catch(() => undefined); // an error after the client left has nobody to report to
  // The transport's promise never settles when the client hangs up mid-call, so do not wait on it alone.
  await Promise.race([handled, closed]);
  // Resolve only when the tool calls have finished, even if the client hung up: the caller holds a concurrency slot
  // until then, so a dropped connection cannot start more work than the cap allows.
  await new Promise<void>((resolve) => setImmediate(resolve));
  while (inflight.size > 0) await Promise.allSettled([...inflight]);
}
