// Plug point for external AI-text detectors (SCR-03). A `DetectorAdapter` turns text into a score in [0,1]; the
// ensemble (./ensemble.ts) validates what comes back. Calling an adapter SENDS TEXT OFF THIS MACHINE (for the HTTP
// adapter) so nothing here runs unless the caller names the detector explicitly, and `Engine.score` hands adapters
// only text that already went through the confidentiality filter.
import { MAX_DETECTOR_RESPONSE_BYTES } from '../../config/scorer.js';
import { ENDPOINT_MESSAGES, endpointProblem } from '../llm/endpoint.js';
import { DEFAULT_TIMEOUT_MS, classifyFetchError, httpError, positive, readCapped } from '../llm/http.js';
import { LlmTransportError } from '../llm/retry.js';
import type { FetchLike } from '../llm/http.js';
import { ConfigError } from '../models/errors.js';
import type { DetectorAdapter, DetectorConfig } from '../models/types.js';

export type { DetectorAdapter };

export const DETECTOR_NAME_RE = /^[a-z0-9_-]{1,40}$/;
/** Names that are legal under `DETECTOR_NAME_RE` but would collide with object internals in a plain-object lookup. */
export const RESERVED_DETECTOR_NAMES: ReadonlySet<string> = new Set(['local', '__proto__']);
/** Reserved: the built-in heuristic's name in an ensemble. */
export const LOCAL_NAME = 'local';

/** `ConfigError` unless `a` looks like an adapter: a usable name (not `local`) and a `score` function. */
export function assertDetectorAdapter(a: unknown): asserts a is DetectorAdapter {
  const name = (a as Partial<DetectorAdapter> | null | undefined)?.name;
  if (typeof name !== 'string' || !DETECTOR_NAME_RE.test(name) || RESERVED_DETECTOR_NAMES.has(name)) {
    throw new ConfigError('detector adapter: name must be 1-40 characters of a-z, 0-9, "_" or "-" and must not be "local" or "__proto__"');
  }
  if (typeof (a as DetectorAdapter).score !== 'function') throw new ConfigError(`detector adapter "${name}": score must be a function`);
}

/** The value if it is a finite number in [0,1], else `undefined`. Anything else (NaN, 1.2, "0.4", null) is rejected. */
export function checkDetectorScore(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
}

/** The detector could not be reached or answered with an error status / oversize body. Carries `kind` and `status` only: never the URL, token or response. */
export class DetectorTransportError extends LlmTransportError {
  constructor(cause: LlmTransportError) {
    super(cause.kind, cause.status === undefined ? {} : { status: cause.status });
    this.name = 'DetectorTransportError';
    this.message = `detector failure: ${this.kind}${this.status === undefined ? '' : ` (HTTP ${this.status})`}`;
  }
}

/** The environment variable that should hold the bearer token is unset or empty. `kind` is the fixed word the ensemble records. */
export class DetectorKeyMissingError extends ConfigError {
  readonly kind = 'missing-key';
}

/** The detector answered, but not with `{"score": number}`. Carries no response content. */
export class DetectorResponseError extends Error {
  readonly kind = 'invalid-response';

  constructor() {
    super('detector response is not a JSON object with a numeric "score"');
    this.name = 'DetectorResponseError';
  }
}

export interface HttpDetectorOptions {
  env?: Readonly<Record<string, string | undefined>>;
  fetch?: FetchLike;
}

/**
 * Detector reachable over HTTP: `POST <url>` with `{"text": "..."}`, bearer token from the environment variable the
 * config names, answer `{"score": <number>}`. No redirects (a 3xx could forward the token), a response size cap, a
 * timeout. Errors carry a failure kind only, never the URL, the token or the response.
 */
export class HttpDetectorAdapter implements DetectorAdapter {
  readonly name: string;
  readonly #url: string;
  readonly #apiKeyEnv: string | undefined;
  readonly #timeoutMs: number;
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #fetch: FetchLike;

  constructor(config: Pick<DetectorConfig, 'name' | 'url' | 'timeoutMs'> & { apiKeyEnv?: string | undefined }, options: HttpDetectorOptions = {}) {
    this.name = config.name;
    const problem = endpointProblem(config.url, config.apiKeyEnv !== undefined);
    if (problem !== undefined) throw new ConfigError(`detector "${config.name}": url ${ENDPOINT_MESSAGES[problem]}`);
    this.#url = config.url;
    this.#apiKeyEnv = config.apiKeyEnv;
    this.#timeoutMs = positive(config.timeoutMs, DEFAULT_TIMEOUT_MS);
    this.#env = options.env ?? process.env;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    assertDetectorAdapter(this);
  }

  async score(text: string): Promise<number> {
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
    if (this.#apiKeyEnv !== undefined) {
      const key = this.#env[this.#apiKeyEnv];
      if (key === undefined || key === '') throw new DetectorKeyMissingError(`detector "${this.name}": environment variable ${this.#apiKeyEnv} is not set`);
      headers.authorization = `Bearer ${key}`;
    }
    let body: Uint8Array;
    try {
      const res = await this.#fetch(this.#url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ text }),
        redirect: 'error',
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw httpError(res);
      }
      body = await readCapped(res, MAX_DETECTOR_RESPONSE_BYTES);
    } catch (err) {
      throw new DetectorTransportError(classifyFetchError(err));
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(body));
    } catch {
      throw new DetectorResponseError();
    }
    if (parsed === null || typeof parsed !== 'object' || typeof (parsed as { score?: unknown }).score !== 'number') throw new DetectorResponseError();
    return (parsed as { score: number }).score; // range is checked by the ensemble, like for any adapter
  }
}
