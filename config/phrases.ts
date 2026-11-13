// Style-filter phrase list as data (STY-02). Each entry is a LITERAL phrase (never a regex), matched case-insensitively
// on word boundaries, with any run of spaces/tabs between words. No `replacement` = delete the phrase (the filter
// repairs casing, commas and spacing around the gap); with a `replacement` the phrase is substituted, keeping the
// original's casing (lower / Capitalized / UPPER).
import type { PhraseEntry, RhythmSettings } from '../src/filters/style.js';

export const DEFAULT_PHRASES: readonly PhraseEntry[] = [
  // connectives and throat-clearing: deleted
  { pattern: 'furthermore' },
  { pattern: 'moreover' },
  { pattern: 'additionally' },
  { pattern: 'in conclusion' },
  { pattern: 'in summary' },
  { pattern: 'to summarize' },
  { pattern: 'needless to say' },
  { pattern: 'it is important to note that' },
  { pattern: "it's important to note that" },
  { pattern: 'it is worth noting that' },
  { pattern: "it's worth noting that" },
  { pattern: 'it should be noted that' },
  { pattern: 'at the end of the day' },
  { pattern: "in today's fast-paced world" },
  { pattern: "in today's digital age" },
  { pattern: 'in the ever-evolving landscape of' },
  // stock verbs and phrases: replaced with plainer wording
  { pattern: 'delve into', replacement: 'dig into' },
  { pattern: 'delves into', replacement: 'digs into' },
  { pattern: 'delving into', replacement: 'digging into' },
  { pattern: 'utilize', replacement: 'use' },
  { pattern: 'utilizes', replacement: 'uses' },
  { pattern: 'utilizing', replacement: 'using' },
  { pattern: 'in order to', replacement: 'to' },
  { pattern: 'due to the fact that', replacement: 'because' },
  { pattern: 'a testament to', replacement: 'proof of' },
  { pattern: 'a rich tapestry of', replacement: 'a mix of' },
  { pattern: 'navigate the complexities of', replacement: 'handle' },
  { pattern: 'game-changer', replacement: 'big change' },
  { pattern: 'unlock the potential of', replacement: 'make use of' },
];

/** Rhythm check (STY-03): see StyleFilter. */
export const DEFAULT_RHYTHM: RhythmSettings = {
  /** a run of at least this many consecutive sentences of near-equal length is flagged */
  runMin: 4,
  /** "near-equal" = every sentence within this fraction of the run's mean length (+-15%) */
  tolerance: 0.15,
  /** a sentence needs at least this many words before it may be split */
  minSplitWords: 8,
};
