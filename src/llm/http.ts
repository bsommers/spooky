// Shared HTTP plumbing for the provider adapters: a size-capped body reader and failure classification.
// Nothing here ever puts a URL, header or response text into an error; see LlmTransportError.
import { LlmTransportError, parseRetryAfter } from './retry.js';

export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Is `err` the abort or timeout raised by an AbortSignal (or undici's equivalent)? */
export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

/** Classify a thrown fetch/body failure as a typed, secret-free transport error. */
export function classifyFetchError(err: unknown): LlmTransportError {
  if (err instanceof LlmTransportError) return err;
  return new LlmTransportError(isAbortError(err) ? 'timeout' : 'network');
}

/** Typed error for a non-2xx response; carries status and a parsed Retry-After only. */
export function httpError(res: Response): LlmTransportError {
  const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
  return new LlmTransportError('http', retryAfterMs === undefined ? { status: res.status } : { status: res.status, retryAfterMs });
}

/**
 * Read the whole body, refusing anything larger than `maxBytes` (declared by Content-Length or counted while
 * streaming; the stream is cancelled the moment the cap is crossed). Abort/timeout/network failures mid-body are
 * classified, never leaked raw.
 */
export async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw new LlmTransportError('too-large');
  }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new LlmTransportError('too-large');
      }
      parts.push(value);
    }
  } catch (err) {
    throw classifyFetchError(err);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/** Check a positive-integer-ish option; returns the fallback for anything else. */
export function positive(n: number | undefined, fallback: number): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : fallback;
}
