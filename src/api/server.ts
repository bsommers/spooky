// HTTP surface (Phase 9): a small `node:http` server over the operations registry. No framework: the whole surface is
// one handler, so every check below is visible in one place and none can be skipped by a router.
//
//   GET  /api/<read operation>?field=value     POST /api/<operation>  {json}      GET /openapi.json      POST /mcp (opt-in)
//
// Routes are DERIVED from the registry (`op.http`); this file names no operation. Order of checks for every request:
//   Host (DNS rebinding) -> Origin (CSRF / CORS) -> preflight -> static hook -> bearer token -> route -> method ->
//   concurrency -> content type -> declared size -> streamed size + time -> JSON -> schema -> handler.
// Responses are `{ok:true,...}` / `{ok:false,error:{code,message}}` with the status from the shared error table.
// The token, request bodies and query strings never reach a log line or a response.
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { handleMcpHttp } from '../mcp/server.js';
import { ConfigError } from '../models/errors.js';
import { describeError, errorDocument, SurfaceError } from '../service/errors.js';
import { buildOpenApi, serializeOpenApi } from '../service/openapi.js';
import { OPERATIONS } from '../service/operations.js';
import type { AnyOperation } from '../service/operations.js';
import type { ServiceRuntime } from '../service/runtime.js';
import { packageVersion } from '../service/version.js';
import {
  DEFAULT_HOST,
  assertBindAllowed,
  bearerMatches,
  buildHostPolicy,
  checkHost,
  classifyOrigin,
  normalizeAllowedOrigin,
  validateToken,
} from './auth.js';
import { ConcurrencyGate, DEFAULT_API_LIMITS, MAX_BODY_CEILING, checkDeclaredLength, isJsonContentType, readBody } from './limits.js';
import type { ApiLimits } from './limits.js';

/** Optional hook for a UI mount (Phase 10): return true when it answered. Runs before the token check and sets its own CSP. */
export type StaticHandler = (req: IncomingMessage, res: ServerResponse, url: URL) => boolean | Promise<boolean>;

export interface ApiServerOptions {
  runtime: ServiceRuntime;
  /** Default 127.0.0.1. Anything but loopback requires `token`. */
  host?: string;
  /** Default 8787; 0 = pick a free port. */
  port?: number;
  /** Bearer token. Absent = open to every local process that can reach the socket. */
  token?: string;
  /** Exact browser origins allowed to call the API cross-origin (CORS). Never `*`. */
  allowOrigins?: readonly string[];
  /** Extra Host header names accepted besides loopback and the bind host. */
  allowHosts?: readonly string[];
  limits?: Partial<ApiLimits>;
  /** Serve `/api/*` and `/openapi.json` (default true). */
  api?: boolean;
  /** Serve MCP over streamable HTTP at `/mcp` (default false). */
  mcp?: boolean;
  staticHandler?: StaticHandler;
  /** One line per request: method, path, status, ms. Default: none. */
  log?: (line: string) => void;
  /** Registry to serve (tests). Default: the real one. */
  operations?: readonly AnyOperation[];
}

export interface ApiServer {
  readonly server: Server;
  readonly host: string;
  readonly port: number;
  /** `http://127.0.0.1:8787` */
  readonly url: string;
  close(): Promise<void>;
}

export const DEFAULT_PORT = 8787;
export const MCP_PATH = '/mcp';
export const OPENAPI_PATH = '/openapi.json';

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
};
const API_CSP = "default-src 'none'; frame-ancestors 'none'";

/** Headers every response carries. A static handler passes its own `csp` (the UI needs scripts and styles). */
export function applySecurityHeaders(res: ServerResponse, csp: string = API_CSP): void {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  res.setHeader('Content-Security-Policy', csp);
}

const printable = (s: string, max: number): string => s.slice(0, max).replace(/[^\x20-\x7E]/g, '?');

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const buf = Buffer.from(text, 'utf8');
  applySecurityHeaders(res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', String(buf.length));
  for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
  res.statusCode = status;
  res.end(buf);
}

