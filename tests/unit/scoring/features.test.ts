import { describe, expect, it } from 'vitest';
import { MAX_SCORE_INPUT_CHARS } from '../../../config/scorer.js';
import { FEATURE_NAMES, burstiness, cliche, computeFeatures, countCliches, lexicalDiversity, paragraphUniformity, prepareText, punctuation, repetition } from '../../../src/scoring/features.js';

const uniform = Array.from({ length: 8 }, (_, i) => `The ${['red', 'blue', 'green', 'grey', 'tall', 'old', 'new', 'dry'][i]} house stands near the quiet river.`).join(' ');
const varied =
  'No. The committee, after weeks of wrangling over budgets, schedules and who would chair what, finally agreed to meet on Thursday at noon in the old library. Fine. Nobody came. ' +
  'Then the rain started, hard and sideways, and everyone who had stayed home felt very clever indeed. Why? Because the roof leaked.';

describe('prepareText', () => {
  it('counts words, sentences and paragraphs', () => {
    const p = prepareText('One two three. Four five!\n\nSix seven eight nine?');
    expect(p.words).toHaveLength(9);
    expect(p.sentenceLengths).toEqual([3, 2, 4]);
    expect(p.paragraphLengths).toEqual([5, 4]);
  });

  it('does not split on abbreviations, initials or decimals', () => {
    const p = prepareText('Dr. Smith paid 3.5 dollars to J. Doe. Then he left, e.g. quickly.');
    expect(p.sentenceLengths).toEqual([9, 6]); // "3.5" and "e.g." count as two words each;
  });

  it('splits after sentence-final words that look like abbreviations, and after "I."', () => {
    const lens = (t: string): number[] => prepareText(t).sentenceLengths;
    expect(lens('I said no. Then he left.')).toEqual([3, 3]);
    expect(lens('She met Prof. Lee, and so did I. Then we left the co. in peace.')).toEqual([8, 5, 2]);
    expect(lens('He ran the firm for years, etc. Then he retired.')).toEqual([7, 3]);
    expect(lens('They sell shoes, hats, etc. and more. Then it closed.')).toEqual([7, 3]);
    expect(lens('Read No. 5 and Fig. 3 carefully. Then stop.')).toEqual([7, 2]);
    expect(lens('We went to St. Louis. It was fine.')).toEqual([5, 3]);
    expect(lens('The Smiths Jr. said no. Nobody cared.')).toEqual([5, 2]);
    expect(lens('J. R. R. Tolkien wrote it. Fine.')).toEqual([6, 1]);
    expect(lens('Is it Mr. Jones? Yes. He is.')).toEqual([4, 1, 2]);
  });

  it('refuses text over the scorer limit instead of running a quadratic pass', () => {
    expect(() => prepareText('\n'.repeat(MAX_SCORE_INPUT_CHARS + 1))).toThrow(/scorer limit/);
    expect(() => prepareText('word '.repeat(1000))).not.toThrow();
  });

  it('treats list items and headings as their own sentences and wrapped lines as one', () => {
    const p = prepareText('# Title\n\n- first item here\n- second item\nwrapped on\n\nA line that is\nwrapped. Another one.');
    expect(p.sentenceLengths).toEqual([1, 3, 4, 5, 2]);
  });

  it('removes fenced code, inline code, URLs and blockquotes before measuring', () => {
    const prose = 'Plain words here. More plain words follow.';
    const dirty = `${prose}\n\n\`\`\`js\nmoreover(furthermore); delve(); // tapestry\n\`\`\`\n\n> quoted moreover furthermore text\n\nSee https://example.com/delve/tapestry and \`delve()\` now.`;
    const p = prepareText(dirty);
    expect(p.words).not.toContain('moreover');
    expect(p.words).not.toContain('tapestry');
    expect(p.words).not.toContain('example');
    expect(p.words.slice(0, 7)).toEqual(['plain', 'words', 'here', 'more', 'plain', 'words', 'follow']);
  });

  it('returns empty structures for empty, blank and all-code input', () => {
    for (const text of ['', '   \n\n\t', '```\ncode only\n```\n']) {
      const p = prepareText(text);
      expect(p.words).toEqual([]);
      expect(p.sentenceLengths).toEqual([]);
      expect(p.paragraphLengths).toEqual([]);
    }
  });

  it('normalizes curly apostrophes and counts punctuation classes of the prose only', () => {
    const p = prepareText('It’s fine; really: “yes” (maybe) — wait... why?! `a;b:c`');
    expect(p.words.slice(0, 2)).toEqual(["it's", 'fine']);
    expect(p.punctuation).toMatchObject({ semicolon: 1, colon: 1, quote: 2, paren: 2, dash: 1, ellipsis: 1, question: 1, exclaim: 1 });
  });
});

