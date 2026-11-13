// In-memory cosine-similarity vector store with a JSON persistence file (SRC-03).
//
//  * Retrieval is exact and deterministic: score = cosine similarity (0 when either vector is all zeros), ordered by
//    score descending then chunk id ascending (code-unit order), so ties never depend on insertion order.
//  * The persisted file is plaintext chunk text. It is written with mode 0600 through a temp file + rename (a crash or
//    full disk cannot leave a half-written store, and a symlink at the target is replaced, not followed).
//  * Loading treats the file as untrusted: size is checked before reading, the JSON is validated field by field
//    (typed `StoreCorruptError`, messages never contain file content), item/collection/dimension counts are capped,
//    and the live contents are replaced only after the whole file validated.
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { InputTooLargeError, StoreCorruptError } from '../models/errors.js';
import type { Chunk, ScoredChunk, VectorStore } from '../models/types.js';

const FORMAT = 'ghostwriter-vector-store';
const VERSION = 1;
const MAX_DIM = 65_536;

export interface InMemoryVectorStoreOptions {
  /** Largest store file `save` will write and `load` will read. Default 256 MiB. */
  maxFileBytes?: number;
  /** Most vectors held at once (across collections), enforced on `upsert` and `load`. Default 200,000. */
  maxItems?: number;
  /** Most collections `save` will write and a loaded file may hold. Default 10,000. */
  maxCollections?: number;
}

interface Entry {
  vector: Float64Array;
  /** Largest absolute component and the norm of `vector / max`; (0, 0) for an all-zero vector. See `scale`. */
  max: number;
  snorm: number;
  chunk: Chunk;
}
interface Collection {
  dim: number;
  items: Map<string, Entry>;
}

const compareIds = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Overflow/underflow-safe magnitude of a finite vector: `max` is the largest absolute component and `snorm` the
 * Euclidean norm of `v / max` (so in [1, sqrt(dim)]). The true norm is `max * snorm`, which is never formed because it
 * can overflow; scores use the two factors separately. An all-zero vector is (0, 0).
 */
function scale(v: ArrayLike<number>): { max: number; snorm: number } {
  let max = 0;
  for (let i = 0; i < v.length; i++) {
    const a = Math.abs(v[i] as number);
    if (a > max) max = a;
  }
  if (max === 0) return { max: 0, snorm: 0 };
  let s = 0;
  for (let i = 0; i < v.length; i++) {
    const y = (v[i] as number) / max;
    s += y * y;
  }
  return { max, snorm: Math.sqrt(s) };
}

/** Cosine similarity from two scaled vectors: always finite and within [-1, 1]; 0 when either is all zeros. */
function cosine(a: ArrayLike<number>, am: number, as: number, b: ArrayLike<number>, bm: number, bs: number): number {
  if (am === 0 || bm === 0) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += ((a[i] as number) / am) * ((b[i] as number) / bm);
  const score = dot / (as * bs);
  return Number.isFinite(score) ? Math.max(-1, Math.min(1, score)) : 0;
}

function toVector(raw: unknown, what: string): Float64Array {
  if (!Array.isArray(raw)) throw new TypeError(`${what} must be an array of numbers`);
  const v = new Float64Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    const x: unknown = raw[i];
    if (typeof x !== 'number' || !Number.isFinite(x)) throw new TypeError(`${what} must contain only finite numbers`);
    v[i] = x;
  }
  return v;
}

/** The one chunk-shape check shared by `upsert` and `load`: `[field, problem]` for the first violation, else undefined. */
function chunkProblem(chunk: unknown, id: string): [string, string] | undefined {
  if (chunk === null || typeof chunk !== 'object' || Array.isArray(chunk)) return ['chunk', 'not an object'];
  const c = chunk as Record<string, unknown>;
  if (c.id !== id) return ['chunk.id', 'differs from item id'];
  if (typeof c.authorId !== 'string') return ['chunk.authorId', 'not a string'];
  if (typeof c.text !== 'string') return ['chunk.text', 'not a string'];
  if (typeof c.index !== 'number' || !Number.isInteger(c.index) || c.index < 0) return ['chunk.index', 'not a non-negative integer'];
  return undefined;
}

const copyChunk = (c: Chunk): Chunk => ({ id: c.id, authorId: c.authorId, text: c.text, index: c.index });

export class InMemoryVectorStore implements VectorStore {
  #collections = new Map<string, Collection>();
  readonly #maxFileBytes: number;
  readonly #maxItems: number;
  readonly #maxCollections: number;

  constructor(options: InMemoryVectorStoreOptions = {}) {
    this.#maxFileBytes = options.maxFileBytes ?? 256 * 1024 * 1024;
    this.#maxItems = options.maxItems ?? 200_000;
    this.#maxCollections = options.maxCollections ?? 10_000;
  }

