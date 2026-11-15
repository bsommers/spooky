// stdio server lifecycle: end of input must not discard replies still being computed.
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { serveStdio } from '../../../src/mcp/server.js';
import { CLEAN_ANSWER, makeRuntime } from '../../helpers/surfaces.js';

const line = (o: unknown): string => `${JSON.stringify(o)}\n`;
const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } };

function collect(out: PassThrough): { lines: () => any[] } {
  let text = '';
  out.on('data', (d: Buffer) => (text += d.toString('utf8')));
  return { lines: () => text.split('\n').filter(Boolean).map((l) => JSON.parse(l)) };
}

describe('serveStdio end of input', () => {
  it('a one-shot client (write, close stdin) still receives the reply of a slow tool call, then the server stops', async () => {
    const rig = await makeRuntime({ script: (async () => {
      await new Promise((r) => setTimeout(r, 150));
      return CLEAN_ANSWER;
    }) as never });
    try {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const out = collect(stdout);
      const done = serveStdio(rig.runtime, { stdin, stdout });
      stdin.write(line(init));
      stdin.write(line({ jsonrpc: '2.0', method: 'notifications/initialized' }));
      stdin.write(line({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'generate', arguments: { authorId: 'terse', persona: 'exec', text: 'Please rewrite this short draft.' } } }));
      stdin.end(); // the client is done writing and waits for the answers
      await done;
      const replies = out.lines();
      expect(replies.map((r) => r.id).sort()).toEqual([1, 2]);
      const call = replies.find((r) => r.id === 2);
      expect(call.result.isError).toBeFalsy();
      expect(call.result.structuredContent).toMatchObject({ ok: true, text: CLEAN_ANSWER });
    } finally {
      rig.cleanup();
    }
  });

  it('several slow calls in flight at end of input are all answered', async () => {
    const rig = await makeRuntime({ script: (async () => {
      await new Promise((r) => setTimeout(r, 80));
      return CLEAN_ANSWER;
    }) as never });
    try {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const out = collect(stdout);
      const done = serveStdio(rig.runtime, { stdin, stdout });
      stdin.write(line(init));
      for (let id = 2; id <= 4; id++) {
        stdin.write(line({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'generate', arguments: { authorId: 'terse', persona: 'exec', text: 'Please rewrite this short draft.' } } }));
      }
      stdin.end();
      await done;
      expect(out.lines().map((r) => r.id).sort()).toEqual([1, 2, 3, 4]);
    } finally {
      rig.cleanup();
    }
  });

  it('with nothing in flight, end of input ends the session promptly; an abort does not wait for work in progress', async () => {
    const rig = await makeRuntime({ script: (async () => {
      await new Promise((r) => setTimeout(r, 5000));
      return CLEAN_ANSWER;
    }) as never });
    try {
      const idleIn = new PassThrough();
      const idle = serveStdio(rig.runtime, { stdin: idleIn, stdout: new PassThrough() });
      idleIn.end();
      await idle;

      const ac = new AbortController();
      const busyIn = new PassThrough();
      const started = Date.now();
      const busy = serveStdio(rig.runtime, { stdin: busyIn, stdout: new PassThrough(), signal: ac.signal });
      busyIn.write(line(init));
      busyIn.write(line({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'generate', arguments: { authorId: 'terse', persona: 'exec', text: 'Please rewrite this short draft.' } } }));
      await new Promise((r) => setTimeout(r, 100));
      ac.abort();
      await busy;
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      rig.cleanup();
    }
  });
});
