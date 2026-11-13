// Seeded PRNG (mulberry32) so property/torture tests are reproducible.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(rnd: () => number, items: readonly T[]): T {
  return items[Math.floor(rnd() * items.length)] as T;
}

/** Concatenate `parts` random picks from `alphabet` until at least `length` characters. */
export function randomText(rnd: () => number, alphabet: readonly string[], length: number): string {
  let out = '';
  while (out.length < length) out += pick(rnd, alphabet);
  return out.slice(0, length);
}
