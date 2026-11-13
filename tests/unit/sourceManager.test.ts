import { describe, expect, it } from 'vitest';
import { HashEmbedder } from '../../src/embedding/hashEmbedder.js';
import { ConfidentialityFilter } from '../../src/filters/confidentiality.js';
import { FilterPipeline } from '../../src/filters/pipeline.js';
import {
  ConfigError,
  FilterFailedError,
  InputTooLargeError,
  ProfileError,
  UnknownAuthorError,
} from '../../src/models/errors.js';
import type { Chunk, Embedder, Filter, ScoredChunk, VectorStore } from '../../src/models/types.js';
import { SourceManager, type SourceManagerOptions } from '../../src/registry/sourceManager.js';
import { InMemoryVectorStore } from '../../src/store/inMemoryVectorStore.js';

const pipeline = (): FilterPipeline =>
  new FilterPipeline({ stage: 'pre', requireConfidentiality: true }).register(new ConfidentialityFilter());

const para = (topic: string, n: number): string =>
  Array.from({ length: n }, (_, i) => `The ${topic} number ${i} was reviewed; however, the ${topic} stayed stable.`).join(' ');

const CORPUS = `${para('database', 12)}\n\n${para('network', 12)}\n\n${para('garden', 12)}`;

const make = (over: Partial<SourceManagerOptions> = {}): SourceManager =>
  new SourceManager({
    store: new InMemoryVectorStore(),
    embedder: new HashEmbedder(64),
    confidentiality: pipeline(),
    chunkCfg: { size: 300, overlap: 40 },
    ...over,
  });

/** A store wrapper that records everything handed to it. */
class SpyStore extends InMemoryVectorStore {
  upserted: Chunk[] = [];
  collections = new Set<string>();
  override async upsert(c: string, items: Parameters<VectorStore['upsert']>[1]): Promise<void> {
    this.upserted.push(...items.map((i) => i.chunk));
    this.collections.add(c);
    return super.upsert(c, items);
  }
  override async replaceCollection(c: string, items: Parameters<VectorStore['upsert']>[1]): Promise<void> {
    this.upserted.push(...items.map((i) => i.chunk));
    this.collections.add(c);
    return super.replaceCollection(c, items);
  }
}

/** A store with only the base VectorStore surface (no atomic replace). */
const baseOnly = (inner: InMemoryVectorStore): VectorStore => ({
  upsert: (c, items) => inner.upsert(c, items),
  query: (c, v, k) => inner.query(c, v, k),
  deleteCollection: (c) => inner.deleteCollection(c),
});

