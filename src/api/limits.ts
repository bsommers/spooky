// Resource limits of the HTTP surface (Phase 9). Every number that bounds untrusted input lives here.
//
//   body size   : Content-Length over the cap is refused before a byte is read; without one (chunked) the stream is
//                 counted and aborted at the cap. The body is never parsed before the whole of it is within the cap.
//   body time   : a client that dribbles its body is cut off (408), so a few sockets cannot pin the server.
//   concurrency : at most `maxConcurrent` operations in flight; the next is refused with 503 + Retry-After.
import type { IncomingMessage } from 'node:http';
import { SurfaceError } from '../service/errors.js';
import { InputTooLargeError } from '../models/errors.js';

export interface ApiLimits {
  /** Largest request body in bytes for every route except ingest (REQUIREMENTS API-03: default 1 MiB). */
  maxBodyBytes: number;
  /** Largest body for `ingest` and for `/mcp` (which can carry an ingest call): default 10 MiB. A corpus is capped by the engine separately. */
  maxIngestBodyBytes: number;
  /** Time allowed to receive the whole request (headers and body), milliseconds. */
  readTimeoutMs: number;
  /** Operations (and MCP requests) running at the same time. */
  maxConcurrent: number;
}

export const DEFAULT_API_LIMITS: Readonly<ApiLimits> = Object.freeze({
  maxBodyBytes: 1024 * 1024,
  maxIngestBodyBytes: 10 * 1024 * 1024,
  readTimeoutMs: 30_000,
  maxConcurrent: 8,
});

/** Hard ceilings for what the CLI flags may ask for. */
export const MAX_BODY_CEILING = 256 * 1024 * 1024;

/** Cap on the declared `Content-Length`: refuse before reading. Throws `InputTooLargeError` (413). */
export function checkDeclaredLength(req: IncomingMessage, max: number): void {
  const raw = req.headers['content-length'];
  if (raw === undefined) return;
  const n = /^\d{1,15}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isFinite(n)) throw new SurfaceError('USAGE', 'invalid Content-Length');
  if (n > max) throw new InputTooLargeError(n, max, 'bytes');
}

/** Read the body within the byte and time caps. Throws `InputTooLargeError` (413) or `SurfaceError` REQUEST_TIMEOUT (408). */
export function readBody(req: IncomingMessage, limits: Pick<ApiLimits, 'maxBodyBytes' | 'readTimeoutMs'>): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const parts: Buffer[] = [];
    let size = 0;
    let settled = false;
    const done = (err: Error | undefined, value?: Buffer): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
      if (err !== undefined) {
        req.pause(); // stop consuming; the server closes the connection after answering
        reject(err);
      } else resolve(value as Buffer);
    };
    const onData = (chunk: Buffer | string): void => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      size += buf.length;
      if (size > limits.maxBodyBytes) {
        done(new InputTooLargeError(size, limits.maxBodyBytes, 'bytes'));
        return;
      }
      parts.push(buf);
    };
    const onEnd = (): void => done(undefined, Buffer.concat(parts));
    const onError = (): void => done(new SurfaceError('USAGE', 'the request body could not be read'));
    const onAborted = (): void => done(new SurfaceError('USAGE', 'the request was aborted'));
    const timer = setTimeout(() => done(new SurfaceError('REQUEST_TIMEOUT', 'the request body was not received in time')), limits.readTimeoutMs);
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
  });
}

/** `application/json` with an optional `charset=utf-8` parameter and nothing else. */
export function isJsonContentType(value: string | undefined): boolean {
  if (value === undefined) return false;
  return /^application\/json\s*(;\s*charset\s*=\s*"?utf-8"?\s*)?$/i.test(value.trim());
}

/** Count of in-flight operations against a ceiling. */
export class ConcurrencyGate {
  #active = 0;
  readonly #max: number;

  constructor(max: number) {
    this.#max = max;
  }

  get active(): number {
    return this.#active;
  }

  /** Take a slot or throw OVERLOADED (503 with Retry-After). Release exactly once with the returned function. */
  acquire(): () => void {
    if (this.#active >= this.#max) throw new SurfaceError('OVERLOADED', 'the server is busy; retry shortly', { retryAfterSeconds: 1 });
    this.#active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active -= 1;
    };
  }
}
