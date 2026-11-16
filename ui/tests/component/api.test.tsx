import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ApiError, createApiClient } from '../../src/api/client';
import { CAPABILITIES, fakeClient, jsonResponse, renderApp } from '../helpers/app';

describe('typed API client', () => {
  it('a 401 on any call forgets the token (it is never resent) and tells the listeners whether one was held', async () => {
    const c = fakeClient((url) => (url.includes('x401') ? jsonResponse(401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'no' } }) : jsonResponse(200, { ok: true })));
    const heard: boolean[] = [];
    const off = c.onUnauthorized((had) => heard.push(had));
    c.setToken('tok-0123456789abcdef');
    await c.post('/api/score?x401' as never, { text: 'a' } as never).catch(() => undefined);
    expect(c.hasToken()).toBe(false);
    await c.get('/api/capabilities?x401' as never).catch(() => undefined);
    expect(heard).toEqual([true, false]);
    await c.get('/api/capabilities');
    expect((c.calls[2]!.init.headers as Record<string, string>).Authorization).toBeUndefined();
    off();
    await c.get('/api/capabilities?x401' as never).catch(() => undefined);
    expect(heard).toHaveLength(2);
  });

  it('a request that never answers ends with CLIENT_TIMEOUT after the timeout, and the fetch was given an abort signal', async () => {
    let signal: AbortSignal | undefined;
    const c = createApiClient({ timeoutMs: 20, fetch: ((_u: string, init: RequestInit) => ((signal = init.signal ?? undefined), new Promise(() => undefined))) as typeof fetch });
    const e = await c.post('/api/score', { text: 'x' } as never).catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ status: 0, code: 'CLIENT_TIMEOUT' });
    expect(signal?.aborted).toBe(true);
  });

  it('the caller\'s signal cancels the request: ABORTED, also when it was already aborted, and also when the fetch ignores its signal', async () => {
    const c = createApiClient({ fetch: (() => new Promise(() => undefined)) as typeof fetch });
    const ctl = new AbortController();
    const pending = c.post('/api/score', { text: 'x' } as never, { signal: ctl.signal }).catch((x) => x);
    ctl.abort();
    expect(await pending).toMatchObject({ status: 0, code: 'ABORTED' });
    expect(await c.get('/api/capabilities', undefined, { signal: ctl.signal }).catch((x) => x)).toMatchObject({ code: 'ABORTED' });
  });

  it('GET sends Accept, no credentials or cookies, no referrer, and no Authorization until a token is set', async () => {
    const c = fakeClient();
    const doc = await c.get('/api/capabilities');
    expect(doc.operations.map((o) => o.name)).toEqual(['ingest', 'authors']);
    const init = c.calls[0]!.init;
    expect(init).toMatchObject({ method: 'GET', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' });
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(c.calls[0]!.url).toBe('/api/capabilities');
  });

  it('the token is kept in memory, sent as a bearer header only, and forgotten on setToken(undefined) or ""', async () => {
    const c = fakeClient();
    c.setToken('tok-1234567890abcdef');
    expect(c.hasToken()).toBe(true);
    await c.get('/api/capabilities');
    expect((c.calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer tok-1234567890abcdef');
    expect(c.calls[0]!.url).not.toContain('tok-');
    c.setToken('');
    expect(c.hasToken()).toBe(false);
    await c.get('/api/capabilities');
    expect((c.calls[1]!.init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('never writes the token to web storage, cookies or the address bar', async () => {
    const c = fakeClient();
    c.setToken('tok-secret-0123456789');
    await c.get('/api/capabilities');
    expect(JSON.stringify({ ...localStorage })).not.toContain('tok-secret');
    expect(JSON.stringify({ ...sessionStorage })).not.toContain('tok-secret');
    expect(document.cookie).not.toContain('tok-secret');
    expect(window.location.href).not.toContain('tok-secret');
  });

  it('query values are encoded; undefined ones are left out', async () => {
    const c = fakeClient(() => jsonResponse(200, { ok: true }));
    await c.get('/api/profile', { authorId: 'a b&c=d', extra: undefined } as never);
    expect(c.calls[0]!.url).toBe('/api/profile?authorId=a+b%26c%3Dd');
  });

  it('POST sends JSON with a content type', async () => {
    const c = fakeClient(() => jsonResponse(200, { ok: true }));
    await c.post('/api/score', { text: 'hello' } as never);
    expect(c.calls[0]!.init).toMatchObject({ method: 'POST', body: '{"text":"hello"}' });
    expect((c.calls[0]!.init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('turns the error document into ApiError (status, code, message); 401 is flagged; 429 carries Retry-After', async () => {
    const c = fakeClient((url) =>
      url.includes('401')
        ? jsonResponse(401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'a valid bearer token is required' } })
        : jsonResponse(429, { ok: false, error: { code: 'RATE_LIMITED', message: 'slow down' } }, { 'Retry-After': '42' }),
    );
    const a = await c.get('/api/capabilities?401' as never).catch((e) => e);
    expect(a).toBeInstanceOf(ApiError);
    expect([a.status, a.code, a.unauthorized]).toEqual([401, 'UNAUTHORIZED', true]);
    const b = await c.get('/api/capabilities?429' as never).catch((e) => e);
    expect([b.status, b.code, b.retryAfterSeconds]).toEqual([429, 'RATE_LIMITED', 42]);
  });

  it('a network failure, a non-JSON body and an ok:false 200 are all ApiErrors, never a raw exception or a fake success', async () => {
    const net = createApiClient({
      fetch: (() => {
        throw new TypeError('Failed to fetch');
      }) as unknown as typeof fetch,
    });
    expect(await net.get('/api/capabilities').catch((e) => e)).toMatchObject({ status: 0, code: 'NETWORK' });
    const html = fakeClient(() => new Response('<html>nope</html>', { status: 502 }));
    expect(await html.get('/api/capabilities').catch((e) => e)).toMatchObject({ status: 502, code: 'BAD_RESPONSE' });
    const lie = fakeClient(() => jsonResponse(200, { ok: false, error: { code: 'X', message: 'm' } }));
    expect(await lie.get('/api/capabilities').catch((e) => e)).toMatchObject({ code: 'X' });
  });
});

describe('Overview', () => {
  it('lists the operations the server offers', async () => {
    renderApp('#/');
    expect(await screen.findByText(/Connected\. 2 operations available/)).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Operations offered by this server' });
    expect(table).toHaveTextContent('POST /api/ingest');
    expect(table).toHaveTextContent('ghostwriter authors');
  });

  it('on 401 asks for the token, keeps it in memory, retries with it, and shows the data', async () => {
    const client = fakeClient((_url, init) =>
      (init.headers as Record<string, string>).Authorization === 'Bearer right-token-0123456789'
        ? jsonResponse(200, CAPABILITIES)
        : jsonResponse(401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'a valid bearer token is required' } }),
    );
    const user = userEvent.setup();
    renderApp('#/', client);
    expect(await screen.findByText('This server asks for an API token.')).toBeInTheDocument();
    const field = screen.getByLabelText('API token');
    expect(field).toHaveAttribute('type', 'password');
    await user.type(field, 'wrong-token-xxxxxxxxxxxx');
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByText('That token was not accepted.')).toBeInTheDocument();
    await user.clear(screen.getByLabelText('API token'));
    await user.type(screen.getByLabelText('API token'), 'right-token-0123456789');
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByText(/Connected/)).toBeInTheDocument();
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain('right-token');
  });

  it('a rejected token is forgotten: navigating away and back does not resend it', async () => {
    const client = fakeClient(() => jsonResponse(401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'a valid bearer token is required' } }));
    const user = userEvent.setup();
    renderApp('#/', client);
    await user.type(await screen.findByLabelText('API token'), 'wrong-token-xxxxxxxxxxxx');
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByText('That token was not accepted.')).toBeInTheDocument();
    expect(client.hasToken()).toBe(false);
    const sentWithToken = client.calls.filter((c) => (c.init.headers as Record<string, string>).Authorization !== undefined).length;
    expect(sentWithToken).toBe(1); // the one attempt the user made
    await user.click(screen.getByRole('link', { name: 'Kitchen sink' }));
    await screen.findByRole('heading', { level: 1, name: 'Kitchen sink' });
    const before = client.calls.length;
    await user.click(screen.getByRole('link', { name: 'Overview' }));
    await screen.findByText('This server asks for an API token.');
    expect(client.calls.length).toBeGreaterThan(before);
    for (const c of client.calls.slice(before)) expect((c.init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('submitting a token keeps the form mounted (focus never falls to <body>), then moves focus to the result; no nested live regions', async () => {
    let release: (r: Response) => void = () => undefined;
    const client = fakeClient((_url, init) => {
      if ((init.headers as Record<string, string>).Authorization === 'Bearer right-token-0123456789') return new Promise<Response>((r) => (release = r));
      return jsonResponse(401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'a valid bearer token is required' } });
    });
    const user = userEvent.setup();
    const { container } = renderApp('#/', client);
    const field = await screen.findByLabelText('API token');
    expect(container.querySelector('.gw-card')?.hasAttribute('aria-live')).toBe(false);
    await user.type(field, 'right-token-0123456789');
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    const button = await screen.findByRole('button', { name: 'Checking...' }); // pending: still the same form on screen
    expect(screen.getByLabelText('API token')).toBe(field);
    expect(document.body).toContainElement(button);
    release(jsonResponse(200, CAPABILITIES));
    expect(await screen.findByText(/Connected/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('heading', { level: 2, name: 'Server' })).toHaveFocus());
  });

  it('a lockout (429) says how long to wait', async () => {
    renderApp('#/', fakeClient(() => jsonResponse(429, { ok: false, error: { code: 'RATE_LIMITED', message: 'x' } }, { 'Retry-After': '60' })));
    expect(await screen.findByText('Too many wrong tokens; try again in 60 seconds.')).toBeInTheDocument();
  });

  it('a server that cannot be reached is reported as an alert, not a blank page', async () => {
    renderApp('#/', fakeClient(() => { throw new TypeError('x'); }));
    const alert = await screen.findByRole('alert');
    await waitFor(() => expect(alert).toHaveTextContent('could not reach the server'));
  });
});
