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

export interface ApiClientOptions {
  /** Default: same origin (the UI is served by the API server). */
  baseUrl?: string;
  fetch?: typeof fetch;
}

export interface ApiClient {
  /** Keep the token in memory for this page load. `undefined` forgets it. */
  setToken(token: string | undefined): void;
  hasToken(): boolean;
  get<P extends GetPath>(path: P, query?: GetQuery<P>): Promise<GetResponse<P>>;
  post<P extends PostPath>(path: P, body: PostBody<P>): Promise<PostResponse<P>>;
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const base = options.baseUrl ?? '';
  let token: string | undefined;

  async function send(method: 'GET' | 'POST', path: string, query?: Json, body?: unknown): Promise<unknown> {
    const doFetch = options.fetch ?? fetch;
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) qs.set(k, String(v));
    const url = `${base}${path}${qs.size > 0 ? `?${qs.toString()}` : ''}`;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (token !== undefined) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res: Response;
    try {
      res = await doFetch(url, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' });
    } catch {
      throw new ApiError(0, 'NETWORK', 'could not reach the server');
    }
    let doc: unknown;
    try {
      doc = await res.json();
    } catch {
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
  }

  return {
    setToken(t) {
      token = t === undefined || t === '' ? undefined : t;
    },
    hasToken: () => token !== undefined,
    get: (path, query) => send('GET', path, query as Json | undefined) as never,
    post: (path, body) => send('POST', path, undefined, body) as never,
  };
}
