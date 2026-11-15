// Security tier: a secret that arrives through the HTTP API or an MCP tool call never comes back out: not in any
// response body, not in an error message, not in a log line, not in what the model was sent (the torture corpus' secret
// generators are reused).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createMcpServer } from '../../src/mcp/server.js';
import { ALL_SECRET_KINDS, makeSecrets } from '../fixtures/leaks/secrets.js';
import { makeRuntime, postJson, raw, startTestServer } from '../helpers/surfaces.js';

const KINDS = ['aws', 'ghp', 'githubPat', 'sk', 'skAnt', 'slack', 'jwt', 'bearer', 'stripeLive', 'google', 'gitlab', 'npm', 'huggingface', 'sendgrid', 'pemRsa'] as const;

function plant(): { secrets: string[]; text: string; corpus: string } {
  const gen = makeSecrets(42);
  const picked = KINDS.map((k) => (gen[k] as () => { values: string[]; text: string })());
  // the pieces that must not survive: every value the generator lists (a PEM block lists its body lines too)
  const secrets = picked.flatMap((p) => p.values).filter((v) => v.length >= 16);
  const sentences = picked.map((p, i) => `Note ${i}: the credential ${p.text} was pasted by mistake, and the team rotated it.`);
  return { secrets, text: sentences.join(' '), corpus: sentences.map((s) => `${s} We keep working steadily and write plainly.`).join('\n') };
}

const leaks = (haystack: string, secrets: readonly string[]): string[] => secrets.filter((s) => haystack.includes(s));

describe('secrets never leave through HTTP', () => {
  it('ingest, generate, score, profile, authors and every error path return no planted secret; the model never sees one either', async () => {
    const { secrets, text, corpus } = plant();
    expect(ALL_SECRET_KINDS.length).toBeGreaterThanOrEqual(KINDS.length);
    // the scripted model answers with exactly what it was sent, so a secret that reached the prompt would come back
    const rig = await makeRuntime({ script: ((req: { user: string; system: string }) => `${req.user.slice(0, 1500)}\n${req.system.slice(0, 1500)}`) as never, ingest: false });
    const server = await startTestServer(rig);
    const bodies: string[] = [];
    const record = (r: { text: string }): void => void bodies.push(r.text);
    try {
      const gen = makeSecrets(7);
      const secretName = `Name ${(gen.sk as () => { text: string })().text}`;
      const secretPersona = (gen.skProj as () => { text: string })().text.slice(0, 60);
      const secretAuthor = (gen.ghp as () => { text: string })().text;
      secrets.push(secretName.slice(5), secretPersona, secretAuthor);

      record(await postJson(server, '/api/ingest', { authorId: 'planted', name: secretName, text: corpus }));
      record(await postJson(server, '/api/generate', { authorId: 'planted', persona: 'exec', text }));
      record(await postJson(server, '/api/score', { text }));
      record(await raw(server, '/api/profile?authorId=planted'));
      record(await raw(server, '/api/authors'));
      record(await raw(server, '/api/config'));
      record(await raw(server, '/api/capabilities'));
      // errors that echo input in a naive implementation
      record(await postJson(server, '/api/generate', { authorId: 'planted', persona: secretPersona, text }));
      record(await postJson(server, '/api/generate', { authorId: secretAuthor, persona: 'exec', text }));
      record(await raw(server, `/api/profile?authorId=${encodeURIComponent(secretAuthor)}`));
      record(await postJson(server, '/api/generate', { authorId: 'planted', persona: 'exec', text, [secretPersona]: 1 }));
      record(await postJson(server, '/api/score', { text, detectors: [secretPersona] }));
      record(await raw(server, '/api/score', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: `{"text": "${text.slice(0, 200).replace(/"/g, "'")}` }));
      record(await raw(server, `/${secretPersona}`));

      const everything = bodies.join('\n');
      expect(bodies.length).toBeGreaterThan(10);
      expect(leaks(everything, secrets)).toEqual([]);
      expect(leaks(server.logs.join('\n'), secrets)).toEqual([]);
      expect(rig.llm.requests.length).toBeGreaterThan(0);
      expect(leaks(rig.llm.requests.map((r) => `${r.system}\n${r.user}`).join('\n'), secrets)).toEqual([]);
      expect(everything).toContain('[REDACTED:'); // the redaction visibly ran
    } finally {
      await server.close();
      rig.cleanup();
    }
  });
});

describe('secrets never leave through MCP', () => {
  it('every tool result and error result is free of planted secrets', async () => {
    const { secrets, text, corpus } = plant();
    const rig = await makeRuntime({ script: ((req: { user: string }) => req.user.slice(0, 1500)) as never, ingest: false });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer(rig.runtime);
    const client = new Client({ name: 'test', version: '1' });
    await Promise.all([server.connect(a), client.connect(b)]);
    try {
      const gen = makeSecrets(9);
      const secretPersona = (gen.skProj as () => { text: string })().text.slice(0, 60);
      const secretAuthor = (gen.ghp as () => { text: string })().text;
      secrets.push(secretPersona, secretAuthor);
      const calls: [string, Record<string, unknown>][] = [
        ['ingest', { authorId: 'planted', name: 'Planted', text: corpus }],
        ['generate', { authorId: 'planted', persona: 'exec', text }],
        ['score', { text }],
        ['profile', { authorId: 'planted' }],
        ['authors', {}],
        ['config_get', {}],
        ['generate', { authorId: 'planted', persona: secretPersona, text }],
        ['generate', { authorId: secretAuthor, persona: 'exec', text }],
        ['profile', { authorId: secretAuthor }],
        ['score', { text, [secretPersona]: 1 }],
      ];
      const seen: string[] = [];
      for (const [name, args] of calls) seen.push(JSON.stringify(await client.callTool({ name, arguments: args })));
      expect(leaks(seen.join('\n'), secrets)).toEqual([]);
      expect(seen.join('\n')).toContain('[REDACTED:');
      expect(leaks(rig.llm.requests.map((r) => `${r.system}\n${r.user}`).join('\n'), secrets)).toEqual([]);
    } finally {
      await client.close();
      await server.close();
      rig.cleanup();
    }
  });
});
