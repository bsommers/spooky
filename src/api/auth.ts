// Access control for the HTTP surface (Phase 9): bearer token, bind policy, Host / Origin checks, CORS.
//
// Threats: a web page in the user's browser calling the local API (CORS, CSRF, DNS rebinding), another machine reaching
// a server bound beyond loopback, and the token leaking. The token is compared in constant time, is never logged and
// never appears in a response. Without a token the server is open to anything that can reach the socket, which is why
// the default bind is loopback only and a non-loopback bind without a token refuses to start.
import { createHash, timingSafeEqual } from 'node:crypto';
import { isLoopbackHost } from '../llm/endpoint.js';
import { ConfigError } from '../models/errors.js';
import { SurfaceError } from '../service/errors.js';

export const MIN_TOKEN_LENGTH = 16;
export const MAX_TOKEN_LENGTH = 512;
export const DEFAULT_HOST = '127.0.0.1';

/** A usable bearer token: printable ASCII, no whitespace, 16 to 512 characters. Throws `ConfigError` (never echoing it). */
export function validateToken(token: string): string {
  if (token.length < MIN_TOKEN_LENGTH || token.length > MAX_TOKEN_LENGTH || !/^[\x21-\x7E]+$/.test(token)) {
    throw new ConfigError(`the API token must be ${MIN_TOKEN_LENGTH}-${MAX_TOKEN_LENGTH} printable characters without spaces`);
  }
  return token;
}

const digest = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();

/** Constant-time check of an `Authorization` header value against the token. Equal-length digests go to `timingSafeEqual`. */
export function bearerMatches(header: string | undefined, token: string): boolean {
  if (header === undefined) return false;
  const m = /^Bearer ([\x21-\x7E]+)$/.exec(header);
  const presented = m?.[1];
  // Always do the comparison so a missing or malformed header costs the same as a wrong token.
  const ok = timingSafeEqual(digest(presented ?? ''), digest(token));
  return ok && presented !== undefined;
}

export interface BindPolicy {
  host: string;
  hasToken: boolean;
}

/** Loopback hosts are the only ones allowed without a token. Wildcard and external addresses require one. */
export function isLoopbackBind(host: string): boolean {
  return isLoopbackHost(host.toLowerCase());
}

/** Refuse a bind that would expose the service without a token (`ConfigError`). */
export function assertBindAllowed(policy: BindPolicy): void {
  if (!isLoopbackBind(policy.host) && !policy.hasToken) {
    throw new ConfigError(
      `refusing to listen on "${policy.host}" without an API token: set one with --token-env <NAME> (a variable holding 16+ characters), or bind to ${DEFAULT_HOST}`,
    );
  }
}

/** Hostname part of a `Host` header (`[::1]:8080` -> `[::1]`, `LocalHost:80` -> `localhost`); undefined when malformed. */
export function hostnameOfHostHeader(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0 || value.length > 255) return undefined;
  const m = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+)(?::(\d{1,5}))?$/.exec(value);
  return m?.[1]?.toLowerCase();
}

export interface HostPolicy {
  /** Hostnames accepted in the Host header; `undefined` turns the check off (only for a token-protected non-loopback bind). */
  allowedHosts: ReadonlySet<string> | undefined;
}

export function buildHostPolicy(bindHost: string, hasToken: boolean, extraHosts: readonly string[] = []): HostPolicy {
  if (!isLoopbackBind(bindHost) && hasToken && (bindHost === '0.0.0.0' || bindHost === '::' || bindHost === '[::]')) {
    // A wildcard bind is reachable under any name the machine has; the token is the control there.
    return { allowedHosts: undefined };
  }
  const hosts = new Set(['localhost', '127.0.0.1', '[::1]']);
  const configured = bindHost.toLowerCase();
  hosts.add(configured.includes(':') && !configured.startsWith('[') ? `[${configured}]` : configured);
  for (const h of extraHosts) hosts.add(h.toLowerCase());
  return { allowedHosts: hosts };
}

/** DNS-rebinding defense: the Host header must name this server. Throws `SurfaceError` MISDIRECTED_REQUEST (421). */
export function checkHost(policy: HostPolicy, hostHeader: string | undefined): void {
  if (policy.allowedHosts === undefined) return;
  const name = hostnameOfHostHeader(hostHeader);
  if (name === undefined || !policy.allowedHosts.has(name)) {
    throw new SurfaceError('MISDIRECTED_REQUEST', 'the Host header does not name this server');
  }
}

/** An allow-listed browser origin: exact `scheme://host[:port]`, never `*`, no path. Throws `ConfigError`. */
export function normalizeAllowedOrigin(raw: string): string {
  if (raw === '*' || raw === 'null') throw new ConfigError('--allow-origin must name an exact origin such as http://localhost:5173, never "*" or "null"');
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ConfigError('--allow-origin must be an origin such as http://localhost:5173');
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.pathname !== '/' || u.search !== '' || u.hash !== '' || u.username !== '' || u.password !== '') {
    throw new ConfigError('--allow-origin must be an origin such as http://localhost:5173 (scheme, host and optional port only)');
  }
  return u.origin;
}

export interface OriginPolicy {
  allowedOrigins: ReadonlySet<string>;
}

export type OriginVerdict = 'none' | 'same-origin' | 'allowed' | 'denied';

/**
 * Classify the `Origin` header. No header (a non-browser client) = `none`. Same origin = the Origin names this server
 * (its host equals the Host header). An allow-listed origin is `allowed` (CORS applies). Anything else is `denied`.
 */
export function classifyOrigin(policy: OriginPolicy, origin: string | undefined, hostHeader: string | undefined): OriginVerdict {
  if (origin === undefined) return 'none';
  if (policy.allowedOrigins.has(origin)) return 'allowed';
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return 'denied';
  }
  if (u.origin === origin && hostHeader !== undefined && u.host.toLowerCase() === hostHeader.toLowerCase() && (u.protocol === 'http:' || u.protocol === 'https:')) return 'same-origin';
  return 'denied';
}
