// Topic-based generation as data. `generate` has two input modes: `rewrite` (the text is a draft to rewrite) and `topic` (the
// text is a subject to write NEW text about, optionally with user-supplied notes). There is no web search and no live
// research in either: in topic mode the model writes from the topic, the notes and its own knowledge, and can be wrong.

export const GENERATE_MODES = ['rewrite', 'topic'] as const;
export type GenerateMode = (typeof GENERATE_MODES)[number];

export const TOPIC_LENGTHS = ['short', 'medium', 'long'] as const;
export type TopicLength = (typeof TOPIC_LENGTHS)[number];

/** What each `length` asks of the model. Our own words, never user text. */
export const TOPIC_LENGTH_WORDS: Readonly<Record<TopicLength, string>> = {
  short: 'about 150 words',
  medium: 'about 400 words',
  long: 'about 800 words',
};

/**
 * Said on every surface next to a topic-mode result (and shown by the web UI on every topic result): the text was written from
 * the topic, the notes and the model's own knowledge, nothing was looked up, and no fact in it was checked.
 * tests/security/ui-topic-caveat.test.ts fails if ui/src/screens/generate/topicCaveat.ts differs from this word for word.
 */
export const TOPIC_CAVEAT =
  'Facts are not verified. This text was written from your topic, your notes and the model\'s own knowledge; nothing was looked up online. It may state things that are wrong or out of date. Check every fact, number, name and quote against a source before you use it.';
