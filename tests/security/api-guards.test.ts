// Security tier: the HTTP surface against drive-by browsers and hostile clients (DNS rebinding, CSRF, oversize and slow
// bodies, overload, malformed requests). Every rejection must happen before the operation runs.
import { connect } from 'node:net';
import { describe, expect, it } from 'vitest';
import { CLEAN_ANSWER, makeRuntime, postJson, raw, startTestServer } from '../helpers/surfaces.js';

async function withServer<T>(opts: Parameters<typeof startTestServer>[1], fn: (s: Awaited<ReturnType<typeof startTestServer>>, rig: Awaited<ReturnType<typeof makeRuntime>>) => Promise<T>, rigOpts: Parameters<typeof makeRuntime>[0] = {}): Promise<T> {
  const rig = await makeRuntime(rigOpts);
  const server = await startTestServer(rig, opts);
  try {
    return await fn(server, rig);
  } finally {
    await server.close();
    rig.cleanup();
  }
}

/** Send raw bytes on a socket and collect the reply text; ends after `idleMs` of silence or on close. */
function socketExchange(port: number, head: string, body: Buffer | string = '', idleMs = 300): Promise<string> {
  return new Promise((resolve) => {
    const sock = connect(port, '127.0.0.1');
    let data = '';
    let timer: NodeJS.Timeout | undefined;
    const done = (): void => {
      clearTimeout(timer);
      sock.destroy();
      resolve(data);
    };
    const arm = (): void => {
      clearTimeout(timer);
      timer = setTimeout(done, idleMs);
    };
    sock.on('data', (d) => {
      data += d.toString('utf8');
      arm();
    });
    sock.on('close', done);
    sock.on('error', () => undefined);
    sock.write(head);
    if (body.length > 0) sock.write(body);
    arm();
  });
}
const statusOf = (reply: string): number => Number(/^HTTP\/1\.1 (\d{3})/.exec(reply)?.[1] ?? 0);

describe('DNS rebinding and CSRF', () => {
  it('a Host header that does not name this server is 421 and nothing runs', async () => {
    await withServer({}, async (s, rig) => {
      for (const host of ['evil.example', 'evil.example:8787', 'localhost.evil.example', '127.0.0.1.evil.example', '169.254.169.254', 'attacker.test:80']) {
        const r = await raw(s, '/api/authors', { headers: { Host: host } });
        expect(r.status, host).toBe(421);
        expect(r.json().error.code).toBe('MISDIRECTED_REQUEST');
        expect(r.text).not.toContain('terse');
      }
      const post = await postJson(s, '/api/generate', { authorId: 'terse', persona: 'exec', text: 'hi there' }, { Host: 'evil.example' });
      expect(post.status).toBe(421);
      expect(rig.llm.callCount).toBe(0);
      // the right names work
      for (const host of [`localhost:${s.port}`, `127.0.0.1:${s.port}`, `[::1]:${s.port}`]) expect((await raw(s, '/api/personas', { headers: { Host: host } })).status, host).toBe(200);
    });
  });

  it('a POST with a foreign Origin is 403 before the body is read or the operation runs; a same-origin POST works', async () => {
    await withServer({}, async (s, rig) => {
      const body = { authorId: 'terse', persona: 'exec', text: 'Please rewrite this draft.' };
      for (const origin of ['http://evil.example', 'https://evil.example', 'null', 'http://127.0.0.1:1', 'http://localhost.evil.example']) {
        const r = await postJson(s, '/api/generate', body, { Origin: origin });
        expect(r.status, origin).toBe(403);
        expect(r.json().error.code).toBe('FORBIDDEN');
        expect(r.headers['access-control-allow-origin']).toBeUndefined();
      }
      expect(rig.llm.callCount).toBe(0);
      const ok = await postJson(s, '/api/generate', body, { Origin: `http://127.0.0.1:${s.port}` });
      expect(ok.status).toBe(200);
      expect(ok.json().text).toBe(CLEAN_ANSWER);
    });
  });

  it('a cross-site "simple" form POST (text/plain, no preflight) is refused with 415 even without an Origin header', async () => {
    await withServer({}, async (s, rig) => {
      const r = await raw(s, '/api/ingest', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ authorId: 'zz', name: 'Z', text: 'A. B. C.' }) });
      expect(r.status).toBe(415);
      const form = await raw(s, '/api/ingest', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'authorId=zz&name=Z&text=hello' });
      expect(form.status).toBe(415);
      expect(rig.engine.listAuthors().map((a) => a.authorId)).toEqual(['terse']);
    });
  });

  it('with a token, a wildcard bind skips the Host check but still requires the token; without one it is not allowed to start', async () => {
    const rig = await makeRuntime();
    try {
      const { startApiServer } = await import('../../src/api/server.js');
      const s = await startApiServer({ runtime: rig.runtime, port: 0, host: '0.0.0.0', token: 'a-long-enough-token-1234' });
      try {
        const noTok = await raw({ host: '127.0.0.1', port: s.port }, '/api/personas', { headers: { Host: 'some.name.internal' } });
        expect(noTok.status).toBe(401);
        const withTok = await raw({ host: '127.0.0.1', port: s.port }, '/api/personas', { headers: { Host: 'some.name.internal', Authorization: 'Bearer a-long-enough-token-1234' } });
        expect(withTok.status).toBe(200);
      } finally {
        await s.close();
      }
    } finally {
      rig.cleanup();
    }
  });
});

