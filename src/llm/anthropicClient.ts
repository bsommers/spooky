// Anthropic Messages adapter on the official SDK, configured so this module owns retry, timeout and size policy:
//  * SDK retries are off (`maxRetries: 0`); `withRetry` is the single retry layer, same as the OpenAI-compat adapter.
//  * A wrapped fetch enforces the response size cap and discards error-response bodies, so neither a hostile server
//    nor an SDK error message can carry response text (or anything that echoes the key) into our errors.
//  * Failures are mapped to `LlmTransportError(kind, status)`; the SDK's own error objects are never kept as a cause.
//  * The API key is held in a private field and is not part of `toJSON`.
import Anthropic from '@anthropic-ai/sdk';
import { ConfigError } from '../models/errors.js';
import type { LlmClient, LlmRequest } from '../models/types.js';
import { ENDPOINT_MESSAGES, endpointProblem } from './endpoint.js';
import { DEFAULT_MAX_RESPONSE_BYTES, DEFAULT_TIMEOUT_MS, positive, readCapped, type FetchLike } from './http.js';
import { API_KEY_PATTERN } from './openaiCompatClient.js';
import { LlmTransportError, parseRetryAfter, withRetry, type RetryOptions } from './retry.js';

export interface AnthropicClientOptions {
  model: string;
  apiKey: string;
  /** Override the API origin (tests, proxies). Same rules as the OpenAI-compat baseUrl. */
  baseUrl?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  retry?: RetryOptions;
  fetch?: FetchLike;
}

export class AnthropicClient implements LlmClient {
  readonly #sdk: Anthropic;
  readonly #model: string;
  readonly #timeoutMs: number;
  readonly #retry: RetryOptions;

  constructor(options: AnthropicClientOptions) {
    if (typeof options.apiKey !== 'string' || options.apiKey === '') throw new ConfigError('Anthropic API key is empty');
    if (!API_KEY_PATTERN.test(options.apiKey)) throw new ConfigError('API key contains characters that are not allowed in an HTTP header');
    if (typeof options.model !== 'string' || options.model.trim() === '') throw new ConfigError('anthropic model must be a non-empty string');
    if (options.baseUrl !== undefined) {
      const problem = endpointProblem(options.baseUrl, true); // a key is always sent
      if (problem !== undefined) throw new ConfigError(`anthropic baseUrl ${ENDPOINT_MESSAGES[problem]}`);
    }
    this.#model = options.model;
    this.#timeoutMs = positive(options.timeoutMs, DEFAULT_TIMEOUT_MS);
    this.#retry = options.retry ?? {};
    const maxBytes = positive(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES);
    const inner: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
    this.#sdk = new Anthropic({
      apiKey: options.apiKey,
      ...(options.baseUrl === undefined ? {} : { baseURL: options.baseUrl }),
      maxRetries: 0,
      timeout: this.#timeoutMs,
      fetch: boundedFetch(inner, maxBytes) as unknown as NonNullable<ConstructorParameters<typeof Anthropic>[0]>['fetch'],
    });
  }

  complete(req: LlmRequest): Promise<string> {
    return withRetry(() => this.#attempt(req), this.#retry);
  }

  async #attempt(req: LlmRequest): Promise<string> {
    let message: Anthropic.Message;
    try {
      message = await this.#sdk.messages.create(
        { model: this.#model, max_tokens: req.maxTokens, temperature: req.temperature, system: req.system, messages: [{ role: 'user', content: req.user }] },
        { signal: AbortSignal.timeout(this.#timeoutMs) },
      );
    } catch (err) {
      throw mapSdkError(err);
    }
    const content: unknown = (message as { content?: unknown } | null)?.content;
    if (!Array.isArray(content)) throw new LlmTransportError('invalid-response');
    let text = '';
    for (const block of content as unknown[]) {
      const b = block as { type?: unknown; text?: unknown } | null;
      if (b?.type !== 'text') continue;
      if (typeof b.text !== 'string') throw new LlmTransportError('invalid-response');
      text += b.text;
    }
    if (text.trim() === '') throw new LlmTransportError('empty-response');
    return text;
  }

  toJSON(): { provider: string; model: string } {
    return { provider: 'anthropic', model: this.#model };
  }
}

/** fetch wrapper: success bodies are read under the size cap; error bodies are dropped (status and headers kept). */
function boundedFetch(inner: FetchLike, maxBytes: number): FetchLike {
  return async (input, init) => {
    const res = await inner(input, init);
    const headers = new Headers(res.headers);
    headers.delete('content-encoding');
    headers.delete('content-length');
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return new Response(null, { status: res.status, headers });
    }
    const bytes = await readCapped(res, maxBytes);
    return new Response(bytes as unknown as BodyInit, { status: res.status, headers });
  };
}

/** Reduce any SDK failure to a secret-free transport error. */
function mapSdkError(err: unknown): LlmTransportError {
  for (let e: unknown = err, depth = 0; e instanceof Error && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    if (e instanceof LlmTransportError) return e;
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new LlmTransportError('timeout');
  if (err instanceof Anthropic.APIUserAbortError) return new LlmTransportError('timeout');
  if (err instanceof Anthropic.APIConnectionError) {
    const cause = (err as { cause?: unknown }).cause;
    return new LlmTransportError(cause instanceof Error && (cause.name === 'AbortError' || cause.name === 'TimeoutError') ? 'timeout' : 'network');
  }
  if (err instanceof Anthropic.APIError && typeof err.status === 'number') {
    const retryAfterMs = parseRetryAfter(err.headers?.['retry-after']);
    return new LlmTransportError('http', retryAfterMs === undefined ? { status: err.status } : { status: err.status, retryAfterMs });
  }
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) return new LlmTransportError('timeout');
  // SyntaxError from a non-JSON 200 body and anything else the SDK throws: treat as a malformed response, not retryable.
  return new LlmTransportError('invalid-response');
}
