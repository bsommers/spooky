// Feature-hashing bag-of-words embedder (SRC-02). Offline, deterministic and dependency free. It captures lexical
// overlap only, not meaning (accepted: the `Embedder` interface is the seam for a real model in v2).
//
// Tokens are lower-cased runs of letters/digits; each token is FNV-1a hashed into one of `dim` buckets and counted;
// the count vector is L2-normalized. Text with no tokens embeds to the zero vector (which scores 0 against anything).
import { ConfigError } from '../models/errors.js';
import type { Embedder } from '../models/types.js';

const TOKEN = /[\p{L}\p{N}]+/gu;
const MAX_DIM = 65_536;
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** 32-bit FNV-1a over the UTF-16 code units of `s`, two bytes (low, high) per unit. */
function fnv1a(s: string): number {
  let h = FNV_OFFSET;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h = Math.imul(h ^ (c & 0xff), FNV_PRIME);
    h = Math.imul(h ^ (c >>> 8), FNV_PRIME);
  }
  return h >>> 0;
}

export class HashEmbedder implements Embedder {
  readonly dim: number;

  constructor(dim = 256) {
    if (!Number.isInteger(dim) || dim < 1 || dim > MAX_DIM) {
      throw new ConfigError(`HashEmbedder: dim must be an integer in [1, ${MAX_DIM}] (got ${String(dim)})`);
    }
    this.dim = dim;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.#embedOne(t));
  }

  #embedOne(text: string): number[] {
    if (typeof text !== 'string') throw new TypeError('HashEmbedder: texts must be strings');
    const v = new Array<number>(this.dim).fill(0);
    for (const m of text.toLowerCase().matchAll(TOKEN)) {
      const bucket = fnv1a(m[0]) % this.dim;
      v[bucket] = (v[bucket] as number) + 1;
    }
    let sq = 0;
    for (const x of v) sq += x * x;
    if (sq === 0) return v;
    const n = Math.sqrt(sq);
    for (let i = 0; i < v.length; i++) v[i] = (v[i] as number) / n;
    return v;
  }
}
