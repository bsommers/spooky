// Phase 5 / ORC-01..05: the generate flow end to end with a scripted LLM.
import { describe, expect, it } from 'vitest';
import { ConfidentialityFilter } from '../../src/filters/confidentiality.js';
import { LlmTransportError } from '../../src/llm/retry.js';
import { ConfigError, FilterFailedError, InputTooLargeError, LlmError, UnknownAuthorError, UnknownPersonaError } from '../../src/models/errors.js';
import { FilterPipeline } from '../../src/filters/pipeline.js';
import { SpyFilter, corpus, fastRetry, makeRig } from '../helpers/rig.js';
import { Orchestrator } from '../../src/orchestration/orchestrator.js';

const KEY = 'AKIAIOSFODNN7EXAMPLE';
const run = (r: Awaited<ReturnType<typeof makeRig>>, input = 'Please summarize the rollout plan.') => r.orchestrator.generate('terse', 'exec', input);
const calm = (n: number): string => `The plan is clear and concise number ${n}.`;

describe('orchestrator: happy path', () => {
  it('returns text, trace in order pre -> llm -> post, and a token estimate', async () => {
    const r = await makeRig([calm(1)]);
    const out = await run(r);
    expect(out.text).toContain('The plan is clear');
    expect(out.trace.map((t) => t.filter)).toEqual(['confidentiality', 'llm', 'style', 'confidentiality']);
    expect(out.trace[1]?.metadata).toMatchObject({ attempts: 1 });
    expect(out.promptTokensEstimate).toBeGreaterThan(0);
    expect(r.llm.callCount).toBe(1);
  });

  it('sends options through and builds the prompt from the persona and profile', async () => {
    const r = await makeRig([calm(1)]);
    await r.orchestrator.generate('terse', 'exec', 'Rewrite this.', { maxTokens: 77, temperature: 0.1, exemplarCount: 2 });
    const req = r.llm.requests[0]!;
    expect(req.maxTokens).toBe(77);
    expect(req.temperature).toBe(0.1);
    expect(req.system).toContain('Executive');
    expect(req.system).toContain('lead with the decision');
    expect(req.system).toContain('Terse Author');
    expect(req.user).toContain('<input>');
    expect((req.user.match(/<exemplar>/g) ?? []).length).toBeLessThanOrEqual(2);
  });

  it('exemplarCount 0 retrieves nothing', async () => {
    const r = await makeRig([calm(1)]);
    let retrieved = 0;
    const sources = { getProfile: r.sources.getProfile.bind(r.sources), retrieve: async () => (retrieved++, []) };
    const o = new Orchestrator({ ...r.deps, sources });
    await o.generate('terse', 'exec', 'hello world', { exemplarCount: 0 });
    expect(retrieved).toBe(0);
    expect(r.llm.requests[0]!.user).not.toContain('<exemplars>');
  });

  it('is deterministic: same input twice gives the same text, prompt and trace shape', async () => {
    const r = await makeRig([calm(1), calm(1)]);
    const a = await run(r);
    const b = await run(r);
    const strip = (t: typeof a.trace) => t.map(({ ms: _ms, ...rest }) => rest);
    expect(a.text).toBe(b.text);
    expect(a.promptTokensEstimate).toBe(b.promptTokensEstimate);
    expect(strip(a.trace)).toEqual(strip(b.trace));
    expect(r.llm.requests[0]).toEqual(r.llm.requests[1]);
  });

  it('post stage context carries the profile and the persona banned phrases', async () => {
    const spy = new SpyFilter('probe', ['post'], 'skip');
    const base = await makeRig([calm(1)]);
    const post = new FilterPipeline({ stage: 'post', requireConfidentiality: true }).register(spy).register(new ConfidentialityFilter());
    const o = new Orchestrator({ ...base.deps, post });
    await o.generate('terse', 'exec', 'hello there', {});
    expect(spy.calls[0]?.ctx.profile?.authorId).toBe('terse');
    expect(spy.calls[0]?.ctx.extraBannedPhrases).toEqual(['synergy']);
    expect(spy.calls[0]?.ctx.stage).toBe('post');
  });
});

