// Uniform surfaces (Phase 9): for EVERY operation in the registry there must be an Engine method, a CLI command with
// its flags, an HTTP route, an MCP tool and an OpenAPI path; and no surface may offer a capability the registry lacks.
// A capability that is planned but not built (humanize, Phase 8) is enumerated as PENDING: it must have no adapter
// anywhere yet, and the test fails the moment the Engine gains it without a registry entry.
//
// The comparison is a pure function over "surface descriptors" so the test can prove it works: it deletes one adapter
// entry at a time from a copy of the real descriptors (and adds a rogue one) and requires the check to notice.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProgram } from '../../src/cli/main.js';
import { Engine } from '../../src/engine.js';
import { PENDING_CAPABILITIES, OPERATIONS, cliLine } from '../../src/service/operations.js';
import type { AnyOperation, PendingCapability } from '../../src/service/operations.js';
import type { ApiServer } from '../../src/api/server.js';
import { connectMcp, makeRuntime, raw, startTestServer } from '../helpers/surfaces.js';
import type { Rigged } from '../helpers/surfaces.js';

interface Surfaces {
  engineMethods: Set<string>;
  /** `config get` -> { flags, arguments } */
  cli: Map<string, { flags: Set<string>; args: Set<string> }>;
  http: Set<string>; // `GET /api/profile`
  mcp: Set<string>;
  openapi: Set<string>; // `/api/profile`
}

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

beforeAll(async () => {
  rig = await makeRuntime();
  server = await startTestServer(rig, { mcp: true });
  const program = buildProgram({ stdout: () => undefined, stderr: () => undefined, stdin: (async function* () {})(), stdinIsTTY: false, env: {} });
  const cli: Surfaces['cli'] = new Map();
  walk(program.commands.filter((c) => !TRANSPORT_COMMANDS.has(c.name())), [], cli);

  // HTTP: the document the server serves, and a probe of each route the registry names (a wrong or missing route is 404/405)
  const doc = (await raw(server, '/openapi.json')).json() as { paths: Record<string, Record<string, unknown>> };
  const openapi = new Set(Object.keys(doc.paths).filter((p) => p.startsWith('/api/')));
  const http = new Set<string>();
  for (const p of openapi) for (const m of Object.keys(doc.paths[p] ?? {})) http.add(`${m.toUpperCase()} ${p}`);
  const probed = new Set<string>();
  for (const op of OPERATIONS) {
    const r = await raw(server, op.http.path, op.http.method === 'GET' ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (r.status !== 404 && r.status !== 405) probed.add(`${op.http.method} ${op.http.path}`);
  }
  expect([...probed].sort()).toEqual([...http].sort());

  const mcp = await connectMcp(rig);
  const tools = new Set((await mcp.client.listTools()).tools.map((t) => t.name));
  await mcp.close();

  real = {
    engineMethods: new Set(Object.getOwnPropertyNames(Engine.prototype).filter((m) => m !== 'constructor')),
    cli,
    http,
    mcp: tools,
    openapi,
  };
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
      const stub = { ...OPERATIONS[0], name: 'stubbed', engineMethod: 'stubbed', http: { method: 'GET' as const, path: '/api/stubbed' }, cli: { command: ['stubbed'], arguments: [], flags: [], derived: true } } as unknown as AnyOperation;
      const found = gaps([...OPERATIONS, stub], PENDING_CAPABILITIES, real).filter((g) => g.startsWith('stubbed:'));
      expect(found.length).toBe(5);
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
