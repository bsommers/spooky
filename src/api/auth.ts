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

/** Distinct characters a token must use, and the empirical (Shannon) bits it must carry: rejects `aaaa...` and `abababab...`. */
export const MIN_TOKEN_DISTINCT = 8;
export const MIN_TOKEN_BITS = 48;

/** Bits of information the character frequencies of `s` account for (empirical entropy x length). */
function empiricalBits(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) bits -= n * Math.log2(n / s.length);
  return bits;
}

/**
 * A usable bearer token: printable ASCII, no whitespace, 16 to 512 characters, at least 8 distinct characters and a
 * plausible amount of variety (not `aaaaaaaaaaaaaaaa`). Throws `ConfigError` (never echoing it).
 */
export function validateToken(token: string): string {
  if (token.length < MIN_TOKEN_LENGTH || token.length > MAX_TOKEN_LENGTH || !/^[\x21-\x7E]+$/.test(token)) {
    throw new ConfigError(`the API token must be ${MIN_TOKEN_LENGTH}-${MAX_TOKEN_LENGTH} printable characters without spaces (generate one with: openssl rand -hex 24)`);
  }
  if (new Set(token).size < MIN_TOKEN_DISTINCT || empiricalBits(token) < MIN_TOKEN_BITS) {
    throw new ConfigError('the API token is too repetitive to be a secret; generate one with: openssl rand -hex 24');
  }
  return token;
}

export interface AuthThrottleOptions {
  /** Failures from one address that cost nothing (a mistyped token). */
  freeFailures: number;
  /** Delay before the 401 once the free failures are used up, doubling per further failure. */
  baseDelayMs: number;
  maxDelayMs: number;
  /** This many failures inside `windowMs` lock the address out (429) for `lockoutMs`. */
  lockoutFailures: number;
  windowMs: number;
  lockoutMs: number;
  /** Addresses remembered at once; the oldest is dropped beyond this. */
  maxTracked: number;
  now?: () => number;
}

export const DEFAULT_AUTH_THROTTLE: Readonly<Omit<AuthThrottleOptions, 'now'>> = Object.freeze({
  freeFailures: 3,
  baseDelayMs: 250,
  maxDelayMs: 4000,
  lockoutFailures: 20,
  windowMs: 60_000,
  lockoutMs: 60_000,
  maxTracked: 1024,
});

/**
 * Slows and then stops guessing of the bearer token from one remote address: failures past a small allowance are
 * answered after an exponentially growing delay, and enough of them lock the address out. A lockout refuses even the
 * right token (the check is not run), so guessing cannot continue behind it. Note that every local process shares
 * 127.0.0.1: a local guesser locks out the local user for the lockout period, which is the price of stopping it.
 */
export class AuthThrottle {
  readonly #o: Omit<AuthThrottleOptions, 'now'>;
  readonly #now: () => number;
  readonly #entries = new Map<string, { failures: number; last: number; lockedUntil: number }>();

  constructor(options: Partial<AuthThrottleOptions> = {}) {
    this.#o = { ...DEFAULT_AUTH_THROTTLE, ...options };
    this.#now = options.now ?? Date.now;
  }

  /** Seconds until the address may try again, or `undefined` when it is not locked out. */
  lockedFor(key: string): number | undefined {
    const e = this.#entries.get(key);
    if (e === undefined) return undefined;
    const now = this.#now();
    if (e.lockedUntil > now) return Math.max(1, Math.ceil((e.lockedUntil - now) / 1000));
    if (e.lockedUntil > 0 || now - e.last > this.#o.windowMs) this.#entries.delete(key);
    return undefined;
  }

  /** Record a failed attempt; returns the milliseconds to wait before answering it. */
  failed(key: string): number {
    const now = this.#now();
    const prev = this.#entries.get(key);
    const fresh = prev === undefined || now - prev.last > this.#o.windowMs || prev.lockedUntil > 0;
    const failures = (fresh ? 0 : prev.failures) + 1;
    this.#entries.delete(key); // re-insert last: Map order = least recently failed first
    if (this.#entries.size >= this.#o.maxTracked) this.#entries.delete(this.#entries.keys().next().value as string);
    this.#entries.set(key, { failures, last: now, lockedUntil: failures >= this.#o.lockoutFailures ? now + this.#o.lockoutMs : 0 });
    const over = failures - this.#o.freeFailures;
    return over <= 0 ? 0 : Math.min(this.#o.maxDelayMs, this.#o.baseDelayMs * 2 ** Math.min(over - 1, 20));
  }

  succeeded(key: string): void {
    this.#entries.delete(key);
  }
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
