// Bounded retry for LLM calls (LLM-02).
//
//  * Retries only transient failures: HTTP 429, HTTP 5xx, network errors and request timeouts. Any other failure
//    (4xx, malformed, empty or truncated response, a failure that is already an `LlmError`) is final on the first attempt.
//  * Delay before retry n is baseMs * 2^(n-1), raised to a server-supplied Retry-After when that is larger, and always
//    clamped to maxDelayMs so a hostile or buggy server cannot park the caller.
//  * The terminal error is an `LlmError(attempts)` whose `cause` is a `LlmTransportError` carrying only a failure kind
//    and an HTTP status: never a response body, a header or a URL, so an API key cannot ride out in a message or log.
import { LlmError } from '../models/errors.js';

export type LlmFailureKind = 'http' | 'network' | 'timeout' | 'invalid-response' | 'empty-response' | 'too-large' | 'truncated';

/** A single failed provider attempt. The message is built from `kind` and `status` only. */
export class LlmTransportError extends Error {
  readonly kind: LlmFailureKind;
  readonly status?: number;
  /** Server-requested wait before the next attempt, already parsed to milliseconds (unbounded; withRetry clamps it). */
  readonly retryAfterMs?: number;

  constructor(kind: LlmFailureKind, options: { status?: number; retryAfterMs?: number } = {}) {
    super(options.status === undefined ? `LLM provider failure: ${kind}` : `LLM provider failure: ${kind} (HTTP ${options.status})`);
    this.name = 'LlmTransportError';
    this.kind = kind;
    if (options.status !== undefined) this.status = options.status;
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
  }
}

/** Parse a Retry-After header value (delta-seconds or HTTP-date) to milliseconds, or undefined when absent or invalid. */
export function parseRetryAfter(value: string | null | undefined, now: () => number = Date.now): number | undefined {
  if (value === null || value === undefined) return undefined;
  const v = value.trim();
  if (/^\d{1,9}$/.test(v)) return Number(v) * 1000;
  if (!/^[A-Za-z]{3},? /.test(v)) return undefined; // HTTP-date only; V8's Date.parse also accepts junk like '1.5'
  const at = Date.parse(v);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now());
}

/** Default retry predicate: 429, 5xx, network errors and timeouts. */
export function isRetryableLlmError(err: unknown): boolean {
  if (!(err instanceof LlmTransportError)) return false;
  if (err.kind === 'network' || err.kind === 'timeout') return true;
  if (err.kind === 'http') return err.status === 429 || (err.status !== undefined && err.status >= 500 && err.status <= 599);
  return false;
}

export interface RetryOptions {
  /** Retries after the first attempt (so attempts = maxRetries + 1). Clamped to [0, MAX_RETRIES]. Default 2. */
  maxRetries?: number;
  /** Base backoff in milliseconds; delay n is baseMs * 2^(n-1). Default 500. */
  baseMs?: number;
  /** Upper bound on any single wait, including a server Retry-After. Default 30000. */
  maxDelayMs?: number;
  /** Wait implementation; tests inject a fake. */
  sleep?: (ms: number) => Promise<void>;
  isRetryable?: (err: unknown) => boolean;
}

export const MAX_RETRIES = 10;
export const DEFAULT_RETRY = { maxRetries: 2, baseMs: 500, maxDelayMs: 30_000 } as const;

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function nonNegative(n: number | undefined, fallback: number): number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Run `fn` until it succeeds, fails with a non-retryable error, or the retries are spent.
 * Resolves with fn's value; rejects with `LlmError(attempts, cause)` (an `LlmError` thrown by fn passes through
 * untouched, so a client that already retried internally is not retried again).
 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxRetries = Math.min(MAX_RETRIES, Math.floor(nonNegative(options.maxRetries, DEFAULT_RETRY.maxRetries)));
  const baseMs = nonNegative(options.baseMs, DEFAULT_RETRY.baseMs);
  const maxDelayMs = nonNegative(options.maxDelayMs, DEFAULT_RETRY.maxDelayMs);
  const sleep = options.sleep ?? realSleep;
  const isRetryable = options.isRetryable ?? isRetryableLlmError;

  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (err instanceof LlmError) throw err;
      if (attempt > maxRetries || !isRetryable(err)) throw new LlmError(attempt, sanitizeCause(err));
      const backoff = baseMs * 2 ** (attempt - 1);
      const asked = err instanceof LlmTransportError ? (err.retryAfterMs ?? 0) : 0;
      await sleep(Math.min(maxDelayMs, Math.max(backoff, asked)));
    }
  }
}

/**
 * Only a `LlmTransportError` (built from kind and status alone) is kept as the cause. Anything else could carry a
 * request URL, header or response text from a library, so it is reduced to its constructor name.
 */
function sanitizeCause(err: unknown): LlmTransportError | Error {
  if (err instanceof LlmTransportError) return err;
  const name = err instanceof Error ? err.name : typeof err;
  return new Error(`LLM call failed: ${name}`);
}
