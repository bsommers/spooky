// One error table for every surface (Phase 9): error `code` -> CLI exit code, HTTP status, MCP category.
//
// The codes of the typed engine errors (src/models/errors.ts) are the vocabulary; the surface-only codes (`USAGE`, the
// HTTP guard codes, `IO_ERROR`, `INTERNAL`) are added here so a transport failure and an engine failure are reported
// the same way. tests/unit/service/errors.test.ts fails if a GhostwriterError code is missing from this table.
//
// Message policy: a typed error's message is written to carry no secret and no input text (see models/errors.ts); an
// unexpected error is reported by CLASS NAME only, because its message can embed text from the request.
import { GhostwriterError, UnknownPersonaError } from '../models/errors.js';

/** Coarse MCP-side classification, reported in `_meta` of an error result so an agent can decide whether to retry. */
export type McpCategory = 'invalid_request' | 'not_found' | 'too_large' | 'upstream' | 'unavailable' | 'denied' | 'internal';

export interface ErrorSpec {
  /** Process exit code of `ghostwriter` (.planning/CONTRACTS.md "CLI exit codes"). */
  readonly exit: number;
  /** HTTP status of the API. */
  readonly http: number;
  readonly mcp: McpCategory;
}

/** Surface-only codes: raised by the transports, never by the engine. */
export type SurfaceErrorCode =
  | 'USAGE'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'METHOD_NOT_ALLOWED'
  | 'REQUEST_TIMEOUT'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'MISDIRECTED_REQUEST'
  | 'OVERLOADED';

export const ERROR_TABLE: Readonly<Record<string, ErrorSpec>> = {
  // engine errors (src/models/errors.ts)
  CONFIG_INVALID: { exit: 2, http: 400, mcp: 'invalid_request' },
  PROFILE_INVALID: { exit: 2, http: 422, mcp: 'invalid_request' },
  UNKNOWN_PERSONA: { exit: 3, http: 404, mcp: 'not_found' },
  UNKNOWN_AUTHOR: { exit: 3, http: 404, mcp: 'not_found' },
  FILTER_FAILED: { exit: 4, http: 500, mcp: 'internal' },
  LLM_FAILED: { exit: 5, http: 502, mcp: 'upstream' },
  INPUT_TOO_LARGE: { exit: 6, http: 413, mcp: 'too_large' },
  STORE_CORRUPT: { exit: 7, http: 500, mcp: 'internal' },
  STATE_LOCKED: { exit: 8, http: 503, mcp: 'unavailable' },
  DETECTORS_FAILED: { exit: 9, http: 502, mcp: 'upstream' },
  // surface-only
  USAGE: { exit: 2, http: 400, mcp: 'invalid_request' },
  UNAUTHORIZED: { exit: 1, http: 401, mcp: 'denied' },
  FORBIDDEN: { exit: 1, http: 403, mcp: 'denied' },
  NOT_FOUND: { exit: 1, http: 404, mcp: 'not_found' },
  METHOD_NOT_ALLOWED: { exit: 2, http: 405, mcp: 'invalid_request' },
  REQUEST_TIMEOUT: { exit: 1, http: 408, mcp: 'unavailable' },
  UNSUPPORTED_MEDIA_TYPE: { exit: 2, http: 415, mcp: 'invalid_request' },
  MISDIRECTED_REQUEST: { exit: 1, http: 421, mcp: 'denied' },
  OVERLOADED: { exit: 1, http: 503, mcp: 'unavailable' },
  IO_ERROR: { exit: 1, http: 500, mcp: 'internal' },
  INTERNAL: { exit: 1, http: 500, mcp: 'internal' },
};

/** Process exit code per error `code` (the CLI contract). Derived from `ERROR_TABLE`; the CLI re-exports it. */
export const EXIT_CODES: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(Object.entries(ERROR_TABLE).map(([code, s]) => [code, s.exit])),
);

/** A failure raised by a transport (bad request shape, auth, limits) rather than by the engine. Carries no input text. */
export class SurfaceError extends GhostwriterError {
  /** Optional `Retry-After` hint in seconds (HTTP 503/429 style responses). */
  readonly retryAfterSeconds: number | undefined;

  constructor(code: SurfaceErrorCode, message: string, options: { retryAfterSeconds?: number } = {}) {
    super(code, message);
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

/** Path-qualified validation failure of an operation's input (`USAGE`). */
export class InputError extends SurfaceError {
  readonly issues: readonly { path: string; message: string }[];

  constructor(message: string, issues: readonly { path: string; message: string }[] = []) {
    super('USAGE', message);
    this.issues = issues;
  }
}

export interface DescribedError {
  code: string;
  message: string;
  exit: number;
  http: number;
  mcp: McpCategory;
  retryAfterSeconds?: number;
}

const FALLBACK: ErrorSpec = { exit: 1, http: 500, mcp: 'internal' };

/** Map any thrown value to its reportable form. Only typed errors keep their message; everything else is a class name. */
export function describeError(err: unknown): DescribedError {
  if (err instanceof GhostwriterError) {
    const spec = ERROR_TABLE[err.code] ?? FALLBACK;
    const retry = err instanceof SurfaceError ? err.retryAfterSeconds : undefined;
    // The persona key is caller input and may be secret-shaped, so (like UnknownAuthorError) the report does not echo it.
    const message = err instanceof UnknownPersonaError ? `unknown persona (${err.key.length} characters); valid personas: ${err.valid.join(', ')}` : err.message;
    return { code: err.code, message, ...spec, ...(retry === undefined ? {} : { retryAfterSeconds: retry }) };
  }
  const errno = (err as NodeJS.ErrnoException | undefined)?.code;
  if (typeof errno === 'string' && /^E[A-Z0-9]+$/.test(errno)) {
    return { code: 'IO_ERROR', message: `file system error (${errno})`, ...(ERROR_TABLE.IO_ERROR as ErrorSpec) };
  }
  return { code: 'INTERNAL', message: `internal error (${err instanceof Error ? err.name : typeof err})`, ...(ERROR_TABLE.INTERNAL as ErrorSpec) };
}

/** The `{ ok:false, error }` document every surface reports (CLI `--json`, HTTP body, MCP structured content). */
export function errorDocument(d: Pick<DescribedError, 'code' | 'message'>): { ok: false; error: { code: string; message: string } } {
  return { ok: false, error: { code: d.code, message: d.message } };
}
