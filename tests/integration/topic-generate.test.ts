// Integration: topic-based generation through the Engine, the HTTP API, an MCP tool call and the CLI. One operation, one
// implementation (docs/SURFACES.md): the same request gives the same data on every surface, and every topic result carries
// the fixed "facts are not verified" caveat.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TOPIC_CAVEAT } from '../../config/topic.js';
import type { ApiServer } from '../../src/api/server.js';
import { MockLlmClient } from '../../src/llm/mockClient.js';
import { InputTooLargeError, ConfigError } from '../../src/models/errors.js';
import { runCli } from '../helpers/cli.js';
import { PERSONA } from '../helpers/rig.js';
import { connectMcp, makeRuntime, postJson, startTestServer } from '../helpers/surfaces.js';
import type { Rigged } from '../helpers/surfaces.js';

const CONFIG = { llm: { model: 'm', maxRetries: 0 }, personas: [PERSONA], limits: { maxInputChars: 2000 } };
const TOPIC = 'Why small teams ship faster';
const NOTES = 'Fact: the team shipped 12 releases in 2024. Fact: median review time was 3 hours.';
const ANSWER = 'Small teams ship faster because fewer people have to agree.';

let rig: Rigged;
let server: ApiServer & { logs: string[] };
let work: string;
let cfgPath: string;

beforeAll(async () => {
  rig = await makeRuntime({ config: CONFIG, script: () => ANSWER });
  server = await startTestServer(rig);
  work = mkdtempSync(join(tmpdir(), 'gw-topic-'));
  cfgPath = join(work, 'config.json');
  writeFileSync(cfgPath, JSON.stringify(CONFIG));
});
afterAll(async () => {
  await server.close();
  rig.cleanup();
  rmSync(work, { recursive: true, force: true });
});

const lastRequest = () => rig.llm.requests[rig.llm.requests.length - 1]!;
const cliArgs = (): string[] => ['--config', cfgPath, '--state-dir', rig.stateDir, '--json'];
const cliLlm = (answer = ANSWER) => ({ llm: new MockLlmClient(() => answer) });