describe('orchestrator: confidentiality ordering', () => {
  it('a secret in the input never reaches the LLM request or the retrieval query', async () => {
    const r = await makeRig([calm(1)]);
    const queries: string[] = [];
    const sources = {
      getProfile: r.sources.getProfile.bind(r.sources),
      retrieve: (a: string, q: string, k: number) => (queries.push(q), r.sources.retrieve(a, q, k)),
    };
    const o = new Orchestrator({ ...r.deps, sources });
    await o.generate('terse', 'exec', `Deploy with key ${KEY} today, please.`);
    const req = r.llm.requests[0]!;
    expect(req.system + req.user).not.toContain(KEY);
    expect(req.user).toContain('[REDACTED:');
    expect(queries).toHaveLength(1);
    expect(queries[0]).not.toContain(KEY);
  });

  it('a secret echoed by the LLM is stripped from the final text', async () => {
    const r = await makeRig([`Here you go: ${KEY} and the rest.`]);
    const out = await run(r);
    expect(out.text).not.toContain(KEY);
    expect(out.text).toContain('[REDACTED:');
  });

  it('config blocklist reaches both stages', async () => {
    const r = await makeRig(['Falcon returns on Monday.'], {
      config: { llm: { model: 'm' }, personas: [{ key: 'exec', name: 'E', cognitiveLoad: 'l', informationDensity: 'm', structuralMandates: [], bannedPhrases: [] }], confidentiality: { blocklist: ['Falcon'] } },
    });
    const out = await r.orchestrator.generate('terse', 'exec', 'Tell them about Falcon.');
    expect(r.llm.requests[0]!.user).not.toContain('Falcon');
    expect(out.text).not.toContain('Falcon');
  });

  it('a pre pipeline whose trace shows no confidentiality run fails closed before the LLM', async () => {
    const r = await makeRig([calm(1)]);
    const fake = { names: [], run: async (text: string) => ({ text, trace: [] }) } as unknown as FilterPipeline;
    const o = new Orchestrator({ ...r.deps, pre: fake });
    await expect(o.generate('terse', 'exec', 'hello')).rejects.toBeInstanceOf(FilterFailedError);
    expect(r.llm.callCount).toBe(0);
  });

  it('a post pipeline without a successful confidentiality entry returns no text', async () => {
    const r = await makeRig([calm(1)]);
    const fake = { names: [], run: async (text: string) => ({ text, trace: [{ filter: 'confidentiality', modified: false, ms: 0, metadata: {}, error: 'Error' }] }) } as unknown as FilterPipeline;
    const o = new Orchestrator({ ...r.deps, post: fake });
    await expect(o.generate('terse', 'exec', 'hello')).rejects.toBeInstanceOf(FilterFailedError);
  });
});

