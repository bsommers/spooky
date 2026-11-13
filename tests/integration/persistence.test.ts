// Carry-over from Phase 4: ingest-then-generate across processes needs profiles (and chunks) on disk.
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HashEmbedder } from '../../src/embedding/hashEmbedder.js';
import { ConfidentialityFilter } from '../../src/filters/confidentiality.js';
import { FilterPipeline } from '../../src/filters/pipeline.js';
import { ConfigError, InputTooLargeError, ProfileError, StoreCorruptError, UnknownAuthorError } from '../../src/models/errors.js';
import type { ScoredChunk, VectorStore } from '../../src/models/types.js';
import { SourceManager } from '../../src/registry/sourceManager.js';
import { InMemoryVectorStore } from '../../src/store/inMemoryVectorStore.js';
import { corpus } from '../helpers/rig.js';

let dir = '';
beforeEach(async () => void (dir = await mkdtemp(join(tmpdir(), 'gw-persist-'))));
afterEach(async () => rm(dir, { recursive: true, force: true }));

const paths = () => ({ storePath: join(dir, 'state', 'store.json'), profilesPath: join(dir, 'state', 'profiles.json') });
const pre = () => new FilterPipeline({ stage: 'pre', requireConfidentiality: true }).register(new ConfidentialityFilter());
const make = (store: VectorStore = new InMemoryVectorStore(), dim = 256, persistence = paths()) =>
  new SourceManager({ store, embedder: new HashEmbedder(dim), confidentiality: pre(), chunkCfg: { size: 400, overlap: 60 }, persistence });

describe('SourceManager persistence', () => {
  it('ingest in one manager, load in a fresh one: same profile, same retrieval', async () => {
    const a = make();
    const profile = await a.ingest('terse', 'Terse Author', corpus());
    const b = make();
    await b.load();
    expect(b.getProfile('terse')).toEqual(profile);
    expect(b.listAuthors()).toHaveLength(1);
    const q = 'deploy the service rollback';
    expect(await b.retrieve('terse', q, 3)).toEqual(await a.retrieve('terse', q, 3));
  });

  it('writes both files with mode 0600 in a 0700 directory and leaves no temp files', async () => {
    await make().ingest('terse', 'T', corpus());
    for (const f of ['store.json', 'profiles.json']) expect((await stat(join(dir, 'state', f))).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, 'state'))).mode & 0o777).toBe(0o700);
    expect((await readdir(join(dir, 'state'))).sort()).toEqual(['profiles.json', 'store.json']);
  });

  it('profiles file is byte-deterministic', async () => {
    const a = make();
    await a.ingest('b', 'B', corpus('verbose-hedging.txt'));
    await a.ingest('a', 'A', corpus());
    const first = await readFile(paths().profilesPath, 'utf8');
    await a.save();
    expect(await readFile(paths().profilesPath, 'utf8')).toBe(first);
    expect((JSON.parse(first) as { profiles: Array<{ authorId: string }> }).profiles.map((p) => p.authorId)).toEqual(['a', 'b']);
  });

  it('a first run (no files) loads as an empty state', async () => {
    const m = make();
    await m.load();
    expect(m.listAuthors()).toEqual([]);
  });

  it('redacted before it is written: no secret in either file, display name included', async () => {
    const key = 'AKIAIOSFODNN7EXAMPLE';
    await make().ingest('terse', `Ann ${key}`, `${corpus()}\nOur deploy key is ${key} and it must stay private.`);
    const text = (await readFile(paths().storePath, 'utf8')) + (await readFile(paths().profilesPath, 'utf8'));
    expect(text).not.toContain(key);
  });

  it('remove persists', async () => {
    const a = make();
    await a.ingest('terse', 'T', corpus());
    await a.remove('terse');
    const b = make();
    await b.load();
    expect(() => b.getProfile('terse')).toThrow(UnknownAuthorError);
  });

  it('a symlink at the target is replaced, not followed', async () => {
    await mkdir(join(dir, 'state'), { recursive: true });
    const victim = join(dir, 'victim.txt');
    await writeFile(victim, 'keep');
    await symlink(victim, paths().profilesPath);
    await make().ingest('terse', 'T', corpus());
    expect(await readFile(victim, 'utf8')).toBe('keep');
    expect(JSON.parse(await readFile(paths().profilesPath, 'utf8'))).toHaveProperty('format', 'ghostwriter-profiles');
  });

  it('a failing save surfaces the error (state dir is a file)', async () => {
    await writeFile(join(dir, 'state'), 'not a directory');
    await expect(make().ingest('terse', 'T', corpus())).rejects.toThrow();
  });
});

