import type { MatchMedia, StorageLike } from '../../src/theme/engine';

/** A matchMedia stand-in: `matches` lists the queries that are true. */
export function mediaWith(matches: readonly string[] = []): MatchMedia & { listeners: Map<string, Set<() => void>>; fire(query: string, on: boolean): void } {
  const state = new Set(matches);
  const listeners = new Map<string, Set<() => void>>();
  const fn = ((q: string) => ({
    get matches() {
      return state.has(q);
    },
    addEventListener: (_t: string, l: () => void) => void (listeners.get(q) ?? listeners.set(q, new Set()).get(q))!.add(l),
    removeEventListener: (_t: string, l: () => void) => void listeners.get(q)?.delete(l),
  })) as unknown as MatchMedia & { listeners: Map<string, Set<() => void>>; fire(query: string, on: boolean): void };
  fn.listeners = listeners;
  fn.fire = (q, on) => {
    if (on) state.add(q);
    else state.delete(q);
    for (const l of listeners.get(q) ?? []) l();
  };
  return fn;
}

export function memoryStorage(initial: Record<string, string> = {}): StorageLike & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

export const throwingStorage: StorageLike = {
  getItem() {
    throw new DOMException('denied', 'SecurityError');
  },
  setItem() {
    throw new DOMException('quota', 'QuotaExceededError');
  },
};

export const DARK = '(prefers-color-scheme: dark)';
export const LIGHT = '(prefers-color-scheme: light)';
export const REDUCE = '(prefers-reduced-motion: reduce)';