/** Read a query string into an input object. A repeated key or a non-identifier key is a usage error. */
function queryInput(url: URL): Record<string, string> {
  const out: Record<string, string> = {};
  const seen = new Set<string>();
  for (const [k, v] of url.searchParams) {
    if (seen.has(k)) throw new SurfaceError('USAGE', 'a query parameter was repeated');
    seen.add(k);
    Object.defineProperty(out, k, { value: v, enumerable: true, writable: true, configurable: true }); // `__proto__` stays a plain key
  }
  return out;
}

function parseJsonBody(buf: Buffer): unknown {
  if (buf.length === 0) return {};
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    throw new SurfaceError('USAGE', 'the request body is not valid UTF-8');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new SurfaceError('USAGE', 'the request body is not valid JSON');
  }
}

export async function startApiServer(options: ApiServerOptions): Promise<ApiServer> {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ConfigError('--port must be an integer from 0 to 65535');
  const token = options.token === undefined ? undefined : validateToken(options.token);
  assertBindAllowed({ host, hasToken: token !== undefined });
  const limits: ApiLimits = { ...DEFAULT_API_LIMITS, ...options.limits };
  for (const [flag, v] of [['--max-body', limits.maxBodyBytes], ['--max-ingest-body', limits.maxIngestBodyBytes]] as const) {
    if (!Number.isInteger(v) || v < 1024 || v > MAX_BODY_CEILING) throw new ConfigError(`${flag} must be between 1024 and ${MAX_BODY_CEILING} bytes`);
  }
  if (!Number.isInteger(limits.maxConcurrent) || limits.maxConcurrent < 1) throw new ConfigError('max concurrency must be a positive integer');
  const origins = { allowedOrigins: new Set((options.allowOrigins ?? []).map(normalizeAllowedOrigin)) };
  const hosts = buildHostPolicy(host, token !== undefined, options.allowHosts ?? []);
  const ops = options.operations ?? OPERATIONS;
  const serveApi = options.api !== false;
  const serveMcp = options.mcp === true;
  const routes = new Map<string, AnyOperation>(ops.map((o) => [o.http.path, o]));
  const openapi = serveApi ? serializeOpenApi(buildOpenApi({ version: packageVersion() }, ops)) : '';
  const gate = new ConcurrencyGate(limits.maxConcurrent);
  const log = options.log ?? ((): void => undefined);
  const runtime = options.runtime;

  async function route(req: IncomingMessage, res: ServerResponse, url: URL, seen: { route: string }): Promise<void> {
    const method = req.method ?? 'GET';
    const path = url.pathname;

    checkHost(hosts, req.headers.host);
    const originHeader = req.headers.origin;
    const verdict = classifyOrigin(origins, typeof originHeader === 'string' ? originHeader : undefined, req.headers.host);
    if (Array.isArray(originHeader) || verdict === 'denied') throw new SurfaceError('FORBIDDEN', 'this origin is not allowed');
    if (verdict === 'allowed') {
      res.setHeader('Access-Control-Allow-Origin', originHeader as string);
      res.setHeader('Vary', 'Origin');
    }

    if (method === 'OPTIONS') {
      res.setHeader('Allow', 'GET, POST, OPTIONS');
      if (verdict === 'allowed') {
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, Mcp-Protocol-Version');
        res.setHeader('Access-Control-Max-Age', '600');
      }
      applySecurityHeaders(res);
      res.statusCode = 204;
      res.end();
      return;
    }

    const isApi = serveApi && (path.startsWith('/api/') || path === OPENAPI_PATH);
    const isMcp = serveMcp && path === MCP_PATH;
    if (!isApi && !isMcp) {
      if (options.staticHandler !== undefined && (method === 'GET' || method === 'HEAD') && !path.startsWith('/api/') && path !== MCP_PATH && path !== OPENAPI_PATH) {
        if (await options.staticHandler(req, res, url)) return;
      }
      throw new SurfaceError('NOT_FOUND', 'no such route');
    }

    if (token !== undefined && !bearerMatches(req.headers.authorization, token)) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      throw new SurfaceError('UNAUTHORIZED', 'a valid bearer token is required');
    }

    if (isMcp) {
      seen.route = MCP_PATH;
      if (method !== 'POST') {
        res.setHeader('Allow', 'POST');
        throw new SurfaceError('METHOD_NOT_ALLOWED', 'MCP over HTTP accepts POST only');
      }
      const release = gate.acquire();
      res.once('close', release);
      if (!isJsonContentType(req.headers['content-type'])) throw new SurfaceError('UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json');
      checkDeclaredLength(req, limits.maxIngestBodyBytes);
      const body = parseJsonBody(await readBody(req, { ...limits, maxBodyBytes: limits.maxIngestBodyBytes }));
      await handleMcpHttp(runtime, req, res, body, ops);
      return;
    }

    if (path === OPENAPI_PATH) {
      seen.route = OPENAPI_PATH;
      if (method !== 'GET') {
        res.setHeader('Allow', 'GET');
        throw new SurfaceError('METHOD_NOT_ALLOWED', 'method not allowed');
      }
      sendJson(res, 200, openapi);
      return;
    }

    const op = routes.get(path);
    if (op === undefined) throw new SurfaceError('NOT_FOUND', 'no such route');
    seen.route = op.http.path;
    if (method !== op.http.method) {
      res.setHeader('Allow', op.http.method);
      throw new SurfaceError('METHOD_NOT_ALLOWED', `use ${op.http.method} for this route`);
    }
    const release = gate.acquire();
    res.once('close', release);

    let input: unknown;
    if (op.http.method === 'GET') {
      input = queryInput(url);
    } else {
      if (!isJsonContentType(req.headers['content-type'])) throw new SurfaceError('UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json');
      const cap = op.mutates ? limits.maxIngestBodyBytes : limits.maxBodyBytes;
      checkDeclaredLength(req, cap);
      input = parseJsonBody(await readBody(req, { ...limits, maxBodyBytes: cap }));
    }
    sendJson(res, 200, await runtime.runDocument(op, input));
  }

  const server = createServer({ maxHeaderSize: 16 * 1024 }, (req, res) => {
    const started = Date.now();
    // Only the path of a ROUTE THIS SERVER KNOWS is logged: an unmatched path is attacker-chosen text and could carry a secret.
    const seen = { route: '(unrouted)' };
    res.once('close', () => log(`${printable(req.method ?? '?', 8)} ${seen.route} ${res.statusCode} ${Date.now() - started}ms`));
    void (async () => {
      try {
        if (typeof req.url !== 'string' || !req.url.startsWith('/')) throw new SurfaceError('USAGE', 'the request target must be an absolute path');
        await route(req, res, new URL(req.url, 'http://localhost'), seen);
      } catch (err) {
        if (res.headersSent) {
          res.destroy();
          return;
        }
        const d = describeError(err);
        const extra: Record<string, string> = {};
        if (d.retryAfterSeconds !== undefined) extra['Retry-After'] = String(d.retryAfterSeconds);
        // A rejected upload may still be streaming in: do not keep the connection for the next request.
        if (d.http === 413 || d.http === 408 || d.http === 415 || d.http === 400) extra.Connection = 'close';
        if (d.code === 'INTERNAL' || d.code === 'IO_ERROR') log(`error ${d.code} ${d.message}`);
        sendJson(res, d.http, errorDocument(d), extra);
      }
    })();
  });
  server.requestTimeout = Math.max(limits.readTimeoutMs * 2, 10_000);
  server.headersTimeout = Math.min(limits.readTimeoutMs, 60_000);
  server.keepAliveTimeout = 5_000;

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve();
    });
  });
  const addr = server.address() as AddressInfo;
  const shownHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return {
    server,
    host,
    port: addr.port,
    url: `http://${shownHost}:${addr.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
