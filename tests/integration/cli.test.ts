// Phase 5 / ORC-05: the CLI in-process (real engine, scripted LLM). The real binary is covered in tests/system/cli.test.ts.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LlmTransportError } from '../../src/llm/retry.js';
import { MockLlmClient } from '../../src/llm/mockClient.js';
import { json, startStub } from '../helpers/llmStub.js';
import { runCli } from '../helpers/cli.js';
import { PERSONA, SpyFilter, corpus, fastRetry } from '../helpers/rig.js';

let dir = '';
let configPath = '';
let corpusPath = '';
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gw-cli-'));
  configPath = join(dir, 'config.json');
  corpusPath = join(dir, 'corpus.txt');
  await writeFile(configPath, JSON.stringify({ llm: { model: 'test-model' }, personas: [PERSONA], limits: { maxInputChars: 2000 } }));
  await writeFile(corpusPath, corpus());
});
afterEach(async () => rm(dir, { recursive: true, force: true }));

const common = () => ['--config', configPath, '--state-dir', join(dir, 'state')];
const ingest = (extra: string[] = []) => runCli(['ingest', '--author', 'terse', '--name', 'Terse Author', corpusPath, ...common(), ...extra]);
const generate = (llm: MockLlmClient, extra: string[] = [], stdin = 'Please rewrite this status update.') =>
  runCli(['generate', '--author', 'terse', '--persona', 'exec', ...common(), ...extra], { stdin }, { llm, retry: fastRetry });
const ok = () => new MockLlmClient(() => 'Plain and clear result text.');

describe('cli: help and usage', () => {
  it('--help lists all five commands on stdout, exit 0', async () => {
    const r = await runCli(['--help']);
    expect(r.code).toBe(0);
    for (const c of ['ingest', 'generate', 'personas', 'filters', 'profile']) expect(r.out).toContain(c);
    expect(r.err).toBe('');
  });
  it('each command has its own --help', async () => {
    for (const c of ['ingest', 'generate', 'personas', 'filters', 'profile']) {
      const r = await runCli([c, '--help']);
      expect(r.code, c).toBe(0);
      expect(r.out).toContain('--json');
    }
  });
  it('no arguments, unknown command, missing required option -> exit 2, nothing on stdout', async () => {
    for (const argv of [[], ['frobnicate'], ['ingest'], ['generate', '--author', 'a'], ['generate', '--author', 'a', '--persona', 'p', '--temperature', '7']]) {
      const r = await runCli(argv);
      expect(r.code, argv.join(' ')).toBe(2);
      expect(r.out).toBe('');
      expect(r.err).not.toBe('');
    }
  });
  it('usage error with --json: JSON on stdout, stderr empty', async () => {
    const r = await runCli(['ingest', '--json']);
    expect(r.code).toBe(2);
    expect(r.err).toBe('');
    expect(JSON.parse(r.out)).toMatchObject({ ok: false, error: { code: 'USAGE' } });
  });
});

