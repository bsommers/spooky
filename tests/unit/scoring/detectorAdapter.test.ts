import { describe, expect, it } from 'vitest';
import { LlmTransportError } from '../../../src/llm/retry.js';
import { ConfigError } from '../../../src/models/errors.js';
import { DetectorResponseError, HttpDetectorAdapter, checkDetectorScore } from '../../../src/scoring/detectorAdapter.js';

const cfg = { name: 'acme', url: 'https://detect.example/v1/score', timeoutMs: 5000 };
const json = (body: unknown, init: ResponseInit = {}): Response => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200, ...init });

describe('checkDetectorScore', () => {
  it('accepts finite numbers in [0,1] only', () => {
    expect([0, 0.5, 1].map(checkDetectorScore)).toEqual([0, 0.5, 1]);
    for (const v of [-0.0001, 1.0001, Number.NaN, Infinity, -Infinity, '0.5', null, undefined, {}, [0.5]]) expect(checkDetectorScore(v)).toBeUndefined();
  });
});

describe('HttpDetectorAdapter', () => {
  it('POSTs {"text"} as JSON without following redirects and returns the score', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const a = new HttpDetectorAdapter(cfg, { fetch: async (url, init) => ((seen = { url, init }), json({ score: 0.42 })) });
    expect(await a.score('hello')).toBe(0.42);
    expect(seen?.url).toBe(cfg.url);
    expect(seen?.init.method).toBe('POST');
    expect(seen?.init.redirect).toBe('error');
    expect(JSON.parse(seen?.init.body as string)).toEqual({ text: 'hello' });
    expect((seen?.init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('sends the bearer token from the named environment variable, and fails when it is unset', async () => {
    let auth: string | undefined;
    const fetchStub = async (_u: string, init: RequestInit): Promise<Response> => ((auth = (init.headers as Record<string, string>).authorization), json({ score: 0.1 }));
    const withKey = new HttpDetectorAdapter({ ...cfg, apiKeyEnv: 'ACME_KEY' }, { env: { ACME_KEY: 'tok-123' }, fetch: fetchStub });
    await withKey.score('x');
    expect(auth).toBe('Bearer tok-123');
    const without = new HttpDetectorAdapter({ ...cfg, apiKeyEnv: 'ACME_KEY' }, { env: {}, fetch: fetchStub });
    await expect(without.score('x')).rejects.toThrow(/ACME_KEY is not set/);
    await expect(without.score('x')).rejects.toMatchObject({ name: 'DetectorKeyMissingError', kind: 'missing-key' });
  });

  it('returns an out-of-range number as-is (the ensemble rejects it)', async () => {
    const a = new HttpDetectorAdapter(cfg, { fetch: async () => json({ score: 1.7 }) });
    expect(await a.score('x')).toBe(1.7);
  });

  it('classifies failures without leaking the url, token or body', async () => {
    const run = (fetchImpl: () => Promise<Response>) => new HttpDetectorAdapter({ ...cfg, apiKeyEnv: 'K' }, { env: { K: 'tok-secret' }, fetch: fetchImpl }).score('x');
    const e500 = await run(async () => json('boom tok-secret', { status: 500 })).catch((e: unknown) => e);
    expect(e500).toBeInstanceOf(LlmTransportError);
    expect((e500 as LlmTransportError).status).toBe(500);
    const net = await run(async () => { throw new TypeError('connect ECONNREFUSED detect.example tok-secret'); }).catch((e: unknown) => e);
    expect((net as LlmTransportError).kind).toBe('network');
    expect([e500, net].map((e) => (e as Error).name)).toEqual(['DetectorTransportError', 'DetectorTransportError']);
    for (const e of [e500, net]) expect(String((e as Error).message)).not.toMatch(/tok-secret|detect\.example/);
    for (const body of ['not json', '[]', '{"score":"0.4"}', '{}', 'null']) {
      await expect(run(async () => json(body))).rejects.toBeInstanceOf(DetectorResponseError);
    }
  });

  it('refuses an oversized response', async () => {
    const a = new HttpDetectorAdapter(cfg, { fetch: async () => json(`{"score":0.5,"pad":"${'x'.repeat(70_000)}"}`) });
    await expect(a.score('x')).rejects.toMatchObject({ kind: 'too-large' });
  });

  it('applies the endpoint policy at construction', () => {
    expect(() => new HttpDetectorAdapter({ ...cfg, url: 'file:///etc/passwd' })).toThrow(ConfigError);
    expect(() => new HttpDetectorAdapter({ ...cfg, url: 'https://u:p@detect.example/' })).toThrow(ConfigError);
    expect(() => new HttpDetectorAdapter({ ...cfg, url: 'http://detect.example/', apiKeyEnv: 'K' })).toThrow(/https/);
    expect(() => new HttpDetectorAdapter({ ...cfg, url: 'http://127.0.0.1:9000/', apiKeyEnv: 'K' })).not.toThrow();
    expect(() => new HttpDetectorAdapter({ ...cfg, name: 'local' })).toThrow(ConfigError);
  });
});
