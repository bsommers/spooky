// System tier: the REAL binary (tsc-built, run with node) against a local OpenAI-compatible stub server.
// Covers what in-process tests cannot: the shebang entry, process exit codes, true stdout/stderr separation, stdin
// from a pipe, files on disk and persistence between separate processes.
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { json, openaiOk, startStub } from '../helpers/llmStub.js';
import type { Stub } from '../helpers/llmStub.js';
import { PERSONA, corpus } from '../helpers/rig.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const cacheDir = join(root, 'node_modules', '.cache');
let outDir = '';
let bin = '';
let work = '';
let stub: Stub;
let configPath = '';
let state = '';

interface Res {
  code: number | null;
  out: string;
  err: string;
}

function run(args: string[], stdin?: string, env: Record<string, string> = {}): Promise<Res> {
  return new Promise((resolveRun, reject) => {
    // A clean environment: no inherited API keys or GHOSTWRITER_* settings.
    const child = spawn(process.execPath, [bin, ...args], { env: { PATH: process.env.PATH ?? '', HOME: work, ...env }, cwd: work });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => void (out += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => void (err += d.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolveRun({ code, out, err }));
    child.stdin.end(stdin ?? '');
  });
}

beforeAll(async () => {
  mkdirSync(cacheDir, { recursive: true });
  outDir = mkdtempSync(join(cacheDir, 'cli-build-'));
  const tsc = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', join(root, 'tsconfig.build.json'), '--outDir', outDir], { cwd: root, encoding: 'utf8' });
  expect(tsc.stdout + tsc.stderr).toBe('');
  bin = join(outDir, 'src', 'cli', 'bin.js');
  expect(existsSync(bin)).toBe(true);

  work = mkdtempSync(join(cacheDir, 'cli-work-'));
  state = join(work, 'state');
  stub = await startStub((_req, res) => json(res, 200, openaiOk('Written by the stub model.')));
  configPath = join(work, 'config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      llm: { model: 'stub-model', provider: 'openai-compat', baseUrl: `${stub.origin}/v1`, maxRetries: 0 },
      personas: [PERSONA],
      limits: { maxInputChars: 1000 },
    }),
  );
  writeFileSync(join(work, 'corpus.txt'), corpus());
  writeFileSync(join(work, 'draft.txt'), 'Please rewrite this status update.');
}, 180_000);

afterAll(async () => {
  await stub?.close();
  if (outDir) rmSync(outDir, { recursive: true, force: true });
  if (work) rmSync(work, { recursive: true, force: true });
});

const base = () => ['--config', configPath, '--state-dir', state];

