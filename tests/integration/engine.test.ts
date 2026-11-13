// Phase 5 / Engine facade: the five library capabilities, persistence across instances, lazy LLM creation.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Engine, defaultStateDir, providerConfig } from '../../src/engine.js';
import { loadConfig } from '../../src/config/load.js';
import { MockLlmClient } from '../../src/llm/mockClient.js';
import { ConfigError, StoreCorruptError, UnknownAuthorError, UnknownPersonaError } from '../../src/models/errors.js';
import { json, openaiOk, startStub } from '../helpers/llmStub.js';
import type { Stub } from '../helpers/llmStub.js';
import { PERSONA, corpus, fastRetry } from '../helpers/rig.js';

let dir = '';
beforeEach(async () => void (dir = await mkdtemp(join(tmpdir(), 'gw-engine-'))));
afterEach(async () => rm(dir, { recursive: true, force: true }));

const cfg = (extra: Record<string, unknown> = {}) => loadConfig({ llm: { model: 'm' }, personas: [PERSONA], ...extra });

describe('Engine: surface', () => {
  it('exposes ingest, getProfile, listPersonas, listFilters, generate', () => {
    for (const m of ['ingest', 'getProfile', 'listPersonas', 'listFilters', 'generate']) {
      expect(typeof (Engine.prototype as unknown as Record<string, unknown>)[m], m).toBe('function');
    }
  });

  it('ingest -> getProfile -> generate in memory', async () => {
    const llm = new MockLlmClient(['Short answer. Clear and plain.']);
    const e = await Engine.create({ config: cfg(), llm, retry: fastRetry });
    const profile = await e.ingest('terse', 'Terse Author', corpus());
    expect(e.getProfile('terse')).toEqual(profile);
    const out = await e.generate('terse', 'exec', 'Please rewrite this status update.');
    expect(out.text).toContain('Short answer');
    expect(out.trace.map((t) => t.filter)).toEqual(['confidentiality', 'llm', 'style', 'confidentiality']);
  });

  it('listPersonas is sorted and detached; listFilters is the ordered pipeline and detached', async () => {
    const e = new Engine({ config: loadConfig({ llm: { model: 'm' } }), llm: new MockLlmClient() });
    expect(e.listPersonas().map((p) => p.key)).toEqual(['engineer', 'executive', 'newcomer']);
    e.listPersonas()[0]!.name = 'mutated';
    expect(e.listPersonas()[0]!.name).not.toBe('mutated');
    expect(e.listFilters().map((f) => `${f.name}:${f.stage}`)).toEqual(['confidentiality:pre', 'style:post', 'confidentiality:post']);
    e.listFilters()[0]!.enabled = false;
    expect(e.listFilters()[0]!.enabled).toBe(true);
  });

  it('typed errors: unknown author / persona', async () => {
    const e = await Engine.create({ config: cfg(), llm: new MockLlmClient(['x y z']) });
    expect(() => e.getProfile('ghost')).toThrow(UnknownAuthorError);
    await e.ingest('terse', 'T', corpus());
    await expect(e.generate('terse', 'nope', 'hi')).rejects.toBeInstanceOf(UnknownPersonaError);
    await expect(e.generate('ghost', 'exec', 'hi')).rejects.toBeInstanceOf(UnknownAuthorError);
  });

  it('validates a hand-built config and detaches from it', () => {
    const c = cfg();
    expect(() => new Engine({ config: { ...c, filters: { pipeline: [{ name: 'style', stage: 'post', onError: 'skip', enabled: true }] } } })).toThrow(ConfigError);
    const e = new Engine({ config: c, llm: new MockLlmClient() });
    c.personas.length = 0;
    expect(e.listPersonas()).toHaveLength(1);
  });

  it('config blocklist reaches ingest, so a blocklisted term is never stored', async () => {
    const e = await Engine.create({ config: cfg({ confidentiality: { blocklist: ['Falcon'] } }), stateDir: dir, llm: new MockLlmClient() });
    await e.ingest('terse', 'T', `${corpus()}\nProject Falcon launches soon and the team is ready.`);
    expect(await readFile(join(dir, 'store.json'), 'utf8')).not.toContain('Falcon');
  });
});

