// Source axis: turns an author's corpus into a StylometricProfile plus retrievable exemplar chunks, and answers
// "give me this author's passages closest to X".
//
// Ingest order is a security property, not an implementation detail:
//   size guard -> confidentiality (pre-stage pipeline, fail-closed) -> profile -> chunk -> embed -> store.
// Redaction runs on the WHOLE corpus before it is split, so a secret that straddles a chunk boundary is still one
// match, and nothing downstream (profile, embedder, store, retrieval) ever sees the original text. The confidentiality
// filter detects on NFKC-normalized text, so zero-width and full-width evasions are caught.
//
// Untrusted-size guards: corpus length, chunk count, author count and query length are capped (InputTooLargeError /
// ConfigError) before the expensive work. Mutating operations (and retrieval) are serialized so a concurrent
// re-ingest can never interleave with a delete/upsert or a read of the same collection.
//
// Persistence (optional, `options.persistence`): the vector store file and a profiles file are written after every
// successful ingest / remove, INSIDE the same serialized task, and `load()` restores both. Because store.save and
// store.load run on the manager's queue they can never interleave with an ingest, a delete or a retrieval. The two
// files are written store first; a crash between the writes leaves new chunks next to the old profile, never a profile
// without chunks. Single writer: two processes saving to one state directory race last-writer-wins.
import { chunk } from '../ingestion/chunker.js';
import { extractProfile, vectorCollectionName } from '../ingestion/stylometry.js';
import { ConfigError, FilterFailedError, InputTooLargeError, ProfileError, StoreCorruptError, UnknownAuthorError } from '../models/errors.js';
import type { Embedder, ScoredChunk, StylometricProfile, VectorStore } from '../models/types.js';
import type { FilterPipeline } from '../filters/pipeline.js';
import { AUTHOR_ID, MAX_DISPLAY_NAME, loadProfiles, saveProfiles, validateProfile } from './profileFile.js';
import { access } from 'node:fs/promises';

export interface SourceLimits {
  /** Longest corpus (characters) `ingest` accepts. Default 10,000,000. */
  maxCorpusChars?: number;
  /** Most chunks one corpus may produce. Default 50,000. */
  maxChunks?: number;
  /** Most authors held at once. Default 1,000. */
  maxAuthors?: number;
  /** Longest retrieval query (characters). Default 200,000 (the engine's input limit). */
  maxQueryChars?: number;
}

export interface SourceManagerOptions {
  store: VectorStore;
  embedder: Embedder;
  /** A pipeline built for the `pre` stage that includes the fail-closed `confidentiality` filter. */
  confidentiality: FilterPipeline;
  chunkCfg: { size: number; overlap: number };
  limits?: SourceLimits;
  /** Where `load()` / `save()` (and the automatic save after ingest / remove) read and write. Needs a store with save/load. */
  persistence?: { storePath: string; profilesPath: string };
}

const MAX_K = 100;
const EMBED_BATCH = 128;

const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const copyProfile = (p: StylometricProfile): StylometricProfile => ({
  ...p,
  preferredPunctuation: [...p.preferredPunctuation],
  commonTransitionWords: [...p.commonTransitionWords],
});
const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return false;
      throw err;
    },
  );
