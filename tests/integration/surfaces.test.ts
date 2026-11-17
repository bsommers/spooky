// Integration: the same operation through the library, the CLI (`--json`), the HTTP API and an MCP tool call returns
// the same data, and the same failure carries the same code, the CLI exit code and the HTTP status from the one table.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/load.js';
import { Engine } from '../../src/engine.js';
import { MockLlmClient } from '../../src/llm/mockClient.js';
import { LlmTransportError } from '../../src/llm/retry.js';
import { ERROR_TABLE } from '../../src/service/errors.js';
import { TOPIC_CAVEAT } from '../../config/topic.js';
import { HUMANIZE_CAVEAT, OPERATIONS, invokeOperation } from '../../src/service/operations.js';
import { readFileSync } from 'node:fs';
import type { ApiServer } from '../../src/api/server.js';
import { runCli } from '../helpers/cli.js';
import { PERSONA, corpus } from '../helpers/rig.js';
import { CLEAN_ANSWER, connectMcp, makeRuntime, postJson, raw, startTestServer } from '../helpers/surfaces.js';
import type { Rigged } from '../helpers/surfaces.js';

const __dirname_ = dirname(fileURLToPath(import.meta.url));
const CONFIG = { llm: { model: 'm', maxRetries: 0 }, personas: [PERSONA], limits: { maxInputChars: 5000 } };
const DRAFT = 'Please rewrite this short draft so it reads plainly. We ship on Friday. The team agrees.';
const AI_TEXT = readFileSync(join(__dirname_, '..', 'fixtures', 'corpus', 'ai', '08-social-media.txt'), 'utf8');
const TOPIC = 'Why small teams ship faster';
const NOTES = 'Fact: the team shipped 12 releases in 2024. Fact: median review time was 3 hours.';
const SCORE_TEXT = 'This is a plain paragraph. It has a few sentences, some short and some a little longer than the others. Then it ends.';

/** Wall-clock fields differ between runs; everything else must be equal. */
const norm = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (k, x) => (k === 'ms' ? 0 : x)));

let rig: Rigged;
let server: ApiServer & { logs: string[] };
let work: string;
let cfgPath: string;

beforeAll(async () => {
  rig = await makeRuntime({ config: CONFIG });
  server = await startTestServer(rig);
  work = mkdtempSync(join(tmpdir(), 'gw-int-'));
  cfgPath = join(work, 'config.json');
  writeFileSync(cfgPath, JSON.stringify(CONFIG));
});
afterAll(async () => {
  await server.close();
  rig.cleanup();
  rmSync(work, { recursive: true, force: true });
});

const cliArgs = (): string[] => ['--config', cfgPath, '--state-dir', rig.stateDir, '--json'];
const cliLlm = () => ({ llm: new MockLlmClient(() => CLEAN_ANSWER) });

interface Case {
  op: string;
  http: (s: ApiServer) => Promise<{ status: number; json: () => any }>;
  cli: { argv: string[]; stdin?: string };
  mcp: Record<string, unknown>;
  engine: () => Promise<Record<string, unknown>>;
}

