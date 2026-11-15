// Humanizer confidentiality (HUM-03) across the surfaces: a secret in the input never reaches the model or a result, and a
// secret the model invents is removed before the rescore and never comes back, over the library, HTTP and MCP.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiServer } from '../../src/api/server.js';
import { connectMcp, makeRuntime, postJson, startTestServer } from '../helpers/surfaces.js';
import type { Rigged } from '../helpers/surfaces.js';

const SECRET = 'AKIA' + 'ABCDEFGHIJKLMNOP';
const TEXT = `The deploy key is ${SECRET} and the team agrees. The plan is clear. It is also simple. The robust plan is pivotal here. We delve into it now, but they never saw why it mattered at all.`;
const joiner = (req: { user: string }): string => `${(/<input>\n([\s\S]*)\n<\/input>/.exec(req.user)?.[1] ?? '').replace(/\. (The|It) /g, (_m, w: string) => `; ${w.toLowerCase()} `)} Rotate ${SECRET} now.`;

let rig: Rigged;
let server: ApiServer & { logs: string[] };
beforeAll(async () => {
  rig = await makeRuntime({ script: joiner as never });
  server = await startTestServer(rig, { mcp: true });
});
afterAll(async () => {
  await server.close();
  rig.cleanup();
});

describe('humanize never leaks a secret', () => {
  it('library: not sent to the model, not in the text, the trace or the steps', async () => {
    const r = await rig.engine.humanize(TEXT, { maxIterations: 2, target: 0 });
    expect(rig.llm.requests.length).toBeGreaterThan(0);
    for (const q of rig.llm.requests) expect(q.system + q.user).not.toContain(SECRET);
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(r.steps.some((s) => s.step === 'llm' && s.redacted)).toBe(true);
  });

  it('HTTP and MCP: the response document carries no secret', async () => {
    const http = await postJson(server, '/api/humanize', { text: TEXT, maxIterations: 2, target: 0 });
    expect(http.status).toBe(200);
    expect(http.text).not.toContain(SECRET);
    const mcp = await connectMcp(rig);
    try {
      const r = await mcp.client.callTool({ name: 'humanize', arguments: { text: TEXT, maxIterations: 2, target: 0 } });
      expect(r.isError).toBeFalsy();
      expect(JSON.stringify(r)).not.toContain(SECRET);
    } finally {
      await mcp.close();
    }
  });

  it('generate --humanize: the generated text, redacted by the post pipeline, stays redacted after the loop', async () => {
    const r2 = await makeRuntime({ script: (() => `The robust plan is clear. It is also simple. We delve into ${SECRET} now.`) as never });
    try {
      const out = await r2.engine.generate('terse', 'exec', 'Please rewrite this draft in plain words.', { humanize: true, target: 0 });
      expect(out.text).not.toContain(SECRET);
      expect(JSON.stringify(out.trace)).not.toContain(SECRET);
    } finally {
      r2.cleanup();
    }
  });
});
