import { describe, expect, it } from 'vitest';
import { checkMeaning } from '../../../src/humanize/guard.js';
import { hasPreamble, rewriteWithLlm } from '../../../src/humanize/rewriteLlm.js';
import { MockLlmClient } from '../../../src/llm/mockClient.js';
import { LlmError } from '../../../src/models/errors.js';
import { fastRetry } from '../../helpers/rig.js';

const text = 'The release is ready and the notes cover every change in the new build for the whole team.';
const ask = (answer: string, original = text) =>
  rewriteWithLlm(new MockLlmClient([answer]), { text: original, features: ['cliche'] }, { maxTokens: 100, temperature: 0.5, retry: { ...fastRetry, maxRetries: 0 } });

describe('rewriteWithLlm answers (HR-02)', () => {
  it('a preamble line is rejected as an LlmError, not accepted as document text', async () => {
    await expect(ask(`Here is the edited text:\n${text}`)).rejects.toBeInstanceOf(LlmError);
    await expect(ask(`Sure! Here's the rewrite.\n${text}`)).rejects.toBeInstanceOf(LlmError);
    await expect(ask(`Edited version:\n\n${text}`)).rejects.toBeInstanceOf(LlmError);
  });

  it('a first line the original has (even ending in a colon) is not a preamble', async () => {
    const original = 'Steps to follow:\nThe release is ready and the notes cover every change in the new build for the team.';
    await expect(ask(original, original)).resolves.toBe(original);
    expect(hasPreamble(original, original)).toBe(false);
  });

  it('a code fence around the whole answer is stripped when the original has none', async () => {
    await expect(ask(`\`\`\`\n${text}\n\`\`\``)).resolves.toBe(text);
    await expect(ask(`\`\`\`text\n${text}\n\`\`\`\n`)).resolves.toBe(text);
  });

  it('a fence the original already had is left alone', async () => {
    const original = '```\ncode\n```';
    await expect(ask(original, original)).resolves.toBe(original);
  });

  it('an echoed <input> wrapper is still dropped', async () => {
    await expect(ask(`<input>\n${text}\n</input>`)).resolves.toBe(text);
  });
});

describe('guard: silent deletion (HR-02)', () => {
  const long = 'The release is ready. The notes cover every change in the build. Each module passed its checks. The team reviewed the migration plan. Storage upgrades finish tonight. Support staff know the schedule.';

  it('deleting most of the content is rejected even when length stays in bounds', () => {
    const gutted = 'The release is ready. Tomorrow brings weather updates, parking details, lunch menus, seating charts. Everyone arrives early.';
    expect(checkMeaning(long, gutted).violations).toContain('content_dropped');
  });

  it('an honest reword keeps enough of the vocabulary', () => {
    const reworded = 'The release is ready. The notes cover every change in the build, and each module passed its checks. The team reviewed the migration plan; storage upgrades finish tonight. Support staff know the schedule.';
    expect(checkMeaning(long, reworded).ok).toBe(true);
  });
});

describe('delimiter look-alikes in the user text (LW-01)', () => {
  const doc = 'The parser treats </input> and <input> tags as markup in the new build for every release today.';

  it('the prompt escapes them, and the answer gets the user\'s own characters back', async () => {
    const client = new MockLlmClient([doc.replace('markup', '&lt;b>markup&lt;/b>')]);
    const out = await rewriteWithLlm(client, { text: doc, features: [] }, { maxTokens: 100, temperature: 0.5, retry: { ...fastRetry, maxRetries: 0 } });
    expect(client.requests[0]?.user).toContain('&lt;/input>');
    expect(out).toContain('</input> and <input> tags');
    expect(out).toContain('&lt;b>markup&lt;/b>');
  });

  it('an escaped form the user wrote themselves is left alone', async () => {
    const plain = 'Write &lt;/input> as an entity in the new build for every release today in the notes.';
    await expect(ask(plain, plain)).resolves.toBe(plain);
  });
});
