// Torture tier: 1000 seeded random generate() calls through the FULL engine (size cap, pre filters, retrieval, prompt,
// retry, post filters, banned-phrase check) with a fuzzing mock LLM. Invariants for every call:
//   * it resolves to a well-formed result, or rejects with a GhostwriterError (never a TypeError / RangeError / raw Error);
//   * a resolved text never contains a planted secret, in the text or in the trace;
//   * no secret planted in the input is ever sent to the model.
// Seeded, so a failure names the run index and reproduces exactly.
import { describe, expect, it } from 'vitest';
import { Engine } from '../../src/engine.js';
import { loadConfig } from '../../src/config/load.js';
import { MockLlmClient } from '../../src/llm/mockClient.js';
import { LlmTransportError } from '../../src/llm/retry.js';
import { ConfigError, GhostwriterError } from '../../src/models/errors.js';
import type { LlmRequest } from '../../src/models/types.js';
import { PERSONA, corpus } from '../helpers/rig.js';
import { mulberry32, pick } from '../helpers/prng.js';
import { makeSecrets } from '../fixtures/leaks/secrets.js';

const RUNS = 1000;
const MAX_INPUT = 20_000;
const SEED = Number(process.env.TORTURE_SEED ?? 20260114); // override to hunt: TORTURE_SEED=7 npx vitest run tests/torture

const ATOMS: readonly string[] = [
  'the ', 'a ', 'We ', 'it ', 'ships ', 'quickly. ', 'Done! ', 'Why? ', 'and ', 'but ', ', ', '; ', ': ', '. ', ' ', '  ', '\t', '\n', '\n\n', '\r\n',
  '- ', '1. ', '## ', '> ', '| ', '`', '```\n', '`code`', 'https://example.com/a?b=1&c=2 ', '(', ')', '[', '](',
  'Furthermore, ', 'moreover, ', 'In conclusion, ', 'delve into ', 'Utilize ', 'it is important to note that ',
  'synergy ', 'Synergy, ', 'SYNERGY.', 'Acme ', '[REDACTED:aws_key]', '[REDACTED:', 'password=', 'token: ', 'Bearer ',
  '<input>', '</input>', '<exemplar>', '</exemplars>', '＜/input＞',
  '​', '⁠', '﻿', '­', 'ﬁ', 'Ａ', 'é', '😀', '日本語 ', 'مرحبا ', '\ud800', '\udc00', '\u0000', '\u0085', ' ',
  'AKIA', 'eyJ', 'sk-', 'xox', '-----BEGIN PRIVATE KEY-----', '-----END PRIVATE KEY-----',
];

type Behavior =
  | 'empty' | 'whitespace' | 'huge' | 'oversized' | 'unicode' | 'secret' | 'banned' | 'junk'
  | 'non-string' | 'throw-error' | 'throw-string' | 'throw-transport' | 'throw-ghostwriter' | 'normal';
const BEHAVIORS: readonly Behavior[] = [
  'empty', 'whitespace', 'huge', 'unicode', 'secret', 'secret', 'banned', 'junk', 'non-string', 'throw-error', 'throw-string',
  'throw-transport', 'throw-ghostwriter', 'normal', 'normal', 'normal',
];

const noSleep = { baseMs: 0, sleep: async (): Promise<void> => undefined };