describe('SourceManager.load rejects bad state with typed errors', () => {
  const seeded = async () => {
    await make().ingest('terse', 'T', corpus());
    return JSON.parse(await readFile(paths().profilesPath, 'utf8')) as { format: string; version: number; profiles: Array<Record<string, unknown>> };
  };
  const rewrite = (doc: unknown) => writeFile(paths().profilesPath, typeof doc === 'string' ? doc : JSON.stringify(doc));
  const loadErr = async (m = make()) => (await m.load().then(() => undefined, (e: unknown) => e)) as Error | undefined;

  it('only one of the two files', async () => {
    await seeded();
    await rm(paths().storePath);
    expect(await loadErr()).toBeInstanceOf(StoreCorruptError);
    await make().save().catch(() => undefined);
  });

  it('profiles file: invalid JSON, wrong format/version, not array, wrong root', async () => {
    const doc = await seeded();
    for (const bad of ['{nope', '[]', '"x"', 'null', { ...doc, format: 'x' }, { ...doc, version: 2 }, { ...doc, profiles: {} }]) {
      await rewrite(bad);
      const err = await loadErr();
      expect(err, JSON.stringify(bad)).toBeInstanceOf(StoreCorruptError);
    }
  });

  it('profile records: wrong types, out of range, unknown key, mismatched collection, duplicate, bad id', async () => {
    const doc = await seeded();
    const p = doc.profiles[0]!;
    const variants: Array<Record<string, unknown>> = [
      { ...p, avgSentenceLength: 'x' },
      { ...p, avgSentenceLength: -1 },
      { ...p, lexicalDensityRatio: 2 },
      { ...p, corpusWordCount: 1.5 },
      { ...p, displayName: '   ' },
      { ...p, displayName: 'x'.repeat(201) },
      { ...p, preferredPunctuation: Array.from({ length: 11 }, () => ';') },
      { ...p, commonTransitionWords: [1] },
      { ...p, extra: 1 },
      { ...p, vectorCollectionName: 'someone-else' },
      { ...p, authorId: '../x' },
      { ...p, authorId: undefined },
    ];
    for (const v of variants) {
      await rewrite({ ...doc, profiles: [v] });
      const err = await loadErr();
      expect(err, JSON.stringify(v)).toBeInstanceOf(StoreCorruptError);
      expect(err?.message).not.toContain('x'.repeat(50));
    }
    await rewrite({ ...doc, profiles: [p, p] });
    expect(await loadErr()).toBeInstanceOf(StoreCorruptError);
  });

  it('oversized profiles file -> InputTooLargeError; directory in place of a file -> StoreCorruptError', async () => {
    await seeded();
    await writeFile(paths().profilesPath, ' '.repeat(8 * 1024 * 1024 + 1));
    expect(await loadErr()).toBeInstanceOf(InputTooLargeError);
    await rm(paths().profilesPath);
    await mkdir(paths().profilesPath);
    expect(await loadErr()).toBeInstanceOf(StoreCorruptError);
  });

  it('corrupt store file leaves the manager empty', async () => {
    await seeded();
    await writeFile(paths().storePath, '{"format":"ghostwriter-vector-store","version":1,"collections":"x"}');
    const m = make();
    expect(await loadErr(m)).toBeInstanceOf(StoreCorruptError);
    expect(m.listAuthors()).toEqual([]);
  });

  it('a profile whose chunks are not in the store is inconsistent', async () => {
    const doc = await seeded();
    const other = (await import('../../src/ingestion/stylometry.js')).vectorCollectionName('ghost');
    await rewrite({ ...doc, profiles: [{ ...doc.profiles[0], authorId: 'ghost', vectorCollectionName: other }] });
    const m = make();
    expect(await loadErr(m)).toBeInstanceOf(StoreCorruptError);
    expect(m.listAuthors()).toEqual([]);
  });

  it('a store written with another embedding dimension is rejected', async () => {
    await seeded();
    expect(await loadErr(make(new InMemoryVectorStore(), 128))).toBeInstanceOf(StoreCorruptError);
  });
});

