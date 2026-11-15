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

export function createMcpServer(runtime: ServiceRuntime, ops: readonly AnyOperation[] = OPERATIONS): Server {
  const server = new Server({ name: 'ghostwriter', version: packageVersion() }, { capabilities: { tools: {} }, instructions: MCP_INSTRUCTIONS });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: toolDefinitions(ops) }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const result = await callTool(runtime, request.params.name, request.params.arguments, ops);
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
  await server.connect(transport);
  // The SDK transport does not notice the client hanging up; end of input means the session is over.
  const input = options.stdin ?? process.stdin;
  input.once('end', () => void server.close());
  input.once('close', () => void server.close());
  const onAbort = (): void => void server.close();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted === true) onAbort();
  await closed;
  options.signal?.removeEventListener('abort', onAbort);
}

/** Handle one streamable-HTTP MCP request (POST). `body` is the already size-limited, parsed JSON. */
export async function handleMcpHttp(runtime: ServiceRuntime, req: IncomingMessage, res: ServerResponse, body: unknown, ops: readonly AnyOperation[] = OPERATIONS): Promise<void> {
  const server = createMcpServer(runtime, ops);
  const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
