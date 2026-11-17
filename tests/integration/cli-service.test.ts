// The Phase 9 CLI commands: authors, config get, capabilities (registry-derived), and serve / mcp argument handling.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main } from '../../src/cli/main.js';
import { MockLlmClient } from '../../src/llm/mockClient.js';
import { runCli } from '../helpers/cli.js';
import { PERSONA, corpus } from '../helpers/rig.js';

let work: string;
let state: string;
let cfg: string;
const SECRET_KEY = 'sk-ant-api03-' + 'Zz9Yy8Xx7Ww6Vv5Uu4Tt3'.repeat(3);
const common = (): string[] => ['--config', cfg, '--state-dir', state];

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'gw-cli-svc-'));
  state = join(work, 'state');
  cfg = join(work, 'config.json');
  writeFileSync(cfg, JSON.stringify({ llm: { model: 'm', apiKeyEnv: 'MY_PRIVATE_KEY' }, personas: [PERSONA] }));
  const r = await runCli(['ingest', '--author', 'ann', '--name', 'Ann Author', ...common()], { stdin: corpus() });
  expect(r.code, r.err).toBe(0);
  const r2 = await runCli(['ingest', '--author', 'bob', '--name', 'Bob B', ...common()], { stdin: corpus('verbose-hedging.txt') });
  expect(r2.code, r2.err).toBe(0);
});
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe('ghostwriter authors', () => {
  it('lists ingested authors sorted by id: text lines, and --json {ok, authors}', async () => {
    const text = await runCli(['authors', ...common()]);
    expect(text.code).toBe(0);
    expect(text.out.split('\n').filter(Boolean).map((l) => l.split('\t')[0])).toEqual(['ann', 'bob']);
    expect(text.out).toContain('Ann Author');
    const json = JSON.parse((await runCli(['authors', ...common(), '--json'])).out);
    expect(json.ok).toBe(true);
    expect(json.authors.map((a: { authorId: string }) => a.authorId)).toEqual(['ann', 'bob']);
    expect(json.authors[0].corpusWordCount).toBeGreaterThan(0);
  });

  it('with no state it is an empty list, exit 0', async () => {
    const r = await runCli(['authors', '--json', '--config', cfg, '--state-dir', join(work, 'empty')]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ ok: true, authors: [] });
  });
});

describe('ghostwriter config get', () => {
  it('shows the redacted view; the key variable NAME and whether it is set, never its value', async () => {
    const r = await runCli(['config', 'get', ...common(), '--json'], { env: { MY_PRIVATE_KEY: SECRET_KEY, OTHER_SECRET: 'sk-live-other-0123456789' } });
    expect(r.code, r.err).toBe(0);
    expect(r.out).not.toContain(SECRET_KEY);
    expect(r.out).not.toContain('sk-live-other');
    const doc = JSON.parse(r.out);
    expect(doc.config.llm).toMatchObject({ provider: 'anthropic', model: 'm', apiKeyEnv: 'MY_PRIVATE_KEY', apiKeyEnvSet: true });
    expect(doc.config.personas).toEqual(['exec']);
    const unset = JSON.parse((await runCli(['config', 'get', ...common(), '--json'])).out);
    expect(unset.config.llm.apiKeyEnvSet).toBe(false);
  });

  it('text mode is readable and equally free of values; `config` alone is a usage error (exit 2)', async () => {
    const r = await runCli(['config', 'get', ...common()], { env: { MY_PRIVATE_KEY: SECRET_KEY } });
    expect(r.code).toBe(0);
    expect(r.out).toContain('llm: anthropic m');
    expect(r.out).toContain('MY_PRIVATE_KEY (set)');
    expect(r.out + r.err).not.toContain(SECRET_KEY);
    expect((await runCli(['config'])).code).toBe(2);
    expect((await runCli(['config', 'set', 'x'])).code).toBe(2);
  });
});

describe('ghostwriter capabilities', () => {
  it('lists every operation (humanize included) and nothing pending', async () => {
    const doc = JSON.parse((await runCli(['capabilities', '--json'])).out);
    expect(doc.operations.map((o: { name: string }) => o.name)).toEqual(['ingest', 'generate', 'score', 'humanize', 'profile', 'authors', 'personas', 'filters', 'config_get', 'capabilities']);
    expect(doc.pending).toEqual([]);
    const text = (await runCli(['capabilities'])).out;
    expect(text).toContain('humanize\tPOST /api/humanize\tghostwriter humanize');
    expect(text).toContain('config_get\tGET /api/config\tghostwriter config get');
  });
});

