import { render } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import { ApiProvider } from '../../src/api/context';
import { createApiClient } from '../../src/api/client';
import type { ApiClient } from '../../src/api/client';
import { App } from '../../src/app/App';
import { ThemeProvider } from '../../src/theme/ThemeProvider';
import { DARK, memoryStorage, mediaWith } from './media';

export const CAPABILITIES = {
  ok: true,
  operations: [
    { name: 'ingest', description: 'd', mutates: true, http: { method: 'POST', path: '/api/ingest' }, cli: 'ghostwriter ingest', mcpTool: 'ingest' },
    { name: 'authors', description: 'd', mutates: false, http: { method: 'GET', path: '/api/authors' }, cli: 'ghostwriter authors', mcpTool: 'authors' },
  ],
  pending: [],
};

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

/** A client whose fetch is `handler` (default: the capabilities document). */
export function fakeClient(handler: (url: string, init: RequestInit) => Response | Promise<Response> = () => jsonResponse(200, CAPABILITIES)): ApiClient & { calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const client = createApiClient({
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return handler(url, init);
    }) as typeof fetch,
  });
  return Object.assign(client, { calls });
}

export function renderApp(hash = '#/', client: ApiClient = fakeClient()): RenderResult & { client: ApiClient } {
  window.location.hash = hash;
  const utils = render(
    <ThemeProvider storage={memoryStorage()} matchMedia={mediaWith([DARK])}>
      <ApiProvider client={client}>
        <App />
      </ApiProvider>
    </ThemeProvider>,
  );
  return Object.assign(utils, { client });
}