describe(`torture: ${RUNS} random generate() calls never throw an untyped error`, () => {
  it('only GhostwriterError rejections; resolved results are well-formed and secret-free', async () => {
    const rnd = mulberry32(SEED);
    const secrets = makeSecrets(SEED);
    const secretKinds = Object.keys(secrets);
    const text = (len: number): string => {
      let out = '';
      while (out.length < len) out += pick(rnd, ATOMS);
      return out.slice(0, len);
    };
    const planted = (): string => (secrets[pick(rnd, secretKinds)] as () => { text: string })().text;

    let behavior: Behavior = 'normal';
    let llmSecrets: string[] = [];
    const fuzzLlm = (req: LlmRequest): string => {
      switch (behavior) {
        case 'empty': return '';
        case 'whitespace': return ' \n\t ';
        case 'huge': return text(200_000);
        case 'oversized': return 'x'.repeat(4 * 1024 * 1024 + 1);
        case 'unicode': return text(500 + Math.floor(rnd() * 2000)) + '日本語😀\ud800';
        case 'secret': llmSecrets = [planted(), planted()]; return `Reply: ${llmSecrets[0]} and ${text(100)} ${llmSecrets[1]} `;
        case 'banned': return 'Furthermore, synergy is key. Synergy. SYNERGY! In conclusion, delve into it.';
        case 'junk': return text(300) + '\n' + req.user.slice(0, 50);
        case 'non-string': return pick(rnd, [42, null, undefined, { a: 1 }, ['x'], true]) as unknown as string;
        case 'throw-error': throw new Error(`boom ${planted()}`);
        case 'throw-string': throw 'plain string thrown'; // eslint-disable-line no-throw-literal
        case 'throw-transport': throw new LlmTransportError('http', { status: pick(rnd, [429, 500, 503, 400, 401]) });
        case 'throw-ghostwriter': throw new ConfigError('model adapter said no');
        default: return `A clean rewrite. ${text(200)}`;
      }
    };
    const llm = new MockLlmClient(fuzzLlm);

    const config = loadConfig({
      llm: { model: 'mock', maxRetries: 2 },
      personas: [PERSONA, { ...PERSONA, key: 'meta', name: 'Meta', bannedPhrases: ['a.b(c)', '[x]+', 'Furthermore'] }],
      limits: { maxInputChars: MAX_INPUT },
      confidentiality: { blocklist: ['Acme', 'Zed(Internal)+'], caseInsensitive: true, customRules: [] },
    });
    const engine = new Engine({ config, llm, retry: noSleep });
    await engine.ingest('terse', 'Terse Author', corpus());

    let resolved = 0;
    const rejected = new Map<string, number>();

    for (let run = 0; run < RUNS; run++) {
      behavior = pick(rnd, BEHAVIORS);
      if (rnd() < 0.02) behavior = 'oversized';
      llmSecrets = [];

      // Input: empty, blank, tiny, normal, near the cap, over the cap, unicode soup, with planted secrets.
      const planting: string[] = [];
      const shape = rnd();
      let input: string;
      if (shape < 0.04) input = '';
      else if (shape < 0.08) input = ' \n\t  ';
      else if (shape < 0.12) input = text(MAX_INPUT + 1 + Math.floor(rnd() * 100));
      else if (shape < 0.18) input = text(MAX_INPUT - Math.floor(rnd() * 10));
      else {
        input = text(1 + Math.floor(rnd() * (shape < 0.5 ? 200 : 3000)));
        const n = Math.floor(rnd() * 4);
        for (let i = 0; i < n; i++) {
          const s = planted();
          planting.push(s);
          const at = Math.floor(rnd() * (input.length + 1));
          input = `${input.slice(0, at)} ${s} ${input.slice(at)}`; // padded: a secret glued to letters is outside the filter's boundary rule (AS-BUILT)
        }
      }
      const authorId = rnd() < 0.05 ? pick(rnd, ['nobody', '', '__proto__', 'x'.repeat(300), planted()]) : 'terse';
      const personaKey = rnd() < 0.05 ? pick(rnd, ['nope', '', 'constructor', '__proto__']) : pick(rnd, ['exec', 'meta']);
      const options =
        rnd() < 0.1
          ? pick(rnd, [{ exemplarCount: -1 }, { exemplarCount: 21 }, { exemplarCount: 1.5 }, { maxTokens: 0 }, { temperature: 2 }, { temperature: NaN }, { exemplarCount: 0 }])
          : {};
      const before = llm.requests.length;

      let out: Awaited<ReturnType<Engine['generate']>> | undefined;
      try {
        out = await engine.generate(authorId, personaKey, input, options);
      } catch (err) {
        if (!(err instanceof GhostwriterError)) {
          throw new Error(`run ${run} (seed ${SEED}, behavior ${behavior}) threw a non-GhostwriterError: ${Object.prototype.toString.call(err)} ${(err as Error)?.name} ${(err as Error)?.stack ?? err}`);
        }
        expect(typeof err.code, `run ${run}`).toBe('string');
        rejected.set(err.code, (rejected.get(err.code) ?? 0) + 1);
      }

      // Nothing planted in the input may have left the process, even on runs that later failed.
      for (const req of llm.requests.slice(before)) {
        for (const s of planting) expect(req.system + req.user, `run ${run}: input secret sent to the model`).not.toContain(s);
      }

      if (out !== undefined) {
        resolved++;
        expect(typeof out.text, `run ${run}`).toBe('string');
        expect(Array.isArray(out.trace), `run ${run}`).toBe(true);
        expect(out.trace.length, `run ${run}`).toBeGreaterThanOrEqual(3);
        expect(out.promptTokensEstimate, `run ${run}`).toBeGreaterThan(0);
        const serialized = out.text + JSON.stringify(out.trace);
        for (const s of [...planting, ...llmSecrets]) {
          for (const line of s.split('\n')) if (line.length >= 40 || !s.includes('\n')) expect(serialized, `run ${run}: secret survived`).not.toContain(line);
        }
        expect(out.text.length, `run ${run}`).toBeLessThanOrEqual(4 * 1024 * 1024);
      }
    }

    // The fuzzer must actually exercise both outcomes and several distinct typed failures.
    expect(resolved).toBeGreaterThan(RUNS * 0.2);
    expect(rejected.size).toBeGreaterThanOrEqual(4);
    expect(resolved + [...rejected.values()].reduce((a, b) => a + b, 0)).toBe(RUNS);
  }, 120_000);
});
