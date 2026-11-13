import { describe, expect, it } from 'vitest';
import { ConfidentialityFilter } from '../../src/filters/confidentiality.js';
import { FilterPipeline } from '../../src/filters/pipeline.js';
import type { PipelineContext } from '../../src/models/types.js';
import { ConfigError } from '../../src/models/errors.js';
import { KNOWN_OVER_REDACTIONS, MUST_NOT_CHANGE } from '../fixtures/leaks/benign.js';
import { BLOCKLIST, buildLeakCorpus } from '../fixtures/leaks/samples.js';
import { makeSecrets } from '../fixtures/leaks/secrets.js';

// Independent residue detectors (deliberately NOT the filter's own regexes).
const RESIDUE: [string, RegExp][] = [
  ['aws key', /(?:AKIA|ASIA)[A-Z0-9]{16}/],
  ['github token', /gh[pousr]_[A-Za-z0-9]{20}/],
  ['github pat', /github_pat_[A-Za-z0-9_]{20}/],
  ['sk key', /sk-[A-Za-z0-9_-]{20}/],
  ['slack token', /xox[abprs]-[A-Za-z0-9-]{10}/],
  ['jwt', /eyJ[A-Za-z0-9_-]{10}\.[A-Za-z0-9_-]{10}\./],
  ['pem', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['pem body', /[A-Za-z0-9+/]{64}/],
  ['bearer', /bearer\s+[A-Za-z0-9._~+/=-]{20}/i],
  ['stripe key', /[sr]k_(?:live|test)_[A-Za-z0-9]{16}/],
  ['google key', /AIza[0-9A-Za-z_-]{20}/],
  ['gitlab token', /glpat-[A-Za-z0-9_-]{16}/],
  ['npm token', /npm_[A-Za-z0-9]{30}/],
  ['hf token', /hf_[A-Za-z0-9]{30}/],
  ['sendgrid key', /SG\.[A-Za-z0-9_-]{16}\./],
];

const make = () => new ConfidentialityFilter({ blocklist: BLOCKLIST, customRules: [] });
const ctx = (stage: 'pre' | 'post'): PipelineContext => ({ authorId: 'a', personaKey: 'p', stage });
const corpus = buildLeakCorpus();

describe('leak corpus (security tier)', () => {
  it('has at least 100 samples covering every boundary / provider / header case', () => {
    expect(corpus.length).toBeGreaterThanOrEqual(100);
    const ids = new Set(corpus.map((s) => s.id));
    for (const id of ['boundary/quoted-300', 'boundary/quoted-10000', 'boundary/json-newline-after-colon', 'boundary/url-password-at', 'header/basic', 'prose/password-is', 'stripeLive/plain', 'google/plain', 'gitlab/plain', 'npm/plain', 'huggingface/plain', 'sendgrid/plain']) {
      expect(ids.has(id), id).toBe(true);
    }
    expect(new Set(corpus.map((s) => s.id)).size).toBe(corpus.length);
  });

  describe.each(corpus.map((s) => [s.id, s] as const))('%s', (_id, sample) => {
    it('no secret survives the pre stage or the post stage; output is idempotent; trace is clean', async () => {
      const pipeline = new FilterPipeline().use(make());
      const pre = await pipeline.run(sample.text, ctx('pre'));
      const post = await pipeline.run(pre.text, ctx('post'));
      for (const stageText of [pre.text, post.text]) {
        for (const secret of sample.secrets) expect(stageText).not.toContain(secret);
        for (const [label, rx] of RESIDUE) {
          // multiple samples legitimately contain long base64-ish words only inside secrets
          expect(rx.test(stageText), `${label} residue`).toBe(false);
        }
      }
      expect(post.text).toBe(pre.text); // idempotent: the second pass finds nothing new
      const dump = JSON.stringify([pre.trace, post.trace]);
      for (const secret of sample.secrets) expect(dump).not.toContain(secret);
      expect(pre.trace[0]?.modified).toBe(true);
      expect(post.trace[0]?.modified).toBe(false);
    });
  });
});

describe('false-positive corpus (security tier)', () => {
  const f = () => new ConfidentialityFilter({ blocklist: BLOCKLIST });

  it.each(MUST_NOT_CHANGE.map((t) => [t] as const))('ordinary text is returned byte for byte: %s', async (text) => {
    const r = await f().process(text, ctx('pre'));
    expect(r.content).toBe(text);
    expect(r.modified).toBe(false);
  });

  it.each(KNOWN_OVER_REDACTIONS.map((e) => [e[0], e[1]] as const))('known over-redaction is exactly as documented: %j', async (input, expected) => {
    expect((await f().process(input, ctx('pre'))).content).toBe(expected);
  });
});

describe('custom-rule coverage (security tier)', () => {
  const rules = [
    { name: 'ticket', pattern: 'TKT-[0-9]{1,40}' },
    { name: 'blob', pattern: 'BEGINBLOB[a-z]{500}ENDBLOB' }, // 518 characters: over the limit
  ];

  it('a rule that could match more than the guaranteed length is refused, never silently truncated', () => {
    expect(() => new ConfidentialityFilter({ customRules: [rules[1] as (typeof rules)[number]] })).toThrow(ConfigError);
    expect(() => new ConfidentialityFilter({ customRules: [{ name: 'blob', pattern: 'BEGIN[\\s\\S]{0,2000}END' }] })).toThrow(ConfigError);
    expect(() => new ConfidentialityFilter({ customRules: [{ name: 'blob', pattern: 'BEGIN[\\s\\S]+END' }] })).toThrow(ConfigError);
  });

  it('hostile rules (chained bounded quantifiers) are refused at construction', () => {
    for (const pattern of ['a{1,500}a{1,500}a{1,500}a{1,500}b', 'a{0,200}a{0,200}a{0,200}c', '(a+)+$', 'a+a+b']) {
      expect(() => new ConfidentialityFilter({ customRules: [{ name: 'r', pattern }] }), pattern).toThrow(ConfigError);
    }
  });

  it('a maximum-length custom match and every provider secret are redacted at every window alignment', async () => {
    const f = new ConfidentialityFilter({ customRules: [{ name: 'maxlen', pattern: 'M[a-z]{510}E' }, rules[0] as (typeof rules)[number]] });
    const gens = makeSecrets(4242);
    const longMatch = 'M' + 'k'.repeat(510) + 'E';
    for (let at = 0; at < 1300; at += 11) {
      const secrets = Object.keys(gens).map((k) => (gens[k] as () => { text: string })().text).filter((t) => !t.includes('\n'));
      const filler = '-'.repeat(at);
      const text = `${filler}${longMatch} TKT-12345 ${secrets.join(' | ')}${filler}`;
      const out = (await f.process(text, ctx('pre'))).content;
      expect(out, `at ${at}`).not.toContain('kkkkkkkk');
      expect(out).not.toContain('TKT-12345');
      for (const sec of secrets) expect(out).not.toContain(sec);
    }
  });
});
