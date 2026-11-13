import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config/load.js';
import { buildPipeline, defaultFactories } from '../../../src/filters/registry.js';
import type { FilterFactories } from '../../../src/filters/registry.js';
import { ConfigError } from '../../../src/models/errors.js';
import type { Filter, FilterResult, FilterSpec, OnError, PipelineContext, Stage } from '../../../src/models/types.js';

const ctx = (stage: Stage = 'pre'): PipelineContext => ({ authorId: 'a', personaKey: 'p', stage });

function appender(name: string, opts: { onError?: OnError } = {}): Filter {
  return {
    name,
    stages: ['pre', 'post'],
    onError: opts.onError ?? 'skip',
    async process(text: string): Promise<FilterResult> {
      return { content: `${text}-${name}`, modified: true, metadata: {} };
    },
  };
}

describe('buildPipeline (registry)', () => {
  const base = () => loadConfig({ llm: { model: 'm' } });
  const spec = (name: string, stage: FilterSpec['stage'], onError: OnError = 'fail-closed', enabled = true): FilterSpec => ({
    name,
    stage,
    onError,
    enabled,
  });
  const cfgWith = (pipeline: FilterSpec[]) => ({ filters: { pipeline } });

  it('default config builds confidentiality for pre and confidentiality+style for post, in config order', () => {
    const cfg = base();
    expect(buildPipeline(cfg, 'pre').names).toEqual(['confidentiality']);
    expect(buildPipeline(cfg, 'post').names).toEqual(['style', 'confidentiality']);
  });

  it('disabled via config: the filter is absent from the pipeline and the trace', async () => {
    const cfg = base();
    cfg.filters.pipeline = cfg.filters.pipeline.map((f) => (f.name === 'style' ? { ...f, enabled: false } : f));
    const p = buildPipeline(cfg, 'post');
    expect(p.names).toEqual(['confidentiality']);
    const out = await p.run('hello', ctx('post'));
    expect(out.trace.map((t) => t.filter)).toEqual(['confidentiality']);
  });

  it('reorder via config: execution order follows the config list', () => {
    const cfg = base();
    cfg.filters.pipeline = [
      spec('confidentiality', 'pre'),
      spec('confidentiality', 'post'),
      spec('style', 'post', 'skip'),
    ];
    expect(buildPipeline(cfg, 'post').names).toEqual(['confidentiality', 'style']);
  });

  it('a stage "both" filter is built for pre and for post', () => {
    const cfg = cfgWith([spec('confidentiality', 'both')]);
    expect(buildPipeline(cfg, 'pre').names).toEqual(['confidentiality']);
    expect(buildPipeline(cfg, 'post').names).toEqual(['confidentiality']);
  });

  it('uses injected factories (spec is passed through, unknown names rejected)', () => {
    const seen: FilterSpec[] = [];
    const factories: FilterFactories = {
      confidentiality: (s) => {
        seen.push(s);
        return { ...appender('confidentiality', { onError: 'fail-closed' }) };
      },
    };
    const cfg = cfgWith([spec('confidentiality', 'both')]);
    expect(buildPipeline(cfg, 'pre', factories).names).toEqual(['confidentiality']);
    expect(seen).toHaveLength(1);
    const cfg2 = cfgWith([spec('confidentiality', 'both'), spec('style', 'post', 'skip')]);
    expect(() => buildPipeline(cfg2, 'post', factories)).toThrow(ConfigError);
  });

  it('two enabled entries with the same name at one stage throw at build time', () => {
    const cfg = cfgWith([spec('confidentiality', 'pre'), spec('confidentiality', 'both')]);
    expect(() => buildPipeline(cfg, 'pre')).toThrow(ConfigError);
  });

  it('refuses a hand-built config without an enabled fail-closed confidentiality filter at the stage (defence in depth)', () => {
    expect(() => buildPipeline(cfgWith([spec('style', 'post', 'skip')]), 'pre')).toThrow(ConfigError);
    expect(() => buildPipeline(cfgWith([spec('confidentiality', 'pre', 'fail-closed', false)]), 'pre')).toThrow(ConfigError);
    expect(() => buildPipeline(cfgWith([spec('confidentiality', 'pre', 'skip')]), 'pre')).toThrow(ConfigError);
    expect(() => buildPipeline(cfgWith([spec('confidentiality', 'pre')]), 'post')).toThrow(ConfigError);
  });

  it('an explicit stage the filter cannot run at is a config error (style is post-only)', () => {
    const cfg = cfgWith([spec('confidentiality', 'both'), spec('style', 'pre', 'skip')]);
    expect(() => buildPipeline(cfg, 'pre')).toThrow(ConfigError);
  });

  it('the default post pipeline edits style, then redacts again', async () => {
    const p = buildPipeline(base(), 'post', defaultFactories());
    const out = await p.run('Furthermore, we ship.', ctx('post'));
    expect(out.text).toBe('We ship.');
    expect(out.trace.map((t) => t.filter)).toEqual(['style', 'confidentiality']);
  });

  it('style onError and confidentiality fail-closed come from the config entry', () => {
    const seen: Record<string, OnError> = {};
    const f: FilterFactories = {
      confidentiality: (s) => {
        seen.c = s.onError;
        return appender('confidentiality', { onError: s.onError });
      },
      style: (s) => {
        seen.s = s.onError;
        return appender('style', { onError: s.onError });
      },
    };
    buildPipeline(cfgWith([spec('confidentiality', 'both'), spec('style', 'both', 'fail-closed')]), 'post', f);
    expect(seen).toEqual({ c: 'fail-closed', s: 'fail-closed' });
  });

  it('the default confidentiality factory refuses a relaxed onError even for hand-built specs', () => {
    expect(() => defaultFactories().confidentiality?.(spec('confidentiality', 'pre', 'skip'))).toThrow(ConfigError);
  });

  it('blocklist and phrase options reach the built filters', async () => {
    const factories = defaultFactories({ confidentiality: { blocklist: ['Acme'] }, style: { phrases: [{ pattern: 'synergy', replacement: 'teamwork' }] } });
    const pre = await buildPipeline(base(), 'pre', factories).run('Acme synergy', ctx('pre'));
    expect(pre.text).toBe('[REDACTED:blocklist] synergy');
    const post = await buildPipeline(base(), 'post', factories).run('Acme synergy', ctx('post'));
    expect(post.text).toBe('[REDACTED:blocklist] teamwork');
  });

  it('persona banned phrases flow from ctx into the built style filter (defect 9)', async () => {
    const out = await buildPipeline(base(), 'post').run('Obviously, we ship.', { ...ctx('post'), extraBannedPhrases: ['obviously'] });
    expect(out.text).toBe('We ship.');
  });

  it('names that exist on Object.prototype are not factories', () => {
    const cfg = cfgWith([spec('confidentiality', 'both'), spec('constructor', 'post', 'skip')]);
    expect(() => buildPipeline(cfg, 'post')).toThrow(ConfigError);
  });

  it('a factory that returns a differently named filter is rejected', () => {
    const f: FilterFactories = { confidentiality: () => appender('other', { onError: 'fail-closed' }) };
    expect(() => buildPipeline(cfgWith([spec('confidentiality', 'both')]), 'pre', f)).toThrow(ConfigError);
  });

  it('a built pipeline refuses a wrong or missing ctx.stage instead of passing text through (CR-02)', async () => {
    const pre = buildPipeline(base(), 'pre');
    const key = 'AKIA' + 'ABCDEFGHIJKLMNOP';
    await expect(pre.run(key, ctx('post'))).rejects.toThrow(ConfigError);
    await expect(pre.run(key, { ...ctx('pre'), stage: 'prE' } as unknown as PipelineContext)).rejects.toThrow(ConfigError);
    await expect(pre.run(key, {} as unknown as PipelineContext)).rejects.toThrow(ConfigError);
    expect((await pre.run(key, ctx('pre'))).text).toBe('[REDACTED:aws_key]');
  });
});
