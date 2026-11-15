// Uniform surfaces (Phase 9): for EVERY operation in the registry there must be an Engine method, a CLI command with
// its flags, an HTTP route, an MCP tool and an OpenAPI path; and no surface may offer a capability the registry lacks.
// A capability that is planned but not built (humanize, Phase 8) is enumerated as PENDING: it must have no adapter
// anywhere yet, and the test fails the moment the Engine gains it without a registry entry.
//
// The descriptors are OBSERVED, not read back from the code under test: the HTTP routes and accepted input fields are
// probed on a live server (a 404/405 is "no such route", "unknown field" is "not accepted"), the MCP tools and their
// input schemas come from a real MCP client over HTTP, the CLI from the real commander program, and the OpenAPI paths
// from the document the server serves. Only the registry is the reference they are compared against. The comparison is
// a pure function over the descriptors, so the test also proves it works: it deletes one adapter entry at a time from a
// copy (and adds a rogue one), and it starts a second live server whose registry gained an input field no CLI flag
// exists for, and requires the check to notice.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildProgram } from '../../src/cli/main.js';
import { Engine } from '../../src/engine.js';
import { PENDING_CAPABILITIES, OPERATIONS, cliLine, operation } from '../../src/service/operations.js';
import type { AnyOperation, PendingCapability } from '../../src/service/operations.js';
import type { ApiServer } from '../../src/api/server.js';
import { makeRuntime, raw, startTestServer } from '../helpers/surfaces.js';
import type { Rigged } from '../helpers/surfaces.js';

interface FieldSets {
  mcp: Set<string>;
  openapi: Set<string>;
  http: Set<string>;
}

interface Surfaces {
  engineMethods: Set<string>;
  /** `config get` -> { flags, arguments } */
  cli: Map<string, { flags: Set<string>; args: Set<string> }>;
  http: Set<string>; // `GET /api/profile`
  mcp: Set<string>;
  openapi: Set<string>; // `/api/profile`
  /** Input field names per operation, as each surface reports or accepts them. */
  fields: Map<string, FieldSets>;
}

/**
 * Flags that exist on the command line only, on purpose, each with its reason. Anything else on a command that is not an
 * input field fails the check ("CLI flag X has no input field").
 */
const CLI_ONLY_FLAGS: Record<string, Record<string, string>> = {
  // They override the LLM endpoint for ONE process. A running service takes its model and endpoint from its own config
  // file; letting a remote caller redirect it (and the API key) to another host would be a hole, not a feature.
  generate: { '--model': 'config override', '--provider': 'config override', '--base-url': 'config override', '--api-key-env': 'config override' },
};

/**
 * How each input field is reachable from the command line: a flag (`--author`) or a positional argument (`<id>`).
 * Explicit on purpose: adding an input field to an operation fails the parity test until the field is added here AND
 * the command gets the flag. (`text` is read from `--file`, or from stdin when no file is given.)
 */
const CLI_FIELDS: Record<string, Record<string, string>> = {
  ingest: { authorId: '--author', name: '--name', text: '--file' },
  generate: { authorId: '--author', persona: '--persona', text: '--file', exemplars: '--exemplars', maxTokens: '--max-tokens', temperature: '--temperature' },
  score: { text: '--file', detectors: '--detector' },
  profile: { authorId: '<id>' },
};

const TRANSPORT_COMMANDS = new Set(['serve', 'mcp']); // they host the capabilities; they are not capabilities
const COMMON_FLAGS = new Set(['--config', '--state-dir', '--json']);
const here = dirname(fileURLToPath(import.meta.url));

function walk(commands: readonly Command[], prefix: string[], out: Surfaces['cli']): void {
  for (const c of commands) {
    const path = [...prefix, c.name()];
    if (c.commands.length > 0) walk(c.commands, path, out);
    else out.set(path.join(' '), { flags: new Set(c.options.map((o) => o.long ?? '')), args: new Set(c.registeredArguments.map((a) => a.name())) });
  }
}