describe('SourceManager persistence: construction and serialization', () => {
  it('rejects a store without save/load, identical paths, and load() without persistence', () => {
    const bare: VectorStore = { upsert: async () => undefined, query: async () => [], deleteCollection: async () => undefined };
    expect(() => make(bare)).toThrow(ConfigError);
    expect(() => make(new InMemoryVectorStore(), 256, { storePath: 'a', profilesPath: 'a' })).toThrow(ConfigError);
    const none = new SourceManager({ store: new InMemoryVectorStore(), embedder: new HashEmbedder(), confidentiality: pre(), chunkCfg: { size: 400, overlap: 60 } });
    return expect(none.load()).rejects.toBeInstanceOf(ConfigError);
  });

  it('store.save / store.load never overlap with each other or with retrieval', async () => {
    const inner = new InMemoryVectorStore();
    let busy = 0;
    let overlap = false;
    const slow = async <T>(fn: () => Promise<T>): Promise<T> => {
      if (busy++ > 0) overlap = true;
      try {
        await new Promise((r) => setTimeout(r, 15));
        return await fn();
      } finally {
        busy--;
      }
    };
    const store: VectorStore = {
      upsert: (c, i) => inner.upsert(c, i),
      replaceCollection: (c, i) => slow(() => inner.replaceCollection(c, i)),
      deleteCollection: (c) => slow(() => inner.deleteCollection(c)),
      query: (c, v, k): Promise<ScoredChunk[]> => slow(() => inner.query(c, v, k)),
      save: (p) => slow(() => inner.save(p)),
      load: (p) => slow(() => inner.load(p)),
    };
    const m = make(store);
    await m.ingest('terse', 'T', corpus());
    await Promise.all([m.ingest('terse', 'T2', corpus()), m.load(), m.retrieve('terse', 'deploy', 2), m.save(), m.remove('terse').catch(() => undefined)]);
    expect(overlap).toBe(false);
  });
});

describe('SourceManager.restoreProfiles', () => {
  it('replaces the held profiles after validating every record; ProfileError otherwise and nothing changes', async () => {
    const a = make();
    const p = await a.ingest('terse', 'T', corpus());
    const b = make(new InMemoryVectorStore());
    await b.restoreProfiles([p]);
    expect(b.getProfile('terse')).toEqual(p);
    await expect(b.restoreProfiles([{ ...p, authorId: 'other', vectorCollectionName: 'x' }])).rejects.toBeInstanceOf(ProfileError);
    await expect(b.restoreProfiles([p, p])).rejects.toBeInstanceOf(ProfileError);
    await expect(b.restoreProfiles('x' as never)).rejects.toBeInstanceOf(TypeError);
    expect(b.getProfile('terse')).toEqual(p);
    await b.restoreProfiles([]);
    expect(b.listAuthors()).toEqual([]);
  });
});

describe('SourceManager crash consistency (CR-02)', () => {
  /** A store whose save() writes the file and then "crashes" (rejects) when armed: the process died between the two state-file writes. */
  class CrashAfterSave extends InMemoryVectorStore {
    armed = false;
    override async save(path: string): Promise<void> {
      await super.save(path);
      if (this.armed) throw new Error('simulated crash after store write');
    }
  }

  it('remove: a crash right after the store write leaves a state a fresh process can load', async () => {
    const store = new CrashAfterSave();
    const a = make(store);
    await a.ingest('terse', 'T', corpus());
    await a.ingest('other', 'O', corpus('verbose-hedging.txt'));
    store.armed = true;
    await expect(a.remove('terse')).rejects.toThrow('simulated crash');
    const b = make();
    await b.load(); // used to throw StoreCorruptError("a profile has no stored chunks")
    expect(b.listAuthors().map((p) => p.authorId)).not.toContain('terse');
    expect(b.listAuthors().map((p) => p.authorId)).toContain('other');
    expect((await b.retrieve('other', 'deploy rollback', 2)).length).toBeGreaterThan(0);
  });

  it('ingest: a crash right after the store write leaves a loadable state (new author absent, old author intact)', async () => {
    const store = new CrashAfterSave();
    const a = make(store);
    await a.ingest('terse', 'T', corpus());
    store.armed = true;
    await expect(a.ingest('other', 'O', corpus('verbose-hedging.txt'))).rejects.toThrow('simulated crash');
    const b = make();
    await b.load();
    expect(b.listAuthors().map((p) => p.authorId)).toEqual(['terse']);
    expect((await b.retrieve('terse', 'deploy rollback', 2)).length).toBeGreaterThan(0);
  });
});

