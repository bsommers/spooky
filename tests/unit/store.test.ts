import { mkdtemp, readFile, readdir, rm, stat, writeFile, chmod, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HashEmbedder } from '../../src/embedding/hashEmbedder.js';
import { InMemoryVectorStore } from '../../src/store/inMemoryVectorStore.js';
import { ConfigError, GhostwriterError, InputTooLargeError, StoreCorruptError } from '../../src/models/errors.js';
import type { Chunk } from '../../src/models/types.js';

const norm = (v: readonly number[]): number => Math.sqrt(v.reduce((s, x) => s + x * x, 0));
const cosine = (a: readonly number[], b: readonly number[]): number => {
  const d = a.reduce((s, x, i) => s + x * (b[i] as number), 0);
  const n = norm(a) * norm(b);
  return n === 0 ? 0 : d / n;
};

const mk = (id: string, text = id, authorId = 'a', index = 0): Chunk => ({ id, authorId, text, index });
const item = (id: string, vector: number[], extra: Partial<Chunk> = {}) => ({ id, vector, chunk: { ...mk(id), ...extra } });

describe('HashEmbedder', () => {
  const e = new HashEmbedder();

  it('defaults to 256 dimensions and returns one dim-length vector per text', async () => {
    expect(e.dim).toBe(256);
    const out = await e.embed(['alpha beta', 'gamma']);
    expect(out).toHaveLength(2);
    for (const v of out) expect(v).toHaveLength(256);
    expect(await e.embed([])).toEqual([]);
  });

  it('is deterministic across instances and calls', async () => {
    const a = await new HashEmbedder().embed(['The quick brown fox jumps']);
    const b = await new HashEmbedder().embed(['The quick brown fox jumps']);
    const c = await e.embed(['The quick brown fox jumps']);
    expect(a).toEqual(b);
    expect(a).toEqual(c);
  });

  it('has unit L2 norm for non-empty text', async () => {
    for (const t of ['one', 'many many many words here and there', 'ünïcödé 日本語 text', 'x'.repeat(10_000)]) {
      const [v] = await e.embed([t]);
      expect(norm(v as number[])).toBeCloseTo(1, 10);
    }
  });

  it('maps text with no tokens (empty, whitespace, punctuation) to the zero vector, never NaN', async () => {
    for (const t of ['', '   \n', '...!!!']) {
      const [v] = await e.embed([t]);
      expect((v as number[]).every((x) => x === 0)).toBe(true);
    }
  });

  it('ignores case and punctuation; word order does not matter (bag of words)', async () => {
    const [a, b, c] = await e.embed(['Hello, World!', 'hello world', 'world hello']);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  it('scores related text above unrelated text', async () => {
    const [q, rel, unrel] = await e.embed([
      'database migration schema rollback',
      'the schema migration needs a rollback plan for the database',
      'gardening tomatoes in the summer sun',
    ]);
    expect(cosine(q as number[], rel as number[])).toBeGreaterThan(cosine(q as number[], unrel as number[]));
  });

  it('honours a custom dim and rejects invalid ones', async () => {
    const small = new HashEmbedder(8);
    expect(small.dim).toBe(8);
    expect(((await small.embed(['a b c']))[0] as number[]).length).toBe(8);
    for (const bad of [0, -1, 1.5, Number.NaN, Infinity, 1_000_000]) expect(() => new HashEmbedder(bad)).toThrow(ConfigError);
  });

  it('rejects non-string inputs with TypeError', async () => {
    await expect(e.embed([5 as unknown as string])).rejects.toThrow(TypeError);
  });
});

describe('InMemoryVectorStore: query', () => {
  it('returns the top k by cosine, best first, with the chunk attached', async () => {
    const s = new InMemoryVectorStore();
    await s.upsert('c', [item('far', [0, 1]), item('near', [1, 0.1]), item('mid', [1, 1])]);
    const r = await s.query('c', [1, 0], 2);
    expect(r.map((x) => x.id)).toEqual(['near', 'mid']);
    expect(r[0]?.score).toBeCloseTo(cosine([1, 0], [1, 0.1]), 12);
    expect(r[0]?.text).toBe('near');
    expect(r[0]?.authorId).toBe('a');
  });

  it('k larger than the collection returns everything; k = 0 returns []', async () => {
    const s = new InMemoryVectorStore();
    await s.upsert('c', [item('a', [1, 0]), item('b', [0, 1])]);
    expect(await s.query('c', [1, 1], 50)).toHaveLength(2);
    expect(await s.query('c', [1, 1], 0)).toEqual([]);
  });

  it('rejects a negative, fractional or non-finite k with RangeError', async () => {
    const s = new InMemoryVectorStore();
    await s.upsert('c', [item('a', [1, 0])]);
    for (const k of [-1, 1.5, Number.NaN, Infinity]) await expect(s.query('c', [1, 0], k)).rejects.toThrow(RangeError);
  });

  it('breaks score ties by chunk id ascending, whatever the insertion order', async () => {
    const ids = ['m', 'b', 'z', 'a', 'k', 'B', '10', '9'];
    const expected = [...ids].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    for (const order of [ids, [...ids].reverse(), [...ids].sort(() => 0)]) {
      const s = new InMemoryVectorStore();
      await s.upsert('c', order.map((id) => item(id, [1, 1])));
      expect((await s.query('c', [1, 1], 100)).map((x) => x.id)).toEqual(expected);
    }
  });

  it('is scale invariant', async () => {
    const s = new InMemoryVectorStore();
    await s.upsert('c', [item('a', [3, 4])]);
    const [r1] = await s.query('c', [3, 4], 1);
    const [r2] = await s.query('c', [30, 40], 1);
    expect(r1?.score).toBeCloseTo(1, 12);
    expect(r2?.score).toBeCloseTo(1, 12);
  });

  it('scores a zero vector (stored or queried) as 0, never NaN', async () => {
    const s = new InMemoryVectorStore();
    await s.upsert('c', [item('zero', [0, 0]), item('one', [1, 0])]);
    const r = await s.query('c', [1, 0], 5);
    expect(r.map((x) => [x.id, x.score])).toEqual([
      ['one', 1],
      ['zero', 0],
    ]);
    const z = await s.query('c', [0, 0], 5);
    expect(z.map((x) => x.score)).toEqual([0, 0]);
    expect(z.map((x) => x.id)).toEqual(['one', 'zero']);
  });

  it('returns [] for an unknown collection', async () => {
    const s = new InMemoryVectorStore();
    expect(await s.query('nope', [1, 2], 3)).toEqual([]);
  });

  it('keeps collections separate', async () => {
    const s = new InMemoryVectorStore();
    await s.upsert('one', [item('a', [1, 0])]);
    await s.upsert('two', [item('b', [1, 0])]);
    expect((await s.query('one', [1, 0], 5)).map((x) => x.id)).toEqual(['a']);
    expect((await s.query('two', [1, 0], 5)).map((x) => x.id)).toEqual(['b']);
  });

  it('hands out copies: mutating a result or the original input does not change the store', async () => {
    const s = new InMemoryVectorStore();
    const input = item('a', [1, 0], { text: 'original' });
    await s.upsert('c', [input]);
    input.chunk.text = 'mutated';
    input.vector[0] = 99;
    const [r] = await s.query('c', [1, 0], 1);
    expect(r?.text).toBe('original');
    expect(r?.score).toBeCloseTo(1, 12);
    (r as { text: string }).text = 'tampered';
    expect((await s.query('c', [1, 0], 1))[0]?.text).toBe('original');
  });
});

describe('InMemoryVectorStore: upsert and delete', () => {
  it('replaces an item with the same id instead of duplicating it', async () => {
    const s = new InMemoryVectorStore();
    await s.upsert('c', [item('a', [1, 0], { text: 'v1' })]);
    await s.upsert('c', [item('a', [0, 1], { text: 'v2' })]);
    const r = await s.query('c', [0, 1], 5);
    expect(r).toHaveLength(1);
    expect(r[0]?.text).toBe('v2');
    expect(r[0]?.score).toBeCloseTo(1, 12);
  });

  it('deleteCollection removes it; deleting an unknown collection is a no-op', async () => {
    const s = new InMemoryVectorStore();
    await s.upsert('c', [item('a', [1, 0])]);
    await s.deleteCollection('c');
    await s.deleteCollection('never-existed');
    expect(await s.query('c', [1, 0], 5)).toEqual([]);
  });

  it('an empty upsert creates nothing and does not throw', async () => {
    const s = new InMemoryVectorStore();
    await s.upsert('c', []);
    expect(await s.query('c', [1], 1)).toEqual([]);
  });

  it('rejects a bad batch atomically: nothing from it is stored', async () => {
    const s = new InMemoryVectorStore();
    await expect(s.upsert('c', [item('ok', [1, 0]), item('bad', [1, Number.NaN])])).rejects.toThrow(TypeError);
    expect(await s.query('c', [1, 0], 5)).toEqual([]);
  });

  it('rejects a dimension mismatch, a non-finite vector and an id that differs from chunk.id', async () => {
    const s = new InMemoryVectorStore();
    await s.upsert('c', [item('a', [1, 0])]);
    await expect(s.upsert('c', [item('b', [1, 0, 0])])).rejects.toThrow(TypeError);
    await expect(s.upsert('c', [item('b', [Infinity, 0])])).rejects.toThrow(TypeError);
    await expect(s.upsert('c', [{ id: 'x', vector: [1, 0], chunk: mk('y') }])).rejects.toThrow(TypeError);
    await expect(s.query('c', [1, 0, 0], 1)).rejects.toThrow(TypeError);
    await expect(s.query('c', [Number.NaN, 0], 1)).rejects.toThrow(TypeError);
  });
});

describe('InMemoryVectorStore: save / load', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gw-store-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const filled = async (): Promise<InMemoryVectorStore> => {
    const embedder = new HashEmbedder(32);
    const s = new InMemoryVectorStore();
    const texts = ['alpha beta gamma', 'delta epsilon', 'zeta eta theta iota'];
    const vecs = await embedder.embed(texts);
    await s.upsert('one', texts.map((t, i) => item(`c${i}`, vecs[i] as number[], { text: t, index: i })));
    await s.upsert('two', [item('d0', vecs[0] as number[], { authorId: 'b', text: 'unicode: 日本語 \u{1F600}' })]);
    return s;
  };

  it('round-trips exactly: the same queries give the same results', async () => {
    const s = await filled();
    const file = join(dir, 'store.json');
    await s.save(file);
    const t = new InMemoryVectorStore();
    await t.load(file);
    const q = (await new HashEmbedder(32).embed(['alpha gamma']))[0] as number[];
    expect(await t.query('one', q, 10)).toEqual(await s.query('one', q, 10));
    expect(await t.query('two', q, 10)).toEqual(await s.query('two', q, 10));
  });

  it('writes deterministic bytes (same content, same file) and leaves no temp files', async () => {
    const s = await filled();
    await s.save(join(dir, 'a.json'));
    await s.save(join(dir, 'b.json'));
    expect(await readFile(join(dir, 'a.json'))).toEqual(await readFile(join(dir, 'b.json')));
    expect((await readdir(dir)).sort()).toEqual(['a.json', 'b.json']);
  });

  it('creates the file with mode 0600, even under a permissive umask', async () => {
    const old = process.umask(0);
    try {
      const file = join(dir, 'sub', 'dir', 'store.json');
      await (await filled()).save(file);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(old);
    }
  });

  it('tightens an existing world-readable file to 0600 on overwrite', async () => {
    const file = join(dir, 'store.json');
    await writeFile(file, 'old', { mode: 0o644 });
    await chmod(file, 0o644);
    await (await filled()).save(file);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('replaces a symlink at the target instead of writing through it', async () => {
    const victim = join(dir, 'victim.txt');
    await writeFile(victim, 'precious');
    const file = join(dir, 'store.json');
    await symlink(victim, file);
    await (await filled()).save(file);
    expect(await readFile(victim, 'utf8')).toBe('precious');
    expect((await stat(file)).isFile()).toBe(true);
  });

  it('load replaces the current contents', async () => {
    const file = join(dir, 'store.json');
    await (await filled()).save(file);
    const t = new InMemoryVectorStore();
    await t.upsert('stale', [item('s', [1, 0])]);
    await t.load(file);
    expect(await t.query('stale', [1, 0], 5)).toEqual([]);
    expect((await t.query('one', new Array(32).fill(1), 5)).length).toBe(3);
  });

  it('a missing file rejects with the native ENOENT error and leaves the store untouched', async () => {
    const t = new InMemoryVectorStore();
    await t.upsert('c', [item('a', [1, 0])]);
    await expect(t.load(join(dir, 'nope.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await t.query('c', [1, 0], 1)).toHaveLength(1);
  });

  describe('corrupt files raise StoreCorruptError and leave the store untouched', () => {
    const good = {
      format: 'ghostwriter-vector-store',
      version: 1,
      collections: [{ name: 'c', dim: 2, items: [{ id: 'a', vector: [1, 0], chunk: { id: 'a', authorId: 'x', text: 't', index: 0 } }] }],
    };
    const variant = (mutate: (o: any) => void): string => {
      const o = structuredClone(good);
      mutate(o);
      return JSON.stringify(o);
    };
    const cases: Array<[string, string]> = [
      ['empty file', ''],
      ['not JSON', 'this is { not json'],
      ['truncated JSON', JSON.stringify(good).slice(0, 40)],
      ['JSON null', 'null'],
      ['JSON array', '[]'],
      ['wrong format tag', variant((o) => (o.format = 'other'))],
      ['unknown version', variant((o) => (o.version = 2))],
      ['collections not an array', variant((o) => (o.collections = {}))],
      ['collection name not a string', variant((o) => (o.collections[0].name = 5))],
      ['duplicate collection name', variant((o) => o.collections.push(structuredClone(o.collections[0])))],
      ['dim not an integer', variant((o) => (o.collections[0].dim = 2.5))],
      ['dim zero', variant((o) => (o.collections[0].dim = 0))],
      ['dim absurdly large', variant((o) => (o.collections[0].dim = 1e9))],
      ['vector too short', variant((o) => (o.collections[0].items[0].vector = [1]))],
      ['vector with null (NaN)', variant((o) => (o.collections[0].items[0].vector = [1, null]))],
      ['vector with string', variant((o) => (o.collections[0].items[0].vector = [1, '0']))],
      ['vector not an array', variant((o) => (o.collections[0].items[0].vector = 'abc'))],
      ['chunk missing', variant((o) => delete o.collections[0].items[0].chunk)],
      ['chunk text not a string', variant((o) => (o.collections[0].items[0].chunk.text = 7))],
      ['chunk index negative', variant((o) => (o.collections[0].items[0].chunk.index = -1))],
      ['chunk index fractional', variant((o) => (o.collections[0].items[0].chunk.index = 0.5))],
      ['item id differs from chunk id', variant((o) => (o.collections[0].items[0].id = 'zzz'))],
      ['duplicate item id', variant((o) => o.collections[0].items.push(structuredClone(o.collections[0].items[0])))],
    ];
    it.each(cases)('%s', async (_name, content) => {
      const file = join(dir, 'bad.json');
      await writeFile(file, content);
      const t = new InMemoryVectorStore();
      await t.upsert('keep', [item('k', [1, 0])]);
      let caught: unknown;
      try {
        await t.load(file);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(StoreCorruptError);
      expect(caught).toBeInstanceOf(GhostwriterError);
      expect((caught as StoreCorruptError).code).toBe('STORE_CORRUPT');
      expect(await t.query('keep', [1, 0], 5)).toHaveLength(1);
    });

    it('the unmodified fixture is accepted (the cases above fail for their stated reason only)', async () => {
      const file = join(dir, 'good.json');
      await writeFile(file, JSON.stringify(good));
      const t = new InMemoryVectorStore();
      await t.load(file);
      expect((await t.query('c', [1, 0], 5))[0]?.id).toBe('a');
    });

    it('error messages never echo file content', async () => {
      const file = join(dir, 'bad.json');
      await writeFile(file, JSON.stringify({ ...good, version: 'TOPSECRETVALUE' }));
      await expect(new InMemoryVectorStore().load(file)).rejects.toSatisfy((e: Error) => !e.message.includes('TOPSECRETVALUE'));
    });
  });

  it('refuses a file over maxFileBytes without reading it (InputTooLargeError)', async () => {
    const file = join(dir, 'big.json');
    await writeFile(file, 'x'.repeat(2000));
    await expect(new InMemoryVectorStore({ maxFileBytes: 1000 }).load(file)).rejects.toBeInstanceOf(InputTooLargeError);
  });

  it('refuses a file holding more than maxItems vectors', async () => {
    const s = new InMemoryVectorStore();
    await s.upsert('c', [item('a', [1, 0]), item('b', [0, 1]), item('c', [1, 1])]);
    const file = join(dir, 's.json');
    await s.save(file);
    await expect(new InMemoryVectorStore({ maxItems: 2 }).load(file)).rejects.toBeInstanceOf(StoreCorruptError);
    await new InMemoryVectorStore({ maxItems: 3 }).load(file);
  });

  it('refuses a directory or other non-file path', async () => {
    await mkdir(join(dir, 'd'));
    await expect(new InMemoryVectorStore().load(join(dir, 'd'))).rejects.toBeInstanceOf(StoreCorruptError);
  });

  it('upsert refuses to grow past maxItems', async () => {
    const s = new InMemoryVectorStore({ maxItems: 2 });
    await s.upsert('c', [item('a', [1]), item('b', [1])]);
    await expect(s.upsert('c', [item('c', [1])])).rejects.toBeInstanceOf(InputTooLargeError);
    await s.upsert('c', [item('b', [2])]); // replacement does not grow
  });
});

describe('InMemoryVectorStore.replaceCollection', () => {
  it('replaces the contents exactly and drops stale ids', async () => {
    const s = new InMemoryVectorStore();
    await s.upsert('c', [item('a', [1, 0]), item('b', [0, 1])]);
    await s.replaceCollection('c', [item('z', [1, 1])]);
    const hits = await s.query('c', [1, 1], 10);
    expect(hits.map((h) => h.id)).toEqual(['z']);
  });

  it('a capacity rejection leaves the old collection untouched; capacity is counted net of the replaced collection', async () => {
    const s = new InMemoryVectorStore({ maxItems: 3 });
    await s.upsert('c', [item('a', [1, 0]), item('b', [0, 1])]);
    await expect(s.replaceCollection('c', [item('w', [1, 0]), item('x', [1, 0]), item('y', [1, 0]), item('z', [1, 0])])).rejects.toBeInstanceOf(InputTooLargeError);
    expect((await s.query('c', [1, 0], 10)).map((h) => h.id)).toEqual(['a', 'b']);
    await s.replaceCollection('c', [item('w', [1, 0]), item('x', [1, 0]), item('y', [1, 0])]); // 3 <= 3 net of the old 2
    expect(await s.query('c', [1, 0], 10)).toHaveLength(3);
  });

  it('a validation failure (bad vector, different dimension from the old data is fine) leaves the old collection untouched', async () => {
    const s = new InMemoryVectorStore();
    await s.upsert('c', [item('a', [1, 0])]);
    await expect(s.replaceCollection('c', [item('x', [1, Number.NaN])])).rejects.toThrow(TypeError);
    expect((await s.query('c', [1, 0], 10)).map((h) => h.id)).toEqual(['a']);
    await s.replaceCollection('c', [item('x', [1, 0, 0])]);
    expect((await s.query('c', [1, 0, 0], 10)).map((h) => h.id)).toEqual(['x']);
  });

  it('an empty replacement deletes the collection', async () => {
    const s = new InMemoryVectorStore();
    await s.upsert('c', [item('a', [1, 0])]);
    await s.replaceCollection('c', []);
    expect(await s.query('c', [1, 0], 10)).toEqual([]);
  });
});
