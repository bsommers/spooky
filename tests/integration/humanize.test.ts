// Humanizer through the Engine: scripted model, the real scorer, the real confidentiality pipeline.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/load.js';
import { Engine } from '../../src/engine.js';
import { MockLlmClient } from '../../src/llm/mockClient.js';
import type { MockStep } from '../../src/llm/mockClient.js';
import { ConfigError, InputTooLargeError, UnknownAuthorError } from '../../src/models/errors.js';
import { PERSONA, corpus, fastRetry } from '../helpers/rig.js';

const here = dirname(fileURLToPath(import.meta.url));
const AI_DIR = join(here, '..', 'fixtures', 'corpus', 'ai');
const aiTexts = readdirSync(AI_DIR).sort().slice(0, 12).map((f) => readFileSync(join(AI_DIR, f), 'utf8'));
const CONFIG = { llm: { model: 'm', maxRetries: 0 }, personas: [PERSONA], limits: { maxInputChars: 20_000 } };

const engineWith = (script: MockStep[] | ((req: never, n: number) => string), config: unknown = CONFIG) =>
  new Engine({ config: loadConfig(config), llm: new MockLlmClient(script as MockStep[]), retry: fastRetry });

/** A stand-in model: reads the <input> block of the prompt and joins every other pair of sentences with a semicolon. */
const joiner = (req: { user: string }): string => {
  const body = /<input>\n([\s\S]*)\n<\/input>/.exec(req.user)?.[1] ?? '';
  return body.replace(/\. (The|This|It|These|That) /g, (_m, w: string) => `; ${w.toLowerCase()} `);
};