describe('SourceManager rolls back memory when persist fails (CR-03)', () => {
  const stateDir = () => join(dir, 'state');
  const lock = () => chmod(stateDir(), 0o500); // temp files can no longer be created: every save fails with EACCES
  const unlock = () => chmod(stateDir(), 0o700);

  it('a failed remove keeps the author (memory matches what a restart loads)', async () => {
    const a = make();
    await a.ingest('terse', 'T', corpus());
    const hits = await a.retrieve('terse', 'deploy rollback', 3);
    await lock();
    try {
      await expect(a.remove('terse')).rejects.toThrow();
    } finally {
      await unlock();
    }
    expect(a.listAuthors().map((p) => p.authorId)).toEqual(['terse']);
    expect(await a.retrieve('terse', 'deploy rollback', 3)).toEqual(hits);
    const b = make();
    await b.load();
    expect(b.listAuthors().map((p) => p.authorId)).toEqual(['terse']);
  });

  it('a failed first ingest of an author leaves no profile and no chunks behind', async () => {
    const store = new InMemoryVectorStore();
    const a = make(store);
    await a.ingest('terse', 'T', corpus());
    await lock();
    try {
      await expect(a.ingest('other', 'O', corpus('verbose-hedging.txt'))).rejects.toThrow();
    } finally {
      await unlock();
    }
    expect(a.listAuthors().map((p) => p.authorId)).toEqual(['terse']);
    expect(() => a.getProfile('other')).toThrow(UnknownAuthorError);
    await expect(a.retrieve('other', 'x', 1)).rejects.toBeInstanceOf(UnknownAuthorError);
    // The next successful save must not resurrect the failed author's chunks.
    await a.save();
    const b = make();
    await b.load();
    expect(b.listAuthors().map((p) => p.authorId)).toEqual(['terse']);
  });

  it('a failed re-ingest restores the previous profile and chunks', async () => {
    const a = make();
    const first = await a.ingest('terse', 'T', corpus());
    const hits = await a.retrieve('terse', 'deploy rollback', 3);
    await lock();
    try {
      await expect(a.ingest('terse', 'T2', corpus('verbose-hedging.txt'))).rejects.toThrow();
    } finally {
      await unlock();
    }
    expect(a.getProfile('terse')).toEqual(first);
    expect(await a.retrieve('terse', 'deploy rollback', 3)).toEqual(hits);
  });

  it('a first save that fails leaves an empty manager, not an unpersisted author', async () => {
    const a = make(new InMemoryVectorStore(), 256, { storePath: join(dir, 'ro', 'store.json'), profilesPath: join(dir, 'ro', 'profiles.json') });
    await mkdir(join(dir, 'ro'));
    await chmod(join(dir, 'ro'), 0o500);
    try {
      await expect(a.ingest('terse', 'T', corpus())).rejects.toThrow();
    } finally {
      await chmod(join(dir, 'ro'), 0o700);
    }
    expect(a.listAuthors()).toEqual([]);
    await expect(a.retrieve('terse', 'x', 1)).rejects.toBeInstanceOf(UnknownAuthorError);
  });

  it('a crash after the store write (profiles never written) does not keep serving the new author', async () => {
    class CrashAfterSave extends InMemoryVectorStore {
      override async save(path: string): Promise<void> {
        await super.save(path);
        throw new Error('simulated crash after store write');
      }
    }
    const a = make(new CrashAfterSave());
    await expect(a.ingest('terse', 'T', corpus())).rejects.toThrow('simulated crash');
    expect(a.listAuthors()).toEqual([]);
    await expect(a.retrieve('terse', 'x', 1)).rejects.toBeInstanceOf(UnknownAuthorError);
  });
});