describe('orchestrator: rejections happen before any LLM call or filter', () => {
  it('unknown persona', async () => {
    const r = await makeRig([calm(1)]);
    await expect(r.orchestrator.generate('terse', 'nope', 'hi')).rejects.toBeInstanceOf(UnknownPersonaError);
    expect(r.llm.callCount).toBe(0);
  });
  it('unknown author', async () => {
    const r = await makeRig([calm(1)]);
    await expect(r.orchestrator.generate('ghost', 'exec', 'hi')).rejects.toBeInstanceOf(UnknownAuthorError);
    expect(r.llm.callCount).toBe(0);
  });
  it('unknown persona wins before client construction; llm factory not called', async () => {
    const r = await makeRig([calm(1)]);
    let made = 0;
    const o = new Orchestrator({ ...r.deps, llm: () => (made++, r.llm) });
    await expect(o.generate('terse', 'nope', 'hi')).rejects.toBeInstanceOf(UnknownPersonaError);
    await expect(o.generate('ghost', 'exec', 'hi')).rejects.toBeInstanceOf(UnknownAuthorError);
    expect(made).toBe(0);
  });
  it('a client factory ConfigError (missing key) surfaces as ConfigError with no filter run', async () => {
    const spy = new SpyFilter('confidentiality', ['pre', 'post'], 'fail-closed', new ConfidentialityFilter());
    const r = await makeRig([calm(1)], { factories: { confidentiality: () => spy, style: () => new SpyFilter('style', ['post'], 'skip') }, ingest: false });
    await r.sources.ingest('terse', 'T', corpus());
    const before = spy.calls.length;
    const o = new Orchestrator({ ...r.deps, llm: () => { throw new ConfigError('environment variable X is not set'); } });
    await expect(o.generate('terse', 'exec', 'hi there')).rejects.toBeInstanceOf(ConfigError);
    expect(spy.calls.length).toBe(before);
  });
  it('input over the cap -> InputTooLargeError and no filter ran', async () => {
    const spy = new SpyFilter('confidentiality', ['pre', 'post'], 'fail-closed', new ConfidentialityFilter());
    const r = await makeRig([calm(1)], { factories: { confidentiality: () => spy, style: () => new SpyFilter('style', ['post'], 'skip') } });
    const before = spy.calls.length; // ingest ran the pre filter
    await expect(r.orchestrator.generate('terse', 'exec', 'x'.repeat(5001))).rejects.toBeInstanceOf(InputTooLargeError);
    expect(spy.calls.length).toBe(before);
    expect(r.llm.callCount).toBe(0);
    await expect(r.orchestrator.generate('terse', 'exec', 'x'.repeat(5000))).resolves.toBeDefined();
  });
  it('blank / non-string input, bad options', async () => {
    const r = await makeRig([calm(1)]);
    await expect(r.orchestrator.generate('terse', 'exec', '   ')).rejects.toBeInstanceOf(ConfigError);
    await expect(r.orchestrator.generate('terse', 'exec', 5 as unknown as string)).rejects.toBeInstanceOf(ConfigError);
    for (const bad of [{ exemplarCount: -1 }, { exemplarCount: 1.5 }, { exemplarCount: 21 }, { maxTokens: 0 }, { temperature: 2 }, { temperature: Number.NaN }]) {
      await expect(r.orchestrator.generate('terse', 'exec', 'hi', bad)).rejects.toBeInstanceOf(ConfigError);
    }
    expect(r.llm.callCount).toBe(0);
  });
});

describe('orchestrator: filter failures', () => {
  const failing = (stage: 'pre' | 'post') => {
    const boom = new SpyFilter('confidentiality', [stage], 'fail-closed', undefined, new Error('boom'));
    const ok = new SpyFilter('confidentiality', [stage === 'pre' ? 'post' : 'pre'], 'fail-closed', new ConfidentialityFilter());
    return { boom, ok };
  };
  it('fail-closed pre filter throws -> FilterFailedError and no LLM call', async () => {
    const { boom } = failing('pre');
    const r = await makeRig([calm(1)], { ingest: false });
    const pre = new FilterPipeline({ stage: 'pre', requireConfidentiality: true }).register(boom);
    const o = new Orchestrator({ ...r.deps, pre, sources: { getProfile: () => ({ authorId: 'terse', displayName: 'T', avgSentenceLength: 1, sentenceLengthStdDev: 0, lexicalDensityRatio: 1, preferredPunctuation: [], hedgingFrequency: 0, activePassiveRatio: 0, commonTransitionWords: [], vectorCollectionName: 'c', corpusWordCount: 1 }), retrieve: async () => [] } });
    await expect(o.generate('terse', 'exec', 'hello')).rejects.toBeInstanceOf(FilterFailedError);
    expect(r.llm.callCount).toBe(0);
  });
  it('fail-closed post filter throws -> FilterFailedError and no text', async () => {
    const r = await makeRig([calm(1)]);
    const post = new FilterPipeline({ stage: 'post', requireConfidentiality: true }).register(new SpyFilter('confidentiality', ['post'], 'fail-closed', undefined, new Error('boom')));
    const o = new Orchestrator({ ...r.deps, post });
    await expect(o.generate('terse', 'exec', 'hello')).rejects.toBeInstanceOf(FilterFailedError);
    expect(r.llm.callCount).toBe(1);
  });
  it('a skip-policy style filter failure is traced and generation continues', async () => {
    const r = await makeRig([calm(1)], {
      factories: { confidentiality: () => new ConfidentialityFilter(), style: () => new SpyFilter('style', ['post'], 'skip', undefined, new Error('x')) },
    });
    const out = await run(r);
    const style = out.trace.find((t) => t.filter === 'style');
    expect(style?.error).toBe('Error');
    expect(out.text).toContain('The plan is clear');
  });
});