describe('Engine: topic mode', () => {
  it('writes new text from the topic and the notes, with the caveat, and the model is asked to write about a topic', async () => {
    const r = await rig.engine.generate('terse', 'exec', TOPIC, { mode: 'topic', notes: NOTES, length: 'long' });
    expect(r.text).toBe(ANSWER);
    expect(r.caveat).toBe(TOPIC_CAVEAT);
    const req = lastRequest();
    expect(req.system).toContain('write NEW text about the topic');
    expect(req.system).toContain('Use ONLY the notes for specific facts, numbers, names, dates and quotes.');
    expect(req.system).toContain('about 800 words');
    expect(req.user).toContain(`<topic>\n${TOPIC}\n</topic>`);
    expect(req.user).toContain(`<notes>\n${NOTES}\n</notes>`);
    expect(req.user).not.toContain('<input>');
  });

  it('works without notes and without a length, and the caveat is still there', async () => {
    const r = await rig.engine.generate('terse', 'exec', TOPIC, { mode: 'topic' });
    expect(r.caveat).toBe(TOPIC_CAVEAT);
    expect(lastRequest().system).toContain('The user supplied no notes.');
    expect(lastRequest().user).not.toContain('<notes>');
  });

  it('rewrite mode (explicit or default) is unchanged: no caveat, the <input> block, the rewrite instruction', async () => {
    for (const options of [{}, { mode: 'rewrite' as const }]) {
      const r = await rig.engine.generate('terse', 'exec', 'Rewrite this short draft please.', options);
      expect(r.caveat).toBeUndefined();
      expect(Object.keys(r)).not.toContain('caveat');
      expect(lastRequest().user).toContain('<input>\nRewrite this short draft please.\n</input>');
      expect(lastRequest().system).toContain('Reply with the rewritten text only.');
    }
  });

  it('keeps the caveat when the humanizer runs on a topic result', async () => {
    const r = await rig.engine.generate('terse', 'exec', TOPIC, { mode: 'topic', notes: NOTES, humanize: true });
    expect(r.caveat).toBe(TOPIC_CAVEAT);
  });

  it('notes and length need topic mode, on the library too (ConfigError, no model call)', async () => {
    const before = rig.llm.requests.length;
    await expect(rig.engine.generate('terse', 'exec', 'A draft to rewrite.', { notes: 'n' })).rejects.toBeInstanceOf(ConfigError);
    await expect(rig.engine.generate('terse', 'exec', 'A draft to rewrite.', { mode: 'rewrite', notes: 'n' })).rejects.toThrow(/notes need mode "topic"/);
    await expect(rig.engine.generate('terse', 'exec', 'A draft to rewrite.', { length: 'short' })).rejects.toThrow(/length needs mode "topic"/);
    await expect(rig.engine.generate('terse', 'exec', TOPIC, { mode: 'topic', length: 'epic' as never })).rejects.toBeInstanceOf(ConfigError);
    await expect(rig.engine.generate('terse', 'exec', TOPIC, { mode: 'novel' as never })).rejects.toBeInstanceOf(ConfigError);
    expect(rig.llm.requests.length).toBe(before);
  });

  it('a blank topic is refused (blank notes are the same as no notes)', async () => {
    await expect(rig.engine.generate('terse', 'exec', '   ', { mode: 'topic', notes: NOTES })).rejects.toThrow(/topic must not be blank/);
    await rig.engine.generate('terse', 'exec', TOPIC, { mode: 'topic', notes: '  \n ' });
    expect(lastRequest().user).not.toContain('<notes>');
  });

  it('caps: the topic and the notes are each held to limits.maxInputChars; at the cap passes, over it is InputTooLarge before any model call', async () => {
    const before = rig.llm.requests.length;
    await rig.engine.generate('terse', 'exec', TOPIC, { mode: 'topic', notes: 'n'.repeat(2000) });
    await rig.engine.generate('terse', 'exec', 't'.repeat(2000), { mode: 'topic' });
    const ran = rig.llm.requests.length;
    expect(ran).toBe(before + 2);
    await expect(rig.engine.generate('terse', 'exec', TOPIC, { mode: 'topic', notes: 'n'.repeat(2001) })).rejects.toBeInstanceOf(InputTooLargeError);
    await expect(rig.engine.generate('terse', 'exec', 't'.repeat(2001), { mode: 'topic' })).rejects.toBeInstanceOf(InputTooLargeError);
    expect(rig.llm.requests.length).toBe(ran);
  });

  it('the post pipeline still runs on the output: a secret the model produces is redacted', async () => {
    const leaky = await makeRuntime({ config: CONFIG, script: () => `The key is ${'sk-ant-api03-' + 'Zz9Yy8Xx7Ww6Vv5Uu4Tt3'.repeat(3)} and that is that.` });
    try {
      const r = await leaky.engine.generate('terse', 'exec', TOPIC, { mode: 'topic' });
      expect(r.text).not.toContain('Zz9Yy8Xx7Ww6Vv5Uu4Tt3');
      expect(r.text).toContain('[REDACTED:');
      expect(r.caveat).toBe(TOPIC_CAVEAT);
    } finally {
      leaky.cleanup();
    }
  });

  it('the banned-phrase check still runs on the output (reported in the trace)', async () => {
    const banned = await makeRuntime({ config: CONFIG, script: () => 'A plain start. We need synergy here. A plain end.' });
    try {
      const r = await banned.engine.generate('terse', 'exec', TOPIC, { mode: 'topic' });
      expect(r.trace.some((t) => t.filter === 'style' || t.filter === 'persona-banned')).toBe(true);
    } finally {
      banned.cleanup();
    }
  });
});

describe('HTTP: POST /api/generate', () => {
  it('topic mode returns mode, the text and the caveat; rewrite returns mode "rewrite" and no caveat', async () => {
    const t = await postJson(server, '/api/generate', { authorId: 'terse', persona: 'exec', text: TOPIC, mode: 'topic', notes: NOTES, length: 'medium' });
    expect(t.status).toBe(200);
    expect(t.json()).toMatchObject({ ok: true, text: ANSWER, mode: 'topic', caveat: TOPIC_CAVEAT });
    const r = await postJson(server, '/api/generate', { authorId: 'terse', persona: 'exec', text: 'A draft to rewrite, please.' });
    expect(r.status).toBe(200);
    expect(r.json().mode).toBe('rewrite');
    expect(r.json()).not.toHaveProperty('caveat');
  });

  it('notes or length without topic mode: 400 USAGE; over the cap: 413', async () => {
    const a = await postJson(server, '/api/generate', { authorId: 'terse', persona: 'exec', text: 'A draft.', notes: NOTES });
    expect(a.status).toBe(400);
    expect(a.json().error.code).toBe('USAGE');
    const b = await postJson(server, '/api/generate', { authorId: 'terse', persona: 'exec', text: 'A draft.', length: 'short' });
    expect(b.status).toBe(400);
    const c = await postJson(server, '/api/generate', { authorId: 'terse', persona: 'exec', text: TOPIC, mode: 'topic', notes: 'n'.repeat(2001) });
    expect(c.status).toBe(413);
    expect(c.json().error.code).toBe('INPUT_TOO_LARGE');
  });
});

