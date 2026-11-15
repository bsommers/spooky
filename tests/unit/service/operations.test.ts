import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { HEURISTIC_HELD_OUT_AUC } from '../../../config/humanize.js';
import { buildConfigView, WITHHELD } from '../../../src/config/view.js';
import { loadConfig } from '../../../src/config/load.js';
import { InputError } from '../../../src/service/errors.js';
import { OPERATIONS, PENDING_CAPABILITIES, describeCapabilities, findOperation, invokeOperation, operation, parseInput } from '../../../src/service/operations.js';
import { PERSONA } from '../../helpers/rig.js';
import { makeRuntime } from '../../helpers/surfaces.js';

describe('operations registry', () => {
  it('has unique names, and every operation has a strict object input and an object output schema', () => {
    const names = OPERATIONS.map((o) => o.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(['ingest', 'generate', 'score', 'humanize', 'profile', 'authors', 'personas', 'filters', 'config_get', 'capabilities']);
    for (const op of OPERATIONS) {
      expect(op.input, op.name).toBeInstanceOf(z.ZodObject);
      expect(op.output, op.name).toBeInstanceOf(z.ZodObject);
      expect(op.description.length, op.name).toBeGreaterThan(10);
      // strict: an unknown field is rejected on every operation
      expect(op.input.safeParse({ ...Object.fromEntries(Object.keys(op.input.shape).map((k) => [k, 'x'])), unexpected: 1 }).success, op.name).toBe(false);
    }
  });

  it('routes and CLI commands are unique, GET operations take no body, only ingest mutates', () => {
    expect(new Set(OPERATIONS.map((o) => `${o.http.method} ${o.http.path}`)).size).toBe(OPERATIONS.length);
    expect(new Set(OPERATIONS.map((o) => o.cli.command.join(' '))).size).toBe(OPERATIONS.length);
    expect(OPERATIONS.filter((o) => o.mutates).map((o) => o.name)).toEqual(['ingest']);
    for (const o of OPERATIONS) expect(o.http.path, o.name).toMatch(/^\/api\/[a-z]+$/);
  });

  it('invalid input is a USAGE error with a path-qualified, bounded message', () => {
    const op = operation('generate');
    let err: unknown;
    try {
      parseInput(op, { authorId: '../x', persona: 'exec', text: 5, exemplars: 99 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(InputError);
    const e = err as InputError;
    expect(e.code).toBe('USAGE');
    expect(e.issues.map((i) => i.path).sort()).toEqual(['authorId', 'exemplars', 'text']);
    expect(e.message).toContain('authorId:');
    expect(e.message).toContain('exemplars:');
    expect(e.message.length).toBeLessThan(900);
  });

  it('an unknown key is reported by name only when it looks like an identifier (no echo of attacker text)', () => {
    const op = operation('profile');
    const nasty = 'k'.repeat(5000) + 'sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    expect(() => parseInput(op, { authorId: 'a', [nasty]: 1 })).toThrow(/unknown field: \(unprintable\)/);
    expect(() => parseInput(op, { authorId: 'a', extra: 1 })).toThrow(/unknown field: extra/);
    try {
      parseInput(op, { authorId: 'a', [nasty]: 1 });
    } catch (e) {
      expect((e as Error).message).not.toContain('sk-ABCDEF');
    }
  });

  it('null / undefined input means an empty object (read operations), arrays and strings are rejected', () => {
    expect(parseInput(operation('personas'), undefined)).toEqual({});
    expect(parseInput(operation('personas'), null)).toEqual({});
    expect(() => parseInput(operation('personas'), [])).toThrow(InputError);
    expect(() => parseInput(operation('personas'), 'x')).toThrow(InputError);
    expect(() => parseInput(operation('ingest'), [1])).toThrow(InputError);
  });

  it('humanize (Phase 8) is registered and no longer pending; a planned capability is reported by describeCapabilities', () => {
    expect(PENDING_CAPABILITIES).toEqual([]);
    expect(findOperation('humanize')).toMatchObject({ name: 'humanize', engineMethod: 'humanize', mutates: false, openWorld: true, http: { method: 'POST', path: '/api/humanize' } });
    expect(describeCapabilities().pending).toEqual([]);
    const planned = [{ name: 'translate', phase: 99, summary: 'planned', engineMethod: 'translate' }];
    expect(describeCapabilities(OPERATIONS, planned).pending).toEqual([{ name: 'translate', phase: 99, summary: 'planned' }]);
  });

  it('humanize says what its score is: the description and every result carry the weak-scorer caveat', async () => {
    expect(operation('humanize').description).toContain(String(HEURISTIC_HELD_OUT_AUC));
    const rig = await makeRuntime();
    try {
      const out = await invokeOperation(operation('humanize'), rig.engine, { text: 'A short text to rewrite. It has two sentences and then a third one. And a fourth one ends it.', llm: false });
      expect(out.caveat).toContain('0.694');
      expect(out.caveat).toContain('No external detector has been tested');
      expect(out.caveat).not.toMatch(/Results against detectors/i);
      expect(operation('humanize').render(out as never)).toContain('weak and confounded');
    } finally {
      rig.cleanup();
    }
  });

  it('every operation runs against a real Engine and its output satisfies its own schema', async () => {
    const rig = await makeRuntime();
    try {
      const inputs: Record<string, unknown> = {
        ingest: { authorId: 'b', name: 'B', text: 'First sentence here. Second sentence follows it. Third one ends the paragraph.' },
        generate: { authorId: 'terse', persona: 'exec', text: 'Please rewrite this short draft.' },
        score: { text: 'A short text to score. It has two sentences and then a third one.' },
        humanize: { text: 'A short text to rewrite. It has two sentences and then a third one. And a fourth one ends it.', llm: false },
        profile: { authorId: 'terse' },
      };
      for (const op of OPERATIONS) {
        const out = await invokeOperation(op, rig.engine, inputs[op.name] ?? {});
        const parsed = op.output.safeParse(out);
        expect(parsed.success, `${op.name}: ${parsed.success ? '' : parsed.error.message}`).toBe(true);
        expect(typeof op.render(out as never), op.name).toBe('string');
      }
    } finally {
      rig.cleanup();
    }
  });
});

describe('config get (redacted view)', () => {
  const secret = 'sk-ant-api03-' + 'A1b2C3d4E5f6G7h8I9j0'.repeat(3);
  const full = {
    llm: { model: 'm-1', provider: 'openai-compat', baseUrl: 'https://llm.example.com:8443/v1/secret-path?token=queryvalue', apiKeyEnv: 'MY_LLM_KEY' },
    personas: [PERSONA],
    confidentiality: { blocklist: ['Project Falcon', 'Acme'], caseInsensitive: true, customRules: [{ name: 'ticket', pattern: 'TKT-[0-9]{4}' }] },
    scorer: { detectors: [{ name: 'det', url: 'https://detector.example.com/score?key=urlsecret', apiKeyEnv: 'DET_API_KEY' }] },
  };

  it('shows provider, model, endpoint host, env var NAMES, limits, filters, persona keys, counts', () => {
    const v = buildConfigView(loadConfig(full), { MY_LLM_KEY: secret, DET_API_KEY: 'detectorsecretvalue1234' });
    expect(v.llm).toMatchObject({ provider: 'openai-compat', model: 'm-1', baseUrlHost: 'llm.example.com:8443', apiKeyEnv: 'MY_LLM_KEY', apiKeyEnvSet: true });
    expect(v.personas).toEqual(['exec']);
    expect(v.confidentiality).toEqual({ blocklistTerms: 2, customRules: 1 });
    expect(v.scorer.detectors[0]).toMatchObject({ name: 'det', host: 'detector.example.com', scheme: 'https', apiKeyEnv: 'DET_API_KEY', apiKeyEnvSet: true });
    expect(v.filters.map((f) => f.name)).toContain('confidentiality');
    expect(v.limits.maxInputChars).toBeGreaterThan(0);
  });

  it('never contains an env value, a URL path or query, or blocklist/rule content', () => {
    const text = JSON.stringify(buildConfigView(loadConfig(full), { MY_LLM_KEY: secret, DET_API_KEY: 'detectorsecretvalue1234', OTHER: 'sk-live-should-not-matter' }));
    for (const forbidden of [secret, 'detectorsecretvalue1234', 'secret-path', 'queryvalue', 'urlsecret', 'Project Falcon', 'Acme', 'TKT-']) expect(text, forbidden).not.toContain(forbidden);
  });

  it('reports whether a key variable is set without reading its value into the view', () => {
    expect(buildConfigView(loadConfig(full), {}).llm.apiKeyEnvSet).toBe(false);
    expect(buildConfigView(loadConfig(full), { MY_LLM_KEY: '' }).llm.apiKeyEnvSet).toBe(false);
  });

  it('a key pasted where a variable NAME belongs is withheld, not echoed (built by hand: the config loader already refuses it)', () => {
    const cfg = loadConfig({ llm: { model: 'm' }, personas: [PERSONA] });
    const hacked = { ...cfg, llm: { ...cfg.llm, apiKeyEnv: secret } };
    const v = buildConfigView(hacked, { [secret]: 'x' });
    expect(v.llm.apiKeyEnv).toBe(WITHHELD);
    expect(JSON.stringify(v)).not.toContain(secret);
  });
});
