// Phase 7: engine.score and `ghostwriter score` through the real engine (no LLM involved).
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Engine } from '../../src/engine.js';
import { ConfigError, DetectorsFailedError, InputTooLargeError } from '../../src/models/errors.js';
import type { DetectorAdapter } from '../../src/models/types.js';
import { loadConfig } from '../../src/config/load.js';
import { runCli } from '../helpers/cli.js';
import { PERSONA } from '../helpers/rig.js';

const TEXT =
  'The harbour was quiet at dawn. Gulls wheeled over the empty slips, and somewhere a rope creaked against a post. Nobody had expected the ferry to run, yet it did: slow, grey, half-lit.\n\n' +
  'Maria watched it come in. She had waited eleven years for this boat, and now that it was here she found she could not move. Why? She could not say.\n\nIn the end she walked down to the pier.';

const baseConfig = { llm: { model: 'm' }, personas: [PERSONA], limits: { maxInputChars: 5000 } };
const detector = (name: string, score: () => number | Promise<number>): DetectorAdapter & { calls: string[] } => {
  const calls: string[] = [];
  return { name, calls, score: async (t: string) => (calls.push(t), score()) };
};

describe('engine.score', () => {
  it('local only by default: a breakdown that sums to the score, a confidentiality trace, nothing else', async () => {
    const engine = new Engine({ config: loadConfig(baseConfig) });
    const r = await engine.score(TEXT);
    expect(r.score).toBe(r.local.score);
    expect(r.members).toEqual([{ name: 'local', score: r.score, weight: 1 }]);
    expect(r.excluded).toEqual([]);
    expect(r.trace.map((t) => t.filter)).toEqual(['confidentiality']);
    expect(Object.values(r.local.features).reduce((a, f) => a + f.contribution, 0)).toBeCloseTo(r.score, 9);
  });

  it('is deterministic and needs no state directory, API key or model', async () => {
    const a = await new Engine({ config: loadConfig(baseConfig), env: {} }).score(TEXT);
    const b = await new Engine({ config: loadConfig(baseConfig), env: {} }).score(TEXT);
    expect({ ...a, trace: [] }).toEqual({ ...b, trace: [] });
  });

  it('empty text gives the defined neutral result and calls no detector', async () => {
    const d = detector('acme', () => 0.9);
    const engine = new Engine({ config: loadConfig(baseConfig), detectors: [d] });
    const r = await engine.score('   ', { detectors: ['acme'] });
    expect(r.score).toBe(0.5);
    expect(r.local.flags).toContain('insufficient_text');
    expect(r.excluded).toEqual([{ name: 'acme', reason: 'empty_text' }]);
    expect(d.calls).toEqual([]);
  });

  it('configured weights change the local score', async () => {
    const plain = await new Engine({ config: loadConfig(baseConfig) }).score(TEXT);
    const only = await new Engine({ config: loadConfig({ ...baseConfig, scorer: { weights: { burstiness: 1, lexicalDiversity: 0, cliche: 0, punctuation: 0, repetition: 0, paragraphUniformity: 0 } } }) }).score(TEXT);
    expect(only.score).toBeCloseTo(only.local.features.burstiness?.value ?? Number.NaN, 12);
    expect(only.score).not.toBeCloseTo(plain.score, 3);
  });

  it('averages named detectors with the local score using config weights, and leaves unnamed ones alone', async () => {
    const named = detector('acme', () => 1);
    const other = detector('other', () => 0);
    const config = loadConfig({ ...baseConfig, scorer: { localWeight: 1, detectors: [{ name: 'acme', url: 'https://detect.example/score', weight: 3 }] } });
    const engine = new Engine({ config, detectors: [named, other] }); // an injected adapter replaces the declared one of the same name
    const r = await engine.score(TEXT, { detectors: ['acme'] });
    expect(r.members.map((m) => m.name)).toEqual(['local', 'acme']);
    expect(r.score).toBeCloseTo(0.25 * r.local.score + 0.75 * 1, 9);
    expect(named.calls).toHaveLength(1);
    expect(other.calls).toEqual([]);
    expect((await engine.score(TEXT)).members).toHaveLength(1); // a second call without names sends nothing
    expect(named.calls).toHaveLength(1);
  });

  it('a failing or out-of-range detector is excluded and recorded; the local score stands', async () => {
    const engine = new Engine({
      config: loadConfig(baseConfig),
      detectors: [detector('boom', () => { throw new Error('nope'); }), detector('big', () => 1.2), detector('nan', () => Number.NaN)],
    });
    const r = await engine.score(TEXT, { detectors: ['boom', 'big', 'nan'] });
    expect(r.score).toBe(r.local.score);
    expect(r.excluded).toEqual([
      { name: 'boom', reason: 'error:Error' },
      { name: 'big', reason: 'invalid_score' },
      { name: 'nan', reason: 'invalid_score' },
    ]);
  });

  it('localWeight 0 with every named detector failing is a DetectorsFailedError; a weighted detector still carries the score', async () => {
    const config = loadConfig({ ...baseConfig, scorer: { localWeight: 0 } });
    const failing = new Engine({ config, detectors: [detector('boom', () => { throw new Error('nope'); })] });
    await expect(failing.score(TEXT, { detectors: ['boom'] })).rejects.toBeInstanceOf(DetectorsFailedError);
    await expect(failing.score(TEXT)).rejects.toBeInstanceOf(DetectorsFailedError); // local alone with weight 0: nothing to report
    const ok = new Engine({ config, detectors: [detector('good', () => 0.25)] });
    expect((await ok.score(TEXT, { detectors: ['good'] })).score).toBe(0.25);
  });

  it('a detector cannot be named __proto__ (config or library), and a configured detector weight is applied', async () => {
    expect(() => loadConfig({ ...baseConfig, scorer: { detectors: [{ name: '__proto__', url: 'https://d.example/s' }] } })).toThrow(ConfigError);
    expect(() => new Engine({ config: loadConfig(baseConfig), detectors: [detector('__proto__', () => 0.5)] })).toThrow(ConfigError);
    const engine = new Engine({ config: loadConfig({ ...baseConfig, scorer: { detectors: [{ name: 'w', url: 'https://d.example/s', weight: 3 }] } }), detectors: [detector('w', () => 1)] });
    expect((await engine.score(TEXT, { detectors: ['w'] })).members.find((m) => m.name === 'w')?.weight).toBeCloseTo(0.75, 9);
  });

  it('an unknown detector name is a ConfigError that lists the configured ones, raised before any filter or call', async () => {
    const d = detector('acme', () => 0.5);
    const engine = new Engine({ config: loadConfig(baseConfig), detectors: [d] });
    await expect(engine.score(TEXT, { detectors: ['acme', 'nope'] })).rejects.toThrow(/unknown detector "nope"; configured: acme/);
    expect(d.calls).toEqual([]);
    await expect(new Engine({ config: loadConfig(baseConfig) }).score(TEXT, { detectors: ['x'] })).rejects.toThrow(/none are configured/);
  });

  it('rejects non-string text and text over limits.maxInputChars', async () => {
    const engine = new Engine({ config: loadConfig({ ...baseConfig, limits: { maxInputChars: 100 } }) });
    await expect(engine.score(5 as unknown as string)).rejects.toThrow(ConfigError);
    await expect(engine.score('x'.repeat(101))).rejects.toThrow(InputTooLargeError);
    await expect(engine.score('x'.repeat(100))).resolves.toBeDefined();
  });

  it('HTTP detectors declared in config are called through the injected fetch with the bearer token from env', async () => {
    let seen: { url: string; auth: string | undefined; body: string } | undefined;
    const config = loadConfig({ ...baseConfig, scorer: { detectors: [{ name: 'acme', url: 'https://detect.example/score', apiKeyEnv: 'ACME_KEY' }] } });
    const engine = new Engine({
      config,
      env: { ACME_KEY: 'tok' },
      detectorFetch: async (url, init) => {
        seen = { url, auth: (init.headers as Record<string, string>).authorization, body: init.body as string };
        return new Response('{"score":0.9}', { status: 200 });
      },
    });
    const r = await engine.score(TEXT, { detectors: ['acme'] });
    expect(r.members.map((m) => m.name)).toEqual(['local', 'acme']);
    expect(seen?.url).toBe('https://detect.example/score');
    expect(seen?.auth).toBe('Bearer tok');
    expect(JSON.parse(seen?.body ?? '{}').text).toContain('harbour');
  });
});

