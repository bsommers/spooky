import { readdirSync } from 'node:fs';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { callTool, toolDefinitions } from '../../../src/mcp/tools.js';
import { OPERATIONS } from '../../../src/service/operations.js';
import { connectMcp, makeRuntime } from '../../helpers/surfaces.js';

const parse = (r: any): any => {
  const first = (r.content as { type: string; text: string }[])[0];
  expect(first?.type).toBe('text');
  const fromText = JSON.parse(first?.text ?? 'null');
  if (r.isError) expect(r.structuredContent).toBeUndefined();
  else expect(r.structuredContent).toEqual(fromText);
  return fromText;
};

describe('MCP tools', () => {
  it('one tool per registry operation, in registry order, each with a strict object input schema and an output schema', () => {
    const tools = toolDefinitions();
    expect(tools.map((t) => t.name)).toEqual(OPERATIONS.map((o) => o.name));
    for (const t of tools) {
      expect(t.inputSchema.type, t.name).toBe('object');
      expect((t.inputSchema as { additionalProperties?: unknown }).additionalProperties, t.name).toBe(false);
      expect(t.outputSchema?.type, t.name).toBe('object');
      expect(t.description?.length, t.name).toBeGreaterThan(10);
    }
  });

  it('ingest is the only tool annotated readOnlyHint:false; the rest are read-only; generate and score are open-world', () => {
    const by = Object.fromEntries(toolDefinitions().map((t) => [t.name, t.annotations]));
    expect(by.ingest).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });
    for (const [name, a] of Object.entries(by)) if (name !== 'ingest') expect(a?.readOnlyHint, name).toBe(true);
    expect(by.generate?.openWorldHint).toBe(true);
    expect(by.score?.openWorldHint).toBe(true);
    expect(by.profile?.openWorldHint).toBe(false);
  });

  it('tools/list over the protocol equals the registry, and a call returns the data the Engine returns', async () => {
    const rig = await makeRuntime();
    const { client, close } = await connectMcp(rig);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((t) => t.name)).toEqual(OPERATIONS.map((o) => o.name));
      const r = await client.callTool({ name: 'profile', arguments: { authorId: 'terse' } });
      expect(r.isError).toBeFalsy();
      expect(parse(r)).toEqual({ ok: true, profile: rig.engine.getProfile('terse') });
      const p = await client.callTool({ name: 'personas', arguments: {} });
      expect(parse(p)).toEqual({ ok: true, personas: rig.engine.listPersonas() });
      // arguments omitted entirely is fine for tools with no input
      expect(parse(await client.callTool({ name: 'filters' }))).toEqual({ ok: true, filters: rig.engine.listFilters() });
    } finally {
      await close();
      rig.cleanup();
    }
  });

  it('typed errors come back as isError results carrying the same code as the CLI/HTTP; an unknown tool is a protocol error', async () => {
    const rig = await makeRuntime();
    const { client, close } = await connectMcp(rig);
    try {
      const noAuthor = await client.callTool({ name: 'profile', arguments: { authorId: 'nobody' } });
      expect(noAuthor.isError).toBe(true);
      expect(parse(noAuthor)).toEqual({ ok: false, error: { code: 'UNKNOWN_AUTHOR', message: expect.any(String) } });
      expect((noAuthor._meta as Record<string, unknown>)['ghostwriter/category']).toBe('not_found');
      const noPersona = await client.callTool({ name: 'generate', arguments: { authorId: 'terse', persona: 'nope', text: 'hi' } });
      expect(parse(noPersona).error.code).toBe('UNKNOWN_PERSONA');
      const tooBig = await client.callTool({ name: 'score', arguments: { text: 'x'.repeat(6000) } });
      expect(parse(tooBig).error.code).toBe('INPUT_TOO_LARGE');
      await expect(client.callTool({ name: 'delete_everything', arguments: {} })).rejects.toBeInstanceOf(McpError);
    } finally {
      await close();
      rig.cleanup();
    }
  });
});

