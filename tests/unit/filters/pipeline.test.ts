import { describe, expect, it } from 'vitest';
import { FilterPipeline } from '../../../src/filters/pipeline.js';
import { ConfigError, FilterFailedError } from '../../../src/models/errors.js';
import type { Filter, FilterResult, OnError, PipelineContext, Stage } from '../../../src/models/types.js';

const ctx = (stage: Stage = 'pre'): PipelineContext => ({ authorId: 'a', personaKey: 'p', stage });

interface Opts {
  stages?: readonly Stage[];
  onError?: OnError;
  delayMs?: number;
}

/** Appends `-name` to the text so order of application is visible in the output. */
function appender(name: string, opts: Opts = {}): Filter {
  return {
    name,
    stages: opts.stages ?? ['pre', 'post'],
    onError: opts.onError ?? 'skip',
    async process(text: string): Promise<FilterResult> {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      return { content: `${text}-${name}`, modified: true, metadata: { seen: text.length } };
    },
  };
}

function thrower(name: string, onError: OnError, stages: readonly Stage[] = ['pre', 'post']): Filter {
  return {
    name,
    stages,
    onError,
    async process(): Promise<FilterResult> {
      throw new Error('boom SECRET-IN-MESSAGE');
    },
  };
}

function raw(name: string, onError: OnError, result: unknown): Filter {
  return {
    name,
    stages: ['pre', 'post'],
    onError,
    process: () => Promise.resolve(result as FilterResult),
  };
}

