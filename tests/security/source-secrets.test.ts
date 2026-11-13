// SRC-04: secrets planted in an author's corpus never reach the store, the embedder, the profile or retrieval.
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HashEmbedder } from '../../src/embedding/hashEmbedder.js';
import { ConfidentialityFilter } from '../../src/filters/confidentiality.js';
import { FilterPipeline } from '../../src/filters/pipeline.js';
import { ConfigError, UnknownAuthorError } from '../../src/models/errors.js';
import type { Embedder, VectorStore } from '../../src/models/types.js';
import { SourceManager } from '../../src/registry/sourceManager.js';
import { InMemoryVectorStore } from '../../src/store/inMemoryVectorStore.js';
import { makeSecrets } from '../fixtures/leaks/secrets.js';

const SIZE = 200;
const prose = (n: number): string =>
  Array.from({ length: n }, (_, i) => `Sentence ${i} describes ordinary project work in plain words.`).join(' ');

interface Rig {
  sm: SourceManager;
  store: InMemoryVectorStore;
  seenByEmbedder: string[];
  seenByStore: string[];
}

function rig(blocklist: string[] = []): Rig {
  const store = new InMemoryVectorStore();
  const seenByStore: string[] = [];
  const seenByEmbedder: string[] = [];
  const spyStore: VectorStore = {
    upsert: async (c, items) => {
      seenByStore.push(...items.map((i) => i.chunk.text));
      return store.upsert(c, items);
    },
    query: (c, v, k) => store.query(c, v, k),
    deleteCollection: (c) => store.deleteCollection(c),
  };
  const inner = new HashEmbedder(64);
  const embedder: Embedder = {
    dim: 64,
    embed: async (t) => {
      seenByEmbedder.push(...t);
      return inner.embed(t);
    },
  };
  const sm = new SourceManager({
    store: spyStore,
    embedder,
    confidentiality: new FilterPipeline({ stage: 'pre', requireConfidentiality: true }).register(new ConfidentialityFilter({ blocklist })),
    chunkCfg: { size: SIZE, overlap: 30 },
  });
  return { sm, store, seenByEmbedder, seenByStore };
}

const dump = async (r: Rig, file: string): Promise<string> => {
  await r.store.save(file);
  return readFile(file, 'utf8');
};