const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export class SourceManager {
  readonly #store: VectorStore;
  readonly #embedder: Embedder;
  readonly #confidentiality: FilterPipeline;
  readonly #chunkCfg: { size: number; overlap: number };
  readonly #limits: Required<SourceLimits>;
  readonly #persistence: { storePath: string; profilesPath: string } | undefined;
  readonly #profiles = new Map<string, StylometricProfile>();
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: SourceManagerOptions) {
    if (!options.confidentiality.names.includes('confidentiality')) {
      throw new ConfigError('SourceManager: the confidentiality pipeline has no "confidentiality" filter');
    }
    chunk('', options.chunkCfg); // validates size/overlap now rather than on first ingest
    const l = options.limits ?? {};
    this.#limits = {
      maxCorpusChars: l.maxCorpusChars ?? 10_000_000,
      maxChunks: l.maxChunks ?? 50_000,
      maxAuthors: l.maxAuthors ?? 1_000,
      maxQueryChars: l.maxQueryChars ?? 200_000,
    };
    for (const [name, v] of Object.entries(this.#limits)) {
      if (!Number.isInteger(v) || v < 1) throw new ConfigError(`SourceManager: limits.${name} must be an integer >= 1`);
    }
    if (options.persistence !== undefined) {
      const { storePath, profilesPath } = options.persistence;
      if (typeof storePath !== 'string' || storePath === '' || typeof profilesPath !== 'string' || profilesPath === '' || storePath === profilesPath) {
        throw new ConfigError('SourceManager: persistence needs two distinct, non-empty file paths');
      }
      if (typeof options.store.save !== 'function' || typeof options.store.load !== 'function') {
        throw new ConfigError('SourceManager: persistence needs a vector store with save() and load()');
      }
      this.#persistence = { storePath, profilesPath };
    }
    this.#store = options.store;
    this.#embedder = options.embedder;
    this.#confidentiality = options.confidentiality;
    this.#chunkCfg = { size: options.chunkCfg.size, overlap: options.chunkCfg.overlap };
  }

  /**
   * Redact, profile, chunk, embed and store `text` as the corpus of `authorId`, replacing any earlier ingest of the
   * same author. Everything that can fail on the input (size, redaction, profile, chunk count, embedding) happens
   * before the previous data is touched, and the store swap uses `replaceCollection` (atomic), so a rejected ingest
   * leaves the author as it was. A store without `replaceCollection` falls back to delete-then-upsert, where a store
   * failure drops the author.
   */
  ingest(authorId: string, displayName: string, text: string): Promise<StylometricProfile> {
    return this.#serial(() => this.#ingest(authorId, displayName, text));
  }

  async #ingest(authorId: string, displayName: string, text: string): Promise<StylometricProfile> {
    this.#checkAuthorId(authorId);
    if (typeof displayName !== 'string' || displayName.trim() === '' || displayName.length > MAX_DISPLAY_NAME) {
      throw new ConfigError(`displayName must be a non-blank string of at most ${MAX_DISPLAY_NAME} characters`);
    }
    if (typeof text !== 'string') throw new TypeError('ingest: text must be a string');
    if (text.length > this.#limits.maxCorpusChars) throw new InputTooLargeError(text.length, this.#limits.maxCorpusChars);
    if (!this.#profiles.has(authorId) && this.#profiles.size >= this.#limits.maxAuthors) {
      throw new InputTooLargeError(this.#profiles.size + 1, this.#limits.maxAuthors, 'authors');
    }

    // The id is stored in plaintext (profile, collection name, chunk ids and authorIds, the store file), so it gets the
    // same treatment as the corpus: an id the confidentiality filter would change is refused, and never echoed.
    if ((await this.#redact(authorId, authorId)) !== authorId) {
      throw new ConfigError('authorId rejected: it matches a confidential pattern (value withheld); choose a neutral identifier');
    }
    const safeText = await this.#redact(authorId, text);
    const safeName = (await this.#redact(authorId, displayName.trim())).replace(/\s+/g, ' ');
    const profile = extractProfile(authorId, safeName, safeText);
    const pieces = chunk(safeText, { ...this.#chunkCfg, maxChunks: this.#limits.maxChunks });

    const chunks = pieces.map((t, index) => ({ id: `${authorId}#${String(index).padStart(8, '0')}`, authorId, text: t, index }));
    const items: Array<{ id: string; vector: number[]; chunk: (typeof chunks)[number] }> = [];
    for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
      const batch = chunks.slice(i, i + EMBED_BATCH);
      const vectors = await this.#embedder.embed(batch.map((c) => c.text));
      if (vectors.length !== batch.length) throw new Error('embedder returned a different number of vectors than texts');
      batch.forEach((c, j) => items.push({ id: c.id, vector: vectors[j] as number[], chunk: c }));
      if (i + EMBED_BATCH < chunks.length) await yieldToEventLoop();
    }

    const collection = profile.vectorCollectionName;
    if (typeof this.#store.replaceCollection === 'function') {
      // Atomic: on any rejection (capacity, dimensions, I/O) the previous chunks and profile are untouched.
      await this.#store.replaceCollection(collection, items);
    } else {
      // A store without atomic replace cannot offer the guarantee: the old chunks are dropped before the upsert.
      await this.#store.deleteCollection(collection);
      try {
        await this.#store.upsert(collection, items);
      } catch (err) {
        // Do not keep a profile that points at nothing.
        await this.#store.deleteCollection(collection).catch(() => undefined);
        this.#profiles.delete(authorId);
        throw err;
      }
    }
    this.#profiles.set(authorId, profile);
    await this.#persist();
    return copyProfile(profile);
  }

  /** Run the corpus through the pre-stage confidentiality pipeline. Fails closed if the filter did not demonstrably run. */
  async #redact(authorId: string, text: string): Promise<string> {
    const out = await this.#confidentiality.run(text, { authorId, personaKey: 'ingest', stage: 'pre' });
    if (!out.trace.some((t) => t.filter === 'confidentiality' && t.error === undefined)) {
      throw new FilterFailedError('confidentiality');
    }
    return out.text;
  }

  /** The stored profile (a copy). Throws `UnknownAuthorError` if the author was never ingested or was removed. */
  getProfile(authorId: string): StylometricProfile {
    const p = this.#profiles.get(authorId);
    if (p === undefined) throw new UnknownAuthorError(authorId);
    return copyProfile(p);
  }

  /** Every author's profile, sorted by author id. */
  listAuthors(): StylometricProfile[] {
    return [...this.#profiles.keys()].sort(compareCodeUnits).map((id) => copyProfile(this.#profiles.get(id) as StylometricProfile));
  }

  /** The `k` chunks of `authorId` most similar to `query` (1 <= k <= 100), best first. Never returns another author's chunks. */
  retrieve(authorId: string, query: string, k: number): Promise<ScoredChunk[]> {
    return this.#serial(async () => {
      const profile = this.#profiles.get(authorId);
      if (profile === undefined) throw new UnknownAuthorError(authorId);
      if (!Number.isInteger(k) || k < 1 || k > MAX_K) throw new RangeError(`retrieve: k must be an integer in [1, ${MAX_K}] (got ${String(k)})`);
      if (typeof query !== 'string') throw new TypeError('retrieve: query must be a string');
      if (query.length > this.#limits.maxQueryChars) throw new InputTooLargeError(query.length, this.#limits.maxQueryChars);
      const [vector] = await this.#embedder.embed([query]);
      const hits = await this.#store.query(profile.vectorCollectionName, vector as number[], k);
      return hits.filter((h) => h.authorId === authorId);
    });
  }

  /** Delete the author's profile and chunks. Throws `UnknownAuthorError` if there is no such author. */
  remove(authorId: string): Promise<void> {
    return this.#serial(async () => {
      if (!this.#profiles.has(authorId)) throw new UnknownAuthorError(authorId);
      await this.#store.deleteCollection(vectorCollectionName(authorId));
      this.#profiles.delete(authorId);
      await this.#persist();
    });
  }

  /**
   * Replace every held profile with `profiles` (all-or-nothing; each record is validated, `ProfileError` names the
   * field). For callers that persist profiles themselves; the chunks must already be in the store. Serialized.
   */
  restoreProfiles(profiles: readonly unknown[]): Promise<void> {
    return this.#serial(async () => {
      if (!Array.isArray(profiles)) throw new TypeError('restoreProfiles: profiles must be an array');
      if (profiles.length > this.#limits.maxAuthors) throw new InputTooLargeError(profiles.length, this.#limits.maxAuthors, 'authors');
      const next = new Map<string, StylometricProfile>();
      profiles.forEach((raw, i) => {
        const p = validateProfile(raw, `profiles[${i}]`);
        if (next.has(p.authorId)) throw new ProfileError(`invalid profiles[${i}].authorId: duplicate`);
        next.set(p.authorId, p);
      });
      this.#profiles.clear();
      for (const [id, p] of next) this.#profiles.set(id, p);
    });
  }

  /**
   * Restore the persisted state: the vector store file, then the profiles file. Neither file present = a fresh, empty
   * state (first run). Exactly one present, a corrupt file, a profile without stored chunks, or a store whose vector
   * dimension differs from the embedder's = `StoreCorruptError`. The held profiles are unchanged on any rejection; the
   * store's contents are replaced as soon as its file validated (a later rejection leaves the loaded chunks next to
   * the old profiles, so treat a rejected `load()` as fatal for this manager).
   */
  load(): Promise<void> {
    return this.#serial(() => this.#load());
  }

  /** Write the store and profiles files now (also happens automatically after every ingest / remove). */
  save(): Promise<void> {
    return this.#serial(() => this.#persist());
  }

  async #load(): Promise<void> {
    const p = this.#persistence;
    if (p === undefined) throw new ConfigError('SourceManager: no persistence configured');
    const [haveStore, haveProfiles] = await Promise.all([exists(p.storePath), exists(p.profilesPath)]);
    if (!haveStore && !haveProfiles) return;
    if (haveStore !== haveProfiles) {
      throw new StoreCorruptError(`persisted state is incomplete: the ${haveStore ? 'profiles' : 'vector store'} file is missing`);
    }
    const profiles = await loadProfiles(p.profilesPath, this.#limits.maxAuthors);
    await this.#store.load!(p.storePath); // atomic: unchanged on rejection
    const zero = new Array<number>(this.#embedder.dim).fill(0);
    for (const profile of profiles) {
      let probe: ScoredChunk[];
      try {
        probe = await this.#store.query(profile.vectorCollectionName, zero, 1);
      } catch (err) {
        throw new StoreCorruptError('persisted vectors do not match the embedder (dimension mismatch)', { cause: err });
      }
      if (probe.length === 0) throw new StoreCorruptError('persisted state is inconsistent: a profile has no stored chunks');
    }
    this.#profiles.clear();
    for (const profile of profiles) this.#profiles.set(profile.authorId, profile);
  }

  async #persist(): Promise<void> {
    const p = this.#persistence;
    if (p === undefined) return;
    await this.#store.save!(p.storePath);
    await saveProfiles(p.profilesPath, this.listAuthors());
  }

  #checkAuthorId(authorId: unknown): void {
    if (typeof authorId !== 'string' || !AUTHOR_ID.test(authorId)) {
      throw new ConfigError('authorId must be 1-64 characters: letters, digits, ".", "_" or "-", starting with a letter or digit');
    }
  }

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn);
    this.#queue = run.catch(() => undefined);
    return run;
  }
}