describe('SourceManager.ingest / getProfile / listAuthors', () => {
  it('ingests and returns the profile that getProfile later serves', async () => {
    const sm = make();
    const p = await sm.ingest('ada', 'Ada Lovelace', CORPUS);
    expect(p.authorId).toBe('ada');
    expect(p.displayName).toBe('Ada Lovelace');
    expect(p.corpusWordCount).toBeGreaterThan(100);
    expect(sm.getProfile('ada')).toEqual(p);
  });

  it('returns copies: mutating a result does not change the manager', async () => {
    const sm = make();
    const p = await sm.ingest('ada', 'Ada', CORPUS);
    p.preferredPunctuation.push('!!');
    p.displayName = 'tampered';
    expect(sm.getProfile('ada').displayName).toBe('Ada');
    expect(sm.getProfile('ada').preferredPunctuation).not.toContain('!!');
    sm.listAuthors()[0]!.commonTransitionWords.push('x');
    expect(sm.getProfile('ada').commonTransitionWords).not.toContain('x');
  });

  it('listAuthors is sorted by id and empty at the start', async () => {
    const sm = make();
    expect(sm.listAuthors()).toEqual([]);
    await sm.ingest('zed', 'Z', CORPUS);
    await sm.ingest('amy', 'A', CORPUS);
    await sm.ingest('Bob', 'B', CORPUS);
    expect(sm.listAuthors().map((p) => p.authorId)).toEqual(['Bob', 'amy', 'zed']);
  });

  it('getProfile / retrieve / remove of an unknown author throw UnknownAuthorError', async () => {
    const sm = make();
    expect(() => sm.getProfile('ghost')).toThrow(UnknownAuthorError);
    await expect(sm.retrieve('ghost', 'q', 3)).rejects.toBeInstanceOf(UnknownAuthorError);
    await expect(sm.remove('ghost')).rejects.toBeInstanceOf(UnknownAuthorError);
  });

  it('same text twice gives an identical profile and the same number of stored chunks (replace, not append)', async () => {
    const store = new InMemoryVectorStore();
    const sm = make({ store });
    const p1 = await sm.ingest('ada', 'Ada', CORPUS);
    const n1 = (await sm.retrieve('ada', 'database', 100)).length;
    const p2 = await sm.ingest('ada', 'Ada', CORPUS);
    expect(p2).toEqual(p1);
    expect((await sm.retrieve('ada', 'database', 100)).length).toBe(n1);
    expect(sm.listAuthors()).toHaveLength(1);
  });

  it('re-ingesting different text replaces the old chunks entirely', async () => {
    const sm = make();
    await sm.ingest('ada', 'Ada', CORPUS);
    await sm.ingest('ada', 'Ada', 'Completely different corpus about astronomy. Telescopes gather faint light.');
    const hits = await sm.retrieve('ada', 'database garden network', 100);
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) expect(h.text).not.toMatch(/database|garden|network/);
  });

  it('remove deletes the profile and the vector collection', async () => {
    const store = new InMemoryVectorStore();
    const sm = make({ store });
    const p = await sm.ingest('ada', 'Ada', CORPUS);
    await sm.remove('ada');
    expect(() => sm.getProfile('ada')).toThrow(UnknownAuthorError);
    expect(sm.listAuthors()).toEqual([]);
    expect(await store.query(p.vectorCollectionName, new Array(64).fill(1), 10)).toEqual([]);
    await sm.ingest('ada', 'Ada', CORPUS); // can come back
    expect(sm.getProfile('ada').authorId).toBe('ada');
  });

  it('uses the profile collection name for the store', async () => {
    const store = new SpyStore();
    const sm = make({ store });
    const p = await sm.ingest('ada', 'Ada', CORPUS);
    expect([...store.collections]).toEqual([p.vectorCollectionName]);
  });

  it('produces stable chunk ids that sort in document order', async () => {
    const store = new SpyStore();
    await make({ store }).ingest('ada', 'Ada', CORPUS);
    const ids = store.upserted.map((c) => c.id);
    expect(ids.length).toBeGreaterThan(5);
    expect([...ids].sort()).toEqual(ids);
    expect(store.upserted.map((c) => c.index)).toEqual(ids.map((_, i) => i));
    expect(store.upserted.every((c) => c.authorId === 'ada')).toBe(true);
  });
});

describe('SourceManager.retrieve', () => {
  it('ranks the passage that matches the query first and is deterministic', async () => {
    const sm = make();
    await sm.ingest('ada', 'Ada', CORPUS);
    const a = await sm.retrieve('ada', 'garden number reviewed stayed stable', 3);
    const b = await sm.retrieve('ada', 'garden number reviewed stayed stable', 3);
    expect(a).toEqual(b);
    expect(a).toHaveLength(3);
    expect(a[0]?.text).toContain('garden');
    for (let i = 1; i < a.length; i++) expect((a[i - 1] as ScoredChunk).score).toBeGreaterThanOrEqual((a[i] as ScoredChunk).score);
  });

  it('never returns another author\'s chunks', async () => {
    const sm = make();
    await sm.ingest('amy', 'Amy', 'Alpha beta gamma. '.repeat(60));
    await sm.ingest('bob', 'Bob', 'Delta epsilon zeta. '.repeat(60));
    for (const q of ['alpha beta', 'delta epsilon', 'gamma zeta']) {
      for (const [who, ok] of [['amy', 'amy'], ['bob', 'bob']] as const) {
        const hits = await sm.retrieve(who, q, 100);
        expect(hits.length).toBeGreaterThan(0);
        expect(hits.every((h) => h.authorId === ok)).toBe(true);
      }
    }
  });

  it('filters out foreign chunks even if the store hands them back', async () => {
    const leaky: VectorStore = {
      async upsert() {},
      async deleteCollection() {},
      async query() {
        return [{ id: 'x#0', authorId: 'someone-else', text: 'private', index: 0, score: 1 }];
      },
    };
    const sm = make({ store: leaky });
    await sm.ingest('ada', 'Ada', CORPUS);
    expect(await sm.retrieve('ada', 'q', 5)).toEqual([]);
  });

  it('validates k and the query', async () => {
    const sm = make({ limits: { maxQueryChars: 50 } });
    await sm.ingest('ada', 'Ada', CORPUS);
    for (const k of [0, -1, 1.5, Number.NaN, 101, Infinity]) await expect(sm.retrieve('ada', 'q', k)).rejects.toBeInstanceOf(RangeError);
    await expect(sm.retrieve('ada', 5 as unknown as string, 1)).rejects.toBeInstanceOf(TypeError);
    await expect(sm.retrieve('ada', 'q'.repeat(51), 1)).rejects.toBeInstanceOf(InputTooLargeError);
    expect(await sm.retrieve('ada', '', 3)).toHaveLength(3); // empty query: zero vector, all scores 0, ids ascending
  });
});