describe('MCP: the generate tool', () => {
  it('takes mode, notes and length, and returns the caveat in the structured result', async () => {
    const mcp = await connectMcp(rig);
    try {
      const tools = await mcp.client.listTools();
      const tool = tools.tools.find((t) => t.name === 'generate')!;
      expect(Object.keys(tool.inputSchema.properties as object)).toEqual(expect.arrayContaining(['mode', 'notes', 'length']));
      expect(JSON.stringify(tool.outputSchema)).toContain('caveat');
      expect(tool.description).toMatch(/no web search/i);
      const res = await mcp.client.callTool({ name: 'generate', arguments: { authorId: 'terse', persona: 'exec', text: TOPIC, mode: 'topic', notes: NOTES } });
      expect(res.isError).toBeFalsy();
      expect(res.structuredContent).toMatchObject({ ok: true, mode: 'topic', caveat: TOPIC_CAVEAT });
      const bad = await mcp.client.callTool({ name: 'generate', arguments: { authorId: 'terse', persona: 'exec', text: 'A draft.', notes: NOTES } });
      expect(bad.isError).toBe(true);
    } finally {
      await mcp.close();
    }
  });
});

describe('CLI: generate --topic', () => {
  it('--topic with --notes-file and --length: --json carries mode and caveat; the model got the notes', async () => {
    const notesPath = join(work, 'notes.txt');
    writeFileSync(notesPath, NOTES);
    const llm = new MockLlmClient(() => ANSWER);
    const r = await runCli(['generate', '--author', 'terse', '--persona', 'exec', '--topic', TOPIC, '--notes-file', notesPath, '--length', 'short', ...cliArgs()], {}, { llm });
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ ok: true, text: ANSWER, mode: 'topic', caveat: TOPIC_CAVEAT });
    expect(llm.requests[0]!.user).toContain(`<topic>\n${TOPIC}\n</topic>`);
    expect(llm.requests[0]!.user).toContain(NOTES);
    expect(llm.requests[0]!.system).toContain('about 150 words');
  });

  it('text mode prints the generated text and then the caveat; it does not read stdin when the topic is given', async () => {
    const r = await runCli(['generate', '--author', 'terse', '--persona', 'exec', '--topic', TOPIC, '--config', cfgPath, '--state-dir', rig.stateDir], { tty: true }, cliLlm());
    expect(r.code, r.err).toBe(0);
    expect(r.out).toBe(`${ANSWER}\n\nnote: ${TOPIC_CAVEAT}\n`);
  });

  it('a draft rewrite prints the text only', async () => {
    const r = await runCli(['generate', '--author', 'terse', '--persona', 'exec', '--config', cfgPath, '--state-dir', rig.stateDir], { stdin: 'A draft to rewrite, please.' }, cliLlm());
    expect(r.code, r.err).toBe(0);
    expect(r.out).toBe(`${ANSWER}\n`);
  });

  it('--notes-file - reads the notes from stdin', async () => {
    const llm = new MockLlmClient(() => ANSWER);
    const r = await runCli(['generate', '--author', 'terse', '--persona', 'exec', '--topic', TOPIC, '--notes-file', '-', ...cliArgs()], { stdin: NOTES }, { llm });
    expect(r.code, r.err).toBe(0);
    expect(llm.requests[0]!.user).toContain(NOTES);
  });

  it('mixing is a usage error (exit 2, no model call): --topic with a draft file, a positional file, notes or length without --topic', async () => {
    const draft = join(work, 'draft.txt');
    writeFileSync(draft, 'A draft to rewrite, please.');
    const cases: Array<[string[], RegExp]> = [
      [['--topic', TOPIC, '--file', draft], /--topic and a draft file/],
      [['--topic', TOPIC, draft], /--topic and a draft file/],
      [['--notes-file', draft, '--file', draft], /--notes-file needs --topic/],
      [['--length', 'short', '--file', draft], /--length needs --topic/],
    ];
    for (const [extra, message] of cases) {
      const llm = new MockLlmClient(() => ANSWER);
      const r = await runCli(['generate', '--author', 'terse', '--persona', 'exec', ...extra, ...cliArgs()], {}, { llm });
      expect(r.code, extra.join(' ')).toBe(2);
      expect(JSON.parse(r.out).error.code).toBe('USAGE');
      expect(JSON.parse(r.out).error.message).toMatch(message);
      expect(llm.requests.length).toBe(0);
    }
  });

  it('a bad --length is a usage error from the option itself; a blank topic is refused', async () => {
    const bad = await runCli(['generate', '--author', 'terse', '--persona', 'exec', '--topic', TOPIC, '--length', 'epic', ...cliArgs()], {}, cliLlm());
    expect(bad.code).toBe(2);
    const blank = await runCli(['generate', '--author', 'terse', '--persona', 'exec', '--topic', '  ', ...cliArgs()], {}, cliLlm());
    expect(blank.code).not.toBe(0);
  });

  it('an over-cap notes file is refused (exit 6)', async () => {
    const big = join(work, 'big-notes.txt');
    writeFileSync(big, 'n'.repeat(2001));
    const r = await runCli(['generate', '--author', 'terse', '--persona', 'exec', '--topic', TOPIC, '--notes-file', big, ...cliArgs()], {}, cliLlm());
    expect(r.code).toBe(6);
  });
});
