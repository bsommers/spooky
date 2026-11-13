import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AnthropicClient } from '../../src/llm/anthropicClient.js';
import { OpenAICompatClient } from '../../src/llm/openaiCompatClient.js';
import { ConfigError, LlmError } from '../../src/models/errors.js';
import { LlmTransportError } from '../../src/llm/retry.js';
import type { LlmClient, LlmRequest } from '../../src/models/types.js';
import { anthropicOk, closedOrigin, json, openaiOk, startStub, type Stub } from '../helpers/llmStub.js';

const KEY = 'sk-test-SECRET-0123456789';
const REQ: LlmRequest = { system: 'be brief', user: 'hello', maxTokens: 64, temperature: 0.2 };
const FAST = { maxRetries: 2, baseMs: 1, maxDelayMs: 5 };

let stub: Stub;
beforeEach(async () => {
  stub = await startStub((_r, res) => json(res, 200, openaiOk('hi there')));
});
afterEach(async () => {
  await stub.close();
});

const fail = async (p: Promise<unknown>): Promise<LlmError> => {
  const e = await p.then(
    () => undefined,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(LlmError);
  return e as LlmError;
};
const kindOf = (e: LlmError): string | undefined => (e.cause instanceof LlmTransportError ? e.cause.kind : undefined);
const dump = (e: unknown): string => inspect(e, { depth: 10, showHidden: true }) + JSON.stringify(e, Object.getOwnPropertyNames(e as object));

// The same behavioral matrix runs against both adapters.
const adapters: { name: string; make: (origin: string, opts?: { apiKey?: string; timeoutMs?: number; maxResponseBytes?: number; fetch?: typeof fetch }) => LlmClient; ok: (text: unknown) => unknown; path: string }[] = [
  {
    name: 'OpenAICompatClient',
    make: (origin, o = {}) => new OpenAICompatClient({ model: 'm', baseUrl: `${origin}/v1`, retry: FAST, ...o }),
    ok: openaiOk,
    path: '/v1/chat/completions',
  },
  {
    name: 'AnthropicClient',
    make: (origin, o = {}) => new AnthropicClient({ model: 'm', apiKey: KEY, baseUrl: origin, retry: FAST, ...(o.timeoutMs === undefined ? {} : { timeoutMs: o.timeoutMs }), ...(o.maxResponseBytes === undefined ? {} : { maxResponseBytes: o.maxResponseBytes }) }),
    ok: (t) => (typeof t === 'string' ? anthropicOk(t) : { content: t }),
    path: '/v1/messages',
  },
];

describe.each(adapters)('$name against a local stub', ({ make, ok, path }) => {
  it('200 returns the model text and posts the documented request', async () => {
    stub.setHandler((_r, res) => json(res, 200, ok('hello back')));
    expect(await make(stub.origin).complete(REQ)).toBe('hello back');
    expect(stub.requests).toHaveLength(1);
    const r = stub.requests[0]!;
    expect(r.method).toBe('POST');
    expect(r.url).toBe(path);
    const body = JSON.parse(r.body) as Record<string, unknown>;
    expect(body.model).toBe('m');
    expect(body.max_tokens).toBe(64);
    expect(body.temperature).toBe(0.2);
    expect(r.body).toContain('be brief');
    expect(r.body).toContain('hello');
  });

  it('429 then 200 retries once and succeeds', async () => {
    stub.setHandler((_r, res, n) => (n === 1 ? json(res, 429, { error: 'slow down' }, { 'retry-after': '0' }) : json(res, 200, ok('second time'))));
    expect(await make(stub.origin).complete(REQ)).toBe('second time');
    expect(stub.requests).toHaveLength(2);
  });

  it('persistent 500 -> LlmError attempts=3 after exactly 3 requests', async () => {
    stub.setHandler((_r, res) => json(res, 500, { error: 'down' }));
    const e = await fail(make(stub.origin).complete(REQ));
    expect(e.attempts).toBe(3);
    expect(stub.requests).toHaveLength(3);
  });

  it('401 and 400 are not retried', async () => {
    for (const status of [400, 401, 404]) {
      stub.requests.length = 0;
      stub.setHandler((_r, res) => json(res, status, { error: 'nope' }));
      const e = await fail(make(stub.origin).complete(REQ));
      expect(e.attempts).toBe(1);
      expect(stub.requests).toHaveLength(1);
    }
  });

  it('malformed JSON body -> LlmError, not retried, no text', async () => {
    stub.setHandler((_r, res) => json(res, 200, '{"choices": [ {'));
    const e = await fail(make(stub.origin).complete(REQ));
    expect(e.attempts).toBe(1);
    expect(stub.requests).toHaveLength(1);
  });

  it('non-JSON 200 body -> LlmError', async () => {
    stub.setHandler((_r, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>login portal</html>');
    });
    expect((await fail(make(stub.origin).complete(REQ))).attempts).toBe(1);
  });

  it('empty or whitespace-only model output -> LlmError (never an empty success)', async () => {
    for (const text of ['', '   \n\t']) {
      stub.setHandler((_r, res) => json(res, 200, ok(text)));
      const e = await fail(make(stub.origin).complete(REQ));
      expect(kindOf(e)).toBe('empty-response');
      expect(e.attempts).toBe(1);
    }
  });

  it('connection refused is a retried network failure', async () => {
    const e = await fail(make(await closedOrigin()).complete(REQ));
    expect(e.attempts).toBe(3);
    expect(kindOf(e)).toBe('network');
  });

  it('a server that never answers hits the request timeout (retried as a timeout)', async () => {
    stub.setHandler(() => {});
    const e = await fail(make(stub.origin, { timeoutMs: 60 }).complete(REQ));
    expect(kindOf(e)).toBe('timeout');
    expect(e.attempts).toBe(3);
    expect(stub.requests).toHaveLength(3);
  });

  it('a body that stalls mid-stream also times out', async () => {
    stub.setHandler((_r, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"choices":');
    });
    const e = await fail(make(stub.origin, { timeoutMs: 60 }).complete(REQ));
    expect(kindOf(e)).toBe('timeout');
  });

  it('a response larger than the cap is rejected without being buffered whole', async () => {
    stub.setHandler((_r, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }); // chunked: no content-length
      res.write('{"x":"');
      res.write('a'.repeat(5000));
      res.end('"}');
    });
    const e = await fail(make(stub.origin, { maxResponseBytes: 1024 }).complete(REQ));
    expect(kindOf(e)).toBe('too-large');
    expect(e.attempts).toBe(1);
  });

  it('a declared Content-Length over the cap is rejected', async () => {
    stub.setHandler((_r, res) => json(res, 200, ok('z'.repeat(4000))));
    const e = await fail(make(stub.origin, { maxResponseBytes: 1024 }).complete(REQ));
    expect(kindOf(e)).toBe('too-large');
  });

  it('a Retry-After far beyond the bound does not stall the caller', async () => {
    stub.setHandler((_r, res, n) => (n === 1 ? json(res, 429, {}, { 'retry-after': '86400' }) : json(res, 200, ok('ok'))));
    const t0 = Date.now();
    expect(await make(stub.origin).complete(REQ)).toBe('ok');
    expect(Date.now() - t0).toBeLessThan(2000); // maxDelayMs is 5ms in FAST
  });

  it('error messages and causes never contain the key, even when the server echoes it', async () => {
    stub.setHandler((r, res) => json(res, 401, { error: `bad key ${String(r.headers.authorization ?? r.headers['x-api-key'])}` }));
    const e = await fail(make(stub.origin, { apiKey: KEY }).complete(REQ));
    expect(dump(e)).not.toContain(KEY);
    expect(dump(e)).not.toContain('SECRET');
  });
});