describe('ghostwriter serve', () => {
  async function runServe(argv: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string; err: string; ac: AbortController; done: Promise<number>; ready: Promise<any> }> {
    const ac = new AbortController();
    let out = '';
    let err = '';
    let onReady: (v: unknown) => void = () => undefined;
    const ready = new Promise<unknown>((r) => (onReady = r));
    const done = main(
      argv,
      {
        stdout: (t) => {
          out += t;
          try {
            onReady(JSON.parse(out.split('\n')[0] as string));
          } catch {
            // not a complete document yet
          }
        },
        stderr: (t) => void (err += t),
        stdin: Readable.from([]),
        stdinIsTTY: false,
        env,
        signal: ac.signal,
      },
      { llm: new MockLlmClient(() => 'x') },
    );
    void done.then(() => onReady(undefined));
    return { get code() { return 0; }, get out() { return out; }, get err() { return err; }, ac, done, ready } as never;
  }

  it('starts on loopback with --port 0, serves the API, reports the URL, and exits 0 when told to stop', async () => {
    const s = await runServe(['serve', '--port', '0', '--json', ...common()]);
    const doc = await s.ready;
    expect(doc.ok).toBe(true);
    expect(doc.listening).toMatchObject({ host: '127.0.0.1', api: true, mcp: false, auth: false });
    const res = await fetch(`${doc.listening.url}/api/authors`);
    expect(res.status).toBe(200);
    expect((await res.json()).authors.map((a: { authorId: string }) => a.authorId)).toEqual(['ann', 'bob']);
    expect(s.err).toContain(`listening on ${doc.listening.url}`);
    expect(s.err).toContain('no API token');
    s.ac.abort();
    expect(await s.done).toBe(0);
    await expect(fetch(`${doc.listening.url}/api/authors`)).rejects.toThrow();
  });

  it('with --token-env the token is enforced and never printed', async () => {
    const token = 'tok-' + 'abcdef0123456789'.repeat(2);
    const s = await runServe(['serve', '--port', '0', '--json', '--token-env', 'GW_TOKEN', ...common()], { GW_TOKEN: token });
    const doc = await s.ready;
    expect(doc.listening.auth).toBe(true);
    expect((await fetch(`${doc.listening.url}/api/authors`)).status).toBe(401);
    expect((await fetch(`${doc.listening.url}/api/authors`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
    s.ac.abort();
    await s.done;
    expect(s.out + s.err).not.toContain(token);
    expect(s.err).not.toContain('no API token');
  });

  it('refuses to start: non-loopback host without a token, a token variable that is unset, short, or a token pasted as the NAME', async () => {
    const run = (argv: string[], env: Record<string, string> = {}) => runCli(['serve', '--port', '0', '--json', ...common(), ...argv], { env });
    const wild = await run(['--host', '0.0.0.0']);
    expect(wild.code).toBe(2);
    expect(JSON.parse(wild.out).error.code).toBe('CONFIG_INVALID');
    const unset = await run(['--token-env', 'NOPE_TOKEN']);
    expect(unset.code).toBe(2);
    expect(JSON.parse(unset.out).error.message).toContain('not set');
    const short = await run(['--token-env', 'GW_SHORT'], { GW_SHORT: 'short' });
    expect(short.code).toBe(2);
    expect(short.out).not.toContain('short"');
    const pasted = await run(['--token-env', 'sk-live-abcdefghijklmnop']);
    expect(pasted.code).toBe(2);
    expect(pasted.out).not.toContain('sk-live-abcdefghijklmnop');
    // --token-env policy: a sane NAME, never another system's credential or a provider key, a token with some variety; the name is never echoed
    const strong = 'tok-' + 'abcdef0123456789'.repeat(2);
    for (const [name, env] of [
      ['PATH', { PATH: strong }],
      ['HOME', { HOME: strong }],
      ['lower_case_token', { lower_case_token: strong }],
      ['ANTHROPIC_API_KEY', { ANTHROPIC_API_KEY: strong }],
      ['OPENAI_API_KEY', { OPENAI_API_KEY: strong }],
      ['AWS_SESSION_TOKEN', { AWS_SESSION_TOKEN: strong }],
      ['GITHUB_TOKEN', { GITHUB_TOKEN: strong }],
      ['MY_SECRET', { MY_SECRET: strong }],
      ['ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890'.repeat(3) + '_X', {}],
    ] as [string, Record<string, string>][]) {
      const r = await run(['--token-env', name], env);
      expect(r.code, name).toBe(2);
      expect(JSON.parse(r.out).error.code, name).toBe('CONFIG_INVALID');
      expect(r.out + r.err, name).not.toContain(name);
      expect(r.out + r.err, name).not.toContain(strong);
    }
    const repetitive = await run(['--token-env', 'GW_TOKEN'], { GW_TOKEN: 'a'.repeat(40) });
    expect(repetitive.code).toBe(2);
    expect(repetitive.out).not.toContain('aaaaaaaa');
    const unsetNamed = await run(['--token-env', 'GW_NOT_SET_ANYWHERE']);
    expect(unsetNamed.out).not.toContain('GW_NOT_SET_ANYWHERE');
    expect((await run(['--allow-origin', '*'])).code).toBe(2);
    expect((await run(['--max-body', '10'])).code).toBe(2);
    expect((await run(['--port', '70000'])).code).toBe(2);
  });
});

describe('ghostwriter mcp', () => {
  it('rejects --stdio together with --http, and --http without a token off loopback', async () => {
    expect((await runCli(['mcp', '--stdio', '--http', ...common()])).code).toBe(2);
    expect((await runCli(['mcp', '--http', '--host', '0.0.0.0', '--port', '0', ...common()])).code).toBe(2);
  });

  it('listener flags without --http are a ConfigError naming the flags, not silently ignored on stdio', async () => {
    const r = await runCli(['mcp', '--host', '0.0.0.0', '--token-env', 'GW_TOKEN', '--port', '9', ...common(), '--json'], { env: { GW_TOKEN: 'tok-' + 'abcdef0123456789'.repeat(2) } });
    expect(r.code).toBe(2);
    const e = JSON.parse(r.out).error;
    expect(e.code).toBe('CONFIG_INVALID');
    expect(e.message).toContain('--host, --port, --token-env only apply with --http');
    expect(r.out).not.toContain('abcdef0123456789');
  });
});
