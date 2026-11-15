// `ghostwriter humanize` and `generate --humanize` through the real commander program (in-process).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockLlmClient } from '../../src/llm/mockClient.js';
import { loadConfig } from '../../src/config/load.js';
import { configSchema } from '../../src/config/schema.js';
import { runCli } from '../helpers/cli.js';
import { PERSONA, corpus } from '../helpers/rig.js';

const here = dirname(fileURLToPath(import.meta.url));
const AI = readFileSync(join(here, '..', 'fixtures', 'corpus', 'ai', '08-social-media.txt'), 'utf8');
let work: string;
let cfg: string;
let state: string;

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'gw-hum-'));
  state = join(work, 'state');
  cfg = join(work, 'config.json');
  writeFileSync(cfg, JSON.stringify({ llm: { model: 'm', maxRetries: 0 }, personas: [PERSONA], limits: { maxInputChars: 20000 } }));
  const r = await runCli(['ingest', '--author', 'terse', '--name', 'Terse', '--config', cfg, '--state-dir', state], { stdin: corpus() });
  expect(r.code, r.err).toBe(0);
});
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe('ghostwriter humanize', () => {
  it('--no-llm prints the rewritten text, the score change and the weak-scorer note; stdout only', async () => {
    const r = await runCli(['humanize', '--no-llm', '--config', cfg], { stdin: AI });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/score: 0\.\d{3} -> 0\.\d{3}/);
    expect(r.out).toContain('weak and confounded');
    expect(r.out).toContain('Social media has changed');
    expect(r.err).toBe('');
  });

  it('--json is one document with the steps and the caveat; a file argument works', async () => {
    const file = join(work, 'in.txt');
    writeFileSync(file, AI);
    const r = await runCli(['humanize', file, '--no-llm', '--json', '--config', cfg]);
    expect(r.code, r.err).toBe(0);
    const doc = JSON.parse(r.out);
    expect(doc).toMatchObject({ ok: true, llmCalls: 0, caveat: expect.stringContaining('0.694') });
    expect(doc.finalScore).toBeLessThan(doc.initialScore);
    expect(doc.steps.length).toBeGreaterThan(0);
  });

  it('--target and --max-iterations are honored; 0 iterations returns the text untouched', async () => {
    const r = await runCli(['humanize', '--max-iterations', '0', '--json', '--config', cfg], { stdin: AI });
    expect(JSON.parse(r.out)).toMatchObject({ ok: true, iterations: 0, text: AI });
    const hi = await runCli(['humanize', '--target', '1', '--json', '--config', cfg], { stdin: AI });
    expect(JSON.parse(hi.out)).toMatchObject({ iterations: 0, reachedTarget: true });
  });

  it('usage errors: target out of range, iterations too large, unknown author', async () => {
    expect((await runCli(['humanize', '--target', '2', '--config', cfg], { stdin: AI })).code).toBe(2);
    const many = await runCli(['humanize', '--max-iterations', '11', '--json', '--config', cfg], { stdin: AI });
    expect(many.code).toBe(2);
    expect(JSON.parse(many.out).error.code).toBe('USAGE');
    const nobody = await runCli(['humanize', '--author', 'nobody', '--no-llm', '--json', '--config', cfg, '--state-dir', state], { stdin: AI });
    expect(nobody.code).toBe(3);
    expect(JSON.parse(nobody.out).error.code).toBe('UNKNOWN_AUTHOR');
  });

  it('a model that cannot be reached is a warning on stderr, never a failure', async () => {
    const r = await runCli(['humanize', '--config', cfg], { stdin: AI, env: {} });
    expect(r.code, r.err).toBe(0);
    expect(r.err).toContain('the model pass failed');
    expect(r.out).toMatch(/score: /);
  });

  it('with a scripted model and --author, the model is called with the profile', async () => {
    const llm = new MockLlmClient(() => AI);
    const r = await runCli(['humanize', '--author', 'terse', '--json', '--target', '0', '--max-iterations', '1', '--config', cfg, '--state-dir', state], { stdin: AI }, { llm });
    expect(r.code, r.err).toBe(0);
    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]?.system).toContain('Terse');
  });
});

describe('ghostwriter generate --humanize', () => {
  it('--target without --humanize is a usage error; with it the trace has humanizer entries', async () => {
    const bad = await runCli(['generate', '--author', 'terse', '--persona', 'exec', '--target', '0.2', '--config', cfg, '--state-dir', state], { stdin: 'Draft.' }, { llm: new MockLlmClient(() => AI) });
    expect(bad.code).toBe(2);
    expect(bad.err).toContain('--target needs --humanize');
    const ok = await runCli(['generate', '--author', 'terse', '--persona', 'exec', '--humanize', '--target', '0.1', '--json', '--config', cfg, '--state-dir', state], { stdin: 'Draft.' }, { llm: new MockLlmClient(() => AI) });
    expect(ok.code, ok.err).toBe(0);
    expect(JSON.parse(ok.out).trace.some((t: { filter: string }) => t.filter === 'humanize')).toBe(true);
  });
});

describe('config humanize section', () => {
  it('defaults when absent, validates bounds, rejects unknown keys', () => {
    expect(loadConfig({ llm: { model: 'm' } }).humanize).toBeUndefined();
    expect(loadConfig({ llm: { model: 'm' }, humanize: {} }).humanize).toEqual({ targetScore: 0.3, maxIterations: 3 });
    expect(loadConfig({ llm: { model: 'm' }, humanize: { targetScore: 0.1, maxIterations: 0 } }).humanize).toEqual({ targetScore: 0.1, maxIterations: 0 });
    for (const bad of [{ targetScore: 1.5 }, { targetScore: -0.1 }, { maxIterations: 11 }, { maxIterations: 1.5 }, { nope: 1 }]) {
      expect(configSchema.safeParse({ llm: { model: 'm' }, humanize: bad }).success).toBe(false);
    }
  });
});
