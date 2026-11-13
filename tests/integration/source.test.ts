// Phase 4 integration: three synthetic authors through the real confidentiality pipeline, embedder and store.
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_CHUNK } from '../../config/settings.js';
import { HashEmbedder } from '../../src/embedding/hashEmbedder.js';
import { ConfidentialityFilter } from '../../src/filters/confidentiality.js';
import { FilterPipeline } from '../../src/filters/pipeline.js';
import type { StylometricProfile } from '../../src/models/types.js';
import { SourceManager } from '../../src/registry/sourceManager.js';
import { InMemoryVectorStore } from '../../src/store/inMemoryVectorStore.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'authors');
const AUTHORS = [
  { id: 'terse', name: 'Terse Technical', file: 'terse-technical.txt' },
  { id: 'verbose', name: 'Verbose Hedging', file: 'verbose-hedging.txt' },
  { id: 'bulleted', name: 'Bulleted Executive', file: 'bulleted-executive.txt' },
] as const;

const manager = (): SourceManager =>
  new SourceManager({
    store: new InMemoryVectorStore(),
    embedder: new HashEmbedder(),
    confidentiality: new FilterPipeline({ stage: 'pre', requireConfidentiality: true }).register(new ConfidentialityFilter()),
    chunkCfg: { size: 400, overlap: 60 },
  });

const COMPARED = [
  'avgSentenceLength',
  'sentenceLengthStdDev',
  'lexicalDensityRatio',
  'hedgingFrequency',
  'activePassiveRatio',
  'preferredPunctuation',
  'commonTransitionWords',
] as const;

const differingMetrics = (a: StylometricProfile, b: StylometricProfile): string[] =>
  COMPARED.filter((m) => JSON.stringify(a[m]) !== JSON.stringify(b[m]));

const texts: Record<string, string> = {};
beforeAll(async () => {
  for (const a of AUTHORS) texts[a.id] = await readFile(join(dir, a.file), 'utf8');
});

async function ingestAll(sm: SourceManager): Promise<Record<string, StylometricProfile>> {
  const out: Record<string, StylometricProfile> = {};
  for (const a of AUTHORS) out[a.id] = await sm.ingest(a.id, a.name, texts[a.id] as string);
  return out;
}

describe('three-author fixture corpus', () => {
  it('yields profiles that pairwise differ on at least 2 metrics', async () => {
    const p = await ingestAll(manager());
    for (const [x, y] of [['terse', 'verbose'], ['terse', 'bulleted'], ['verbose', 'bulleted']] as const) {
      const diff = differingMetrics(p[x] as StylometricProfile, p[y] as StylometricProfile);
      expect(diff.length, `${x} vs ${y}: ${diff.join(',')}`).toBeGreaterThanOrEqual(2);
    }
  });

  it('measures the traits each fixture was written to have', async () => {
    const { terse, verbose, bulleted } = (await ingestAll(manager())) as Record<string, StylometricProfile>;
    expect(terse!.avgSentenceLength).toBeLessThan(8);
    expect(verbose!.avgSentenceLength).toBeGreaterThan(25);
    expect(verbose!.avgSentenceLength).toBeGreaterThan(terse!.avgSentenceLength * 3);
    expect(verbose!.hedgingFrequency).toBeGreaterThan(2);
    expect(terse!.hedgingFrequency).toBe(0);
    expect(bulleted!.hedgingFrequency).toBe(0);
    expect(verbose!.preferredPunctuation[0]).toBe(';');
    expect(verbose!.commonTransitionWords).toEqual(expect.arrayContaining(['however', 'moreover']));
    expect(terse!.preferredPunctuation).toContain(':');
    expect(bulleted!.preferredPunctuation).toContain('!');
    expect(terse!.activePassiveRatio).toBeGreaterThan(verbose!.activePassiveRatio);
  });

  it('is stable: independent managers and repeated ingests give byte-identical profiles', async () => {
    const first = await ingestAll(manager());
    const second = await ingestAll(manager());
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    const sm = manager();
    const once = await sm.ingest('terse', 'Terse Technical', texts.terse as string);
    const twice = await sm.ingest('terse', 'Terse Technical', texts.terse as string);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
    expect(JSON.stringify(once)).toBe(JSON.stringify(first.terse));
  });

  it('retrieval for author A never returns author B\'s chunks, whatever the query', async () => {
    const sm = manager();
    await ingestAll(sm);
    const queries = [texts.terse, texts.verbose, texts.bulleted, 'revenue churn hiring', 'latency cache queue', 'perhaps migration'] as string[];
    for (const a of AUTHORS) {
      for (const q of queries) {
        const hits = await sm.retrieve(a.id, q.slice(0, 2000), 100);
        expect(hits.length).toBeGreaterThan(0);
        for (const h of hits) {
          expect(h.authorId).toBe(a.id);
          expect(texts[a.id]).toContain(h.text.slice(0, 40)); // chunk text really comes from that author's file
        }
      }
    }
  });

  it('retrieves the on-topic passage first and is deterministic', async () => {
    const sm = manager();
    await ingestAll(sm);
    const a = await sm.retrieve('bulleted', 'renewals enterprise decisions October', 3);
    const b = await sm.retrieve('bulleted', 'renewals enterprise decisions October', 3);
    expect(a).toEqual(b);
    expect(a[0]?.text).toMatch(/renewals/i);
    const t = await sm.retrieve('terse', 'lock deadlock network call release', 1);
    expect(t[0]?.text).toMatch(/Locks/);
  });

  it('works with the default chunk configuration too', async () => {
    const sm = new SourceManager({
      store: new InMemoryVectorStore(),
      embedder: new HashEmbedder(),
      confidentiality: new FilterPipeline({ stage: 'pre', requireConfidentiality: true }).register(new ConfidentialityFilter()),
      chunkCfg: { size: DEFAULT_CHUNK.size, overlap: DEFAULT_CHUNK.overlap },
    });
    await ingestAll(sm);
    expect((await sm.retrieve('verbose', 'migration', 5)).length).toBeGreaterThan(0);
  });
});