describe('ghostwriter score', () => {
  let dir = '';
  let textPath = '';
  let configPath = '';
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gw-score-'));
    textPath = join(dir, 'text.txt');
    configPath = join(dir, 'config.json');
    await writeFile(textPath, TEXT);
    await writeFile(configPath, JSON.stringify(baseConfig));
  });
  afterEach(async () => rm(dir, { recursive: true, force: true }));

  it('prints the score and the breakdown from a file, with no model or API key', async () => {
    const r = await runCli(['score', textPath, '--config', configPath]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^score: 0\.\d{3}\n/);
    for (const f of ['burstiness', 'lexicalDiversity', 'cliche', 'punctuation', 'repetition', 'paragraphUniformity']) expect(r.out).toContain(f);
    expect(r.err).toBe('');
  });

  it('reads stdin and --file, and --json prints exactly one document {ok, score, local, members, excluded}', async () => {
    const viaStdin = await runCli(['score', '--json', '--config', configPath], { stdin: TEXT });
    const viaFile = await runCli(['score', '--json', '--config', configPath, '--file', textPath]);
    const a = JSON.parse(viaStdin.out) as Record<string, unknown>;
    expect(a).toMatchObject({ ok: true, members: [{ name: 'local' }], excluded: [] });
    expect(Object.keys(a)).toEqual(expect.arrayContaining(['score', 'local', 'members', 'excluded', 'trace']));
    expect(viaStdin.out.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(viaFile.out)).toEqual({ ...a, trace: expect.anything() });
  });

  it('--detector for an unknown name exits 2 with a JSON error; when every named detector fails it still prints the local score, warns on stderr and exits 9', async () => {
    const unknown = await runCli(['score', textPath, '--config', configPath, '--detector', 'nope', '--json']);
    expect(unknown.code).toBe(2);
    expect(JSON.parse(unknown.out)).toMatchObject({ ok: false, error: { code: 'CONFIG_INVALID' } });

    await writeFile(configPath, JSON.stringify({ ...baseConfig, scorer: { detectors: [{ name: 'acme', url: 'https://detect.example/score', timeoutMs: 500 }] } }));
    const failing = await runCli(['score', textPath, '--config', configPath, '--detector', 'acme', '--json'], {}, {});
    // no network in tests: the real fetch fails (or is refused); the detector is excluded, the local result is still
    // printed, and the exit code says the requested external opinion was not obtained
    expect(failing.code).toBe(9);
    expect(failing.err).toContain('no named detector produced a score');
    expect(failing.err).toContain('sending the redacted text to external detector(s): acme');
    expect(failing.err).toMatch(/detector "acme" was not used \(error:/);
    expect(JSON.parse(failing.out)).toMatchObject({ ok: true, localOnly: true, excluded: [{ name: 'acme' }] });
  }, 15_000);

  it('without --detector there is no exit-9 path', async () => {
    const plain = await runCli(['score', textPath, '--config', configPath]);
    expect(plain.code).toBe(0);
    expect(plain.err).not.toContain('no named detector');
  });

  it('empty input is a defined result, exit 0', async () => {
    const r = await runCli(['score', '--config', configPath], { stdin: '' });
    expect(r.code).toBe(0);
    expect(r.out).toContain('score: 0.500');
    expect(r.out).toContain('insufficient_text');
  });
});
