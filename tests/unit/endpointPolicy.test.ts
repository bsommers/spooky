// CR-05: the API key goes only over https, or over http to loopback; baseUrl credentials are rejected at config load.
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/load.js';
import { ENDPOINT_MESSAGES, endpointProblem, isLoopbackHost } from '../../src/llm/endpoint.js';
import { AnthropicClient } from '../../src/llm/anthropicClient.js';
import { OpenAICompatClient } from '../../src/llm/openaiCompatClient.js';
import { createLlmClient } from '../../src/llm/factory.js';
import { ConfigError } from '../../src/models/errors.js';

const SECRET = 'sk-test-SECRETVALUE123';
const llm = (extra: Record<string, unknown>) => ({ llm: { model: 'm', provider: 'openai-compat', ...extra } });

describe('isLoopbackHost', () => {
  it.each(['localhost', '127.0.0.1', '127.1.2.3', '127.255.255.255', '[::1]'])('%s is loopback', (h) => expect(isLoopbackHost(h)).toBe(true));
  it.each(['127.0.0.1.evil.com', 'localhost.evil.com', 'evil-localhost', '128.0.0.1', '10.0.0.1', '169.254.169.254', '[::2]', '127.0.0', '127.0.0.256', '0.0.0.0', 'example.com', ''])(
    '%s is not loopback',
    (h) => expect(isLoopbackHost(h)).toBe(false),
  );
});

describe('endpointProblem', () => {
  it('https is fine with a key; loopback http is fine with a key; remote http is fine only without one', () => {
    expect(endpointProblem('https://api.example.com/v1', true)).toBeUndefined();
    for (const u of ['http://localhost:11434/v1', 'http://127.0.0.1:8000/v1', 'http://[::1]:8000/v1']) expect(endpointProblem(u, true), u).toBeUndefined();
    expect(endpointProblem('http://llm.internal/v1', true)).toBe('cleartext-key');
    expect(endpointProblem('http://169.254.169.254/v1', true)).toBe('cleartext-key');
    expect(endpointProblem('http://llm.internal/v1', false)).toBeUndefined();
  });
  it('rejects bad schemes, unparseable values and credentials, with or without a key', () => {
    expect(endpointProblem('file:///etc/passwd', false)).toBe('scheme');
    expect(endpointProblem('not a url', false)).toBe('invalid');
    expect(endpointProblem('https://user:pw@host/v1', false)).toBe('credentials');
    expect(endpointProblem('https://user@host/v1', false)).toBe('credentials');
  });
  it('a loopback-looking userinfo trick is judged by the real host', () => {
    expect(endpointProblem('http://127.0.0.1@evil.com/v1', true)).toBe('credentials');
    expect(endpointProblem('http://localhost.evil.com/v1', true)).toBe('cleartext-key');
  });
});

describe('loadConfig enforces the endpoint rule at load time', () => {
  it('rejects embedded credentials without echoing them', () => {
    let msg = '';
    try {
      loadConfig(llm({ baseUrl: 'https://user:hunter2-PASSWORD@h.example/v1' }));
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      msg = (e as Error).message + JSON.stringify((e as ConfigError).issues);
    }
    expect(msg).toContain('llm.baseUrl');
    expect(msg).toContain(ENDPOINT_MESSAGES.credentials);
    expect(msg).not.toContain('hunter2');
  });
  it('rejects apiKeyEnv together with plain http to a non-loopback host', () => {
    expect(() => loadConfig(llm({ baseUrl: 'http://llm.internal/v1', apiKeyEnv: 'MY_KEY' }))).toThrow(/llm\.baseUrl: must use https when an API key is sent/);
  });
  it('accepts https+key, loopback http+key, and keyless remote http', () => {
    expect(() => loadConfig(llm({ baseUrl: 'https://api.example.com/v1', apiKeyEnv: 'MY_KEY' }))).not.toThrow();
    expect(() => loadConfig(llm({ baseUrl: 'http://localhost:11434/v1', apiKeyEnv: 'MY_KEY' }))).not.toThrow();
    expect(() => loadConfig(llm({ baseUrl: 'http://llm.internal/v1' }))).not.toThrow();
  });
});

describe('clients refuse to hold a key for a cleartext remote endpoint', () => {
  const calls: string[] = [];
  const fetch = async (url: string, init: RequestInit) => (calls.push(`${url} ${JSON.stringify(init.headers)}`), new Response('{}', { status: 500 }));

  it('OpenAICompatClient: key + remote http = ConfigError, no request, key not in the message', () => {
    let err: unknown;
    try {
      new OpenAICompatClient({ model: 'm', baseUrl: 'http://llm.internal/v1', apiKey: SECRET, fetch });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect(String((err as Error).message)).not.toContain(SECRET);
    expect(calls).toEqual([]);
  });
  it('OpenAICompatClient: keyless remote http, and key over https or loopback http, are accepted', () => {
    expect(() => new OpenAICompatClient({ model: 'm', baseUrl: 'http://llm.internal/v1', fetch })).not.toThrow();
    expect(() => new OpenAICompatClient({ model: 'm', baseUrl: 'https://llm.internal/v1', apiKey: SECRET, fetch })).not.toThrow();
    expect(() => new OpenAICompatClient({ model: 'm', baseUrl: 'http://127.0.0.1:1/v1', apiKey: SECRET, fetch })).not.toThrow();
  });
  it('AnthropicClient: remote http base URL is refused, https and loopback are accepted', () => {
    expect(() => new AnthropicClient({ model: 'm', apiKey: SECRET, baseUrl: 'http://proxy.internal', fetch })).toThrow(ConfigError);
    expect(() => new AnthropicClient({ model: 'm', apiKey: SECRET, baseUrl: 'https://proxy.internal', fetch })).not.toThrow();
    expect(() => new AnthropicClient({ model: 'm', apiKey: SECRET, baseUrl: 'http://localhost:9', fetch })).not.toThrow();
  });
  it('createLlmClient applies the same rule to a key found in the environment', () => {
    const cfg = { provider: 'openai-compat', model: 'm', baseUrl: 'http://llm.internal/v1', apiKeyEnv: 'K' } as const;
    expect(() => createLlmClient(cfg, { env: { K: SECRET } })).toThrow(ConfigError);
    expect(() => createLlmClient(cfg, { env: {} })).not.toThrow(); // no key set: nothing to leak
  });
});
