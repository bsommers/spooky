// Uniform surfaces: every row of the CONTRACTS "Surface parity" table must have a library method on Engine AND a CLI
// command. The test reads the table, so adding a row without implementing both sides fails here.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildProgram } from '../../src/cli/main.js';
import { Engine } from '../../src/engine.js';
import * as pkg from '../../src/index.js';

const contracts = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.planning', 'CONTRACTS.md');
const section = readFileSync(contracts, 'utf8').split(/^## Surface parity.*$/m)[1]?.split(/^## /m)[0] ?? '';
const rows = section
  .split('\n')
  .filter((l) => l.startsWith('|') && !/^\|\s*(-|Capability)/.test(l))
  .map((l) => {
    const [capability, lib, cli] = l.split('|').slice(1, 4).map((c) => c.trim());
    return { capability: capability ?? '', method: /engine\.(\w+)\(/.exec(lib ?? '')?.[1], command: /ghostwriter (\w+)/.exec(cli ?? '')?.[1], cli: cli ?? '' };
  });

const program = buildProgram({ stdout: () => undefined, stderr: () => undefined, stdin: (async function* () {})(), stdinIsTTY: false, env: {} });
const commands = new Map(program.commands.map((c) => [c.name(), c]));

describe('surface parity (CONTRACTS.md)', () => {
  it('the table is parsed (5 capabilities)', () => {
    expect(rows.map((r) => r.capability)).toEqual(['ingest corpus', 'show profile', 'list personas', 'list filters', 'generate']);
    for (const r of rows) {
      expect(r.method, r.capability).toBeTruthy();
      expect(r.command, r.capability).toBeTruthy();
    }
  });

  for (const row of rows) {
    it(`${row.capability}: engine.${row.method}() and \`ghostwriter ${row.command}\` both exist`, () => {
      expect(typeof (Engine.prototype as unknown as Record<string, unknown>)[row.method as string]).toBe('function');
      const cmd = commands.get(row.command as string);
      expect(cmd, `CLI command ${row.command}`).toBeDefined();
      // every flag the table promises is a real option / argument of that command
      for (const flag of row.cli.match(/--[a-z-]+/g) ?? []) {
        const names = cmd!.options.map((o) => o.long);
        expect(names, `${row.command} ${flag}`).toContain(flag);
      }
      if (/<id>/.test(row.cli)) expect(cmd!.registeredArguments.map((a) => a.name())).toContain('id');
    });
  }

  it('the CLI has no command outside the table (no capability on one surface only)', () => {
    expect([...commands.keys()].sort()).toEqual(rows.map((r) => r.command as string).sort());
  });

  it('the Engine has no public capability outside the table', () => {
    const methods = Object.getOwnPropertyNames(Engine.prototype).filter((m) => m !== 'constructor' && !m.startsWith('#'));
    const allowed = new Set([...rows.map((r) => r.method as string), 'load']); // `load` = restore persisted state (CLI does it implicitly)
    expect(methods.filter((m) => !allowed.has(m))).toEqual([]);
  });

  it('the package entry point exports the Engine and the CLI-visible error classes', () => {
    expect(pkg.Engine).toBe(Engine);
    for (const n of ['ProfileError', 'StoreCorruptError', 'LlmError', 'InputTooLargeError', 'UnknownPersonaError', 'UnknownAuthorError', 'FilterFailedError', 'ConfigError']) {
      expect(typeof (pkg as Record<string, unknown>)[n], n).toBe('function');
    }
  });
});