describe('Engine: persistence across instances', () => {
  it('ingest in one instance, generate in a fresh one (the CLI path)', async () => {
    const a = await Engine.create({ config: cfg(), stateDir: dir, llm: new MockLlmClient() });
    const profile = await a.ingest('terse', 'Terse Author', corpus());
    const llm = new MockLlmClient(['Restored and working fine.']);
    const b = await Engine.create({ config: cfg(), stateDir: dir, llm, retry: fastRetry });
    expect(b.getProfile('terse')).toEqual(profile);
    const out = await b.generate('terse', 'exec', 'Summarize the plan please.');
    expect(out.text).toContain('Restored');
    expect(llm.requests[0]!.user).toContain('<exemplar>'); // chunks came back too
  });

  it('state directory is configurable and a fresh one is empty', async () => {
    const e = await Engine.create({ config: cfg(), stateDir: join(dir, 'nested', 'deeper'), llm: new MockLlmClient() });
    expect(() => e.getProfile('terse')).toThrow(UnknownAuthorError);
  });

  it('corrupt state -> StoreCorruptError from create()', async () => {
    const a = await Engine.create({ config: cfg(), stateDir: dir, llm: new MockLlmClient() });
    await a.ingest('terse', 'T', corpus());
    await writeFile(join(dir, 'profiles.json'), '{broken');
    await expect(Engine.create({ config: cfg(), stateDir: dir })).rejects.toBeInstanceOf(StoreCorruptError);
  });

  it('rejects an empty stateDir and a store without save/load', () => {
    expect(() => new Engine({ config: cfg(), stateDir: '' })).toThrow(ConfigError);
    expect(
      () => new Engine({ config: cfg(), stateDir: dir, store: { upsert: async () => undefined, query: async () => [], deleteCollection: async () => undefined } }),
    ).toThrow(ConfigError);
  });

  it('defaultStateDir honours GHOSTWRITER_STATE_DIR, then XDG_STATE_HOME', () => {
    expect(defaultStateDir({ GHOSTWRITER_STATE_DIR: '/a', XDG_STATE_HOME: '/b' })).toBe('/a');
    expect(defaultStateDir({ XDG_STATE_HOME: '/b' })).toBe('/b/ghostwriter');
    expect(defaultStateDir({})).toMatch(/\.local\/state\/ghostwriter$/);
  });
});

describe('Engine: lazy real LLM client', () => {
  it('no API key: everything but generate works; generate -> ConfigError naming the variable only', async () => {
    const e = await Engine.create({ config: cfg(), env: {} });
    await e.ingest('terse', 'T', corpus());
    expect(e.listPersonas()).toHaveLength(1);
    const err = (await e.generate('terse', 'exec', 'hello there').catch((x: unknown) => x)) as ConfigError;
    expect(err).toBeInstanceOf(ConfigError);
    expect(err.message).toContain('ANTHROPIC_API_KEY');
  });

  it('a custom apiKeyEnv is the one that is checked', async () => {
    const e = await Engine.create({ config: cfg({ llm: { model: 'm', apiKeyEnv: 'MY_KEY' } }), env: { ANTHROPIC_API_KEY: 'sk-ant-x' } });
    await e.ingest('terse', 'T', corpus());
    await expect(e.generate('terse', 'exec', 'hello there')).rejects.toThrow(/MY_KEY/);
  });

  describe('against a local OpenAI-compatible stub', () => {
    let stub: Stub;
    beforeEach(async () => void (stub = await startStub((_req, res) => json(res, 200, openaiOk('Stub says something plain.')))));
    afterEach(async () => stub.close());
    const config = () => cfg({ llm: { model: 'local', provider: 'openai-compat', baseUrl: `${stub.origin}/v1` } });

    it('keyless local server: no Authorization header; secrets in the input never reach the wire', async () => {
      const e = await Engine.create({ config: config(), env: {} });
      await e.ingest('terse', 'T', corpus());
      const out = await e.generate('terse', 'exec', 'Use key AKIAIOSFODNN7EXAMPLE for the deploy.');
      expect(out.text).toContain('Stub says');
      expect(stub.requests).toHaveLength(1);
      expect(stub.requests[0]!.headers.authorization).toBeUndefined();
      expect(stub.requests[0]!.body).not.toContain('AKIAIOSFODNN7EXAMPLE');
    });

    it('Authorization header only when the named env var is set; the key never appears in results', async () => {
      const e = await Engine.create({
        config: cfg({ llm: { model: 'local', provider: 'openai-compat', baseUrl: `${stub.origin}/v1`, apiKeyEnv: 'LOCAL_KEY' } }),
        env: { LOCAL_KEY: 'secret-token-123' },
      });
      await e.ingest('terse', 'T', corpus());
      const out = await e.generate('terse', 'exec', 'hello there friend');
      expect(stub.requests[0]!.headers.authorization).toBe('Bearer secret-token-123');
      expect(JSON.stringify(out)).not.toContain('secret-token-123');
    });

    it('persistent 500s -> LlmError after bounded attempts', async () => {
      stub.setHandler((_r, res) => json(res, 500, { error: 'boom' }));
      const e = await Engine.create({ config: config(), env: {}, llmClientOptions: { retry: { baseMs: 0, sleep: async () => undefined } } });
      await e.ingest('terse', 'T', corpus());
      const err = await e.generate('terse', 'exec', 'hello there').catch((x: unknown) => x);
      expect(err).toMatchObject({ code: 'LLM_FAILED', attempts: 3 });
      expect(stub.requests).toHaveLength(3);
    });
  });
});

describe('providerConfig', () => {
  it('maps config.llm to a ProviderConfig', () => {
    expect(providerConfig(cfg())).toEqual({ provider: 'anthropic', model: 'm', apiKeyEnv: 'ANTHROPIC_API_KEY' });
    expect(providerConfig(cfg({ llm: { model: 'm', provider: 'openai-compat', baseUrl: 'http://h/v1' } }))).toEqual({ provider: 'openai-compat', model: 'm', baseUrl: 'http://h/v1' });
  });
});