/** Input-field disagreements for one operation: every surface vs the registry's schema, and every field vs the CLI. */
function fieldGaps(op: AnyOperation, s: Surfaces, cli: { flags: Set<string>; args: Set<string> } | undefined): string[] {
  const out: string[] = [];
  const want = new Set(Object.keys(op.input.shape));
  const seen = s.fields.get(op.name);
  const everywhere = new Set(want);
  if (seen !== undefined) {
    for (const [surface, got] of Object.entries(seen) as [string, Set<string>][]) {
      for (const f of got) {
        everywhere.add(f);
        if (!want.has(f)) out.push(`${op.name}: ${surface} takes input field ${f}, which the registry does not declare`);
      }
      for (const f of want) if (!got.has(f)) out.push(`${op.name}: ${surface} lacks input field ${f}`);
    }
  }
  const mapping = CLI_FIELDS[op.name] ?? {};
  const mappedFlags = new Set(Object.values(mapping).filter((t) => !t.startsWith('<')));
  for (const f of everywhere) {
    const target = mapping[f];
    if (target === undefined) {
      out.push(`${op.name}: input field ${f} has no CLI flag or argument (add the flag to the command and the field to CLI_FIELDS)`);
    } else if (cli !== undefined && !(target.startsWith('<') ? cli.args.has(target.slice(1, -1)) : cli.flags.has(target))) {
      out.push(`${op.name}: CLI command lacks ${target} for input field ${f}`);
    }
  }
  if (cli !== undefined) for (const f of cli.flags) if (!COMMON_FLAGS.has(f) && !mappedFlags.has(f) && CLI_ONLY_FLAGS[op.name]?.[f] === undefined) out.push(`${op.name}: CLI flag ${f} has no input field`);
  // the registry's own hand-written flag list may not drift from what the input fields imply
  for (const f of mappedFlags) if (!op.cli.flags.includes(f)) out.push(`${op.name}: registry cli.flags lacks ${f}`);
  for (const f of op.cli.flags) if (!mappedFlags.has(f)) out.push(`${op.name}: registry cli.flags lists ${f}, which no input field maps to`);
  return out;
}

/**
 * Every disagreement between a registry and the surfaces, as readable strings. `[]` = uniform.
 * `engineOwnMethods` are the Engine's public methods (minus `load`, which restores persisted state for every surface).
 */
function gaps(registry: readonly AnyOperation[], pending: readonly PendingCapability[], s: Surfaces): string[] {
  const out: string[] = [];
  const cliCommands = new Set(registry.map((o) => o.cli.command.join(' ')));
  for (const op of registry) {
    if (op.engineMethod !== null && !s.engineMethods.has(op.engineMethod)) out.push(`${op.name}: Engine has no method ${op.engineMethod}`);
    const cli = s.cli.get(op.cli.command.join(' '));
    if (cli === undefined) out.push(`${op.name}: no CLI command \`${cliLine(op)}\``);
    else {
      for (const f of [...op.cli.flags, ...COMMON_FLAGS]) if (!cli.flags.has(f)) out.push(`${op.name}: CLI command lacks ${f}`);
      for (const a of op.cli.arguments) if (!cli.args.has(a.name)) out.push(`${op.name}: CLI command lacks argument <${a.name}>`);
    }
    out.push(...fieldGaps(op, s, cli));
    if (!s.http.has(`${op.http.method} ${op.http.path}`)) out.push(`${op.name}: no HTTP route ${op.http.method} ${op.http.path}`);
    if (!s.mcp.has(op.name)) out.push(`${op.name}: no MCP tool`);
    if (!s.openapi.has(op.http.path)) out.push(`${op.name}: no OpenAPI path ${op.http.path}`);
  }
  // reverse: nothing on a surface that the registry does not declare
  const engineAllowed = new Set([...registry.map((o) => o.engineMethod).filter((m): m is string => m !== null), 'load']);
  for (const m of s.engineMethods) if (!engineAllowed.has(m)) out.push(`Engine method ${m} has no registry operation`);
  for (const c of s.cli.keys()) if (!cliCommands.has(c)) out.push(`CLI command \`${c}\` has no registry operation`);
  const routes = new Set(registry.map((o) => `${o.http.method} ${o.http.path}`));
  for (const r of s.http) if (!routes.has(r)) out.push(`HTTP route ${r} has no registry operation`);
  const names = new Set(registry.map((o) => o.name as string));
  for (const t of s.mcp) if (!names.has(t)) out.push(`MCP tool ${t} has no registry operation`);
  const paths = new Set(registry.map((o) => o.http.path));
  for (const p of s.openapi) if (!paths.has(p)) out.push(`OpenAPI path ${p} has no registry operation`);
  // pending capabilities: no adapter anywhere yet
  for (const p of pending) {
    if (names.has(p.name)) out.push(`${p.name}: pending capability is already registered; remove it from PENDING_CAPABILITIES`);
    if (s.engineMethods.has(p.engineMethod)) out.push(`${p.name}: the Engine now has ${p.engineMethod}(); add a registry operation (the CLI, HTTP, MCP and OpenAPI adapters follow from it)`);
    if (s.cli.has(p.name)) out.push(`${p.name}: pending capability already has a CLI command`);
    if ([...s.http].some((r) => r.endsWith(`/${p.name}`))) out.push(`${p.name}: pending capability already has an HTTP route`);
    if (s.mcp.has(p.name)) out.push(`${p.name}: pending capability already has an MCP tool`);
  }
  return out;
}

