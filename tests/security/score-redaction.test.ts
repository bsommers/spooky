// Phase 7 / SCR-03: external detectors get REDACTED text only. Confidentiality runs first; if it cannot run, nothing is sent.
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/load.js';
import { Engine } from '../../src/engine.js';
import { FilterFailedError } from '../../src/models/errors.js';
import type { DetectorAdapter } from '../../src/models/types.js';
import { BLOCKLIST, buildLeakCorpus } from '../fixtures/leaks/samples.js';
import { SpyFilter } from '../helpers/rig.js';

const config = loadConfig({ llm: { model: 'm' }, confidentiality: { blocklist: [...BLOCKLIST], caseInsensitive: false, customRules: [] }, limits: { maxInputChars: 200_000 } });
const corpus = buildLeakCorpus();

function recorder(name = 'acme'): DetectorAdapter & { received: string[] } {
  const received: string[] = [];
  return { name, received, score: async (t: string) => (received.push(t), 0.5) };
}

describe('score: detectors see only redacted text (security tier)', () => {
  it('covers the whole leak corpus', () => {
    expect(corpus.length).toBeGreaterThanOrEqual(100);
  });

  describe.each(corpus.map((s) => [s.id, s] as const))('%s', (_id, sample) => {
    it('no planted secret reaches the detector', async () => {
      const d = recorder();
      const engine = new Engine({ config, detectors: [d] });
      const r = await engine.score(`Some prose to rate. ${sample.text}\n\nMore prose after it.`, { detectors: ['acme'] });
      expect(r.excluded).toEqual([]);
      expect(d.received).toHaveLength(1);
      for (const secret of sample.secrets) expect(d.received[0], `secret leaked to the detector`).not.toContain(secret);
      expect(JSON.stringify(r)).not.toContain(sample.secrets[0] ?? '\u0000never');
    });
  });

  it('the detector receives exactly the confidentiality output (placeholders in place of the secret)', async () => {
    const d = recorder();
    const engine = new Engine({ config, detectors: [d] });
    const secret = 'AKIA' + 'ABCDEFGHIJKLMNOP';
    const r = await engine.score(`Contact ops with key ${secret} today. Project Falcon ships soon.`, { detectors: ['acme'] });
    expect(d.received[0]).toContain('[REDACTED:');
    expect(d.received[0]).not.toContain(secret);
    expect(d.received[0]).not.toContain('Project Falcon');
    expect(r.trace[0]?.filter).toBe('confidentiality');
  });

  it('when the confidentiality filter fails, nothing is sent and the call fails closed', async () => {
    const d = recorder();
    const engine = new Engine({
      config,
      detectors: [d],
      factories: { confidentiality: () => new SpyFilter('confidentiality', ['pre', 'post'], 'fail-closed', undefined, new Error('boom')), style: () => new SpyFilter('style', ['post'], 'skip') },
    });
    await expect(engine.score('Some text with a secret AKIAABCDEFGHIJKLMNOP in it.', { detectors: ['acme'] })).rejects.toBeInstanceOf(FilterFailedError);
    expect(d.received).toEqual([]);
  });

  it('a score request without detector names sends nothing anywhere', async () => {
    const d = recorder();
    const engine = new Engine({ config, detectors: [d] });
    await engine.score('Plain prose with nothing to hide. A second sentence follows it.');
    await engine.score('Plain prose with nothing to hide.', { detectors: [] });
    expect(d.received).toEqual([]);
  });
});
