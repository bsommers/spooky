// Shared wiring for the Phase 9 surface tests: an Engine with a scripted model on a temp state dir, a ServiceRuntime,
// a running HTTP server, and a raw HTTP request helper that lets a test set any header (Host, Origin, chunked bodies).
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApiServer } from '../../src/api/server.js';
import type { ApiServer, ApiServerOptions } from '../../src/api/server.js';
import { loadConfig } from '../../src/config/load.js';
import { Engine } from '../../src/engine.js';
import { MockLlmClient } from '../../src/llm/mockClient.js';
import type { MockStep } from '../../src/llm/mockClient.js';
import { ServiceRuntime } from '../../src/service/runtime.js';
import { PERSONA, corpus, fastRetry } from './rig.js';

export interface Rigged {
  engine: Engine;
  runtime: ServiceRuntime;
  llm: MockLlmClient;
  stateDir: string;
  env: Record<string, string | undefined>;
  cleanup(): void;
}

export const CLEAN_ANSWER = 'A clean rewritten paragraph.';

export async function makeRuntime(
  options: { script?: MockStep[] | ((req: never, n: number) => string); config?: unknown; env?: Record<string, string | undefined>; ingest?: boolean } = {},
): Promise<Rigged> {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-surfaces-'));
  const config = loadConfig(options.config ?? { llm: { model: 'm' }, personas: [PERSONA], limits: { maxInputChars: 5000 } });
  const llm = new MockLlmClient((options.script ?? (() => CLEAN_ANSWER)) as MockStep[]);
  const env = options.env ?? {};
  const engine = await Engine.create({ config, stateDir, llm, retry: fastRetry, env });
  if (options.ingest !== false) await engine.ingest('terse', 'Terse Author', corpus());
  const runtime = new ServiceRuntime(engine, { stateDir });
  await runtime.markLoaded();
  return { engine, runtime, llm, stateDir, env, cleanup: () => rmSync(stateDir, { recursive: true, force: true }) };
}

export async function startTestServer(rig: Rigged, options: Partial<ApiServerOptions> = {}): Promise<ApiServer & { logs: string[] }> {
  const logs: string[] = [];
  const server = await startApiServer({ runtime: rig.runtime, port: 0, log: (l) => logs.push(l), ...options });
  return Object.assign(server, { logs });
}

export interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
  json: () => any;
}

export interface RawOptions {
  method?: string;
  headers?: Record<string, string | string[]>;
  body?: string | Buffer | undefined;
  /** Write the body in pieces with no Content-Length (chunked). */
  chunks?: (Buffer | string)[];
  /** Give up waiting after this long (ms). */
  timeoutMs?: number;
}

/** One HTTP request to `server`, by hand. A connection reset after a response started still yields that response. */
export function raw(server: Pick<ApiServer, 'host' | 'port'>, path: string, options: RawOptions = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | string[]> = { ...options.headers };
    const body = options.body;
    if (body !== undefined && options.chunks === undefined && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-length')) {
      headers['Content-Length'] = String(Buffer.byteLength(body));
    }
    const req = request({ host: server.host, port: server.port, path, method: options.method ?? 'GET', headers, agent: false }, (res) => {
      const parts: Buffer[] = [];
      res.on('data', (c: Buffer) => parts.push(c));
      const finish = (): void => {
        const text = Buffer.concat(parts).toString('utf8');
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json: () => JSON.parse(text) });
      };
      res.on('end', finish);
      res.on('error', finish);
      res.on('close', finish);
    });
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error('raw(): timed out'));
    }, options.timeoutMs ?? 15_000);
    req.on('close', () => clearTimeout(timer));
    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    if (options.chunks !== undefined) {
      for (const c of options.chunks) req.write(c);
      req.end();
    } else req.end(body);
  });
}

/** POST JSON. */
export const postJson = (server: Pick<ApiServer, 'host' | 'port'>, path: string, data: unknown, headers: Record<string, string> = {}): Promise<Reply> =>
  raw(server, path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data) });

/** An MCP client wired to an in-process MCP server over the registry (no process, no socket). */
export async function connectMcp(rig: Rigged): Promise<{ client: import('@modelcontextprotocol/sdk/client/index.js').Client; close(): Promise<void> }> {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { createMcpServer } = await import('../../src/mcp/server.js');
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(rig.runtime);
  const client = new Client({ name: 'test', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}
