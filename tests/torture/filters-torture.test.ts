import { describe, expect, it } from 'vitest';
import { DEFAULT_PHRASES } from '../../config/phrases.js';
import { loadConfig } from '../../src/config/load.js';
import { ConfidentialityFilter } from '../../src/filters/confidentiality.js';
import { splitProtected } from '../../src/filters/protectedSpans.js';
import { buildPipeline, defaultFactories } from '../../src/filters/registry.js';
import type { PipelineContext, StylometricProfile } from '../../src/models/types.js';
import { makeSecrets } from '../fixtures/leaks/secrets.js';
import { mulberry32, pick } from '../helpers/prng.js';

const RUNS = 200;
const LENGTH = 10_000;
const BLOCKLIST = ['Acme Corp', 'Acme', 'Zed(Internal)+'];

const PROFILE: StylometricProfile = {
  authorId: 'a',
  displayName: 'A',
  avgSentenceLength: 9,
  sentenceLengthStdDev: 5,
  lexicalDensityRatio: 0.5,
  preferredPunctuation: [';'],
  hedgingFrequency: 1,
  activePassiveRatio: 0.5,
  commonTransitionWords: ['but'],
  vectorCollectionName: 'c',
  corpusWordCount: 1000,
};

// Text atoms: prose, markdown structure, protected-span openers/closers, banned phrases, evasion characters, odd code units.
const ATOMS: readonly string[] = [
  'the ', 'a ', 'We ', 'it ', 'ships ', 'quickly. ', 'Done! ', 'Why? ', 'and ', 'but ', ', ', '; ', ': ', '. ', ' ', '  ', '\t', '\n', '\n\n', '\r\n',
  '- ', '1. ', '## ', '> ', '| ', '`', '``', '```\n', '~~~\n', '`code`', 'https://example.com/a?b=1&c=2 ', 'http://x.y/z.', '(', ')', '[', '](',
  'Furthermore, ', 'moreover, ', 'In conclusion, ', 'delve into ', 'Utilize ', 'it is important to note that ', "it's worth noting that ",
  'Acme Corp ', 'acme ', 'Zed(Internal)+ ', '[REDACTED:aws_key]', '[REDACTED:', 'REDACTED:x]', 'password=', 'token: ', '?token=', 'Bearer ',
  '​', '⁠', '﻿', '­', 'ﬁ', 'Ａ', 'é', '😀', '\ud800', '\udc00', '\u0000', 'e.g. ', 'Dr. ', '3.5 ',
  'AKIA', 'eyJ', 'sk-', 'xox', '-----BEGIN PRIVATE KEY-----', '-----END PRIVATE KEY-----',
];

const ctx = (stage: 'pre' | 'post', withProfile: boolean, extra: readonly string[] = []): PipelineContext => ({
  authorId: 'a',
  personaKey: 'p',
  stage,
  ...(withProfile ? { profile: PROFILE } : {}),
  ...(extra.length ? { extraBannedPhrases: extra } : {}),
});

/** Every protected segment of `input` must appear, byte for byte and in order, in `output`. */
function protectedSegmentsSurvive(input: string, output: string): boolean {
  let from = 0;
  for (const seg of splitProtected(input)) {
    if (!seg.protected) continue;
    const at = output.indexOf(seg.text, from);
    if (at === -1) return false;
    from = at + seg.text.length;
  }
  return true;
}

describe('torture: filters', () => {
  it(`${RUNS} random ${LENGTH}-char strings through full pre+post: never throws, confidentiality idempotent, planted secrets gone, protected spans unchanged`, () => {
    const rnd = mulberry32(0xf17e5);
    const cfg = loadConfig({ llm: { model: 'm' } });
    const options = { confidentiality: { blocklist: BLOCKLIST, customRules: [{ name: 'employee_id', pattern: 'EMP-\\d{6}' }] }, style: { phrases: DEFAULT_PHRASES } };
    const factories = defaultFactories(options);
    const conf = new ConfidentialityFilter(options.confidentiality);
    const gens = makeSecrets(99);
    const kinds = Object.keys(gens);

    return (async () => {
      let plantedTotal = 0;
      let styleEdited = 0;
      let protectedTotal = 0;
      for (let run = 0; run < RUNS; run++) {
        // random text with a few planted secrets, each fenced by whitespace so a left boundary is not an excuse
        let text = '';
        const planted: string[] = [];
        while (text.length < LENGTH) {
          text += pick(rnd, ATOMS);
          if (rnd() < 0.004) {
            const s = (gens[pick(rnd, kinds)] as () => { values: string[]; text: string })();
            text += `\n${s.text}\n`;
            planted.push(...s.values.filter((v) => v.length >= 16));
          }
        }

        plantedTotal += planted.length;
        // 1. confidentiality: idempotent, no planted secret survives
        const once = conf.redact(text).text;
        expect(conf.redact(once).text).toBe(once);
        for (const p of planted) expect(once).not.toContain(p);

        // 2. the full configured pipeline: pre, then (the "LLM output") post, with and without a profile
        const withProfile = run % 2 === 0;
        const pre = await buildPipeline(cfg, 'pre', factories).run(text, ctx('pre', false));
        const post = await buildPipeline(cfg, 'post', factories).run(pre.text, ctx('post', withProfile, ['obviously', 'trivially']));
        for (const t of [...pre.trace, ...post.trace]) expect(t.error).toBeUndefined();
        for (const p of planted) {
          expect(pre.text).not.toContain(p);
          expect(post.text).not.toContain(p);
        }
        // the final text is a fixed point of confidentiality (post stage re-ran it last)
        expect(conf.redact(post.text).text).toBe(post.text);

        // 3. style alone leaves protected spans of its input untouched
        const style = (await factories.style!({ name: 'style', stage: 'post', onError: 'skip', enabled: true }).process(pre.text, ctx('post', withProfile)))
          .content;
        expect(protectedSegmentsSurvive(pre.text, style)).toBe(true);
        if (style !== pre.text) styleEdited++;
        protectedTotal += splitProtected(pre.text).filter((x) => x.protected).length;
      }
      // guard against a vacuous run: the generator really exercised every property
      expect(plantedTotal).toBeGreaterThan(300);
      expect(styleEdited).toBeGreaterThan(RUNS / 2);
      expect(protectedTotal).toBeGreaterThan(RUNS * 10);
    })();
  }, 120_000);
});
