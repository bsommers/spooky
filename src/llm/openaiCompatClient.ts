// OpenAI-compatible chat-completions adapter on the built-in fetch (no SDK): works against OpenAI, Ollama, vLLM,
// llama.cpp servers and the like.
//
//  * The API key is optional (local servers need none). `Authorization` is sent only when a non-empty key was given,
//    and only over https or to a loopback host (`./endpoint.ts`); a key with plain http to another host is a ConfigError.
//    The key is held in a private field, never serialized, and never appears in an error message or cause.
//  * Every request has a timeout (AbortSignal), `redirect: 'error'` (a redirect cannot carry the key elsewhere), and
//    a response size cap. The response JSON is validated; missing `choices`, non-string content or empty content is a
//    typed `LlmError`, never an empty success.
//  * `complete` retries transient failures (429/5xx/network/timeout) with `withRetry` and ends in `LlmError`.
import { ConfigError } from '../models/errors.js';
import { ENDPOINT_MESSAGES, endpointProblem } from './endpoint.js';
import type { LlmClient, LlmRequest } from '../models/types.js';
import {
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_TIMEOUT_MS,
  classifyFetchError,
  httpError,
  positive,
  readCapped,
  type FetchLike,
} from './http.js';
import { LlmTransportError, withRetry, type RetryOptions } from './retry.js';

export interface OpenAICompatOptions {
  model: string;
  /** e.g. http://localhost:11434/v1 ; `/chat/completions` is appended. Must be http(s), carry no credentials, and be https (or loopback) when `apiKey` is set. */
  baseUrl: string;
  /** Bearer token. Omit or leave empty for keyless local servers. */
  apiKey?: string;
  /** Per-attempt timeout in ms. Default 60000. */
  timeoutMs?: number;
  /** Largest response body accepted, in bytes. Default 4 MiB. */
  maxResponseBytes?: number;
  retry?: RetryOptions;
  /** Injectable for tests. Defaults to the global fetch. */
  fetch?: FetchLike;
}

/** Header values must be visible ASCII: whitespace/control characters would allow header injection. */
export const API_KEY_PATTERN = /^[\x21-\x7e]+$/;

export class OpenAICompatClient implements LlmClient {
  readonly #apiKey: string | undefined;
  readonly #url: string;
  readonly #model: string;
  readonly #timeoutMs: number;
  readonly #maxBytes: number;
  readonly #retry: RetryOptions;
  readonly #fetch: FetchLike;

  constructor(options: OpenAICompatOptions) {
    const key = options.apiKey;
    const hasKey = key !== undefined && key !== '';
    const problem = endpointProblem(typeof options.baseUrl === 'string' ? options.baseUrl : '', hasKey);
    if (problem !== undefined) throw new ConfigError(`openai-compat baseUrl ${ENDPOINT_MESSAGES[problem]}`);
    const url = new URL(options.baseUrl);
    if (typeof options.model !== 'string' || options.model.trim() === '') throw new ConfigError('openai-compat model must be a non-empty string');
    if (hasKey && !API_KEY_PATTERN.test(key)) throw new ConfigError('API key contains characters that are not allowed in an HTTP header');
    this.#apiKey = key === undefined || key === '' ? undefined : key;
    this.#url = `${url.origin}${url.pathname.replace(/\/+$/, '')}/chat/completions`;
    this.#model = options.model;
    this.#timeoutMs = positive(options.timeoutMs, DEFAULT_TIMEOUT_MS);
    this.#maxBytes = positive(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES);
    this.#retry = options.retry ?? {};
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  complete(req: LlmRequest): Promise<string> {
    return withRetry(() => this.#attempt(req), this.#retry);
  }

  async #attempt(req: LlmRequest): Promise<string> {
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
    if (this.#apiKey !== undefined) headers.authorization = `Bearer ${this.#apiKey}`;
    const body = JSON.stringify({
      model: this.#model,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ],
      max_tokens: req.maxTokens,
      temperature: req.temperature,
      stream: false,
    });

    let res: Response;
    try {
      res = await this.#fetch(this.#url, { method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(this.#timeoutMs) });
    } catch (err) {
      throw classifyFetchError(err);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw httpError(res);
    }
    const bytes = await readCapped(res, this.#maxBytes);
    return extractContent(bytes);
  }

  /** Never exposes the key through util.inspect / console.log. */
  toJSON(): { provider: string; model: string } {
    return { provider: 'openai-compat', model: this.#model };
  }
}

/** Validate an OpenAI chat-completions body and return the first choice's text. Throws only typed transport errors. */
function extractContent(bytes: Uint8Array): string {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new LlmTransportError('invalid-response');
  }
  const choices = (json as { choices?: unknown } | null)?.choices;
  if (!Array.isArray(choices) || choices.length === 0) throw new LlmTransportError('invalid-response');
  const content = (choices[0] as { message?: { content?: unknown } } | null)?.message?.content;
  if (typeof content !== 'string') throw new LlmTransportError('invalid-response');
  if (content.trim() === '') throw new LlmTransportError('empty-response');
  return content;
}