describe('SourceManager: validation and limits', () => {
  it.each(['', ' ', 'a b', '../etc', 'a/b', '-lead', '.lead', '__proto__', 'x'.repeat(65), 'é', 'a\n'])(
    'rejects authorId %j',
    async (id) => {
      await expect(make().ingest(id, 'N', CORPUS)).rejects.toBeInstanceOf(ConfigError);
    },
  );

  it.each(['a', 'A1', 'ada_lovelace', 'ada.l-2', 'x'.repeat(64)])('accepts authorId %j', async (id) => {
    await make().ingest(id, 'N', CORPUS);
  });

  it('rejects a blank, overlong or non-string displayName', async () => {
    const sm = make();
    for (const n of ['', '   ', 'x'.repeat(201), 5 as unknown as string]) await expect(sm.ingest('a', n, CORPUS)).rejects.toBeInstanceOf(ConfigError);
  });

  it('rejects a corpus over maxCorpusChars before running any filter or touching the store', async () => {
    let ran = false;
    const spy: Filter = {
      name: 'confidentiality',
      stages: ['pre'],
      onError: 'fail-closed',
      async process(t) {
        ran = true;
        return { content: t, modified: false, metadata: {} };
      },
    };
    const store = new SpyStore();
    const sm = make({ store, confidentiality: new FilterPipeline().register(spy), limits: { maxCorpusChars: 1000 } });
    await expect(sm.ingest('a', 'A', 'word '.repeat(300))).rejects.toBeInstanceOf(InputTooLargeError);
    expect(ran).toBe(false);
    expect(store.upserted).toEqual([]);
    expect(sm.listAuthors()).toEqual([]);
  });

  it('rejects a corpus that would make too many chunks, keeping the previous ingest intact', async () => {
    const sm = make({ limits: { maxChunks: 10 } });
    const before = await sm.ingest('ada', 'Ada', 'Short corpus here. Another sentence follows.');
    await expect(sm.ingest('ada', 'Ada', 'word '.repeat(5000))).rejects.toBeInstanceOf(InputTooLargeError);
    expect(sm.getProfile('ada')).toEqual(before);
    expect((await sm.retrieve('ada', 'short corpus', 5)).length).toBe(1);
  });

  it('caps the number of authors, but allows re-ingesting an existing one', async () => {
    const sm = make({ limits: { maxAuthors: 2 } });
    await sm.ingest('a', 'A', CORPUS);
    await sm.ingest('b', 'B', CORPUS);
    await expect(sm.ingest('c', 'C', CORPUS)).rejects.toBeInstanceOf(InputTooLargeError);
    await sm.ingest('a', 'A', CORPUS);
  });

  it('a corpus with no words raises ProfileError and changes nothing', async () => {
    const sm = make();
    const before = await sm.ingest('ada', 'Ada', CORPUS);
    for (const bad of ['', '   \n', '... !!! ???']) await expect(sm.ingest('ada', 'Ada', bad)).rejects.toBeInstanceOf(ProfileError);
    expect(sm.getProfile('ada')).toEqual(before);
    expect((await sm.retrieve('ada', 'database', 3)).length).toBe(3);
  });

  it('rejects bad construction: chunk config, limits, and a pipeline without confidentiality', () => {
    expect(() => make({ chunkCfg: { size: 100, overlap: 100 } })).toThrow(ConfigError);
    expect(() => make({ limits: { maxChunks: 0 } })).toThrow(ConfigError);
    expect(() => make({ confidentiality: new FilterPipeline() })).toThrow(ConfigError);
  });
});