  /** Validate a batch and build its entries; throws before anything is stored. */
  #stage(items: { id: string; vector: number[]; chunk: Chunk }[], dim0: number | undefined): { staged: Array<[string, Entry]>; dim: number | undefined } {
    let dim = dim0;
    const staged: Array<[string, Entry]> = [];
    for (const it of items) {
      const vector = toVector(it.vector, `vector for "${String(it.id).slice(0, 40)}"`);
      if (typeof it.id !== 'string' || it.chunk?.id !== it.id) throw new TypeError('upsert: item.id must equal item.chunk.id');
      const problem = chunkProblem(it.chunk, it.id);
      if (problem !== undefined) throw new TypeError(`upsert: ${problem[0]} is invalid (${problem[1]})`);
      if (vector.length < 1 || vector.length > MAX_DIM) throw new TypeError(`upsert: vector dimension must be in [1, ${MAX_DIM}]`);
      if (dim === undefined) dim = vector.length;
      else if (vector.length !== dim) throw new TypeError(`upsert: vector has ${vector.length} dimensions; collection has ${dim}`);
      staged.push([it.id, { vector, ...scale(vector), chunk: copyChunk(it.chunk) }]);
    }
    return { staged, dim };
  }

  /** Insert or replace by id. The whole batch is validated first; a bad item stores nothing from the batch. */
  async upsert(collection: string, items: { id: string; vector: number[]; chunk: Chunk }[]): Promise<void> {
    const existing = this.#collections.get(collection);
    const { staged, dim } = this.#stage(items, existing?.dim);
    if (staged.length === 0) return;

    let added = 0;
    const seen = new Set<string>();
    for (const [id] of staged) {
      if (existing?.items.has(id) || seen.has(id)) continue;
      seen.add(id);
      added++;
    }
    if (this.#size() + added > this.#maxItems) throw new InputTooLargeError(this.#size() + added, this.#maxItems, 'vectors');

    let col = existing;
    if (col === undefined) {
      col = { dim: dim as number, items: new Map() };
      this.#collections.set(collection, col);
    }
    for (const [id, entry] of staged) col.items.set(id, entry);
  }

  /**
   * Atomically make `collection` hold exactly `items` (any earlier contents are dropped). The new collection is built
   * and its capacity checked (net of the collection it replaces) before the swap, so a rejection of any kind leaves
   * the previous contents untouched. An empty `items` deletes the collection.
   */
  async replaceCollection(collection: string, items: { id: string; vector: number[]; chunk: Chunk }[]): Promise<void> {
    const { staged, dim } = this.#stage(items, undefined);
    if (staged.length === 0) {
      this.#collections.delete(collection);
      return;
    }
    const next: Collection = { dim: dim as number, items: new Map(staged) };
    const total = this.#size() - (this.#collections.get(collection)?.items.size ?? 0) + next.items.size;
    if (total > this.#maxItems) throw new InputTooLargeError(total, this.#maxItems, 'vectors');
    this.#collections.set(collection, next);
  }

  async query(collection: string, vector: number[], k: number): Promise<ScoredChunk[]> {
    if (!Number.isInteger(k) || k < 0) throw new RangeError(`query: k must be a non-negative integer (got ${String(k)})`);
    const q = toVector(vector, 'query vector');
    const col = this.#collections.get(collection);
    if (col === undefined) return [];
    if (q.length !== col.dim) throw new TypeError(`query: vector has ${q.length} dimensions; collection has ${col.dim}`);
    if (k === 0) return [];
    const qs = scale(q);
    const scored: Array<{ id: string; score: number; entry: Entry }> = [];
    for (const [id, entry] of col.items) {
      scored.push({ id, score: cosine(q, qs.max, qs.snorm, entry.vector, entry.max, entry.snorm), entry });
    }
    // Scores are always finite (see `cosine`), so this comparator is a strict weak order.
    scored.sort((a, b) => (a.score > b.score ? -1 : a.score < b.score ? 1 : compareIds(a.id, b.id)));
    return scored.slice(0, k).map(({ score, entry }) => ({ ...copyChunk(entry.chunk), score }));
  }

  async deleteCollection(collection: string): Promise<void> {
    this.#collections.delete(collection);
  }

  /** Write the store to `path` (parents created), atomically, with mode 0600. Output is byte-deterministic. */
  async save(path: string): Promise<void> {
    // Enforce the limits `load` enforces, before anything is written: a file this store could write but not read back
    // would turn a working store into unrecoverable data.
    if (this.#collections.size > this.#maxCollections) throw new InputTooLargeError(this.#collections.size, this.#maxCollections, 'collections');
    if (this.#size() > this.#maxItems) throw new InputTooLargeError(this.#size(), this.#maxItems, 'vectors');
    const collections = [...this.#collections.entries()]
      .sort(([a], [b]) => compareIds(a, b))
      .map(([name, col]) => ({
        name,
        dim: col.dim,
        items: [...col.items.entries()]
          .sort(([a], [b]) => compareIds(a, b))
          .map(([id, e]) => ({ id, vector: Array.from(e.vector), chunk: e.chunk })),
      }));
    let data: string;
    try {
      data = JSON.stringify({ format: FORMAT, version: VERSION, collections });
    } catch (err) {
      if (err instanceof RangeError) throw new InputTooLargeError(Number.POSITIVE_INFINITY, this.#maxFileBytes, 'bytes'); // beyond the engine's string limit
      throw err;
    }
    const bytes = Buffer.byteLength(data, 'utf8');
    if (bytes > this.#maxFileBytes) throw new InputTooLargeError(bytes, this.#maxFileBytes, 'bytes');

    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      const fh = await open(tmp, 'wx', 0o600);
      try {
        await fh.writeFile(data, 'utf8');
        await fh.chmod(0o600); // the open mode is masked by the umask; state the permissions explicitly
        await fh.sync();
      } finally {
        await fh.close();
      }
      await rename(tmp, path);
      await chmod(path, 0o600);
    } catch (err) {
      await unlink(tmp).catch(() => undefined);
      throw err;
    }
  }

  /**
   * Replace the store's contents with those of `path`. Rejects with `InputTooLargeError` for an oversized file,
   * `StoreCorruptError` for anything that is not a valid store file, and the native error (e.g. `ENOENT`) when the
   * file cannot be read. On any rejection the current contents are unchanged.
   */
  async load(path: string): Promise<void> {
    const st = await stat(path);
    if (!st.isFile()) throw new StoreCorruptError('store path is not a regular file');
    if (st.size > this.#maxFileBytes) throw new InputTooLargeError(st.size, this.#maxFileBytes, 'bytes');
    const buf = await readFile(path);
    if (buf.length > this.#maxFileBytes) throw new InputTooLargeError(buf.length, this.#maxFileBytes, 'bytes'); // grew after stat
    let parsed: unknown;
    try {
      parsed = JSON.parse(buf.toString('utf8'));
    } catch (err) {
      throw new StoreCorruptError('store file is not valid JSON', { cause: err });
    }
    this.#collections = this.#validate(parsed);
  }

  #size(): number {
    let n = 0;
    for (const c of this.#collections.values()) n += c.items.size;
    return n;
  }

  #validate(root: unknown): Map<string, Collection> {
    const bad = (where: string, why: string): never => {
      throw new StoreCorruptError(`invalid store file: ${where}: ${why}`);
    };
    const isObj = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);
    if (!isObj(root)) return bad('root', 'not an object');
    if (root.format !== FORMAT) return bad('format', 'unrecognised');
    if (root.version !== VERSION) return bad('version', 'unsupported');
    if (!Array.isArray(root.collections)) return bad('collections', 'not an array');
    if (root.collections.length > this.#maxCollections) return bad('collections', `more than ${this.#maxCollections}`);

    const out = new Map<string, Collection>();
    let total = 0;
    root.collections.forEach((rawCol: unknown, ci: number) => {
      const at = `collections[${ci}]`;
      if (!isObj(rawCol)) return bad(at, 'not an object');
      const { name, dim, items } = rawCol;
      if (typeof name !== 'string') return bad(`${at}.name`, 'not a string');
      if (out.has(name)) return bad(`${at}.name`, 'duplicate collection');
      if (typeof dim !== 'number' || !Number.isInteger(dim) || dim < 1 || dim > MAX_DIM) return bad(`${at}.dim`, 'not an integer in range');
      if (!Array.isArray(items)) return bad(`${at}.items`, 'not an array');
      total += items.length;
      if (total > this.#maxItems) return bad('items', `more than ${this.#maxItems} vectors`);
      const col: Collection = { dim, items: new Map() };
      items.forEach((rawItem: unknown, ii: number) => {
        const where = `${at}.items[${ii}]`;
        if (!isObj(rawItem)) return bad(where, 'not an object');
        const { id, vector, chunk } = rawItem;
        if (typeof id !== 'string') return bad(`${where}.id`, 'not a string');
        if (col.items.has(id)) return bad(`${where}.id`, 'duplicate id');
        if (!Array.isArray(vector) || vector.length !== dim) return bad(`${where}.vector`, `not an array of ${dim} numbers`);
        const v = new Float64Array(dim);
        for (let i = 0; i < dim; i++) {
          const x: unknown = vector[i];
          if (typeof x !== 'number' || !Number.isFinite(x)) return bad(`${where}.vector[${i}]`, 'not a finite number');
          v[i] = x;
        }
        const problem = chunkProblem(chunk, id);
        if (problem !== undefined) return bad(`${where}.${problem[0]}`, problem[1]);
        const c = chunk as unknown as Chunk;
        col.items.set(id, {
          vector: v,
          ...scale(v),
          chunk: { id, authorId: c.authorId, text: c.text, index: c.index },
        });
      });
      out.set(name, col);
    });
    return out;
  }
}