let rig: Rigged;
let server: ApiServer & { logs: string[] };
let real: Surfaces;
let program: Command;

const camel = (flag: string): string => flag.replace(/^--/, '').replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
const DECOYS = ['purge', 'export', 'remove', 'delete', 'humanize', 'admin', 'shell', 'exec'];

/** Does the server answer on this path/method? (404 = no such route; 405 = the path exists, the method does not.) */
async function probeRoute(srv: Pick<ApiServer, 'host' | 'port'>, name: string): Promise<string[]> {
  const found: string[] = [];
  const path = `/api/${name}`;
  const get = await raw(srv, path);
  if (get.status !== 404 && get.status !== 405) found.push(`GET ${path}`);
  const post = await raw(srv, path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  if (post.status !== 404 && post.status !== 405) found.push(`POST ${path}`);
  return found;
}

/** The input field names the live HTTP route accepts, found by offering each candidate once (strict schema: unknown = refused by name). */
async function probeFields(srv: Pick<ApiServer, 'host' | 'port'>, method: 'GET' | 'POST', path: string, candidates: Iterable<string>): Promise<Set<string>> {
  const accepted = new Set<string>();
  for (const c of new Set(candidates)) {
    const r =
      method === 'GET'
        ? await raw(srv, `${path}?${encodeURIComponent(c)}=1`)
        : await raw(srv, path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [c]: 1 }) });
    const message = r.status === 400 ? String(r.json().error?.message ?? '') : '';
    if (!/unknown field/.test(message)) accepted.add(c);
  }
  return accepted;
}