describe('orchestrator: LLM failures', () => {
  const transient = () => new LlmTransportError('http', { status: 503 });
  it('fail, fail, ok -> succeeds with attempts=3', async () => {
    const r = await makeRig([transient(), transient(), calm(1)]);
    const out = await run(r);
    expect(out.trace.find((t) => t.filter === 'llm')?.metadata.attempts).toBe(3);
    expect(r.llm.callCount).toBe(3);
  });
  it('three transient failures -> LlmError(attempts=3), no text, no post filter', async () => {
    const r = await makeRig([transient(), transient(), transient(), calm(1)]);
    const err = await run(r).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).attempts).toBe(3);
    expect(r.llm.callCount).toBe(3);
  });
  it('a non-retryable 400 is not retried', async () => {
    const r = await makeRig([new LlmTransportError('http', { status: 400 }), calm(1)]);
    const err = await run(r).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).attempts).toBe(1);
    expect(r.llm.callCount).toBe(1);
  });
  it('a plain Error from the client is terminal', async () => {
    const r = await makeRig([new Error('kaboom'), calm(1)]);
    await expect(run(r)).rejects.toBeInstanceOf(LlmError);
    expect(r.llm.callCount).toBe(1);
  });
  it('empty, whitespace, non-string and oversized answers are LlmError, never an empty success', async () => {
    for (const bad of ['', '   \n', undefined, null, 5, 'x'.repeat(4 * 1024 * 1024 + 1)]) {
      const r = await makeRig([bad as string]);
      const err = await run(r).catch((e: unknown) => e);
      expect(err, String(typeof bad)).toBeInstanceOf(LlmError);
      expect((err as LlmError).attempts).toBe(1);
    }
  });
  it('the error and its cause carry no prompt text or secret', async () => {
    const r = await makeRig([new Error(`leak ${KEY}`)]);
    const err = (await r.orchestrator.generate('terse', 'exec', `key ${KEY} here`).catch((e: unknown) => e)) as LlmError;
    expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain(KEY);
    expect(String((err.cause as Error).message)).not.toContain(KEY);
  });
  it('maxRetries from config bounds the attempts (retry option can lower, config governs the default)', async () => {
    const r = await makeRig([transient(), transient(), calm(1)], { deps: { retry: { ...fastRetry, maxRetries: 0 } } });
    const err = await run(r).catch((e: unknown) => e);
    expect((err as LlmError).attempts).toBe(1);
  });
});

describe('orchestrator: persona banned phrases', () => {
  it('a surviving banned phrase is flagged in the trace and the text is still returned', async () => {
    // The real style filter strips persona-banned phrases; with it out of the way the phrase survives and is flagged.
    const r = await makeRig(['We expect great Synergy across teams.'], {
      factories: { confidentiality: () => new ConfidentialityFilter(), style: () => new SpyFilter('style', ['post'], 'skip') },
    });
    const out = await run(r);
    expect(out.text).toContain('Synergy');
    const entry = out.trace.at(-1)!;
    expect(entry.filter).toBe('persona-banned');
    expect(entry.metadata).toEqual({ found: true, count: 1 });
    expect(JSON.stringify(entry)).not.toMatch(/synergy/i);
  });
  it('no entry when nothing matches', async () => {
    const r = await makeRig([calm(1)]);
    expect((await run(r)).trace.some((t) => t.filter === 'persona-banned')).toBe(false);
  });
});

describe('orchestrator: concurrency', () => {
  it('parallel generates do not mix requests', async () => {
    const r = await makeRig((req: { user: string }) => `echo ${req.user.includes('alpha') ? 'A' : 'B'} done fine`);
    const [a, b] = await Promise.all([
      r.orchestrator.generate('terse', 'exec', 'alpha input here'),
      r.orchestrator.generate('terse', 'exec', 'beta input here'),
    ]);
    expect(a.text).toContain('echo A');
    expect(b.text).toContain('echo B');
  });
});

describe('orchestrator: real style filter', () => {
  it('removes the persona banned phrase on its own (no flag needed)', async () => {
    const r = await makeRig(['We expect great synergy across teams.']);
    const out = await run(r);
    expect(out.text.toLowerCase()).not.toContain('synergy');
    expect(out.trace.some((t) => t.filter === 'persona-banned')).toBe(false);
  });
});
