import { afterEach, describe, expect, it } from 'vitest';
import { AnthropicClient } from '../../src/llm/anthropicClient.js';
import { createLlmClient } from '../../src/llm/factory.js';
import { MockLlmClient } from '../../src/llm/mockClient.js';
import { OpenAICompatClient } from '../../src/llm/openaiCompatClient.js';
import { ConfigError } from '../../src/models/errors.js';
import type { LlmRequest, ProviderConfig } from '../../src/models/types.js';
import { json, openaiOk, anthropicOk, startStub, type Stub } from '../helpers/llmStub.js';

const REQ: LlmRequest = { system: 's', user: 'u', maxTokens: 8, temperature: 0 };
const KEY = 'sk-factory-SECRET-777';
let stub: Stub | undefined;
afterEach(async () => {
  await stub?.close();
  stub = undefined;
});

describe('createLlmClient', () => {
  it('anthropic: reads the key from the named env var and defaults to ANTHROPIC_API_KEY', async () => {
    stub = await startStub((_r, res) => json(res, 200, anthropicOk('from anthropic')));
    const named = createLlmClient({ provider: 'anthropic', model: 'm', apiKeyEnv: 'MY_KEY' }, { env: { MY_KEY: KEY }, anthropicBaseUrl: stub.origin });
    expect(named).toBeInstanceOf(AnthropicClient);
    expect(await named.complete(REQ)).toBe('from anthropic');
    expect(stub.requests[0]!.headers['x-api-key']).toBe(KEY);
    const dflt = createLlmClient({ provider: 'anthropic', model: 'm', apiKeyEnv: '' }, { env: { ANTHROPIC_API_KEY: KEY }, anthropicBaseUrl: stub.origin });
    await dflt.complete(REQ);
    expect(stub.requests[1]!.headers['x-api-key']).toBe(KEY);
  });

  it('anthropic: a missing or empty key is a ConfigError naming the variable, not a value', () => {
    for (const env of [{}, { ANTHROPIC_API_KEY: '' }]) {
      let err: unknown;
      try {
        createLlmClient({ provider: 'anthropic', model: 'm', apiKeyEnv: 'ANTHROPIC_API_KEY' }, { env });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).message).toContain('ANTHROPIC_API_KEY');
    }
  });

  it('refuses an apiKeyEnv that looks like a pasted key, without echoing it', () => {
    for (const provider of ['anthropic', 'openai-compat'] as const) {
      const cfg = (provider === 'anthropic' ? { provider, model: 'm', apiKeyEnv: KEY } : { provider, model: 'm', baseUrl: 'https://h/v1', apiKeyEnv: KEY }) as ProviderConfig;
      let err: unknown;
      try {
        createLlmClient(cfg, { env: { [KEY]: 'x' } });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ConfigError);
      expect(String((err as Error).message)).not.toContain('SECRET');
    }
  });

  it('openai-compat: no apiKeyEnv, or an unset one, sends no Authorization header', async () => {
    stub = await startStub((_r, res) => json(res, 200, openaiOk('local')));
    const base = { provider: 'openai-compat', model: 'm', baseUrl: `${stub.origin}/v1` } as const;
    const a = createLlmClient(base, { env: { LOCAL_KEY: KEY } });
    const b = createLlmClient({ ...base, apiKeyEnv: 'LOCAL_KEY' }, { env: {} });
    const c = createLlmClient({ ...base, apiKeyEnv: 'LOCAL_KEY' }, { env: { LOCAL_KEY: '' } });
    expect(a).toBeInstanceOf(OpenAICompatClient);
    for (const client of [a, b, c]) expect(await client.complete(REQ)).toBe('local');
    for (const r of stub.requests) expect(r.headers.authorization).toBeUndefined();
  });

  it('openai-compat: a set key is sent as a bearer token', async () => {
    stub = await startStub((_r, res) => json(res, 200, openaiOk('keyed')));
    const c = createLlmClient({ provider: 'openai-compat', model: 'm', baseUrl: `${stub.origin}/v1`, apiKeyEnv: 'OAI' }, { env: { OAI: KEY } });
    await c.complete(REQ);
    expect(stub.requests[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it('passes retry/timeout options through', async () => {
    stub = await startStub((_r, res) => json(res, 503, {}));
    const c = createLlmClient({ provider: 'openai-compat', model: 'm', baseUrl: `${stub.origin}/v1` }, { retry: { maxRetries: 1, baseMs: 1 } });
    await expect(c.complete(REQ)).rejects.toMatchObject({ code: 'LLM_FAILED', attempts: 2 });
  });

  it('rejects an unknown provider', () => {
    expect(() => createLlmClient({ provider: 'bogus' } as unknown as ProviderConfig)).toThrow(ConfigError);
  });
});

describe('MockLlmClient', () => {
  it('returns scripted responses in order and records each request', async () => {
    const m = new MockLlmClient(['one', 'two']);
    expect(await m.complete(REQ)).toBe('one');
    expect(await m.complete({ ...REQ, user: 'second' })).toBe('two');
    expect(m.callCount).toBe(2);
    expect(m.requests.map((r) => r.user)).toEqual(['u', 'second']);
  });

  it('throws scripted Errors (including transport errors) and runs function steps', async () => {
    const boom = new Error('scripted');
    const m = new MockLlmClient([boom, (req, n) => `${req.user}#${n}`]);
    await expect(m.complete(REQ)).rejects.toBe(boom);
    expect(await m.complete(REQ)).toBe('u#2');
    expect(m.requests).toHaveLength(2); // failed calls are recorded too
  });

  it('a single function script answers every call; an exhausted list fails loudly', async () => {
    const f = new MockLlmClient((req) => req.user.toUpperCase());
    expect(await f.complete(REQ)).toBe('U');
    expect(await f.complete(REQ)).toBe('U');
    const l = new MockLlmClient(['only']);
    await l.complete(REQ);
    await expect(l.complete(REQ)).rejects.toThrow(/no scripted response/);
    await expect(new MockLlmClient().complete(REQ)).rejects.toThrow(/no scripted response/);
  });

  it('records copies: later mutation of the caller object does not change history; script array is copied', async () => {
    const script = ['a'];
    const m = new MockLlmClient(script);
    const req = { ...REQ };
    await m.complete(req);
    req.user = 'mutated';
    expect(m.requests[0]!.user).toBe('u');
    script.push('b');
    await expect(m.complete(REQ)).rejects.toThrow();
  });

  it('is deterministic: two identical clients give byte-identical outputs', async () => {
    const run = async () => {
      const m = new MockLlmClient(['x', 'y']);
      return [await m.complete(REQ), await m.complete(REQ)].join('|');
    };
    expect(await run()).toBe(await run());
  });
});