describe('cli: ingest / profile / personas / filters', () => {
  it('ingest from a positional file, then profile (text and --json) in a separate invocation', async () => {
    const r = await ingest();
    expect(r).toMatchObject({ code: 0, err: '' });
    expect(r.out).toMatch(/^ingested terse: \d+ words\n$/);
    const p = await runCli(['profile', 'terse', ...common()]);
    expect(p.code).toBe(0);
    expect(p.out).toContain('author: terse (Terse Author)');
    const pj = await runCli(['profile', 'terse', '--json', ...common()]);
    expect(JSON.parse(pj.out)).toMatchObject({ ok: true, profile: { authorId: 'terse', displayName: 'Terse Author' } });
  });
  it('ingest --json output is one valid JSON document', async () => {
    const r = await ingest(['--json']);
    expect(JSON.parse(r.out)).toMatchObject({ ok: true, profile: { authorId: 'terse' } });
    expect(r.out.trim().split('\n')).toHaveLength(1);
  });
  it('ingest from --file and from stdin (with and without "-")', async () => {
    const viaFlag = await runCli(['ingest', '--author', 'a1', '--name', 'A', '--file', corpusPath, ...common()]);
    expect(viaFlag.code).toBe(0);
    const viaStdin = await runCli(['ingest', '--author', 'a2', '--name', 'B', ...common()], { stdin: corpus() });
    expect(viaStdin.code).toBe(0);
    const viaDash = await runCli(['ingest', '--author', 'a3', '--name', 'C', '--file', '-', ...common()], { stdin: corpus() });
    expect(viaDash.code).toBe(0);
    for (const id of ['a1', 'a2', 'a3']) expect((await runCli(['profile', id, ...common()])).code).toBe(0);
  });
  it('input errors -> exit 2: both file forms, missing file, directory, empty corpus, TTY with no input, bad author id', async () => {
    expect((await runCli(['ingest', '--author', 'a', '--name', 'A', corpusPath, '--file', corpusPath, ...common()])).code).toBe(2);
    const missing = await runCli(['ingest', '--author', 'a', '--name', 'A', join(dir, 'nope'), ...common()]);
    expect(missing.code).toBe(2);
    expect(missing.err).toContain('ENOENT');
    expect((await runCli(['ingest', '--author', 'a', '--name', 'A', dir, ...common()])).code).toBe(2);
    expect((await runCli(['ingest', '--author', 'a', '--name', 'A', ...common()], { stdin: '   ' })).code).toBe(2);
    const tty = await runCli(['ingest', '--author', 'a', '--name', 'A', ...common()], { tty: true });
    expect(tty.code).toBe(2);
    expect(tty.err).toContain('no input');
    expect((await runCli(['ingest', '--author', '../x', '--name', 'A', corpusPath, ...common()])).code).toBe(2);
  });
  it('profile of an unknown author -> exit 3, with a JSON error document in --json mode', async () => {
    expect((await runCli(['profile', 'ghost', ...common()])).code).toBe(3);
    const r = await runCli(['profile', 'ghost', '--json', ...common()]);
    expect(r.code).toBe(3);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false, error: { code: 'UNKNOWN_AUTHOR' } });
  });
  it('personas and filters (text and json); neither needs a model or a state dir', async () => {
    const p = await runCli(['personas', '--json']);
    expect(p.code).toBe(0);
    expect((JSON.parse(p.out) as { personas: Array<{ key: string }> }).personas.map((x) => x.key)).toEqual(['engineer', 'executive', 'newcomer']);
    expect((await runCli(['personas'])).out).toContain('executive\tExecutive reader');
    const f = await runCli(['filters', '--json']);
    expect((JSON.parse(f.out) as { filters: unknown[] }).filters).toHaveLength(3);
    expect((await runCli(['filters'])).out).toContain('confidentiality\tpre\tfail-closed\tenabled');
  });
  it('a state dir that cannot be used is a file-system error (exit 1), reported by errno only', async () => {
    const file = join(dir, 'afile');
    await writeFile(file, 'x');
    const r = await runCli(['profile', 'terse', '--config', configPath, '--state-dir', file]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/file system error \(E[A-Z]+\)/);
    const j = await runCli(['profile', 'terse', '--json', '--config', configPath, '--state-dir', file]);
    expect(JSON.parse(j.out)).toMatchObject({ ok: false, error: { code: 'IO_ERROR' } });
  });
  it('corrupt state -> exit 7', async () => {
    await ingest();
    await writeFile(join(dir, 'state', 'profiles.json'), '{oops');
    const r = await runCli(['profile', 'terse', ...common()]);
    expect(r.code).toBe(7);
    expect(r.err).not.toContain('oops');
  });
  it('ingest redacts: the stored files hold no secret', async () => {
    await runCli(['ingest', '--author', 'terse', '--name', 'T', ...common()], { stdin: `${corpus()}\nThe key AKIAIOSFODNN7EXAMPLE is rotated weekly by the team.` });
    expect((await readFile(join(dir, 'state', 'store.json'), 'utf8')) + (await readFile(join(dir, 'state', 'profiles.json'), 'utf8'))).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });
});