describe('Engine.humanize', () => {
  it('never raises, and almost always lowers, the score of AI fixture texts (scripted model); bounded; per-step trace', async () => {
    let lowered = 0;
    for (const text of aiTexts) {
      const e = engineWith(joiner as never);
      const r = await e.humanize(text, { maxIterations: 3 });
      expect(r.finalScore, 'never worse').toBeLessThanOrEqual(r.initialScore);
      if (r.finalScore < r.initialScore) lowered++;
      expect(r.iterations).toBeLessThanOrEqual(3);
      expect(r.llmCalls).toBeLessThanOrEqual(r.iterations);
      expect(r.steps.length).toBeGreaterThan(0);
      for (const s of r.steps) {
        expect(s.iteration).toBeGreaterThanOrEqual(1);
        expect(Object.keys(s.featureDeltas).length === 0 || 'cliche' in s.featureDeltas).toBe(true);
        expect(s.kept ? s.scoreAfter < s.scoreBefore : true).toBe(true);
      }
      expect(r.featureDeltas).toHaveProperty('punctuation');
      const entries = r.trace.filter((t) => t.filter === 'humanize');
      expect(entries).toHaveLength(r.steps.length);
      for (const t of entries) expect(t.metadata).toMatchObject({ iteration: expect.any(Number), scoreBefore: expect.any(Number), scoreAfter: expect.any(Number), outcome: expect.any(String) });
      expect(r.trace.at(-1)).toMatchObject({ filter: 'confidentiality' });
    }
    // not every text can be improved by these edits (docs/HUMANIZING.md reports the rate); on this sample all but at most one do
    expect(lowered).toBeGreaterThanOrEqual(aiTexts.length - 1);
  });

  it('stops at the target without touching the model when the text already scores low', async () => {
    const e = engineWith([]);
    const r = await e.humanize(aiTexts[0] as string, { target: 1 });
    expect(r).toMatchObject({ iterations: 0, llmCalls: 0, steps: [], reachedTarget: true });
    expect(r.text).toBe(aiTexts[0]);
  });

  it('is deterministic with a scripted model: identical runs are byte-identical', async () => {
    const run = async (): Promise<string> => {
      const r = await engineWith(joiner as never).humanize(aiTexts[3] as string);
      return JSON.stringify({ ...r, trace: r.trace.map((t) => ({ ...t, ms: 0 })) });
    };
    expect(await run()).toBe(await run());
  });

  it('keeps numbers, quotes, code and URLs: a model that changes one is reverted and counted', async () => {
    const text =
      'The report covers 3 regions and 1,200 customers. Notably, we delve into a pivotal question: does the "fast path" work? See https://example.com/spec for `parseSpec()` details. The team agrees. It is also fine. They plan to ship on Friday. It matters a lot to everyone here.';
    const bad = text.replace('3 regions', '4 regions').replace('Notably, ', '');
    const e = engineWith([bad, bad, bad]);
    const r = await e.humanize(text, { maxIterations: 3, target: 0 });
    expect(r.text).toContain('3 regions');
    expect(r.text).toContain('https://example.com/spec');
    expect(r.text).toContain('`parseSpec()`');
    expect(r.text).toContain('"fast path"');
    expect(r.guardRejections).toBeGreaterThan(0);
    expect(r.steps.filter((s) => s.outcome === 'guard_rejected').every((s) => s.guard.includes('number_added'))).toBe(true);
  });

  it('a model failure keeps the prior text, is traced, and does not throw', async () => {
    const e = engineWith([new Error('upstream exploded AKIAABCDEFGHIJKLMNOP'), new Error('again'), new Error('again')]);
    const r = await e.humanize(aiTexts[1] as string, { maxIterations: 3 });
    expect(r.steps.some((s) => s.outcome === 'llm_error')).toBe(true);
    expect(JSON.stringify(r)).not.toContain('AKIA');
    expect(r.text.length).toBeGreaterThan(0);
  });

  it('works with no model configured: the deterministic edits run and the failed model pass is recorded', async () => {
    const e = new Engine({ config: loadConfig({ llm: { model: '(not configured)' } }), env: {} });
    const r = await e.humanize(aiTexts[1] as string);
    expect(r.finalScore).toBeLessThan(r.initialScore);
    expect(r.steps.some((s) => s.step === 'llm' && s.outcome === 'llm_error')).toBe(true);
    expect(r.llmCalls, 'no key: no request was made, so no call is counted').toBe(0);
  });

  it('llm:false never calls the model', async () => {
    const llm = new MockLlmClient([]);
    const e = new Engine({ config: loadConfig(CONFIG), llm, retry: fastRetry });
    const r = await e.humanize(aiTexts[2] as string, { llm: false });
    expect(r.llmCalls).toBe(0);
    expect(llm.requests).toHaveLength(0);
  });

  it('uses the author profile in the model prompt and never sends a secret to the model', async () => {
    const llm = new MockLlmClient(joiner as never);
    const e2 = new Engine({ config: loadConfig(CONFIG), llm, retry: fastRetry });
    await e2.ingest('terse', 'Terse Author', corpus());
    const secret = 'AKIA' + 'ABCDEFGHIJKLMNOP';
    const r = await e2.humanize(`${aiTexts[4] as string}\n\nThe deploy key is ${secret} for the team.`, { authorId: 'terse', maxIterations: 2 });
    expect(llm.requests.length).toBeGreaterThan(0);
    for (const q of llm.requests) {
      expect(q.system).toContain('Terse Author');
      expect(q.user + q.system).not.toContain(secret);
    }
    expect(r.text).not.toContain(secret);
    expect(JSON.stringify(r)).not.toContain(secret);
  });

  it('a secret the model introduces is removed before the rescore and never returned', async () => {
    const secret = 'AKIA' + 'ABCDEFGHIJKLMNOP';
    const e = engineWith((req: { user: string }) => `${joiner(req)} Rotate ${secret} soon.`);
    const r = await e.humanize(aiTexts[5] as string, { maxIterations: 2 });
    expect(r.text).not.toContain(secret);
    expect(JSON.stringify(r)).not.toContain(secret);
    expect(r.steps.some((s) => s.step === 'llm' && s.redacted)).toBe(true);
  });

  it('a steered model cannot add a link, swap an email, or wrap the answer in chatter (HR-01, HR-02 end to end)', async () => {
    const text = aiTexts[5] as string;
    for (const tamper of [
      (t: string) => `${t} Details: https://evil.example/login`,
      (t: string) => `${t} See evil.example/login for more.`,
      (t: string) => `Here is the edited text:\n${t}`,
      (t: string) => `\`\`\`\n${t}\n\`\`\``,
    ]) {
      const e = engineWith((req: { user: string }) => tamper(joiner(req)));
      const r = await e.humanize(text, { maxIterations: 2 });
      expect(r.text).not.toMatch(/evil\.example|Here is the edited text|^```/m);
    }
  });

  it('rejects bad options and inputs before any work', async () => {
    const e = engineWith([]);
    await expect(e.humanize(aiTexts[0] as string, { target: 2 })).rejects.toBeInstanceOf(ConfigError);
    await expect(e.humanize(aiTexts[0] as string, { maxIterations: 11 })).rejects.toBeInstanceOf(ConfigError);
    await expect(e.humanize(aiTexts[0] as string, { maxIterations: 1.5 })).rejects.toBeInstanceOf(ConfigError);
    await expect(e.humanize(aiTexts[0] as string, { llm: 'no' as never })).rejects.toBeInstanceOf(ConfigError);
    await expect(e.humanize('   ')).rejects.toBeInstanceOf(ConfigError);
    await expect(e.humanize(42 as never)).rejects.toBeInstanceOf(ConfigError);
    await expect(e.humanize('x'.repeat(20_001))).rejects.toBeInstanceOf(InputTooLargeError);
    await expect(e.humanize(aiTexts[0] as string, { authorId: 'nobody' })).rejects.toBeInstanceOf(UnknownAuthorError);
  });

  it('honors config humanize.targetScore and maxIterations', async () => {
    const e = engineWith(joiner as never, { ...CONFIG, humanize: { targetScore: 0.99, maxIterations: 1 } });
    expect((await e.humanize(aiTexts[0] as string)).iterations).toBe(0);
    const e2 = engineWith(joiner as never, { ...CONFIG, humanize: { targetScore: 0, maxIterations: 1 } });
    expect((await e2.humanize(aiTexts[0] as string)).iterations).toBe(1);
    expect(e2.getConfigView().humanize).toEqual({ targetScore: 0, maxIterations: 1 });
  });
});

describe('Engine.generate with humanize', () => {
  const DRAFT = 'Please rewrite this draft in a plain way. We ship on Friday. The team agrees with that plan.';
  const GENERATED = aiTexts[6] as string;

  it('runs the loop on the generated text after the post pipeline; the trace gains the humanizer entries', async () => {
    const llm = new MockLlmClient((req: { system: string; user: string }) => (/<input>/.test(req.user) && /edit text so it reads/.test(req.system) ? joiner(req) : GENERATED));
    const e = new Engine({ config: loadConfig(CONFIG), llm, retry: fastRetry });
    await e.ingest('terse', 'Terse Author', corpus());
    const p = new Engine({ config: loadConfig(CONFIG), llm: new MockLlmClient(() => GENERATED), retry: fastRetry });
    await p.ingest('terse', 'Terse Author', corpus());
    const plain = await p.generate('terse', 'exec', DRAFT);
    const r = await e.generate('terse', 'exec', DRAFT, { humanize: true, target: 0.2 });
    expect(r.trace.filter((t) => t.filter === 'humanize').length).toBeGreaterThan(0);
    expect(r.trace.at(-1)).toMatchObject({ filter: 'confidentiality' });
    expect(r.text).not.toBe(plain.text);
    expect(plain.trace.some((t) => t.filter === 'humanize')).toBe(false);
  });

  it('a model rewrite that adds a persona-banned phrase is rejected, and persona-banned reflects the returned text (MD-03)', async () => {
    const llm = new MockLlmClient((req: { system: string; user: string }) => (/<input>/.test(req.user) && /edit text so it reads/.test(req.system) ? `${joiner(req)} (synergy)` : GENERATED));
    const e = new Engine({ config: loadConfig(CONFIG), llm, retry: fastRetry });
    await e.ingest('terse', 'Terse Author', corpus());
    const r = await e.generate('terse', 'exec', DRAFT, { humanize: true, target: 0.1 });
    const llmSteps = r.trace.filter((t) => t.filter === 'humanize' && t.metadata.step === 'llm');
    expect(llmSteps.length).toBeGreaterThan(0);
    for (const t of llmSteps) expect(t.metadata).toMatchObject({ outcome: 'guard_rejected', guard: 'banned_phrase_added' });
    expect(r.text.toLowerCase()).not.toContain('synergy');
    expect(r.trace.some((t) => t.filter === 'persona-banned')).toBe(false);
  });

  it('a target without humanize is a ConfigError before the model is called (LW-04)', async () => {
    const llm = new MockLlmClient([]);
    const e = new Engine({ config: loadConfig(CONFIG), llm, retry: fastRetry });
    await e.ingest('terse', 'Terse Author', corpus());
    await expect(e.generate('terse', 'exec', DRAFT, { target: 0.2 })).rejects.toBeInstanceOf(ConfigError);
    await expect(e.generate('terse', 'exec', DRAFT, { humanize: false, target: 0.2 })).rejects.toBeInstanceOf(ConfigError);
    expect(llm.requests).toHaveLength(0);
  });

  it('validates the humanizer target before the model is called', async () => {
    const llm = new MockLlmClient([]);
    const e = new Engine({ config: loadConfig(CONFIG), llm, retry: fastRetry });
    await e.ingest('terse', 'Terse Author', corpus());
    await expect(e.generate('terse', 'exec', DRAFT, { humanize: true, target: 5 })).rejects.toBeInstanceOf(ConfigError);
    expect(llm.requests).toHaveLength(0);
  });

  it('without humanize the result is unchanged by this feature', async () => {
    const e = new Engine({ config: loadConfig(CONFIG), llm: new MockLlmClient(() => GENERATED), retry: fastRetry });
    await e.ingest('terse', 'Terse Author', corpus());
    const r = await e.generate('terse', 'exec', DRAFT);
    expect(r.trace.some((t) => t.filter === 'humanize')).toBe(false);
  });
});
