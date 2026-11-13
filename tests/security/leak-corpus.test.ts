import { describe, expect, it } from 'vitest';
import { ConfidentialityFilter } from '../../src/filters/confidentiality.js';
import { FilterPipeline } from '../../src/filters/pipeline.js';
import type { PipelineContext } from '../../src/models/types.js';
import { BLOCKLIST, buildLeakCorpus } from '../fixtures/leaks/samples.js';

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
];

const make = () => new ConfidentialityFilter({ blocklist: BLOCKLIST, customRules: [] });
const ctx = (stage: 'pre' | 'post'): PipelineContext => ({ authorId: 'a', personaKey: 'p', stage });
const corpus = buildLeakCorpus();

describe('leak corpus (security tier)', () => {
  it('has at least 40 samples', () => {
    expect(corpus.length).toBeGreaterThanOrEqual(40);
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