describe('SRC-04: corpus secrets never reach the store', () => {
  it.each(['aws', 'ghp', 'sk', 'jwt', 'slack', 'google', 'pemRsa', 'pemPkcs8', 'pemOpenssh'])(
    'a planted %s secret is absent from store chunks, embedder input, retrieval and the saved file',
    async (kind) => {
      const dir = await mkdtemp(join(tmpdir(), 'gw-sec-'));
      try {
        const secret = makeSecrets(7)[kind]!();
        const corpus = `${prose(8)}\n\nOur note: ${secret.text}\n\n${prose(8)}`;
        const r = rig();
        await r.sm.ingest('ada', 'Ada', corpus);
        const saved = await dump(r, join(dir, 'store.json'));
        const hits = await r.sm.retrieve('ada', "sentence describes ordinary project work", 100);
        const everything = [...r.seenByStore, ...r.seenByEmbedder, saved, JSON.stringify(hits), JSON.stringify(r.sm.getProfile('ada'))];
        for (const v of secret.values) for (const where of everything) expect(where).not.toContain(v);
        expect(r.seenByStore.join('\n')).toContain('[REDACTED:');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it('catches a secret that would straddle a chunk boundary (redaction runs before chunking)', async () => {
    const secret = makeSecrets(11).aws!();
    for (let pad = 0; pad < 40; pad++) {
      const r = rig();
      // Shift the secret across every alignment relative to the chunk size.
      await r.sm.ingest('ada', 'Ada', `${'x '.repeat(SIZE / 2 - 8 + pad)}${secret.text} ${prose(3)}`);
      for (const t of r.seenByStore) expect(t).not.toContain(secret.text.slice(4)); // no fragment of the key body
      expect(r.seenByStore.join('')).not.toContain(secret.text.slice(0, 10));
    }
  });

  it('catches evasion by zero-width characters and full-width letters (detection on NFKC text)', async () => {
    const aws = makeSecrets(3).aws!().text;
    const zw = `${aws.slice(0, 2)}​${aws.slice(2, 6)}⁠${aws.slice(6)}`;
    const fw = aws.replace(/[A-Z0-9]/g, (c) => String.fromCodePoint(c.codePointAt(0)! + (c >= '0' && c <= '9' ? 0xfee0 : 0xfee0)));
    for (const variant of [zw, fw]) {
      const r = rig();
      await r.sm.ingest('ada', 'Ada', `${prose(4)}\n${variant}\n${prose(4)}`);
      const all = r.seenByStore.join('\n') + r.seenByEmbedder.join('\n');
      expect(all).not.toContain(aws.slice(4));
      expect(all.normalize('NFKC').replace(/[​⁠]/g, '')).not.toContain(aws.slice(4));
      expect(all).toContain('[REDACTED:aws_key]');
    }
  });

  it('applies the blocklist and redacts a secret placed in the display name', async () => {
    const r = rig(['Project Nightfall']);
    const key = makeSecrets(5).ghp!();
    const p = await r.sm.ingest('ada', `Ada ${key.text}`, `${prose(5)} We shipped Project Nightfall early. ${prose(5)}`);
    expect(r.seenByStore.join('\n')).not.toContain('Nightfall');
    expect(p.displayName).not.toContain(key.text);
    expect(r.sm.getProfile('ada').displayName).not.toContain(key.text);
  });

  it('redaction placeholders do not skew the profile of an otherwise identical corpus', async () => {
    const key = makeSecrets(9).aws!().text;
    const clean = rig();
    const dirty = rig();
    const base = prose(10);
    const a = await clean.sm.ingest('ada', 'Ada', base);
    const b = await dirty.sm.ingest('ada', 'Ada', `${base} ${key}`);
    expect(b.preferredPunctuation).toEqual(a.preferredPunctuation);
    expect(b.corpusWordCount).toBe(a.corpusWordCount);
  });

  it('the saved store file is owner read/write only', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gw-sec-'));
    try {
      const r = rig();
      await r.sm.ingest('ada', 'Ada', prose(5));
      const file = join(dir, 'nested', 'store.json');
      await r.store.save(file);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('CR-03: a secret-shaped authorId is refused and never echoed', () => {
  it.each(['aws', 'ghp', 'sk', 'slack'])('a %s-shaped authorId is rejected with ConfigError and reaches no store, embedder or message', async (kind) => {
    const id = makeSecrets(11)[kind]!().text;
    expect(id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/); // it passes the plain syntax check, so only redaction can stop it
    const r = rig();
    let caught: unknown;
    try {
      await r.sm.ingest(id, 'Ada', prose(5));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect(String((caught as Error).message)).not.toContain(id);
    expect(JSON.stringify(caught, Object.getOwnPropertyNames(caught))).not.toContain(id);
    expect(r.seenByStore).toEqual([]);
    expect(r.seenByEmbedder).toEqual([]);
    expect(r.sm.listAuthors()).toEqual([]);
    const dir = await mkdtemp(join(tmpdir(), 'gw-sec-'));
    try {
      expect(await dump(r, join(dir, 'store.json'))).not.toContain(id);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a blocklisted term as authorId is rejected too; an ordinary id still works', async () => {
    const r = rig(['nightfall']);
    await expect(r.sm.ingest('nightfall', 'Ada', prose(5))).rejects.toBeInstanceOf(ConfigError);
    await expect(r.sm.ingest('ada-1', 'Ada', prose(5))).resolves.toMatchObject({ authorId: 'ada-1' });
  });

  it('UnknownAuthorError (retrieve/remove/getProfile) does not echo a secret-shaped id in message or JSON', async () => {
    const id = makeSecrets(12).ghp!().text;
    const r = rig();
    const errs: unknown[] = [];
    await r.sm.retrieve(id, 'q', 3).catch((e: unknown) => errs.push(e));
    await r.sm.remove(id).catch((e: unknown) => errs.push(e));
    try {
      r.sm.getProfile(id);
    } catch (e) {
      errs.push(e);
    }
    expect(errs).toHaveLength(3);
    for (const e of errs) {
      expect(e).toBeInstanceOf(UnknownAuthorError);
      expect((e as Error).message).not.toContain(id);
      expect(JSON.stringify(e)).not.toContain(id);
      expect((e as UnknownAuthorError).authorId).toBe(id); // still available programmatically
    }
  });
});