describe('size, shape and time limits', () => {
  const limits = { maxBodyBytes: 2048, maxIngestBodyBytes: 2048, readTimeoutMs: 400, maxConcurrent: 2 };

  it('a declared body over the cap is 413 immediately, without reading it or running the operation', async () => {
    await withServer({ limits }, async (s, rig) => {
      const reply = await socketExchange(s.port, `POST /api/ingest HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\nContent-Type: application/json\r\nContent-Length: 50000000\r\n\r\n`);
      expect(statusOf(reply)).toBe(413);
      expect(reply).toContain('INPUT_TOO_LARGE');
      expect(reply.toLowerCase()).toContain('connection: close');
      expect(rig.engine.listAuthors()).toHaveLength(1);
    });
  });

  it('an oversized body sent with a lying or absent Content-Length (chunked) is cut off at the cap with 413', async () => {
    await withServer({ limits }, async (s, rig) => {
      const big = Buffer.alloc(1500, 97);
      const chunked = await raw(s, '/api/ingest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, chunks: [big, big, big, big] }).catch((e: Error) => e);
      // the server may close the socket while the client is still writing: either the 413 arrives or the write fails
      if (chunked instanceof Error) expect(chunked.message).toMatch(/EPIPE|ECONNRESET|socket hang up/);
      else expect(chunked.status).toBe(413);
      const viaSocket = await socketExchange(
        s.port,
        `POST /api/ingest HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n`,
        `${(1500).toString(16)}\r\n${'a'.repeat(1500)}\r\n${(1500).toString(16)}\r\n${'a'.repeat(1500)}\r\n`,
      );
      expect(statusOf(viaSocket)).toBe(413);
      expect(rig.engine.listAuthors()).toHaveLength(1);
    });
  });

  it('the default caps are 1 MiB for everything but ingest and 10 MiB for ingest and /mcp (REQUIREMENTS API-03)', async () => {
    await withServer({}, async (s) => {
      const small = await socketExchange(s.port, `POST /api/score HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\nContent-Type: application/json\r\nContent-Length: ${1024 * 1024 + 1}\r\n\r\n`);
      expect(statusOf(small)).toBe(413);
      // an ingest of 5 MiB declared is not refused at the door (it is read, then judged by the schema/engine); 11 MiB is
      const big = await socketExchange(s.port, `POST /api/ingest HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\nContent-Type: application/json\r\nContent-Length: ${11 * 1024 * 1024}\r\n\r\n`);
      expect(statusOf(big)).toBe(413);
      const ok = await socketExchange(s.port, `POST /api/ingest HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\nContent-Type: application/json\r\nContent-Length: ${5 * 1024 * 1024}\r\n\r\n`, '', 200);
      expect(statusOf(ok)).toBe(0); // waiting for the body, not rejected
    });
  });

  it('wrong content type is 415; no content type is 415; charset other than utf-8 is 415; application/json; charset=utf-8 is fine', async () => {
    await withServer({}, async (s) => {
      for (const ct of ['text/plain', 'application/xml', 'application/json; charset=latin1', 'application/jsonx', 'multipart/form-data; boundary=x']) {
        expect((await raw(s, '/api/score', { method: 'POST', headers: { 'Content-Type': ct }, body: '{"text":"hello there friend"}' })).status, ct).toBe(415);
      }
      expect((await raw(s, '/api/score', { method: 'POST', body: '{"text":"hello there friend"}' })).status).toBe(415);
      expect((await raw(s, '/api/score', { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: '{"text":"hello there friend. And a second sentence. And a third."}' })).status).toBe(200);
    });
  });

  it('malformed JSON, invalid UTF-8, wrong JSON shapes and unknown fields are 400 USAGE; the message echoes no input', async () => {
    await withServer({}, async (s) => {
      const hdr = { 'Content-Type': 'application/json' };
      const cases: [string, string | Buffer][] = [
        ['not json', '{"text": '],
        ['trailing garbage', '{"text":"a"} x'],
        ['invalid utf-8', Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d])],
        ['array', '[1,2]'],
        ['string', '"just a string"'],
        ['number', '42'],
        ['null', 'null'],
        ['unknown field', '{"text":"hello there","extra":true}'],
        ['wrong type', '{"text":5}'],
        ['proto key', '{"text":"hello there","__proto__":{"polluted":true}}'],
        ['control char in detector name', '{"text":"hello there","detectors":["a\\u0007b"]}'],
      ];
      for (const [name, body] of cases) {
        const r = await raw(s, '/api/score', { method: 'POST', headers: hdr, body });
        expect(r.status, name).toBe(400);
        expect(r.json().error.code, name).toBe('USAGE');
      }
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });
  });

  it('a network-path or backslash request target (//host/path) is 400, never routed as /path', async () => {
    await withServer({}, async (s) => {
      for (const target of ['//x/api/authors', '//api/authors', '///api/authors', '/\\x/api/authors', '/api\\authors', '/\\\\x/api/authors']) {
        const reply = await socketExchange(s.port, `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\nConnection: close\r\n\r\n`);
        expect(statusOf(reply), target).toBe(400);
        expect(reply, target).toContain('USAGE');
      }
      expect((await raw(s, '/api/authors')).status).toBe(200);
    });
  });

  describe('route existence is not revealed before the token', () => {
    const TOKEN = 'a-long-enough-token-1234';
    const auth = { Authorization: `Bearer ${TOKEN}` };
    const protectedPaths = ['/api/authors', '/api/nope', '/api/', '/openapi.json', '/mcp'];

    it('with a token, every protected path answers 401 without it, whether the route or /mcp exists or not', async () => {
      for (const mcp of [false, true]) {
        await withServer({ token: TOKEN, mcp }, async (s) => {
          const replies = new Set<string>();
          for (const path of protectedPaths) {
            for (const method of ['GET', 'POST']) {
              const r = await raw(s, path, { method, headers: method === 'POST' ? { 'Content-Type': 'application/json' } : {}, body: method === 'POST' ? '{}' : undefined });
              expect(r.status, `${method} ${path} mcp=${mcp}`).toBe(401);
              replies.add(r.text);
            }
          }
          expect(replies.size).toBe(1); // the same body for all of them
        });
      }
    });

    it('with the token, a disabled /mcp is 404 and an enabled one answers; paths outside the protected namespace stay 404', async () => {
      await withServer({ token: TOKEN, mcp: false }, async (s) => {
        expect((await raw(s, '/mcp', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(404);
        expect((await raw(s, '/api/nope', { headers: auth })).status).toBe(404);
        expect((await raw(s, '/nope')).status).toBe(404);
      });
      await withServer({ token: TOKEN, mcp: true }, async (s) => {
        expect((await raw(s, '/mcp', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{}' })).status).not.toBe(404);
      });
    });

    it('a --no-api server (mcp only) does not reveal /openapi.json to an unauthenticated caller either', async () => {
      await withServer({ token: TOKEN, mcp: true, api: false }, async (s) => {
        expect((await raw(s, '/openapi.json')).status).toBe(401);
        expect((await raw(s, '/openapi.json', { headers: auth })).status).toBe(404);
      });
    });

    it('the static hook is only offered public GET/HEAD paths, before the token, and never the protected namespace', async () => {
      const offered: string[] = [];
      const staticHandler = (_req: unknown, res: import('node:http').ServerResponse, url: URL): boolean => {
        offered.push(url.pathname);
        res.statusCode = 200;
        res.end('asset');
        return true;
      };
      await withServer({ token: TOKEN, mcp: true, staticHandler }, async (s) => {
        expect((await raw(s, '/index.html')).text).toBe('asset'); // public, no token needed
        for (const p of ['/api/authors', '/api/anything', '/openapi.json', '/mcp']) expect((await raw(s, p)).status, p).toBe(401);
        expect((await raw(s, '/ui', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(404);
        expect(offered).toEqual(['/index.html']);
      });
    });
  });

  it('a request line that is not an absolute path is rejected, and an oversize header block never reaches a handler', async () => {
    await withServer({}, async (s) => {
      const abs = await socketExchange(s.port, `GET http://evil.example/api/authors HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\n\r\n`);
      expect(statusOf(abs)).toBe(400);
      const hugeHeader = await socketExchange(s.port, `GET /api/authors HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\nX-Big: ${'a'.repeat(40_000)}\r\n\r\n`);
      expect([431, 400, 0]).toContain(statusOf(hugeHeader));
    });
  });

  it('a client that never finishes its body is cut off with 408 after readTimeoutMs', async () => {
    await withServer({ limits }, async (s, rig) => {
      const started = Date.now();
      const reply = await socketExchange(
        s.port,
        `POST /api/ingest HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{"authorId":"slow"`,
        '',
        1500,
      );
      expect(statusOf(reply)).toBe(408);
      expect(reply).toContain('REQUEST_TIMEOUT');
      expect(Date.now() - started).toBeLessThan(1400);
      expect(rig.engine.listAuthors()).toHaveLength(1);
    });
  });

  it('beyond maxConcurrent in-flight operations the next request is 503 with Retry-After; slots free up afterwards', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    let started = 0;
    await withServer(
      { limits: { ...limits, maxConcurrent: 2 } },
      async (s) => {
        const body = { authorId: 'terse', persona: 'exec', text: 'Please rewrite this short draft.' };
        const first = postJson(s, '/api/generate', body);
        const second = postJson(s, '/api/generate', body);
        for (let i = 0; i < 100 && started < 2; i++) await new Promise((r) => setTimeout(r, 20));
        expect(started).toBe(2);
        const third = await postJson(s, '/api/generate', body);
        expect(third.status).toBe(503);
        expect(third.headers['retry-after']).toBe('1');
        expect(third.json().error.code).toBe('OVERLOADED');
        release();
        expect((await first).status).toBe(200);
        expect((await second).status).toBe(200);
        expect((await postJson(s, '/api/generate', body)).status).toBe(200);
      },
      {
        script: async () => {
          started += 1;
          await held;
          return CLEAN_ANSWER;
        },
      } as never,
    );
  });

  describe('the concurrency cap holds when clients drop their connections (slot freed on completion, not on socket close)', () => {
    /** Send a complete request and hang up without reading the answer. */
    const fireAndAbort = (port: number, path: string, payload: unknown, extraHeaders = ''): Promise<void> =>
      new Promise((resolve) => {
        const data = JSON.stringify(payload);
        const sock = connect(port, '127.0.0.1');
        sock.on('error', () => undefined);
        sock.on('connect', () => {
          sock.write(
            `POST ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\n${extraHeaders}Content-Length: ${Buffer.byteLength(data)}\r\n\r\n${data}`,
            () => setTimeout(() => {
              sock.destroy();
              resolve();
            }, 25),
          );
        });
      });
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

    function slowRig(): { script: never; stats: { started: number; active: number; peak: number }; release: () => void } {
      let release: () => void = () => undefined;
      const held = new Promise<void>((r) => (release = r));
      const stats = { started: 0, active: 0, peak: 0 };
      const script = async (): Promise<string> => {
        stats.started += 1;
        stats.active += 1;
        stats.peak = Math.max(stats.peak, stats.active);
        await held;
        stats.active -= 1;
        return CLEAN_ANSWER;
      };
      return { script: script as never, stats, release: () => release() };
    }
    const cap = { maxBodyBytes: 100_000, maxIngestBodyBytes: 100_000, readTimeoutMs: 2000, maxConcurrent: 2 };
    const generate = { authorId: 'terse', persona: 'exec', text: 'Please rewrite this short draft.' };

    it('REST: 10 fire-and-abort POSTs start at most maxConcurrent handlers; the next caller still gets 503 while they run', async () => {
      const { script, stats, release } = slowRig();
      await withServer({ limits: cap }, async (s) => {
        for (let i = 0; i < 10; i++) await fireAndAbort(s.port, '/api/generate', generate);
        for (let i = 0; i < 100 && stats.started < 2; i++) await sleep(10);
        await sleep(100);
        expect(stats.started).toBe(2);
        expect(stats.peak).toBeLessThanOrEqual(2);
        const busy = await postJson(s, '/api/generate', generate);
        expect(busy.status).toBe(503);
        expect(busy.json().error.code).toBe('OVERLOADED');
        release();
        for (let i = 0; i < 100 && stats.active > 0; i++) await sleep(10);
        expect(stats.active).toBe(0);
        expect(stats.peak).toBeLessThanOrEqual(2);
        let ok = busy;
        for (let i = 0; i < 100 && ok.status === 503; i++) {
          await sleep(10);
          ok = await postJson(s, '/api/generate', generate);
        }
        expect(ok.status).toBe(200); // slots came back
      }, { script } as never);
    });

    it('MCP over HTTP: the same, for tools/call generate', async () => {
      const { script, stats, release } = slowRig();
      const call = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'generate', arguments: generate } };
      const accept = 'Accept: application/json, text/event-stream\r\n';
      await withServer({ limits: cap, mcp: true }, async (s) => {
        for (let i = 0; i < 10; i++) await fireAndAbort(s.port, '/mcp', call, accept);
        for (let i = 0; i < 100 && stats.started < 2; i++) await sleep(10);
        await sleep(100);
        expect(stats.started).toBe(2);
        expect(stats.peak).toBeLessThanOrEqual(2);
        const busy = await raw(s, '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify(call) });
        expect(busy.status).toBe(503);
        release();
        for (let i = 0; i < 100 && stats.active > 0; i++) await sleep(10);
        expect(stats.peak).toBeLessThanOrEqual(2);
        let ok = busy;
        for (let i = 0; i < 100 && ok.status === 503; i++) {
          await sleep(10);
          ok = await raw(s, '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify(call) });
        }
        expect(ok.status).toBe(200); // slots came back
      }, { script } as never);
    });
  });

  describe('/mcp: one message per request, and the REST body caps apply per tool', () => {
    const mcpHeaders = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    const call = (id: number, name: string, args: unknown): unknown => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
    const split = { maxBodyBytes: 2048, maxIngestBodyBytes: 16_384, readTimeoutMs: 2000, maxConcurrent: 8 };

    it('a JSON-RPC batch (any size, even empty) is 400 and no tool runs', async () => {
      await withServer({ mcp: true }, async (s, rig) => {
        const gen = { authorId: 'terse', persona: 'exec', text: 'Please rewrite this short draft.' };
        const batch = Array.from({ length: 100 }, (_, i) => call(i + 1, 'generate', gen));
        for (const b of [batch, batch.slice(0, 2), [], [call(1, 'personas', {})]]) {
          const r = await raw(s, '/mcp', { method: 'POST', headers: mcpHeaders, body: JSON.stringify(b) });
          expect(r.status, `batch of ${b.length}`).toBe(400);
          expect(r.json().error.code).toBe('USAGE');
        }
        expect(rig.llm.callCount).toBe(0);
        // a single message still works
        const one = await raw(s, '/mcp', { method: 'POST', headers: mcpHeaders, body: JSON.stringify(call(1, 'personas', {})) });
        expect(one.status).toBe(200);
      });
    });

    it('a tools/call of any tool but ingest is held to the default body cap; ingest alone gets the large cap', async () => {
      await withServer({ mcp: true, limits: split }, async (s) => {
        const text = 'Words go here. '.repeat(300); // ~4.5 KB: over maxBodyBytes (2 KB), under maxIngestBodyBytes (16 KB)
        for (const tool of ['score', 'generate']) {
          const args = tool === 'score' ? { text } : { authorId: 'terse', persona: 'exec', text };
          const r = await raw(s, '/mcp', { method: 'POST', headers: mcpHeaders, body: JSON.stringify(call(1, tool, args)) });
          expect(r.status, tool).toBe(413);
          expect(r.json().error.code).toBe('INPUT_TOO_LARGE');
        }
        // not a tools/call at all: also held to the small cap
        const pad = await raw(s, '/mcp', { method: 'POST', headers: mcpHeaders, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: text } }) });
        expect(pad.status).toBe(413);
        const ing = await raw(s, '/mcp', { method: 'POST', headers: mcpHeaders, body: JSON.stringify(call(1, 'ingest', { authorId: 'big1', name: 'Big', text })) });
        expect(ing.status).toBe(200); // past the door; the tool result carries the outcome
        // the declared cap for ingest is still enforced
        const huge = await raw(s, '/mcp', { method: 'POST', headers: mcpHeaders, body: JSON.stringify(call(1, 'ingest', { authorId: 'big2', name: 'Big', text: text.repeat(5) })) });
        expect(huge.status).toBe(413);
      });
    });
  });

  it('unknown routes are 404, wrong methods 405 with Allow, HEAD/PUT/DELETE never run an operation', async () => {
    await withServer({}, async (s, rig) => {
      expect((await raw(s, '/nope')).status).toBe(404);
      expect((await raw(s, '/api/nope')).status).toBe(404);
      expect((await raw(s, '/api/generate')).status).toBe(405);
      expect((await raw(s, '/api/generate')).headers.allow).toBe('POST');
      expect((await raw(s, '/api/personas', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(405);
      for (const m of ['PUT', 'DELETE', 'PATCH', 'HEAD']) expect((await raw(s, '/api/ingest', { method: m })).status, m).toBe(405);
      expect((await raw(s, '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(404); // MCP is opt-in
      expect(rig.llm.callCount).toBe(0);
    });
  });

  it('a repeated query parameter, an unknown one or a path-like author id on a GET is 400 and never touches the file system', async () => {
    await withServer({}, async (s) => {
      expect((await raw(s, '/api/profile?authorId=terse&authorId=terse')).status).toBe(400);
      expect((await raw(s, '/api/profile?authorId=terse&extra=1')).status).toBe(400);
      for (const id of ['../x', '..%2F..%2Fetc%2Fpasswd', 'a/b', '.hidden', 'x%00y', encodeURIComponent('a b')]) {
        const r = await raw(s, `/api/profile?authorId=${id}`);
        expect(r.status, id).toBe(400);
        expect(r.json().error.code).toBe('USAGE');
      }
      expect((await raw(s, '/api/profile?authorId=terse')).status).toBe(200);
      expect((await raw(s, '/api/profile?authorId=nobody')).status).toBe(404);
    });
  });

  it('every response carries the security headers, and API responses a CSP that allows nothing', async () => {
    await withServer({}, async (s) => {
      for (const path of ['/api/personas', '/api/nope', '/openapi.json']) {
        const r = await raw(s, path);
        expect(r.headers['x-content-type-options'], path).toBe('nosniff');
        expect(r.headers['cache-control'], path).toBe('no-store');
        expect(r.headers['content-security-policy'], path).toBe("default-src 'none'; frame-ancestors 'none'");
        expect(r.headers['referrer-policy'], path).toBe('no-referrer');
        expect(r.headers['permissions-policy'], path).toBe('camera=(), microphone=(), geolocation=()');
        expect(r.headers['cross-origin-opener-policy'], path).toBe('same-origin');
        expect(r.headers['content-type'], path).toContain('application/json');
      }
    });
  });
});
