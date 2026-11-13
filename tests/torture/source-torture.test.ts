// Torture: a 5 MB corpus through the whole source path (real confidentiality filter, default chunking, 256-d hash
// embedder, in-memory store, JSON save/load). Deterministic corpus (seeded PRNG), planted secrets.
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CHUNK } from '../../config/settings.js';
import { HashEmbedder } from '../../src/embedding/hashEmbedder.js';
import { ConfidentialityFilter } from '../../src/filters/confidentiality.js';
import { FilterPipeline } from '../../src/filters/pipeline.js';
import { SourceManager } from '../../src/registry/sourceManager.js';
import { InMemoryVectorStore } from '../../src/store/inMemoryVectorStore.js';
import { makeSecrets } from '../fixtures/leaks/secrets.js';
import { mulberry32, pick } from '../helpers/prng.js';

const TARGET_CHARS = 5 * 1024 * 1024;
// Measured 2026-11-13 (32-core Linux box, Node 22, idle): 5,242,973 chars -> 389-397 ms over 5 runs (redaction, profile,
// ~7.5k chunks, embedding, store). Budget = ~5x the measurement: far inside the plan's 5 s ceiling, tight enough that
// an accidental quadratic step (which would cost tens of seconds at this size) fails. Override with GW_SOURCE_BUDGET_MS
// on a slow or heavily shared machine.
const INGEST_BUDGET_MS = Number(process.env.GW_SOURCE_BUDGET_MS ?? 2000);

function corpus(): { text: string; secrets: string[] } {
  const rnd = mulberry32(2026);
  const vocab = Array.from({ length: 3000 }, (_, i) => `w${(i * 7919).toString(36)}`);
  const hedges = ['perhaps', 'however,', 'I think', 'moreover,', 'might'];
  const secrets = makeSecrets(99);
  const kinds = ['aws', 'ghp', 'jwt', 'pemRsa', 'sk'];
  const planted: string[] = [];
  const parts: string[] = [];
  let len = 0;
  let paragraph = 0;
  while (len < TARGET_CHARS) {
    const words = 5 + Math.floor(rnd() * 20);
    const sentence: string[] = [];
    for (let i = 0; i < words; i++) sentence.push(rnd() < 0.05 ? pick(rnd, hedges) : pick(rnd, vocab));
    let s = `${sentence.join(' ')}${rnd() < 0.2 ? '?' : '.'} `;
    if (rnd() < 0.08) s += '\n\n';
    if (paragraph++ % 2500 === 0) {
      const secret = secrets[pick(rnd, kinds)]!();
      planted.push(...secret.values);
      s += `${secret.text}\n`;
    }
    parts.push(s);
    len += s.length;
  }
  return { text: parts.join(''), secrets: planted };
}

describe('torture: 5 MB corpus', () => {
  it(`ingests, redacts, saves and reloads within ${INGEST_BUDGET_MS} ms`, async () => {
    const { text, secrets } = corpus();
    expect(text.length).toBeGreaterThanOrEqual(TARGET_CHARS);
    expect(secrets.length).toBeGreaterThan(10);
    for (const secret of secrets) expect(text).toContain(secret); // the planted secrets are really in the input
    const store = new InMemoryVectorStore();
    const sm = new SourceManager({
      store,
      embedder: new HashEmbedder(),
      confidentiality: new FilterPipeline({ stage: 'pre', requireConfidentiality: true }).register(new ConfidentialityFilter()),
      chunkCfg: { size: DEFAULT_CHUNK.size, overlap: DEFAULT_CHUNK.overlap },
    });

    const t0 = performance.now();
    const profile = await sm.ingest('big', 'Big Corpus', text);
    const ingestMs = performance.now() - t0;
    console.log(`[torture] 5MB ingest: ${ingestMs.toFixed(0)} ms (${text.length} chars, ${profile.corpusWordCount} words)`);
    expect(ingestMs).toBeLessThan(INGEST_BUDGET_MS);

    const hits = await sm.retrieve('big', 'perhaps however moreover', 5);
    expect(hits).toHaveLength(5);

    const dir = await mkdtemp(join(tmpdir(), 'gw-torture-'));
    try {
      const file = join(dir, 'store.json');
      const s0 = performance.now();
      await store.save(file);
      const reloaded = new InMemoryVectorStore();
      await reloaded.load(file);
      console.log(`[torture] save+load: ${(performance.now() - s0).toFixed(0)} ms, ${((await stat(file)).size / 1e6).toFixed(1)} MB`);
      const q = (await new HashEmbedder().embed(['perhaps however moreover']))[0] as number[];
      expect(await reloaded.query(profile.vectorCollectionName, q, 5)).toEqual(await store.query(profile.vectorCollectionName, q, 5));

      const saved = JSON.stringify(await reloaded.query(profile.vectorCollectionName, q, 1000));
      for (const secret of secrets) expect(saved).not.toContain(secret);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