describe('burstiness (sentence-length variation)', () => {
  it('uniform-length text has a high burstiness penalty', () => {
    expect(burstiness(prepareText(uniform)).value).toBeGreaterThan(0.9);
  });
  it('varied-length text has a low one', () => {
    expect(burstiness(prepareText(varied)).value).toBeLessThan(0.3);
  });
  it('is unavailable below three sentences', () => {
    expect(burstiness(prepareText('Just one sentence here. And a second.'))).toEqual({ value: 0.5, available: false });
  });
});

describe('lexicalDiversity (moving-average type-token ratio)', () => {
  it('scores a narrow vocabulary higher than a varied one', () => {
    const narrow = Array.from({ length: 80 }, (_, i) => ['the', 'cat', 'sat', 'on', 'the', 'mat'][i % 6]).join(' ');
    const wide = Array.from({ length: 80 }, (_, i) => `w${i}`).join(' ');
    expect(lexicalDiversity(prepareText(narrow)).value).toBe(1);
    expect(lexicalDiversity(prepareText(wide)).value).toBe(0);
  });
  it('is unavailable below 30 words', () => {
    expect(lexicalDiversity(prepareText('too short to measure')).available).toBe(false);
  });
});

describe('cliche (stock phrase and connective density)', () => {
  const stock =
    'Moreover, this plays a crucial role in the ever-evolving landscape. Furthermore, it fosters a robust and seamless journey. ' +
    'Additionally, we delve into the pivotal tapestry. Ultimately, it is important to note that it serves as a testament.';
  const plain =
    'The bus was late again so I walked the long way past the bakery and the shut post office and got home with wet shoes and a cold, which lasted four days.';
  it('is high for dense stock phrasing and low for plain prose', () => {
    expect(cliche(prepareText(stock)).value).toBeGreaterThan(0.9);
    expect(cliche(prepareText(plain)).value).toBeLessThan(0.05);
  });
  it('counts multi-word phrases once, longest match first', () => {
    expect(countCliches(['it', 'plays', 'a', 'crucial', 'role', 'here'])).toBe(1); // not also "crucial"
    expect(countCliches("it's important to note that x".split(' '))).toBe(1);
    expect(countCliches([])).toBe(0);
  });
  it('is unavailable below 20 words', () => {
    expect(cliche(prepareText('Moreover, furthermore.')).available).toBe(false);
  });
});

describe('punctuation variety', () => {
  const flat = 'This is a plain sentence about nothing in particular. It continues in the same plain way for a while. ' + 'Another sentence follows it. Then there is a fourth one to finish the thought.';
  const rich = 'Wait: what? "No," she said; he (reluctantly) agreed — and then, well... nothing! Why? Because (as always) the plan was bad; the result: chaos. "Fine," he said.';
  it('is high for text using only periods and commas, low for varied marks', () => {
    expect(punctuation(prepareText(flat)).value).toBeGreaterThan(0.9);
    expect(punctuation(prepareText(rich)).value).toBeLessThan(0.2);
  });
});

describe('repetition (repeated word trigrams)', () => {
  it('is high when phrases are repeated and zero when no trigram repeats', () => {
    const repeated = Array.from({ length: 10 }, () => 'we are happy to help you today').join(' ');
    const distinct = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
    expect(repetition(prepareText(repeated)).value).toBe(1);
    expect(repetition(prepareText(distinct)).value).toBe(0);
  });
});

describe('paragraphUniformity', () => {
  const para = (n: number): string => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
  it('is high for equal paragraphs and low for uneven ones', () => {
    expect(paragraphUniformity(prepareText([para(40), para(40), para(40), para(40)].join('\n\n'))).value).toBe(1);
    expect(paragraphUniformity(prepareText([para(5), para(120), para(12), para(60)].join('\n\n'))).value).toBeLessThan(0.1);
  });
  it('is unavailable with fewer than three paragraphs', () => {
    expect(paragraphUniformity(prepareText(`${para(30)}\n\n${para(30)}`)).available).toBe(false);
  });
});

describe('computeFeatures', () => {
  it('returns every feature, in order, each in [0,1]; empty text has none available', () => {
    const f = computeFeatures(prepareText(varied));
    expect(Object.keys(f)).toEqual([...FEATURE_NAMES]);
    for (const r of Object.values(f)) {
      expect(r.value).toBeGreaterThanOrEqual(0);
      expect(r.value).toBeLessThanOrEqual(1);
    }
    expect(Object.values(computeFeatures(prepareText(''))).every((r) => !r.available && r.value === 0.5)).toBe(true);
  });

  it('is unaffected by protected spans (code is excluded from every feature)', () => {
    const prose = `${varied}\n\n${uniform}`;
    const withCode = `${prose}\n\n\`\`\`\n${'moreover furthermore delve; '.repeat(200)}\n\`\`\`\n\nAlso \`delve moreover\` and https://x.example/a/b/c.`;
    expect(computeFeatures(prepareText(withCode))).toEqual(computeFeatures(prepareText(`${prose}\n\n\n\nAlso   and .`)));
  });
});