describe('SourceManager: failure atomicity and concurrency', () => {
  it('an embedder failure leaves the previous ingest intact', async () => {
    let fail = false;
    const inner = new HashEmbedder(64);
    const embedder: Embedder = {
      dim: 64,
      async embed(t) {
        if (fail) throw new Error('embedder down');
        return inner.embed(t);
      },
    };
    const sm = make({ embedder });
    const before = await sm.ingest('ada', 'Ada', CORPUS);
    fail = true;
    await expect(sm.ingest('ada', 'Ada', 'Something else entirely, with new words.')).rejects.toThrow('embedder down');
    fail = false;
    expect(sm.getProfile('ada')).toEqual(before);
    expect((await sm.retrieve('ada', 'database', 3)).length).toBe(3);
  });

  it('CR-01: a capacity rejection on re-ingest leaves the previous author fully intact', async () => {
    const store = new InMemoryVectorStore({ maxItems: 20 });
    const sm = make({ store });
    const before = await sm.ingest('ada', 'Ada', CORPUS);
    const hitsBefore = await sm.retrieve('ada', 'database', 100);
    expect(hitsBefore.length).toBeGreaterThan(0);
    expect(hitsBefore.length).toBeLessThanOrEqual(20);
    await expect(sm.ingest('ada', 'Ada', 'word '.repeat(2000))).rejects.toBeInstanceOf(InputTooLargeError);
    expect(sm.getProfile('ada')).toEqual(before);
    expect(await sm.retrieve('ada', 'database', 100)).toEqual(hitsBefore);
    // the author can still be re-ingested with something that fits
    await sm.ingest('ada', 'Ada', 'Tiny corpus. Small.');
    expect(sm.getProfile('ada').authorId).toBe('ada');
  });

  it('CR-01: a store I/O failure during replace leaves the previous author intact', async () => {
    let fail = false;
    class FlakyStore extends InMemoryVectorStore {
      override async replaceCollection(c: string, items: Parameters<VectorStore['upsert']>[1]): Promise<void> {
        if (fail) throw new Error('disk full');
        return super.replaceCollection(c, items);
      }
    }
    const store = new FlakyStore();
    const sm = make({ store });
    const before = await sm.ingest('ada', 'Ada', CORPUS);
    const hitsBefore = await sm.retrieve('ada', 'database', 5);
    fail = true;
    await expect(sm.ingest('ada', 'Ada', 'Another corpus entirely. With words.')).rejects.toThrow('disk full');
    expect(sm.getProfile('ada')).toEqual(before);
    expect(await sm.retrieve('ada', 'database', 5)).toEqual(hitsBefore);
  });

  it('a store without replaceCollection falls back to delete-then-upsert: a store failure leaves the author unknown', async () => {
    const inner = new InMemoryVectorStore({ maxItems: 3 });
    const sm = make({ store: baseOnly(inner) });
    await sm.ingest('ada', 'Ada', 'Tiny corpus. Small.');
    await expect(sm.ingest('ada', 'Ada', 'word '.repeat(400))).rejects.toBeInstanceOf(InputTooLargeError);
    expect(() => sm.getProfile('ada')).toThrow(UnknownAuthorError);
    expect(await inner.query('author/ada', new Array(64).fill(1), 10)).toEqual([]);
  });

  it('concurrent ingests of one author are serialized: the last call wins completely', async () => {
    const store = new SpyStore();
    const sm = make({ store });
    const big = para('alpha', 40);
    const small = 'Small second corpus. Only two sentences.';
    const first = sm.ingest('ada', 'Ada', big);
    const second = sm.ingest('ada', 'Ada', small);
    await Promise.all([first, second]);
    const hits = await sm.retrieve('ada', 'alpha small', 100);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.text).toContain('Small second corpus');
    expect(sm.getProfile('ada').corpusWordCount).toBe(6);
  });

  it('a failed ingest does not block later calls', async () => {
    const sm = make();
    await expect(sm.ingest('', 'x', 'y')).rejects.toBeInstanceOf(ConfigError);
    await sm.ingest('ada', 'Ada', CORPUS);
    expect(sm.listAuthors()).toHaveLength(1);
  });
});

describe('SourceManager: confidentiality gate', () => {
  it('fails closed (FilterFailedError, nothing stored) when the confidentiality filter throws', async () => {
    const boom: Filter = {
      name: 'confidentiality',
      stages: ['pre'],
      onError: 'fail-closed',
      async process() {
        throw new Error('boom');
      },
    };
    const store = new SpyStore();
    const sm = make({ store, confidentiality: new FilterPipeline().register(boom) });
    await expect(sm.ingest('ada', 'Ada', CORPUS)).rejects.toBeInstanceOf(FilterFailedError);
    expect(store.upserted).toEqual([]);
    expect(sm.listAuthors()).toEqual([]);
  });

  it('fails closed when the pipeline never ran a confidentiality filter at the pre stage', async () => {
    const postOnly: Filter = {
      name: 'confidentiality',
      stages: ['post'],
      onError: 'fail-closed',
      async process(t) {
        return { content: t, modified: false, metadata: {} };
      },
    };
    const store = new SpyStore();
    const sm = make({ store, confidentiality: new FilterPipeline().register(postOnly) });
    await expect(sm.ingest('ada', 'Ada', CORPUS)).rejects.toBeInstanceOf(FilterFailedError);
    expect(store.upserted).toEqual([]);
  });
});