describe('cli: generate', () => {
  beforeEach(async () => void (await ingest()));

  it('prints only the result text on stdout; stderr is empty', async () => {
    const llm = ok();
    const r = await generate(llm);
    expect(r).toEqual({ code: 0, out: 'Plain and clear result text.\n', err: '' });
  });
  it('--json: {ok, text, trace} with the documented trace order', async () => {
    const r = await generate(ok(), ['--json']);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.out) as { ok: boolean; text: string; trace: Array<{ filter: string }> };
    expect(doc.ok).toBe(true);
    expect(doc.text).toBe('Plain and clear result text.');
    expect(doc.trace.map((t) => t.filter)).toEqual(['confidentiality', 'llm', 'style', 'confidentiality']);
    expect(r.err).toBe('');
  });
  it('draft from --file and from the positional file', async () => {
    const draft = join(dir, 'draft.txt');
    await writeFile(draft, 'A draft from a file.');
    const llm = ok();
    const a = await runCli(['generate', '--author', 'terse', '--persona', 'exec', '--file', draft, ...common()], {}, { llm, retry: fastRetry });
    const b = await runCli(['generate', '--author', 'terse', '--persona', 'exec', draft, ...common()], {}, { llm, retry: fastRetry });
    expect([a.code, b.code]).toEqual([0, 0]);
    expect(llm.requests[0]!.user).toContain('A draft from a file.');
    expect(llm.requests[1]!.user).toContain('A draft from a file.');
  });
  it('options reach the request', async () => {
    const llm = ok();
    await generate(llm, ['--exemplars', '0', '--max-tokens', '55', '--temperature', '0.25']);
    expect(llm.requests[0]).toMatchObject({ maxTokens: 55, temperature: 0.25 });
    expect(llm.requests[0]!.user).not.toContain('<exemplars>');
  });
  it('a secret in the draft never reaches the LLM', async () => {
    const llm = ok();
    await generate(llm, [], 'Deploy with AKIAIOSFODNN7EXAMPLE now.');
    expect(llm.requests[0]!.system + llm.requests[0]!.user).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });
  it('same input + scripted LLM twice -> byte-identical stdout', async () => {
    const a = await generate(ok());
    const b = await generate(ok());
    expect(a.out).toBe(b.out);
  });
  it('exit 3: unknown persona and unknown author; the LLM is never called', async () => {
    const llm = ok();
    const p = await runCli(['generate', '--author', 'terse', '--persona', 'nope', ...common()], { stdin: 'hi' }, { llm });
    const a = await runCli(['generate', '--author', 'ghost', '--persona', 'exec', ...common()], { stdin: 'hi' }, { llm });
    expect([p.code, a.code]).toEqual([3, 3]);
    expect(p.err).toContain('valid personas: exec');
    expect(llm.callCount).toBe(0);
  });
  it('exit 4: a fail-closed filter fails; no text on stdout', async () => {
    const boom = new SpyFilter('confidentiality', ['pre', 'post'], 'fail-closed', undefined, new Error('boom with AKIAIOSFODNN7EXAMPLE'));
    const llm = ok();
    const r = await runCli(['generate', '--author', 'terse', '--persona', 'exec', ...common()], { stdin: 'hi there' }, { llm, factories: { confidentiality: () => boom, style: () => new SpyFilter('style', ['post'], 'skip') } });
    expect(r.code).toBe(4);
    expect(r.out).toBe('');
    expect(r.err).not.toContain('AKIA');
    expect(llm.callCount).toBe(0);
  });
  it('exit 5: LLM failures (retries exhausted, empty answer) -> typed error, no text', async () => {
    const down = new MockLlmClient([new LlmTransportError('http', { status: 503 }), new LlmTransportError('http', { status: 503 }), new LlmTransportError('http', { status: 503 })]);
    const r = await generate(down, ['--json']);
    expect(r.code).toBe(5);
    expect(JSON.parse(r.out)).toEqual({ ok: false, error: { code: 'LLM_FAILED', message: 'LLM call failed after 3 attempts' } });
    expect((await generate(new MockLlmClient(['']))).code).toBe(5);
  });
  it('exit 6: draft over limits.maxInputChars (2000), and a stream far past it is cut off early', async () => {
    expect((await generate(ok(), [], 'x'.repeat(2001))).code).toBe(6);
    expect((await generate(ok(), [], 'x'.repeat(2000))).code).toBe(0);
    const huge = await generate(ok(), [], 'x'.repeat(2000 * 4 + 1));
    expect(huge.code).toBe(6);
  });
  it('exit 2: config problems (bad JSON, unknown key, no model, bad provider combination)', async () => {
    const withConfig = async (content: string, extra: string[] = []) => {
      await writeFile(configPath, content);
      return runCli(['generate', '--author', 'terse', '--persona', 'exec', ...common(), ...extra], { stdin: 'hi' }, { llm: ok() });
    };
    expect((await withConfig('{nope')).code).toBe(2);
    expect((await withConfig('[]')).code).toBe(2);
    const unknown = await withConfig(JSON.stringify({ llm: { model: 'm' }, bogus: 1 }));
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain('bogus');
    const nomodel = await withConfig(JSON.stringify({}));
    expect(nomodel.code).toBe(2);
    expect(nomodel.err).toContain('llm.model');
    expect((await withConfig(JSON.stringify({ llm: { model: 'm' } }), ['--provider', 'openai-compat'])).code).toBe(2);
  });
  it('--model and $GHOSTWRITER_MODEL supply the model when the config has none', async () => {
    await writeFile(configPath, JSON.stringify({ personas: [PERSONA] }));
    const llm = ok();
    const viaFlag = await runCli(['generate', '--author', 'terse', '--persona', 'exec', '--model', 'm1', ...common()], { stdin: 'hi there' }, { llm, retry: fastRetry });
    const viaEnv = await runCli(['generate', '--author', 'terse', '--persona', 'exec', ...common()], { stdin: 'hi there', env: { GHOSTWRITER_MODEL: 'm2' } }, { llm, retry: fastRetry });
    expect([viaFlag.code, viaEnv.code]).toEqual([0, 0]);
  });
  it('a surviving banned phrase is a warning on stderr; stdout stays the bare text', async () => {
    await writeFile(configPath, JSON.stringify({ llm: { model: 'm' }, personas: [PERSONA], filters: { pipeline: [{ name: 'confidentiality', stage: 'both' }] } }));
    const r = await generate(new MockLlmClient(['We found real synergy here.']));
    expect(r.code).toBe(0);
    expect(r.out).toBe('We found real synergy here.\n');
    expect(r.err).toContain('warning');
    expect(r.err).not.toContain('synergy');
  });
  it('config blocklist is honoured end to end', async () => {
    await writeFile(configPath, JSON.stringify({ llm: { model: 'm' }, personas: [PERSONA], confidentiality: { blocklist: ['Falcon'] } }));
    const llm = new MockLlmClient(['Falcon is mentioned in the answer.']);
    const r = await generate(llm, [], 'Tell the story of Falcon.');
    expect(llm.requests[0]!.user).not.toContain('Falcon');
    expect(r.out).not.toContain('Falcon');
  });
});