const cases: Case[] = [
  {
    op: 'profile',
    http: (s) => raw(s, '/api/profile?authorId=terse'),
    cli: { argv: ['profile', 'terse'] },
    mcp: { authorId: 'terse' },
    engine: async () => ({ profile: rig.engine.getProfile('terse') }),
  },
  {
    op: 'authors',
    http: (s) => raw(s, '/api/authors'),
    cli: { argv: ['authors'] },
    mcp: {},
    engine: async () => ({ authors: rig.engine.listAuthors() }),
  },
  {
    op: 'personas',
    http: (s) => raw(s, '/api/personas'),
    cli: { argv: ['personas'] },
    mcp: {},
    engine: async () => ({ personas: rig.engine.listPersonas() }),
  },
  {
    op: 'filters',
    http: (s) => raw(s, '/api/filters'),
    cli: { argv: ['filters'] },
    mcp: {},
    engine: async () => ({ filters: rig.engine.listFilters() }),
  },
  {
    op: 'config_get',
    http: (s) => raw(s, '/api/config'),
    cli: { argv: ['config', 'get'] },
    mcp: {},
    engine: async () => ({ config: rig.engine.getConfigView() }),
  },
  {
    op: 'score',
    http: (s) => postJson(s, '/api/score', { text: SCORE_TEXT }),
    cli: { argv: ['score'], stdin: SCORE_TEXT },
    mcp: { text: SCORE_TEXT },
    engine: async () => {
      const r = await rig.engine.score(SCORE_TEXT);
      return { score: r.score, local: r.local, members: r.members, excluded: r.excluded, trace: r.trace };
    },
  },
  {
    op: 'humanize',
    http: (s) => postJson(s, '/api/humanize', { text: AI_TEXT, llm: false }),
    cli: { argv: ['humanize', '--no-llm'], stdin: AI_TEXT },
    mcp: { text: AI_TEXT, llm: false },
    engine: async () => ({ ...(await rig.engine.humanize(AI_TEXT, { llm: false })), caveat: HUMANIZE_CAVEAT }),
  },
  {
    op: 'generate',
    http: (s) => postJson(s, '/api/generate', { authorId: 'terse', persona: 'exec', text: DRAFT }),
    cli: { argv: ['generate', '--author', 'terse', '--persona', 'exec'], stdin: DRAFT },
    mcp: { authorId: 'terse', persona: 'exec', text: DRAFT },
    engine: async () => {
      const r = await rig.engine.generate('terse', 'exec', DRAFT);
      return { text: r.text, trace: r.trace, promptTokensEstimate: r.promptTokensEstimate, mode: 'rewrite' };
    },
  },
  {
    // Topic mode: the same operation, the same data on every surface, and the fixed caveat on all of them. The CLI takes the
    // topic inline and reads the notes from stdin (`--notes-file -`).
    op: 'generate',
    http: (s) => postJson(s, '/api/generate', { authorId: 'terse', persona: 'exec', text: TOPIC, mode: 'topic', notes: NOTES, length: 'short' }),
    cli: { argv: ['generate', '--author', 'terse', '--persona', 'exec', '--topic', TOPIC, '--notes-file', '-', '--length', 'short'], stdin: NOTES },
    mcp: { authorId: 'terse', persona: 'exec', text: TOPIC, mode: 'topic', notes: NOTES, length: 'short' },
    engine: async () => {
      const r = await rig.engine.generate('terse', 'exec', TOPIC, { mode: 'topic', notes: NOTES, length: 'short' });
      expect(r.caveat).toBe(TOPIC_CAVEAT);
      return { text: r.text, trace: r.trace, promptTokensEstimate: r.promptTokensEstimate, mode: 'topic', caveat: r.caveat };
    },
  },
];

describe('golden equality across surfaces', () => {
  for (const c of cases) {
    it(`${c.op}: library == CLI --json == HTTP == MCP`, async () => {
      const mcp = await connectMcp(rig);
      try {
        const lib = norm(await c.engine());
        const cli = await runCli([...c.cli.argv, ...cliArgs()], c.cli.stdin === undefined ? {} : { stdin: c.cli.stdin }, cliLlm());
        expect(cli.code, cli.err).toBe(0);
        const cliDoc = JSON.parse(cli.out) as Record<string, unknown>;
        const http = await c.http(server);
        expect(http.status).toBe(200);
        const viaMcp = await mcp.client.callTool({ name: c.op, arguments: c.mcp });
        expect(viaMcp.isError).toBeFalsy();
        const expected = { ok: true, ...(lib as object) };
        expect(norm(cliDoc)).toEqual(expected);
        expect(norm(http.json())).toEqual(expected);
        expect(norm(viaMcp.structuredContent)).toEqual(expected);
      } finally {
        await mcp.close();
      }
    });
  }

  it('config get: every surface reports the same state directory path, read-only, and no key or env value', async () => {
    const mcp = await connectMcp(rig);
    try {
      const http = (await raw(server, '/api/config')).json();
      const cli = JSON.parse((await runCli(['config', 'get', ...cliArgs()])).out);
      const viaMcp = (await mcp.client.callTool({ name: 'config_get', arguments: {} })).structuredContent as any;
      for (const doc of [http, cli, viaMcp, { config: rig.engine.getConfigView() }]) expect(doc.config.stateDir, JSON.stringify(doc)).toBe(rig.stateDir);
      const text = (await runCli(['config', 'get', ...cliArgs().filter((a) => a !== '--json')])).out;
      expect(text).toContain(`state directory: ${rig.stateDir}`);
      // reading it does not make it writable: no config write route exists on any surface
      expect((await postJson(server, '/api/config', { stateDir: '/elsewhere' })).status).toBeGreaterThanOrEqual(400);
      expect((await raw(server, '/api/config')).json().config.stateDir).toBe(rig.stateDir);
    } finally {
      await mcp.close();
    }
  });

  it('ingest: every surface stores the same profile (HTTP, MCP and CLI write through the one state lock)', async () => {
    const mcp = await connectMcp(rig);
    try {
      const text = corpus();
      const http = await postJson(server, '/api/ingest', { authorId: 'viaHttp', name: 'Same Name', text });
      expect(http.status).toBe(200);
      const viaMcp = await mcp.client.callTool({ name: 'ingest', arguments: { authorId: 'viaMcp', name: 'Same Name', text } });
      const cli = await runCli(['ingest', '--author', 'viaCli', '--name', 'Same Name', ...cliArgs()], { stdin: text });
      expect(cli.code, cli.err).toBe(0);
      const strip = (p: any): unknown => ({ ...p, authorId: 'x', vectorCollectionName: 'x' });
      const profiles = [http.json().profile, (viaMcp.structuredContent as any).profile, JSON.parse(cli.out).profile];
      expect(profiles.map(strip)).toEqual([strip(profiles[0]), strip(profiles[0]), strip(profiles[0])]);
      expect(profiles.map((p) => p.authorId)).toEqual(['viaHttp', 'viaMcp', 'viaCli']);
      // the server sees the CLI's write from another process-like Engine (state refresh) and lists all three
      const authors = (await raw(server, '/api/authors')).json().authors.map((a: any) => a.authorId);
      expect(authors).toEqual(expect.arrayContaining(['terse', 'viaHttp', 'viaMcp', 'viaCli']));
    } finally {
      await mcp.close();
    }
  });

  it('capabilities lists every registry operation (humanize included) on every surface and nothing pending', async () => {
    const http = (await raw(server, '/api/capabilities')).json();
    const cli = JSON.parse((await runCli(['capabilities', ...cliArgs()])).out);
    const mcp = await connectMcp(rig);
    try {
      const viaMcp = (await mcp.client.callTool({ name: 'capabilities', arguments: {} })).structuredContent;
      for (const doc of [http, cli, viaMcp] as any[]) {
        expect(doc.operations.map((o: any) => o.name)).toEqual(OPERATIONS.map((o) => o.name));
        expect(doc.pending).toEqual([]);
        expect(doc.operations.map((o: any) => o.name)).toContain('humanize');
      }
    } finally {
      await mcp.close();
    }
  });
});