/** Observe every surface of a running server (and the real CLI program); nothing is read from the registry except to know what to ask about. */
async function observe(srv: ApiServer, cli: Surfaces['cli'], registry: readonly AnyOperation[]): Promise<Surfaces> {
  // OpenAPI: the document the server serves
  const doc = (await raw(srv, '/openapi.json')).json() as { paths: Record<string, Record<string, any>> };
  const openapiPaths = new Set(Object.keys(doc.paths).filter((p) => p.startsWith('/api/')));
  const openapiFields = (path: string): Set<string> => {
    const item = Object.values(doc.paths[path] ?? {})[0];
    if (item === undefined) return new Set();
    if (Array.isArray(item.parameters)) return new Set((item.parameters as { name: string }[]).map((p) => p.name));
    return new Set(Object.keys(item.requestBody?.content?.['application/json']?.schema?.properties ?? {}));
  };

  // MCP: a real client over streamable HTTP
  const client = new Client({ name: 'parity', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${srv.url}/mcp`)));
  const tools = (await client.listTools()).tools;
  await client.close();
  const mcpFields = (name: string): Set<string> => new Set(Object.keys((tools.find((t) => t.name === name)?.inputSchema.properties ?? {}) as object));

  // HTTP: probe every name any other surface suggests, plus the registry's own routes and decoys
  const names = new Set<string>([...DECOYS, ...PENDING_CAPABILITIES.map((p) => p.name)]);
  for (const key of cli.keys()) for (const w of key.split(' ')) names.add(w);
  for (const m of Object.getOwnPropertyNames(Engine.prototype)) names.add(m.toLowerCase());
  for (const p of openapiPaths) names.add(p.slice('/api/'.length));
  for (const t of tools) names.add(t.name);
  for (const op of registry) names.add(op.http.path.slice('/api/'.length));
  const http = new Set<string>();
  for (const n of names) for (const r of await probeRoute(srv, n)) http.add(r);

  const fields = new Map<string, FieldSets>();
  for (const op of registry) {
    const c = cli.get(op.cli.command.join(' '));
    const candidates = new Set<string>([...Object.keys(op.input.shape), ...mcpFields(op.name), ...openapiFields(op.http.path), ...Object.keys(CLI_FIELDS[op.name] ?? {}), ...[...(c?.flags ?? [])].map(camel)]);
    fields.set(op.name, { mcp: mcpFields(op.name), openapi: openapiFields(op.http.path), http: await probeFields(srv, op.http.method, op.http.path, candidates) });
  }

  return {
    engineMethods: new Set(Object.getOwnPropertyNames(Engine.prototype).filter((m) => m !== 'constructor')),
    cli,
    http,
    mcp: new Set(tools.map((t) => t.name)),
    openapi: openapiPaths,
    fields,
  };
}

function realCli(): Surfaces['cli'] {
  program = buildProgram({ stdout: () => undefined, stderr: () => undefined, stdin: (async function* () {})(), stdinIsTTY: false, env: {} });
  const cli: Surfaces['cli'] = new Map();
  walk(program.commands.filter((c) => !TRANSPORT_COMMANDS.has(c.name())), [], cli);
  return cli;
}

beforeAll(async () => {
  rig = await makeRuntime();
  server = await startTestServer(rig, { mcp: true });
  real = await observe(server, realCli(), OPERATIONS);
});
afterAll(async () => {
  await server.close();
  rig.cleanup();
});

describe('surface parity over the operations registry', () => {
  it('the real surfaces agree with the registry (no operation missing anywhere, nothing extra anywhere)', () => {
    expect(gaps(OPERATIONS, PENDING_CAPABILITIES, real)).toEqual([]);
  });

  it('every registry operation is present on all five surfaces (explicit, per operation)', () => {
    expect(OPERATIONS.length).toBeGreaterThanOrEqual(9);
    for (const op of OPERATIONS) {
      if (op.engineMethod !== null) expect(typeof (Engine.prototype as unknown as Record<string, unknown>)[op.engineMethod], `${op.name} Engine`).toBe('function');
      expect(real.cli.has(op.cli.command.join(' ')), `${op.name} CLI`).toBe(true);
      expect(real.http.has(`${op.http.method} ${op.http.path}`), `${op.name} HTTP`).toBe(true);
      expect(real.mcp.has(op.name), `${op.name} MCP`).toBe(true);
      expect(real.openapi.has(op.http.path), `${op.name} OpenAPI`).toBe(true);
    }
  });

  it('humanize is enumerated as a pending capability with no adapter on any surface (not faked)', () => {
    expect(PENDING_CAPABILITIES).toEqual([expect.objectContaining({ name: 'humanize', phase: 8, engineMethod: 'humanize' })]);
    expect(real.engineMethods.has('humanize')).toBe(false);
    expect(real.cli.has('humanize')).toBe(false);
    expect(real.mcp.has('humanize')).toBe(false);
    expect([...real.http].some((r) => r.includes('humanize'))).toBe(false);
    expect(OPERATIONS.some((o) => o.name === ('humanize' as string))).toBe(false);
  });

  it('a pending capability that gains an adapter or an Engine method without a registry entry FAILS the check', () => {
    const [p] = PENDING_CAPABILITIES as [PendingCapability];
    const withEngine = { ...real, engineMethods: new Set([...real.engineMethods, p.engineMethod]) };
    expect(gaps(OPERATIONS, PENDING_CAPABILITIES, withEngine).join('\n')).toContain('add a registry operation');
    const withTool = { ...real, mcp: new Set([...real.mcp, p.name]) };
    expect(gaps(OPERATIONS, PENDING_CAPABILITIES, withTool).join('\n')).toContain('humanize');
    const withCli = { ...real, cli: new Map([...real.cli, [p.name, { flags: new Set<string>(), args: new Set<string>() }]]) };
    expect(gaps(OPERATIONS, PENDING_CAPABILITIES, withCli).join('\n')).toContain('humanize');
  });

  describe('mutation check: deleting any one adapter entry makes the check fail', () => {
    for (const op of OPERATIONS) {
      it(`${op.name}: removed from the Engine, the CLI, HTTP, MCP or OpenAPI -> reported`, () => {
        const cases: [string, Surfaces][] = [
          ['http', { ...real, http: new Set([...real.http].filter((r) => r !== `${op.http.method} ${op.http.path}`)) }],
          ['mcp', { ...real, mcp: new Set([...real.mcp].filter((t) => t !== op.name)) }],
          ['openapi', { ...real, openapi: new Set([...real.openapi].filter((p) => p !== op.http.path)) }],
          ['cli', { ...real, cli: new Map([...real.cli].filter(([k]) => k !== op.cli.command.join(' '))) }],
        ];
        if (op.engineMethod !== null) cases.push(['engine', { ...real, engineMethods: new Set([...real.engineMethods].filter((m) => m !== op.engineMethod)) }]);
        for (const [adapter, mutated] of cases) {
          const found = gaps(OPERATIONS, PENDING_CAPABILITIES, mutated);
          expect(found.length, `${op.name} without ${adapter}`).toBeGreaterThan(0);
          expect(found.some((g) => g.startsWith(`${op.name}:`)), `${op.name} without ${adapter}: ${found.join(' | ')}`).toBe(true);
        }
      });
    }

    it('a CLI command missing one of its declared flags or arguments is reported', () => {
      const gen = real.cli.get('generate');
      const profile = real.cli.get('profile');
      expect(gen && profile).toBeTruthy();
      const noFlag = new Map(real.cli);
      noFlag.set('generate', { flags: new Set([...(gen as { flags: Set<string> }).flags].filter((f) => f !== '--persona')), args: (gen as { args: Set<string> }).args });
      expect(gaps(OPERATIONS, PENDING_CAPABILITIES, { ...real, cli: noFlag }).join('\n')).toContain('generate: CLI command lacks --persona');
      const noArg = new Map(real.cli);
      noArg.set('profile', { flags: (profile as { flags: Set<string> }).flags, args: new Set() });
      expect(gaps(OPERATIONS, PENDING_CAPABILITIES, { ...real, cli: noArg }).join('\n')).toContain('profile: CLI command lacks argument <id>');
    });
  });

  describe('reverse: a capability on a surface that the registry does not declare is reported', () => {
    it('Engine method, CLI command, HTTP route, MCP tool, OpenAPI path', () => {
      const rogue: [string, Surfaces, string][] = [
        ['engine', { ...real, engineMethods: new Set([...real.engineMethods, 'exportEverything']) }, 'Engine method exportEverything'],
        ['cli', { ...real, cli: new Map([...real.cli, ['purge', { flags: new Set<string>(), args: new Set<string>() }]]) }, 'CLI command `purge`'],
        ['http', { ...real, http: new Set([...real.http, 'POST /api/purge']) }, 'HTTP route POST /api/purge'],
        ['mcp', { ...real, mcp: new Set([...real.mcp, 'purge']) }, 'MCP tool purge'],
        ['openapi', { ...real, openapi: new Set([...real.openapi, '/api/purge']) }, 'OpenAPI path /api/purge'],
      ];
      for (const [name, s, text] of rogue) expect(gaps(OPERATIONS, PENDING_CAPABILITIES, s).join('\n'), name).toContain(text);
    });

    it('a stubbed registry that gains an operation no surface has is reported on all five surfaces', () => {
      const stub = { ...OPERATIONS[0], name: 'stubbed', input: z.strictObject({}), engineMethod: 'stubbed', http: { method: 'GET' as const, path: '/api/stubbed' }, cli: { command: ['stubbed'], arguments: [], flags: [], derived: true } } as unknown as AnyOperation;
      const found = gaps([...OPERATIONS, stub], PENDING_CAPABILITIES, real).filter((g) => g.startsWith('stubbed:'));
      expect(found.length).toBe(5);
    });
  });

  describe('input fields: every field of every surface is reachable from the CLI', () => {
    it('observed on the live surfaces, each operation takes exactly the registry fields on MCP, OpenAPI and HTTP, and the CLI has a flag for each', () => {
      for (const op of OPERATIONS) {
        const f = real.fields.get(op.name);
        const want = Object.keys(op.input.shape).sort();
        expect([...(f?.mcp ?? [])].sort(), `${op.name} MCP`).toEqual(want);
        expect([...(f?.openapi ?? [])].sort(), `${op.name} OpenAPI`).toEqual(want);
        expect([...(f?.http ?? [])].sort(), `${op.name} HTTP`).toEqual(want);
      }
      expect(real.fields.get('generate')?.http.has('maxTokens')).toBe(true);
      expect(real.fields.get('generate')?.http.has('model')).toBe(false); // the endpoint cannot be redirected by a caller
    });

    it('a new input field (topK) that has no CLI flag is reported, whichever surface shows it', () => {
      for (const surface of ['mcp', 'openapi', 'http'] as const) {
        const fields = new Map(real.fields);
        const gen = real.fields.get('generate') as FieldSets;
        fields.set('generate', { ...gen, [surface]: new Set([...gen[surface], 'topK']) });
        const found = gaps(OPERATIONS, PENDING_CAPABILITIES, { ...real, fields });
        expect(found.join('\n'), surface).toContain('generate: input field topK has no CLI flag or argument');
        expect(found.join('\n'), surface).toContain(`generate: ${surface} takes input field topK, which the registry does not declare`);
      }
    });

    it('a field missing from one surface, a CLI flag with no field, and a registry flag list that drifted are reported', () => {
      const fields = new Map(real.fields);
      const gen = real.fields.get('generate') as FieldSets;
      fields.set('generate', { ...gen, mcp: new Set([...gen.mcp].filter((f) => f !== 'temperature')) });
      expect(gaps(OPERATIONS, PENDING_CAPABILITIES, { ...real, fields }).join('\n')).toContain('generate: mcp lacks input field temperature');
      const cli = new Map(real.cli);
      const score = real.cli.get('score') as { flags: Set<string>; args: Set<string> };
      cli.set('score', { ...score, flags: new Set([...score.flags, '--top-k']) });
      expect(gaps(OPERATIONS, PENDING_CAPABILITIES, { ...real, cli }).join('\n')).toContain('score: CLI flag --top-k has no input field');
      const drifted = OPERATIONS.map((o) => (o.name === 'score' ? ({ ...o, cli: { ...o.cli, flags: [...o.cli.flags, '--ghost'] } } as AnyOperation) : o));
      expect(gaps(drifted, PENDING_CAPABILITIES, real).join('\n')).toContain('score: registry cli.flags lists --ghost');
    });
  });

  describe('live mutation: a second server whose registry was changed is caught by observing it', () => {
    async function observeMutant(mutant: readonly AnyOperation[]): Promise<Surfaces> {
      const srv = await startTestServer(rig, { mcp: true, operations: mutant });
      try {
        return await observe(srv, real.cli, mutant);
      } finally {
        await srv.close();
      }
    }
    const gen = operation('generate');

    it('an input field added to generate (reachable by HTTP and MCP, no CLI flag, no handler wiring) FAILS the check', async () => {
      const mutant = OPERATIONS.map((o) => (o.name === 'generate' ? ({ ...gen, input: gen.input.extend({ topK: z.number().int().optional() }) } as AnyOperation) : o));
      const seen = await observeMutant(mutant);
      expect(seen.fields.get('generate')?.http.has('topK')).toBe(true);
      expect(seen.fields.get('generate')?.mcp.has('topK')).toBe(true);
      const found = gaps(mutant, PENDING_CAPABILITIES, seen);
      expect(found).toContain('generate: input field topK has no CLI flag or argument (add the flag to the command and the field to CLI_FIELDS)');
    });

    it('an operation served nowhere in the registry (a rogue /api/purge + MCP tool) FAILS the check on every surface', async () => {
      const rogue = { ...operation('personas'), name: 'purge', http: { method: 'GET' as const, path: '/api/purge' } } as unknown as AnyOperation;
      const seen = await observeMutant([...OPERATIONS, rogue]);
      const text = gaps(OPERATIONS, PENDING_CAPABILITIES, seen).join('\n');
      expect(text).toContain('HTTP route GET /api/purge has no registry operation');
      expect(text).toContain('MCP tool purge has no registry operation');
      expect(text).toContain('OpenAPI path /api/purge has no registry operation');
    });

    it('an operation the server stopped serving FAILS the check (HTTP, MCP and OpenAPI)', async () => {
      const seen = await observeMutant(OPERATIONS.filter((o) => o.name !== 'score'));
      const text = gaps(OPERATIONS, PENDING_CAPABILITIES, seen).join('\n');
      expect(text).toContain('score: no HTTP route POST /api/score');
      expect(text).toContain('score: no MCP tool');
      expect(text).toContain('score: no OpenAPI path /api/score');
    });
  });

  it('the CONTRACTS.md "Surface parity" table and the registry agree (the table is extended, not forked)', () => {
    const doc = readFileSync(join(here, '..', '..', '.planning', 'CONTRACTS.md'), 'utf8');
    const section = doc.split(/^## Surface parity.*$/m)[1]?.split(/^## /m)[0] ?? '';
    const cliCells = section
      .split('\n')
      .filter((l) => l.startsWith('|') && !/^\|\s*(-|Capability)/.test(l))
      .map((l) => /ghostwriter ([a-z]+(?: [a-z]+)?)/.exec(l.split('|')[3] ?? '')?.[1] ?? '');
    // `config get` is the only two-word command; for the others the cell may carry flags after the command word
    const rowCommands = cliCells.map((c) => (c.startsWith('config') ? 'config get' : c.split(' ')[0]));
    expect(rowCommands.sort()).toEqual(OPERATIONS.map((o) => o.cli.command.join(' ')).sort());
  });

  it('the docs list every registry operation and the pending capability', () => {
    const surfaces = readFileSync(join(here, '..', '..', 'docs', 'SURFACES.md'), 'utf8');
    for (const op of OPERATIONS) expect(surfaces, op.name).toContain(op.cli.command.join(' '));
    for (const p of PENDING_CAPABILITIES) expect(surfaces.toLowerCase()).toContain(p.name);
    const api = readFileSync(join(here, '..', '..', 'docs', 'API.md'), 'utf8');
    const mcp = readFileSync(join(here, '..', '..', 'docs', 'MCP.md'), 'utf8');
    for (const op of OPERATIONS) {
      expect(api, `API.md ${op.name}`).toContain(op.http.path);
      expect(mcp, `MCP.md ${op.name}`).toContain(`\`${op.name}\``);
    }
  });
});