describe('cli: real client selection and secrets', () => {
  beforeEach(async () => void (await ingest()));

  it('anthropic provider with no API key -> exit 2, clear message naming the variable, no stack', async () => {
    const r = await runCli(['generate', '--author', 'terse', '--persona', 'exec', ...common()], { stdin: 'hi there', env: {} });
    expect(r.code).toBe(2);
    expect(r.out).toBe('');
    expect(r.err).toContain('ANTHROPIC_API_KEY');
    expect(r.err).not.toMatch(/\bat \S+:\d+/);
  });
  it('--api-key-env names the variable that is checked', async () => {
    const r = await runCli(['generate', '--author', 'terse', '--persona', 'exec', '--api-key-env', 'MY_KEY', ...common()], { stdin: 'hi there', env: { ANTHROPIC_API_KEY: 'sk-ant-zzz' } });
    expect(r.code).toBe(2);
    expect(r.err).toContain('MY_KEY');
  });
  it('a key pasted into --api-key-env is rejected without echoing it', async () => {
    const r = await runCli(['generate', '--author', 'terse', '--persona', 'exec', '--api-key-env', 'sk-ant-api03-SECRETSECRET', ...common()], { stdin: 'hi there' });
    expect(r.code).toBe(2);
    expect(r.err + r.out).not.toContain('SECRETSECRET');
  });
  it('the API key never appears in stdout / stderr, even when the provider rejects it', async () => {
    const stub = await startStub((_req, res) => json(res, 401, { error: { message: 'bad key sk-ant-TOPSECRET123' } }));
    try {
      for (const asJson of [false, true]) {
        const r = await runCli(
          ['generate', '--author', 'terse', '--persona', 'exec', '--provider', 'openai-compat', '--base-url', `${stub.origin}/v1`, '--api-key-env', 'K', ...(asJson ? ['--json'] : []), ...common()],
          { stdin: 'hi there', env: { K: 'sk-ant-TOPSECRET123' } },
        );
        expect(r.code).toBe(5);
        expect(r.out + r.err).not.toContain('TOPSECRET123');
      }
    } finally {
      await stub.close();
    }
  });
  it('a client that throws arbitrary errors is normalised to LlmError; the message text is never printed', async () => {
    const llm = new MockLlmClient(() => {
      throw new RangeError('secret text AKIAIOSFODNN7EXAMPLE');
    });
    const r = await runCli(['generate', '--author', 'terse', '--persona', 'exec', ...common()], { stdin: 'hi there' }, { llm, retry: fastRetry });
    expect(r.code).toBe(5); // client errors are normalised to LlmError
    expect(r.err).not.toContain('AKIA');
  });
});
