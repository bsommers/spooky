// Phase 2 IN-01 carry-over: the confidentiality blocklist / custom rules live in Config and reach the pipeline
// through loadConfig -> buildPipeline with no programmatic side channel.
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/load.js';
import { buildPipeline, defaultFactories } from '../../src/filters/registry.js';
import { ConfigError } from '../../src/models/errors.js';
import type { PipelineContext } from '../../src/models/types.js';

const ctx = (stage: 'pre' | 'post'): PipelineContext => ({ authorId: 'a', personaKey: 'p', stage });
const base = { llm: { model: 'm' } };

describe('config -> pipeline: confidentiality section', () => {
  it('absent section keeps the loaded config free of it (built-in rules only)', () => {
    expect(loadConfig(base).confidentiality).toBeUndefined();
  });

  it('blocklist from config redacts at both stages', async () => {
    const cfg = loadConfig({ ...base, confidentiality: { blocklist: ['Project Falcon'] } });
    expect(cfg.confidentiality).toEqual({ blocklist: ['Project Falcon'], caseInsensitive: false, customRules: [] });
    for (const stage of ['pre', 'post'] as const) {
      const out = await buildPipeline(cfg, stage).run('We ship Project Falcon in May', ctx(stage));
      expect(out.text).not.toContain('Falcon');
      expect(out.text).toContain('[REDACTED:blocklist]');
    }
  });

  it('caseInsensitive applies to the blocklist', async () => {
    const cfg = loadConfig({ ...base, confidentiality: { blocklist: ['Falcon'], caseInsensitive: true } });
    const out = await buildPipeline(cfg, 'pre').run('the FALCON plan', ctx('pre'));
    expect(out.text).not.toMatch(/falcon/i);
  });

  it('custom rules from config redact', async () => {
    const cfg = loadConfig({ ...base, confidentiality: { customRules: [{ name: 'ticket', pattern: 'TKT-[0-9]{4,8}' }] } });
    const out = await buildPipeline(cfg, 'pre').run('see TKT-123456 now', ctx('pre'));
    expect(out.text).toBe('see [REDACTED:ticket] now');
  });

  it('explicit factories override the config-derived defaults', async () => {
    const cfg = loadConfig({ ...base, confidentiality: { blocklist: ['Falcon'] } });
    const out = await buildPipeline(cfg, 'pre', defaultFactories()).run('Falcon', ctx('pre'));
    expect(out.text).toBe('Falcon');
  });

  it('an unsafe custom rule is rejected at loadConfig with a path-qualified issue', () => {
    let err: unknown;
    try {
      loadConfig({ ...base, confidentiality: { customRules: [{ name: 'bad', pattern: '(a+)+$' }] } });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).issues[0]?.path).toBe('confidentiality.customRules');
  });

  it('rejects blank blocklist entries, duplicate rule names, unknown keys and bad shapes', () => {
    const bad = (c: unknown): void => expect(() => loadConfig({ ...base, confidentiality: c })).toThrow(ConfigError);
    bad({ blocklist: ['  '] });
    bad({ blocklist: [1] });
    bad({ blocklist: 'x' });
    bad({ customRules: [{ name: 'Up', pattern: 'a{1,3}' }] });
    bad({ customRules: [{ name: 'a', pattern: 'x{1,3}' }, { name: 'a', pattern: 'y{1,3}' }] });
    bad({ customRules: [{ name: 'a' }] });
    bad({ extra: true });
  });

  it('does not alias the caller input', () => {
    const raw = { ...base, confidentiality: { blocklist: ['x1'] } };
    const cfg = loadConfig(raw);
    cfg.confidentiality?.blocklist.push('y');
    expect(raw.confidentiality.blocklist).toEqual(['x1']);
  });
});

describe('config: llm provider fields', () => {
  it('provider fields are optional and absent by default', () => {
    expect(loadConfig(base).llm).toEqual({ model: 'm', maxTokens: 1500, temperature: 0.7, maxRetries: 2 });
  });
  it('openai-compat needs a baseUrl; baseUrl must be http(s)', () => {
    expect(() => loadConfig({ llm: { model: 'm', provider: 'openai-compat' } })).toThrow(ConfigError);
    expect(() => loadConfig({ llm: { model: 'm', provider: 'openai-compat', baseUrl: 'file:///etc/passwd' } })).toThrow(ConfigError);
    const cfg = loadConfig({ llm: { model: 'm', provider: 'openai-compat', baseUrl: 'http://localhost:11434/v1' } });
    expect(cfg.llm.baseUrl).toBe('http://localhost:11434/v1');
  });
  it('baseUrl with the anthropic provider is rejected; apiKeyEnv must be a variable name, never a key', () => {
    expect(() => loadConfig({ llm: { model: 'm', baseUrl: 'http://x' } })).toThrow(ConfigError);
    expect(() => loadConfig({ llm: { model: 'm', apiKeyEnv: 'sk-ant-abc123def456' } })).toThrow(ConfigError);
    expect(loadConfig({ llm: { model: 'm', apiKeyEnv: 'MY_KEY' } }).llm.apiKeyEnv).toBe('MY_KEY');
  });
  it('rejected apiKeyEnv does not echo the value', () => {
    try {
      loadConfig({ llm: { model: 'm', apiKeyEnv: 'sk-ant-SECRETVALUE-1234' } });
    } catch (e) {
      expect(String((e as Error).message)).not.toContain('SECRETVALUE');
    }
  });
});
