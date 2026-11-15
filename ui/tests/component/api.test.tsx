import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ApiError, createApiClient } from '../../src/api/client';
import { CAPABILITIES, fakeClient, jsonResponse, renderApp } from '../helpers/app';

describe('typed API client', () => {
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