describe('MCP inputs are untrusted (security)', () => {
  it('oversized text, __proto__ keys, path-like ids, control characters and extra properties are rejected by the schema; nothing reaches the engine or the file system', async () => {
    const rig = await makeRuntime();
    const before = readdirSync(rig.stateDir).sort();
    const authors = rig.engine.listAuthors().length;
    const { client, close } = await connectMcp(rig);
    try {
      const bad: [string, Record<string, unknown>][] = [
        ['profile', { authorId: '../x' }],
        ['profile', { authorId: '..' }],
        ['profile', { authorId: '/etc/passwd' }],
        ['profile', { authorId: 'a\u0000b' }],
        ['profile', { authorId: 'a b' }],
        ['profile', { authorId: 'a'.repeat(65) }],
        ['profile', { authorId: 'terse', extra: 1 }],
        ['profile', { authorId: ['terse'] }],
        ['profile', { authorId: { $ne: null } }],
        ['ingest', { authorId: '../escape', name: 'X', text: 'One. Two. Three.' }],
        ['ingest', { authorId: 'ok', name: 'Bad\u0007name', text: 'One. Two. Three.' }],
        ['ingest', { authorId: 'ok', name: '   ', text: 'One. Two. Three.' }],
        ['ingest', { authorId: 'ok', name: 'N', text: 'nul\u0000byte' }],
        ['ingest', { authorId: 'ok', name: 'N', text: 'One. Two. Three.', stateDir: '/tmp/x' }],
        ['ingest', { authorId: 'ok', name: 'N', text: 'One. Two. Three.', file: '/etc/passwd' }],
        ['generate', { authorId: 'terse', persona: 'exec; rm -rf /', text: 'hi' }],
        ['generate', { authorId: 'terse', persona: 'ex\nec', text: 'hi' }],
        ['generate', { authorId: 'terse', persona: 'exec', text: 'hi', temperature: 5 }],
        ['generate', { authorId: 'terse', persona: 'exec', text: 'hi', maxTokens: 1e12 }],
        ['generate', { authorId: 'terse', persona: 'exec', text: 'hi', exemplars: -1 }],
        ['generate', { authorId: 'terse', persona: 'exec', text: 'hi', apiKey: 'sk-x' }],
        ['score', { text: 'hello there', detectors: ['a'.repeat(41)] }],
        ['score', { text: 'hello there', detectors: new Array(17).fill('d') }],
        ['score', { text: 'hello there', detectors: ['x/../y'] }],
        ['score', { text: 12 }],
        ['config_get', { verbose: true }],
        ['personas', { key: 'x' }],
      ];
      for (const [name, args] of bad) {
        const r = await client.callTool({ name, arguments: args });
        expect(r.isError, `${name} ${JSON.stringify(args).slice(0, 60)}`).toBe(true);
        expect(parse(r).error.code).toBe('USAGE');
      }
      expect(rig.llm.callCount).toBe(0);
      expect(readdirSync(rig.stateDir).sort()).toEqual(before);
      expect(rig.engine.listAuthors()).toHaveLength(authors);
      // oversize text hits the engine's size cap (the configured maxInputChars), also as a typed error and with no model call
      const big = await client.callTool({ name: 'generate', arguments: { authorId: 'terse', persona: 'exec', text: 'x'.repeat(5001) } });
      expect(parse(big).error.code).toBe('INPUT_TOO_LARGE');
      expect(rig.llm.callCount).toBe(0);
      expect(({} as Record<string, unknown>).admin).toBeUndefined();
    } finally {
      await close();
      rig.cleanup();
    }
  });

  it('an own __proto__ key in the arguments is rejected by the strict schema (the SDK client may also drop it before it gets here)', async () => {
    const rig = await makeRuntime();
    try {
      for (const payload of ['{"authorId":"terse","__proto__":{"admin":true}}', '{"__proto__":{"authorId":"terse"}}', '{"authorId":"terse","constructor":{"prototype":{"admin":true}}}']) {
        const r = await callTool(rig.runtime, 'profile', JSON.parse(payload));
        expect(r?.isError, payload).toBe(true);
        expect(parse(r).error.code).toBe('USAGE');
      }
      expect(({} as Record<string, unknown>).admin).toBeUndefined();
      expect(await callTool(rig.runtime, 'no_such_tool', {})).toBeUndefined();
    } finally {
      rig.cleanup();
    }
  });

  it('the tool surface has no parameter that names a path, a command or a URL', () => {
    for (const t of toolDefinitions()) {
      for (const key of Object.keys((t.inputSchema as { properties?: object }).properties ?? {})) {
        expect(key, `${t.name}.${key}`).not.toMatch(/path|file|dir|cmd|command|url|uri|shell|exec$/i);
      }
    }
  });
});