describe('system: ghostwriter binary', () => {
  it('--help lists all 5 commands (stdout, exit 0)', async () => {
    const r = await run(['--help']);
    expect(r.code).toBe(0);
    for (const c of ['ingest', 'generate', 'personas', 'filters', 'profile']) expect(r.out).toContain(c);
  });

  it('ingest, then generate --json in a SEPARATE process: exit 0, valid JSON, clean stderr', async () => {
    const i = await run(['ingest', '--author', 'terse', '--name', 'Terse Author', join(work, 'corpus.txt'), '--json', ...base()]);
    expect(i).toMatchObject({ code: 0, err: '' });
    expect(JSON.parse(i.out)).toMatchObject({ ok: true, profile: { authorId: 'terse' } });
    for (const f of ['store.json', 'profiles.json']) expect(statSync(join(state, f)).mode & 0o777).toBe(0o600);

    const g = await run(['generate', '--author', 'terse', '--persona', 'exec', '--json', ...base()], 'Deploy using AKIAIOSFODNN7EXAMPLE tonight.');
    expect(g.code).toBe(0);
    expect(g.err).toBe('');
    const doc = JSON.parse(g.out) as { ok: boolean; text: string; trace: Array<{ filter: string }> };
    expect(doc).toMatchObject({ ok: true, text: 'Written by the stub model.' });
    expect(doc.trace.map((t) => t.filter)).toEqual(['confidentiality', 'llm', 'style', 'confidentiality']);
    // the provider only ever saw redacted text, and no Authorization header (keyless local server)
    const last = stub.requests.at(-1)!;
    expect(last.body).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(last.body).toContain('REDACTED');
    expect(last.headers.authorization).toBeUndefined();
  });

  it('generate with --file, positional file and stdin all work; text mode prints only the text', async () => {
    const viaFile = await run(['generate', '--author', 'terse', '--persona', 'exec', '--file', join(work, 'draft.txt'), ...base()]);
    const viaArg = await run(['generate', '--author', 'terse', '--persona', 'exec', join(work, 'draft.txt'), ...base()]);
    const viaStdin = await run(['generate', '--author', 'terse', '--persona', 'exec', ...base()], 'From a pipe.');
    for (const r of [viaFile, viaArg, viaStdin]) expect(r).toEqual({ code: 0, out: 'Written by the stub model.\n', err: '' });
  });

  it('profile / personas / filters work from the shell', async () => {
    expect((await run(['profile', 'terse', ...base()])).out).toContain('author: terse');
    expect(JSON.parse((await run(['personas', '--json', ...base()])).out)).toMatchObject({ ok: true, personas: [{ key: 'exec' }] });
    expect((await run(['filters', ...base()])).out).toContain('confidentiality\tpre');
  });

  it('every documented error maps to its exit code', async () => {
    const gen = (extra: string[], stdin = 'hello there') => run(['generate', '--author', 'terse', '--persona', 'exec', ...extra, ...base()], stdin);
    expect((await run(['ingest', ...base()])).code).toBe(2); // usage
    expect((await run(['nonsense'])).code).toBe(2);
    expect((await run(['ingest', '--author', 'x', '--name', 'X', join(work, 'missing.txt'), ...base()])).code).toBe(2);
    expect((await run(['generate', '--author', 'terse', '--persona', 'nope', ...base()], 'hi')).code).toBe(3);
    expect((await run(['generate', '--author', 'ghost', '--persona', 'exec', ...base()], 'hi')).code).toBe(3);
    expect((await run(['profile', 'ghost', ...base()])).code).toBe(3);
    expect((await gen([], 'x'.repeat(1001))).code).toBe(6);
    stub.setHandler((_r, res) => json(res, 500, { error: 'down' }));
    const down = await gen(['--json']);
    expect(down.code).toBe(5);
    expect(JSON.parse(down.out)).toMatchObject({ ok: false, error: { code: 'LLM_FAILED' } });
    stub.setHandler((_r, res) => json(res, 200, openaiOk('Written by the stub model.')));
    const bad = join(work, 'bad-state');
    mkdirSync(bad);
    writeFileSync(join(bad, 'store.json'), '{"nope":true}');
    writeFileSync(join(bad, 'profiles.json'), '{"nope":true}');
    chmodSync(join(bad, 'profiles.json'), 0o600);
    expect((await run(['profile', 'terse', '--config', configPath, '--state-dir', bad])).code).toBe(7);
    // exit code 4 (fail-closed filter) needs a deliberately broken filter; it is covered in tests/integration/cli.test.ts
  });

  it('anthropic provider with no API key: exit 2, clear message, no key material anywhere', async () => {
    const cfg = join(work, 'anthropic.json');
    writeFileSync(cfg, JSON.stringify({ llm: { model: 'claude-x' }, personas: [PERSONA] }));
    const r = await run(['generate', '--author', 'terse', '--persona', 'exec', '--config', cfg, '--state-dir', state], 'hello there');
    expect(r.code).toBe(2);
    expect(r.out).toBe('');
    expect(r.err).toContain('ANTHROPIC_API_KEY');
    expect(r.err).not.toMatch(/\n\s+at /);
    // ... and a key that IS set is never echoed, even when the provider rejects it
    const rejected = await run(['generate', '--author', 'terse', '--persona', 'exec', '--config', cfg, '--state-dir', state], 'hello there', {
      ANTHROPIC_API_KEY: 'sk-ant-api03-NEVERPRINTME',
      // point the SDK nowhere reachable: connection errors must not leak the key either
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
    });
    expect(rejected.code).toBe(5);
    expect(rejected.out + rejected.err).not.toContain('NEVERPRINTME');
  }, 60_000);

  it('the same input twice gives byte-identical stdout', async () => {
    const a = await run(['generate', '--author', 'terse', '--persona', 'exec', ...base()], 'Stable input.');
    const b = await run(['generate', '--author', 'terse', '--persona', 'exec', ...base()], 'Stable input.');
    expect(a.out).toBe(b.out);
  });

  it('the shebang is present so the installed bin is executable by name', () => {
    expect(readFileSync(bin, 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true);
  });
});
