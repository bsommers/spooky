// System tier: the REAL binary as an MCP server (stdio and streamable HTTP) and as an HTTP server, against a local
// OpenAI-compatible stub model. In-process tests cannot show that stdout carries only protocol frames, that SIGTERM
// stops the server cleanly, or that the shebang entry wires everything.
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OPERATIONS } from '../../src/service/operations.js';
import { json, openaiOk, startStub } from '../helpers/llmStub.js';
import type { Stub } from '../helpers/llmStub.js';
import { PERSONA, corpus } from '../helpers/rig.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const cacheDir = join(root, 'node_modules', '.cache');
let outDir = '';
let bin = '';
let work = '';
let state = '';
let configPath = '';
let stub: Stub;
const TOKEN = 'system-test-token-0123456789abcdef';
const SECRET = 'AKIA' + 'IOSFODNN7EXAMPLE';

const cleanEnv = (extra: Record<string, string> = {}): Record<string, string> => ({ PATH: process.env.PATH ?? '', HOME: work, ...extra });
const baseArgs = (): string[] => ['--config', configPath, '--state-dir', state];

beforeAll(async () => {
  mkdirSync(cacheDir, { recursive: true });
  outDir = mkdtempSync(join(cacheDir, 'surfaces-build-'));
  const tsc = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', join(root, 'tsconfig.build.json'), '--outDir', outDir], { cwd: root, encoding: 'utf8' });
  expect(tsc.stdout + tsc.stderr).toBe('');
  bin = join(outDir, 'src', 'cli', 'bin.js');
  expect(existsSync(bin)).toBe(true);
  work = mkdtempSync(join(cacheDir, 'surfaces-work-'));
  state = join(work, 'state');
  stub = await startStub((_req, res) => json(res, 200, openaiOk('Written by the stub model.')));
  configPath = join(work, 'config.json');
  writeFileSync(
    configPath,
    JSON.stringify({ llm: { model: 'stub-model', provider: 'openai-compat', baseUrl: `${stub.origin}/v1`, maxRetries: 0 }, personas: [PERSONA], limits: { maxInputChars: 5000 } }),
  );
}, 180_000);

afterAll(async () => {
  await stub?.close();
  if (outDir) rmSync(outDir, { recursive: true, force: true });
  if (work) rmSync(work, { recursive: true, force: true });
});

const textOf = (r: any): any => JSON.parse(r.content[0].text);

/** Every registered tool is called once with valid input; returns what came back. */
async function exerciseAllTools(client: Client): Promise<void> {
  const listed = await client.listTools();
  expect(listed.tools.map((t) => t.name)).toEqual(OPERATIONS.map((o) => o.name));
  const ingest = listed.tools.find((t) => t.name === 'ingest');
  expect(ingest?.annotations?.readOnlyHint).toBe(false);
  for (const t of listed.tools) if (t.name !== 'ingest') expect(t.annotations?.readOnlyHint, t.name).toBe(true);

  const inputs: Record<string, Record<string, unknown>> = {
    ingest: { authorId: 'sys', name: 'System Author', text: corpus() },
    generate: { authorId: 'sys', persona: 'exec', text: `Deploy using ${SECRET} tonight.` },
    score: { text: 'A plain text to rate. It has a second sentence. And then a third one to end.' },
    humanize: { text: 'A plain text to rewrite. It has a second sentence. And then a third one to end it here.', llm: false },
    profile: { authorId: 'sys' },
  };
  for (const op of OPERATIONS) {
    const r = await client.callTool({ name: op.name, arguments: inputs[op.name] ?? {} });
    expect(r.isError, `${op.name}: ${JSON.stringify(r.content)}`).toBeFalsy();
    const doc = textOf(r);
    expect(doc.ok, op.name).toBe(true);
    expect(op.output.safeParse(Object.fromEntries(Object.entries(doc).filter(([k]) => k !== 'ok'))).success, op.name).toBe(true);
    expect(JSON.stringify(r)).not.toContain(SECRET);
  }
  const bad = await client.callTool({ name: 'profile', arguments: { authorId: '../etc/passwd' } });
  expect(bad.isError).toBe(true);
  expect(textOf(bad).error.code).toBe('USAGE');
}