describe('FilterPipeline', () => {
  it('zero filters: text unchanged, empty trace', async () => {
    const out = await new FilterPipeline().run('hello', ctx());
    expect(out).toEqual({ text: 'hello', trace: [] });
  });

  it('order A,B: B sees the output of A; trace order A,B', async () => {
    const p = new FilterPipeline().use(appender('A')).use(appender('B'));
    const out = await p.run('x', ctx());
    expect(out.text).toBe('x-A-B');
    expect(out.trace.map((t) => t.filter)).toEqual(['A', 'B']);
    expect(out.trace[1]?.metadata).toEqual({ seen: 3 }); // B received "x-A"
    expect(out.trace.every((t) => t.modified)).toBe(true);
  });

  it('use() and register() are chainable and equivalent', async () => {
    const p = new FilterPipeline();
    expect(p.use(appender('A'))).toBe(p);
    expect(p.register(appender('B'))).toBe(p);
    expect(p.names).toEqual(['A', 'B']);
  });

  it('stage filtering: a pre-only filter is not run in the post stage (and vice versa)', async () => {
    const p = new FilterPipeline().use(appender('P', { stages: ['pre'] })).use(appender('Q', { stages: ['post'] }));
    const pre = await p.run('x', ctx('pre'));
    expect(pre.text).toBe('x-P');
    expect(pre.trace.map((t) => t.filter)).toEqual(['P']);
    const post = await p.run('x', ctx('post'));
    expect(post.text).toBe('x-Q');
    expect(post.trace.map((t) => t.filter)).toEqual(['Q']);
  });

  it('async filter with a delay is awaited and ms reflects it', async () => {
    const out = await new FilterPipeline().use(appender('slow', { delayMs: 30 })).run('x', ctx());
    expect(out.text).toBe('x-slow');
    // timers may fire up to ~1ms early relative to performance.now()
    expect(out.trace[0]?.ms).toBeGreaterThanOrEqual(29);
  });

  it('fail-closed filter that throws: FilterFailedError(filter=name), later filters not run, no text returned', async () => {
    let laterRan = false;
    const later: Filter = {
      name: 'later',
      stages: ['pre'],
      onError: 'skip',
      process: async (t) => {
        laterRan = true;
        return { content: t, modified: false, metadata: {} };
      },
    };
    const p = new FilterPipeline().use(thrower('guard', 'fail-closed')).use(later);
    const err = await p.run('top secret', ctx()).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(FilterFailedError);
    expect((err as FilterFailedError).filter).toBe('guard');
    expect((err as FilterFailedError).code).toBe('FILTER_FAILED');
    expect(laterRan).toBe(false);
  });

  it('fail-closed filter that throws synchronously is also caught', async () => {
    const f: Filter = {
      name: 'sync',
      stages: ['pre'],
      onError: 'fail-closed',
      process: () => {
        throw new Error('sync boom');
      },
    };
    await expect(new FilterPipeline().use(f).run('x', ctx())).rejects.toBeInstanceOf(FilterFailedError);
  });

  it('skip filter that throws: trace error set, text = previous, later filters still run', async () => {
    const p = new FilterPipeline().use(appender('A')).use(thrower('bad', 'skip')).use(appender('C'));
    const out = await p.run('x', ctx());
    expect(out.text).toBe('x-A-C');
    expect(out.trace.map((t) => t.filter)).toEqual(['A', 'bad', 'C']);
    const bad = out.trace[1];
    expect(bad?.error).toBeTypeOf('string');
    expect(bad?.modified).toBe(false);
    expect(bad?.metadata).toEqual({});
  });

  it('trace error never echoes the thrown error message (it may carry input text)', async () => {
    const out = await new FilterPipeline().use(thrower('bad', 'skip')).run('x', ctx());
    expect(JSON.stringify(out.trace)).not.toContain('SECRET-IN-MESSAGE');
  });

  it.each([
    ['content is a number', { content: 42, modified: true, metadata: {} }],
    ['content is undefined', { modified: false, metadata: {} }],
    ['result is null', null],
    ['modified is not boolean', { content: 'x', modified: 'yes', metadata: {} }],
    ['metadata holds an object value', { content: 'x', modified: false, metadata: { leak: { a: 1 } } }],
    ['metadata is missing', { content: 'x', modified: false }],
  ])('invalid filter result (%s) is a filter error: skip -> traced, fail-closed -> FilterFailedError', async (_n, bad) => {
    const skipped = await new FilterPipeline().use(raw('r', 'skip', bad)).run('orig', ctx());
    expect(skipped.text).toBe('orig');
    expect(skipped.trace[0]?.error).toBeTypeOf('string');
    await expect(new FilterPipeline().use(raw('r', 'fail-closed', bad)).run('orig', ctx())).rejects.toBeInstanceOf(
      FilterFailedError,
    );
  });

  it('registering the same name twice throws at registration', () => {
    const p = new FilterPipeline().use(appender('A'));
    expect(() => p.use(appender('A'))).toThrow(ConfigError);
  });

  it('rejects structurally invalid filters at registration', () => {
    const p = new FilterPipeline();
    expect(() => p.use({ ...appender('x'), name: '' })).toThrow(ConfigError);
    expect(() => p.use({ ...appender('y'), stages: [] })).toThrow(ConfigError);
    expect(() => p.use({ ...appender('z'), onError: 'maybe' as OnError })).toThrow(ConfigError);
  });

  it('run() does not see filters registered while it is in flight', async () => {
    const p = new FilterPipeline();
    const reg: Filter = {
      name: 'reg',
      stages: ['pre'],
      onError: 'skip',
      process: async (t) => {
        p.use(appender('late'));
        return { content: t, modified: false, metadata: {} };
      },
    };
    p.use(reg);
    const out = await p.run('x', ctx());
    expect(out.trace.map((t) => t.filter)).toEqual(['reg']);
  });

  it('modified in the trace reflects whether the text really changed', async () => {
    const noop: Filter = {
      name: 'noop',
      stages: ['pre'],
      onError: 'skip',
      process: async (t) => ({ content: t, modified: true, metadata: {} }),
    };
    const out = await new FilterPipeline().use(noop).run('same', ctx());
    expect(out.trace[0]?.modified).toBe(false);
  });

  describe('fail closed on a bad stage (CR-02)', () => {
    const secretText = 'AKIA' + 'ABCDEFGHIJKLMNOP';
    it.each([
      ['unknown stage', { stage: 'prE' }],
      ['missing stage', {}],
      ['null stage', { stage: null }],
      ['non-string stage', { stage: 1 }],
    ])('a plain pipeline rejects %s instead of passing the text through', async (_n, bad) => {
      const p = new FilterPipeline().use(appender('A'));
      await expect(p.run(secretText, bad as unknown as PipelineContext)).rejects.toThrow(ConfigError);
    });

    it('rejects an undefined context', async () => {
      await expect(new FilterPipeline().run('x', undefined as unknown as PipelineContext)).rejects.toThrow(ConfigError);
    });

    it('a pipeline built for a stage rejects a context for the other stage', async () => {
      const p = new FilterPipeline({ stage: 'pre' }).use(appender('A'));
      await expect(p.run('x', ctx('post'))).rejects.toThrow(ConfigError);
      expect((await p.run('x', ctx('pre'))).text).toBe('x-A');
    });

    it('requireConfidentiality refuses to run when no fail-closed confidentiality filter is active', async () => {
      const guarded = (f?: Filter) => {
        const p = new FilterPipeline({ requireConfidentiality: true });
        return f ? p.use(f) : p;
      };
      await expect(guarded().run('x', ctx())).rejects.toThrow(ConfigError);
      await expect(guarded(appender('style')).run('x', ctx())).rejects.toThrow(ConfigError);
      await expect(guarded(appender('confidentiality', { onError: 'skip' })).run('x', ctx())).rejects.toThrow(ConfigError);
      await expect(guarded(appender('confidentiality', { onError: 'fail-closed', stages: ['pre'] })).run('x', ctx('post'))).rejects.toThrow(
        ConfigError,
      );
      expect((await guarded(appender('confidentiality', { onError: 'fail-closed' })).run('x', ctx())).text).toBe('x-confidentiality');
    });
  });
});
