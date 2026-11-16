// Typed client for the HTTP API. Types come from the generated `schema.d.ts` (OpenAPI document of the operations
// registry), so a renamed route or field fails the typecheck. The bearer token lives in memory only: never in
// localStorage, a cookie, a URL or a log line, and there is no API key anywhere in the UI (keys stay on the server).
import type { paths } from './schema';

type Json = Record<string, unknown>;

type GetPath = { [P in keyof paths]: paths[P] extends { get: infer G } ? (G extends never ? never : P) : never }[keyof paths];
type PostPath = { [P in keyof paths]: paths[P] extends { post: infer G } ? (G extends never ? never : P) : never }[keyof paths];

type OkBody<Op> = Op extends { responses: { 200: { content: { 'application/json': infer B } } } } ? B : never;
type QueryOf<Op> = Op extends { parameters: { query?: infer Q } } ? (Q extends undefined ? never : NonNullable<Q>) : never;
type BodyOf<Op> = Op extends { requestBody: { content: { 'application/json': infer B } } } ? B : never;

export type GetResponse<P extends GetPath> = OkBody<NonNullable<paths[P]['get']>>;
export type PostResponse<P extends PostPath> = OkBody<NonNullable<paths[P]['post']>>;
export type GetQuery<P extends GetPath> = QueryOf<NonNullable<paths[P]['get']>>;
export type PostBody<P extends PostPath> = BodyOf<NonNullable<paths[P]['post']>>;

/** The server's error document, as thrown. `status` 0 means the request never got an answer. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
  get unauthorized(): boolean {
    return this.status === 401;
  }
}

/** How long a request may run before the page gives up on it. Humanize can take up to 10 model passes, so this is generous. */
export const DEFAULT_TIMEOUT_MS = 5 * 60_000;

export interface RequestOptions {
  /** Abort the request (the page left the screen, or the user pressed Cancel). Rejects with code `ABORTED`. */
  signal?: AbortSignal;
  /** Overrides the client's timeout for this request. Rejects with code `CLIENT_TIMEOUT`. */
  timeoutMs?: number;
}

export interface ApiClientOptions {
  /** Default: same origin (the UI is served by the API server). */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Default `DEFAULT_TIMEOUT_MS`. */
  timeoutMs?: number;
}

export interface ApiClient {
  /** Keep the token in memory for this page load. `undefined` forgets it. */
  setToken(token: string | undefined): void;
  hasToken(): boolean;
  get<P extends GetPath>(path: P, query?: GetQuery<P>, request?: RequestOptions): Promise<GetResponse<P>>;
  post<P extends PostPath>(path: P, body: PostBody<P>, request?: RequestOptions): Promise<PostResponse<P>>;
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const base = options.baseUrl ?? '';
  let token: string | undefined;

  async function send(method: 'GET' | 'POST', path: string, query?: Json, body?: unknown, request: RequestOptions = {}): Promise<unknown> {
    const doFetch = options.fetch ?? fetch;
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) qs.set(k, String(v));
    const url = `${base}${path}${qs.size > 0 ? `?${qs.toString()}` : ''}`;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (token !== undefined) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    // One controller for both reasons to stop: the caller's signal and the timeout. The abort promise is raced against the
    // fetch so a stopped request ends even when the fetch implementation ignores its signal.
    const ctl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctl.abort();
    }, request.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const forward = () => ctl.abort();
    if (request.signal?.aborted === true) ctl.abort();
    else request.signal?.addEventListener('abort', forward, { once: true });
    const stopped = new Promise<never>((_, reject) => {
      const stop = () => reject(timedOut ? new ApiError(0, 'CLIENT_TIMEOUT', 'the server did not answer in time') : new ApiError(0, 'ABORTED', 'the request was cancelled'));
      if (ctl.signal.aborted) stop();
      else ctl.signal.addEventListener('abort', stop, { once: true });
    });
    stopped.catch(() => undefined);
    try {
      let res: Response;
      try {
        res = await Promise.race([doFetch(url, { method, headers, signal: ctl.signal, ...(body === undefined ? {} : { body: JSON.stringify(body) }), credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' }), stopped]);
      } catch (e) {
        if (e instanceof ApiError) throw e;
        if (ctl.signal.aborted) await stopped;
        throw new ApiError(0, 'NETWORK', 'could not reach the server');
      }
      let doc: unknown;
      try {
        doc = await Promise.race([res.json() as Promise<unknown>, stopped]);
      } catch (e) {
        if (e instanceof ApiError) throw e;
        throw new ApiError(res.status, 'BAD_RESPONSE', `the server answered ${res.status} with something that is not JSON`);
      }
      const d = doc as { ok?: unknown; error?: { code?: unknown; message?: unknown } };
      if (res.ok && d.ok === true) return doc;
      const retry = Number(res.headers.get('Retry-After'));
      throw new ApiError(
        res.status,
        typeof d.error?.code === 'string' ? d.error.code : 'ERROR',
        typeof d.error?.message === 'string' ? d.error.message : `request failed with ${res.status}`,
        Number.isFinite(retry) && retry > 0 ? retry : undefined,
      );
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', forward);
    }
  }

  return {
    setToken(t) {
      token = t === undefined || t === '' ? undefined : t;
    },
    hasToken: () => token !== undefined,
    get: (path, query, request) => send('GET', path, query as Json | undefined, undefined, request) as never,
    post: (path, body, request) => send('POST', path, undefined, body, request) as never,
  };
}