describe('system: MCP over stdio (spawned binary)', () => {
  it('SDK client: list tools == registry, every tool callable, ingest alone is not read-only, a secret never comes back', async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [bin, 'mcp', '--stdio', ...baseArgs()], env: cleanEnv(), stderr: 'pipe' });
    const client = new Client({ name: 'system-test', version: '1' });
    await client.connect(transport);
    try {
      await exerciseAllTools(client);
    } finally {
      await client.close();
    }
    expect(JSON.stringify(stub.requests.map((r) => r.body))).not.toContain(SECRET);
  }, 60_000);

  it('stdout carries only JSON-RPC frames: every line parses and has jsonrpc 2.0; logs are on stderr; end of input ends the process', async () => {
    const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [bin, 'mcp', ...baseArgs()], { env: cleanEnv(), cwd: work });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => void (out += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => void (err += d.toString('utf8')));
    const exited = new Promise<number | null>((r) => child.on('close', (c) => r(c)));
    const send = (m: unknown): void => void child.stdin.write(`${JSON.stringify(m)}\n`);
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'personas', arguments: {} } });
    send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } });
    for (let i = 0; i < 100 && out.split('\n').filter(Boolean).length < 4; i++) await new Promise((r) => setTimeout(r, 50));
    child.stdin.end();
    expect(await exited).toBe(0);
    const lines = out.split('\n').filter(Boolean);
    expect(lines.length).toBe(4);
    const frames = lines.map((l) => JSON.parse(l));
    for (const f of frames) expect(f.jsonrpc).toBe('2.0');
    expect(frames.map((f) => f.id).sort()).toEqual([1, 2, 3, 4]);
    expect(frames.find((f) => f.id === 2).result.tools.map((t: { name: string }) => t.name)).toEqual(OPERATIONS.map((o) => o.name));
    expect(frames.find((f) => f.id === 4).error).toBeDefined(); // unknown tool: protocol error
    expect(err).toContain('MCP server on stdio');
    expect(err).not.toContain('jsonrpc');
  }, 30_000);
});

interface Spawned {
  child: ChildProcessWithoutNullStreams;
  doc: { listening: { url: string; port: number; auth: boolean; mcp: boolean; api: boolean } };
  err(): string;
  stop(): Promise<number | null>;
}

async function spawnListening(args: string[], env: Record<string, string> = {}): Promise<Spawned> {
  const child = spawn(process.execPath, [bin, ...args, '--port', '0', '--json', ...baseArgs()], { env: cleanEnv(env), cwd: work });
  let out = '';
  let err = '';
  child.stderr.on('data', (d: Buffer) => void (err += d.toString('utf8')));
  const exited = new Promise<number | null>((r) => child.on('close', (c) => r(c)));
  const doc = await new Promise<Spawned['doc']>((resolveDoc, reject) => {
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString('utf8');
      const line = out.split('\n')[0];
      if (out.includes('\n') && line !== undefined) resolveDoc(JSON.parse(line));
    });
    child.on('close', () => reject(new Error(`exited before listening: ${err}`)));
  });
  return { child, doc, err: () => err, stop: () => (child.kill('SIGTERM'), exited) };
}

describe('system: HTTP server (spawned binary)', () => {
  it('serve: listens on loopback, answers with the token, 401 without, stops on SIGTERM with exit 0, token never printed', async () => {
    const s = await spawnListening(['serve', '--token-env', 'GW_TOKEN'], { GW_TOKEN: TOKEN });
    try {
      expect(s.doc.listening).toMatchObject({ auth: true, api: true, mcp: false });
      const url = s.doc.listening.url;
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect((await fetch(`${url}/api/personas`)).status).toBe(401);
      const ok = await fetch(`${url}/api/personas`, { headers: { Authorization: `Bearer ${TOKEN}` } });
      expect(ok.status).toBe(200);
      const spec = (await (await fetch(`${url}/openapi.json`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json()) as { openapi: string; paths: object };
      expect(spec.openapi).toBe('3.1.0');
      expect(Object.keys(spec.paths)).toContain('/api/generate');
      expect((await fetch(`${url}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(404);
    } finally {
      expect(await s.stop()).toBe(0);
    }
    expect(s.err()).not.toContain(TOKEN);
  }, 30_000);

  it('serve --mcp + mcp --http: the SDK streamable HTTP client lists and calls every tool; a token is required', async () => {
    const s = await spawnListening(['serve', '--mcp', '--token-env', 'GW_TOKEN'], { GW_TOKEN: TOKEN });
    try {
      const url = new URL(`${s.doc.listening.url}/mcp`);
      expect(s.doc.listening.mcp).toBe(true);
      const anon = new Client({ name: 'anon', version: '1' });
      await expect(anon.connect(new StreamableHTTPClientTransport(url))).rejects.toThrow();
      const client = new Client({ name: 'system-test', version: '1' });
      await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
      try {
        await exerciseAllTools(client);
      } finally {
        await client.close();
      }
    } finally {
      await s.stop();
    }
    const m = await spawnListening(['mcp', '--http']);
    try {
      expect(m.doc.listening).toMatchObject({ api: false, mcp: true });
      expect((await fetch(`${m.doc.listening.url}/api/personas`)).status).toBe(404); // MCP only: no REST routes
      const client = new Client({ name: 'system-test', version: '1' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${m.doc.listening.url}/mcp`)));
      try {
        expect((await client.listTools()).tools.map((t) => t.name)).toEqual(OPERATIONS.map((o) => o.name));
      } finally {
        await client.close();
      }
    } finally {
      expect(await m.stop()).toBe(0);
    }
  }, 60_000);

  it('serve refuses a wildcard bind without a token: exit 2, nothing listening', async () => {
    const r = spawnSync(process.execPath, [bin, 'serve', '--host', '0.0.0.0', '--port', '0', '--json', ...baseArgs()], { env: cleanEnv(), encoding: 'utf8', timeout: 20_000 });
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout).error.code).toBe('CONFIG_INVALID');
  });
});