describe('OpenAICompatClient specifics', () => {
  const make = (o: Partial<ConstructorParameters<typeof OpenAICompatClient>[0]> = {}) => new OpenAICompatClient({ model: 'm', baseUrl: `${stub.origin}/v1`, retry: FAST, ...o });

  it('sends Authorization: Bearer only when a key is set', async () => {
    await make({ apiKey: KEY }).complete(REQ);
    expect(stub.requests[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    await make().complete(REQ);
    await make({ apiKey: '' }).complete(REQ);
    expect(stub.requests[1]!.headers.authorization).toBeUndefined();
    expect(stub.requests[2]!.headers.authorization).toBeUndefined();
  });

  it('works against a keyless local server and tolerates a trailing slash in baseUrl', async () => {
    expect(await make({ baseUrl: `${stub.origin}/v1/` }).complete(REQ)).toBe('hi there');
    expect(stub.requests[0]!.url).toBe('/v1/chat/completions');
  });

  it('rejects malformed completion shapes with a typed, non-retried LlmError', async () => {
    const shapes: unknown[] = [
      {},
      { choices: null },
      { choices: [] },
      { choices: {} },
      { choices: [null] },
      { choices: [{}] },
      { choices: [{ message: null }] },
      { choices: [{ message: {} }] },
      { choices: [{ message: { content: null } }] },
      { choices: [{ message: { content: 42 } }] },
      { choices: [{ message: { content: ['a'] } }] },
      null,
      [],
      'text',
    ];
    for (const shape of shapes) {
      stub.requests.length = 0;
      stub.setHandler((_r, res) => json(res, 200, JSON.stringify(shape)));
      const e = await fail(make().complete(REQ));
      expect(e.attempts, JSON.stringify(shape)).toBe(1);
      expect(stub.requests).toHaveLength(1);
    }
  });

  it('does not follow redirects, so the key cannot be forwarded elsewhere', async () => {
    const other = await startStub((_r, res) => json(res, 200, openaiOk('stolen')));
    try {
      stub.setHandler((_r, res) => {
        res.writeHead(307, { location: `${other.origin}/v1/chat/completions` });
        res.end();
      });
      await fail(make({ apiKey: KEY }).complete(REQ));
      expect(other.requests).toHaveLength(0);
    } finally {
      await other.close();
    }
  });

  it('the client object does not expose the key to inspect or JSON', () => {
    const c = make({ apiKey: KEY });
    expect(inspect(c, { depth: 5, showHidden: true })).not.toContain(KEY);
    expect(JSON.stringify(c)).not.toContain(KEY);
  });

  it('thrown fetch errors carrying the key in their message are reduced to a kind', async () => {
    const f = async () => {
      throw new TypeError(`fetch failed for Bearer ${KEY}`);
    };
    const e = await fail(make({ apiKey: KEY, fetch: f }).complete(REQ));
    expect(kindOf(e)).toBe('network');
    expect(dump(e)).not.toContain(KEY);
  });

  it('constructor rejects bad config without echoing the secret', () => {
    const bad: [string, Partial<ConstructorParameters<typeof OpenAICompatClient>[0]>][] = [
      ['not a url', { baseUrl: 'localhost-11434' }],
      ['scheme', { baseUrl: 'ftp://h/v1' }],
      ['file scheme', { baseUrl: 'file:///etc/passwd' }],
      ['credentials', { baseUrl: 'http://user:pw-SECRET@h/v1' }],
      ['model', { model: ' ' }],
      ['newline in key', { apiKey: `${KEY}\r\nX-Evil: 1` }],
    ];
    for (const [label, o] of bad) {
      let err: unknown;
      try {
        make(o);
      } catch (e) {
        err = e;
      }
      expect(err, label).toBeInstanceOf(ConfigError);
      expect(dump(err), label).not.toContain('SECRET');
    }
  });
});

describe('AnthropicClient specifics', () => {
  const make = (o: Partial<ConstructorParameters<typeof AnthropicClient>[0]> = {}) => new AnthropicClient({ model: 'm', apiKey: KEY, baseUrl: stub.origin, retry: FAST, ...o });

  it('authenticates with x-api-key and joins multiple text blocks, skipping non-text', async () => {
    stub.setHandler((_r, res) => json(res, 200, { content: [{ type: 'text', text: 'a' }, { type: 'tool_use', id: 't', name: 'n', input: {} }, { type: 'text', text: 'b' }] }));
    expect(await make().complete(REQ)).toBe('ab');
    expect(stub.requests[0]!.headers['x-api-key']).toBe(KEY);
  });

  it('rejects missing or non-array content and non-string text', async () => {
    for (const shape of [{}, { content: null }, { content: 'x' }, { content: [] }, { content: [{ type: 'text', text: 5 }] }, { content: [{ type: 'tool_use' }] }]) {
      stub.setHandler((_r, res) => json(res, 200, shape));
      await fail(make().complete(REQ));
    }
  });

  it('the SDK itself never retries (exactly one request on a 400/401)', async () => {
    stub.setHandler((_r, res) => json(res, 401, {}));
    await fail(make().complete(REQ));
    expect(stub.requests).toHaveLength(1);
  });

  it('constructor validates key, model and baseUrl without echoing them', () => {
    for (const o of [{ apiKey: '' }, { apiKey: 'a b' }, { model: '' }, { baseUrl: 'nope' }, { baseUrl: 'gopher://x' }, { baseUrl: 'http://u:p@x' }]) {
      expect(() => make(o)).toThrow(ConfigError);
    }
    expect(inspect(make(), { depth: 6, showHidden: true })).not.toContain(KEY);
    expect(JSON.stringify(make())).not.toContain(KEY);
  });
});
