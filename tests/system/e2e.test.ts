// End-to-end (system tier, in process): the public Engine with the default config and a scripted mock model.
// 3 fixture authors are ingested, then each generates for 2 personas. Asserts what the user can observe: persona
// structure reaches the prompt and the (scripted) answer, the trace has the documented shape, nothing secret leaves
// the process or appears in the result, and the whole run is deterministic.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Engine } from '../../src/engine.js';
import { loadConfig } from '../../src/config/load.js';
import { MockLlmClient } from '../../src/llm/mockClient.js';
import type { LlmRequest, TraceEntry } from '../../src/models/types.js';

const authorsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'authors');
const AUTHORS = [
  { id: 'terse', name: 'Terse Technical', file: 'terse-technical.txt' },
  { id: 'exec', name: 'Bulleted Executive', file: 'bulleted-executive.txt' },
  { id: 'hedger', name: 'Verbose Hedger', file: 'verbose-hedging.txt' },
] as const;
const PERSONAS = ['executive', 'engineer'] as const;

// Built at runtime so no secret-shaped literal sits in the source.
const AWS = 'AKIA' + 'IOSFODNN7EXAMPLE';
const GH = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
const DRAFT = `We ship the billing fix on Friday. The deploy key is ${AWS} and CI uses ${GH}. Obviously this deep dive saved time.`;

/** Scripted model: BLUF layout for the executive prompt, a plain paragraph otherwise; the model also echoes a secret. */
function scripted(req: LlmRequest): string {
  if (req.system.includes('first sentence is the recommendation')) {
    return `BLUF: ship the billing fix on Friday.\n\nThe model echoed ${GH} by mistake. Furthermore, we measured no regressions.`;
  }
  return `The billing fix ships Friday. The model echoed ${AWS} by mistake. Furthermore, we measured no regressions.`;
}

async function runAll() {
  const llm = new MockLlmClient(scripted);
  const engine = new Engine({ config: loadConfig({ llm: { model: 'mock' } }), llm });
  for (const a of AUTHORS) await engine.ingest(a.id, a.name, readFileSync(join(authorsDir, a.file), 'utf8'));
  const results: Array<{ author: string; persona: string; text: string; trace: TraceEntry[]; promptTokensEstimate: number }> = [];
  for (const a of AUTHORS) for (const p of PERSONAS) results.push({ author: a.id, persona: p, ...(await engine.generate(a.id, p, DRAFT)) });
  return { engine, llm, results };
}

describe('e2e: ingest 3 authors, generate 2 personas each', () => {
  it('produces one result per (author, persona) with persona structure markers', async () => {
    const { results } = await runAll();
    expect(results).toHaveLength(6);
    for (const r of results.filter((x) => x.persona === 'executive')) {
      expect(r.text.startsWith('BLUF:')).toBe(true); // executive: recommendation first
    }
    for (const r of results.filter((x) => x.persona === 'engineer')) {
      expect(r.text.startsWith('The billing fix ships Friday.')).toBe(true);
      expect(r.text).not.toContain('BLUF');
    }
  });

  it('the persona mandates, author voice and fenced input reach the model; the style filter removed the banned filler', async () => {
    const { llm, results } = await runAll();
    expect(llm.requests).toHaveLength(6);
    const execReq = llm.requests.filter((r) => r.system.includes('Audience: Executive reader'));
    const engReq = llm.requests.filter((r) => r.system.includes('Audience: Senior engineer'));
    expect(execReq).toHaveLength(3);
    expect(engReq).toHaveLength(3);
    for (const r of execReq) {
      expect(r.system).toContain('first sentence is the recommendation');
      expect(r.system).toContain('Never use the phrase "deep dive"');
      expect(r.user).toContain('<input>');
    }
    for (const a of AUTHORS) expect(llm.requests.some((r) => r.system.includes(`voice of ${a.name}`))).toBe(true);
    for (const r of results) {
      expect(r.text).not.toMatch(/Furthermore/i); // style filter (post stage) edited the model answer
      expect(r.text).toContain('We measured no regressions.'); // ...and repaired capitalisation
    }
  });

  it('trace shape: pre confidentiality, llm, post style, post confidentiality; redactions are counts only', async () => {
    const { results } = await runAll();
    for (const r of results) {
      expect(r.trace.map((t) => t.filter)).toEqual(['confidentiality', 'llm', 'style', 'confidentiality']);
      for (const t of r.trace) {
        expect(typeof t.ms).toBe('number');
        expect(t.ms).toBeGreaterThanOrEqual(0);
        expect(typeof t.modified).toBe('boolean');
        expect(t.error).toBeUndefined();
      }
      expect(r.trace[0]?.modified).toBe(true); // the draft carried two secrets
      expect(r.trace[1]?.metadata).toMatchObject({ attempts: 1 });
      expect(r.promptTokensEstimate).toBeGreaterThan(0);
    }
  });

  it('no secret reaches the model, the result text or the trace; the model-echoed secret is redacted in the answer', async () => {
    const { llm, results } = await runAll();
    for (const req of llm.requests) {
      expect(req.system + req.user).not.toContain(AWS);
      expect(req.system + req.user).not.toContain(GH);
      expect(req.user).toContain('[REDACTED:');
    }
    for (const r of results) {
      expect(r.text).not.toContain(AWS);
      expect(r.text).not.toContain(GH);
      expect(r.text).toContain('[REDACTED:');
      const serialized = JSON.stringify(r.trace);
      expect(serialized).not.toContain(AWS);
      expect(serialized).not.toContain(GH);
    }
  });

  it('is deterministic: two independent engines give byte-identical text and identical prompts', async () => {
    const a = await runAll();
    const b = await runAll();
    expect(b.results.map((r) => r.text)).toEqual(a.results.map((r) => r.text));
    expect(b.llm.requests).toEqual(a.llm.requests);
    expect(b.results.map((r) => r.trace.map((t) => [t.filter, t.modified, t.metadata]))).toEqual(
      a.results.map((r) => r.trace.map((t) => [t.filter, t.modified, t.metadata])),
    );
  });

  it('distinct authors produce distinct profiles', async () => {
    const { engine } = await runAll();
    const avg = AUTHORS.map((a) => engine.getProfile(a.id).avgSentenceLength);
    expect(new Set(avg).size).toBe(3);
  });
});