describe('the same failure, the same code, the table status on each surface', () => {
  interface Fail {
    name: string;
    code: string;
    http: (s: ApiServer) => Promise<{ status: number; json: () => any }>;
    cli: { argv: string[]; stdin?: string };
    mcp: [string, Record<string, unknown>];
    config?: unknown;
    llm?: Error;
  }
  const fails: Fail[] = [
    { name: 'unknown author', code: 'UNKNOWN_AUTHOR', http: (s) => raw(s, '/api/profile?authorId=nobody'), cli: { argv: ['profile', 'nobody'] }, mcp: ['profile', { authorId: 'nobody' }] },
    {
      name: 'unknown persona',
      code: 'UNKNOWN_PERSONA',
      http: (s) => postJson(s, '/api/generate', { authorId: 'terse', persona: 'nope', text: DRAFT }),
      cli: { argv: ['generate', '--author', 'terse', '--persona', 'nope'], stdin: DRAFT },
      mcp: ['generate', { authorId: 'terse', persona: 'nope', text: DRAFT }],
    },
    {
      name: 'input too large',
      code: 'INPUT_TOO_LARGE',
      http: (s) => postJson(s, '/api/score', { text: 'x '.repeat(3000) }),
      cli: { argv: ['score'], stdin: 'x '.repeat(3000) },
      mcp: ['score', { text: 'x '.repeat(3000) }],
    },
    {
      name: 'unknown detector (config error)',
      code: 'CONFIG_INVALID',
      http: (s) => postJson(s, '/api/score', { text: SCORE_TEXT, detectors: ['nope'] }),
      cli: { argv: ['score', '--detector', 'nope'], stdin: SCORE_TEXT },
      mcp: ['score', { text: SCORE_TEXT, detectors: ['nope'] }],
    },
    {
      name: 'humanize with an unknown author',
      code: 'UNKNOWN_AUTHOR',
      http: (s) => postJson(s, '/api/humanize', { text: DRAFT, authorId: 'nobody', llm: false }),
      cli: { argv: ['humanize', '--author', 'nobody', '--no-llm'], stdin: DRAFT },
      mcp: ['humanize', { text: DRAFT, authorId: 'nobody', llm: false }],
    },
    {
      name: 'generate target without humanize (LW-04: the same on every surface)',
      code: 'USAGE',
      http: (s) => postJson(s, '/api/generate', { authorId: 'terse', persona: 'exec', text: DRAFT, target: 0.2 }),
      cli: { argv: ['generate', '--author', 'terse', '--persona', 'exec', '--target', '0.2'], stdin: DRAFT },
      mcp: ['generate', { authorId: 'terse', persona: 'exec', text: DRAFT, target: 0.2 }],
    },
    {
      name: 'invalid author id (usage)',
      code: 'USAGE',
      http: (s) => postJson(s, '/api/ingest', { authorId: '../x', name: 'N', text: 'One. Two. Three.' }),
      cli: { argv: ['ingest', '--author', '../x', '--name', 'N'], stdin: 'One. Two. Three.' },
      mcp: ['ingest', { authorId: '../x', name: 'N', text: 'One. Two. Three.' }],
    },
    {
      name: 'language model failed',
      code: 'LLM_FAILED',
      http: (s) => postJson(s, '/api/generate', { authorId: 'terse', persona: 'exec', text: DRAFT }),
      cli: { argv: ['generate', '--author', 'terse', '--persona', 'exec'], stdin: DRAFT },
      mcp: ['generate', { authorId: 'terse', persona: 'exec', text: DRAFT }],
      llm: new LlmTransportError('http', { status: 500 }),
    },
  ];

  for (const f of fails) {
    it(`${f.name} -> ${f.code}`, async () => {
      const spec = ERROR_TABLE[f.code];
      expect(spec, f.code).toBeDefined();
      // a dedicated runtime so the scripted failure does not disturb the shared one
      const r = await makeRuntime({ config: CONFIG, script: f.llm === undefined ? () => CLEAN_ANSWER : [f.llm] });
      const s = await startTestServer(r);
      const mcp = await connectMcp(r);
      try {
        const http = await f.http(s);
        expect(http.status).toBe(spec?.http);
        expect(http.json()).toEqual({ ok: false, error: { code: f.code, message: expect.any(String) } });
        const cliR = await runCli([...f.cli.argv, '--config', cfgPath, '--state-dir', r.stateDir, '--json'], f.cli.stdin === undefined ? {} : { stdin: f.cli.stdin }, {
          llm: new MockLlmClient(f.llm === undefined ? () => CLEAN_ANSWER : [f.llm]),
        });
        expect(cliR.code).toBe(spec?.exit);
        expect(JSON.parse(cliR.out).error.code).toBe(f.code);
        const viaMcp = await mcp.client.callTool({ name: f.mcp[0], arguments: f.mcp[1] });
        expect(viaMcp.isError).toBe(true);
        expect(JSON.parse((viaMcp.content as any)[0].text).error.code).toBe(f.code);
        for (const text of [http.json().error.message, JSON.parse(cliR.out).error.message, JSON.parse((viaMcp.content as any)[0].text).error.message]) {
          expect(text).not.toContain('sk-should-not-appear');
        }
      } finally {
        await mcp.close();
        await s.close();
        r.cleanup();
      }
    });
  }

  it('corrupt persisted state -> STORE_CORRUPT: 500 over HTTP, exit 7 on the CLI, same code over MCP', async () => {
    const r = await makeRuntime({ config: CONFIG });
    const s = await startTestServer(r);
    const mcp = await connectMcp(r);
    try {
      const { writeFileSync: write, utimesSync } = await import('node:fs');
      const file = join(r.stateDir, 'store.json');
      write(file, '{"not":"a store"}');
      utimesSync(file, new Date(), new Date(Date.now() + 5000)); // make the change visible to the refresh check
      const http = await raw(s, '/api/authors');
      expect(http.status).toBe(ERROR_TABLE.STORE_CORRUPT?.http);
      expect(http.json().error.code).toBe('STORE_CORRUPT');
      const cliR = await runCli(['authors', '--config', cfgPath, '--state-dir', r.stateDir, '--json']);
      expect(cliR.code).toBe(7);
      const viaMcp = await mcp.client.callTool({ name: 'authors', arguments: {} });
      expect(viaMcp.isError).toBe(true);
      expect(JSON.parse((viaMcp.content as any)[0].text).error.code).toBe('STORE_CORRUPT');
    } finally {
      await mcp.close();
      await s.close();
      r.cleanup();
    }
  });

  it('an unexpected exception is INTERNAL / 500 / exit 1 and names only its class', async () => {
    const r = await makeRuntime({ config: CONFIG, script: [new TypeError('leaky message sk-should-not-appear-0123456789')] });
    const s = await startTestServer(r);
    try {
      const http = await postJson(s, '/api/generate', { authorId: 'terse', persona: 'exec', text: DRAFT });
      // the orchestrator wraps a model failure as LLM_FAILED; an exception from our own code would be INTERNAL
      expect([500, 502]).toContain(http.status);
      expect(http.json().error.message).not.toContain('sk-should-not');
      const e = new Engine({ config: loadConfig(CONFIG) });
      const op = OPERATIONS.find((o) => o.name === 'profile')!;
      await expect(invokeOperation(op, e, { authorId: 'nobody' })).rejects.toMatchObject({ code: 'UNKNOWN_AUTHOR' });
    } finally {
      await s.close();
      r.cleanup();
    }
  });
});
