import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Validator } from '@seriousme/openapi-schema-validator';
import { describe, expect, it } from 'vitest';
import { buildOpenApi, errorStatuses, serializeOpenApi } from '../../../src/service/openapi.js';
import { ERROR_TABLE } from '../../../src/service/errors.js';
import { OPERATIONS, operation } from '../../../src/service/operations.js';
import { startTestServer, makeRuntime, raw } from '../../helpers/surfaces.js';

const here = dirname(fileURLToPath(import.meta.url));
const doc = buildOpenApi({ version: '9.9.9' }) as { openapi: string; paths: Record<string, Record<string, any>>; components: any };

describe('OpenAPI 3.1 document', () => {
  it('validates against the OpenAPI 3.1 schema', async () => {
    const result = await new Validator().validate(JSON.parse(JSON.stringify(doc)));
    expect(result.valid, JSON.stringify(result)).toBe(true);
    expect(doc.openapi).toBe('3.1.0');
    // the validator is real: a broken document is refused
    const broken = JSON.parse(JSON.stringify(doc));
    broken.paths['/api/authors'].get.responses = 'nope';
    expect((await new Validator().validate(broken)).valid).toBe(false);
  });

  it('has a path and method for every registry operation, and nothing for an operation that is not registered', () => {
    for (const op of OPERATIONS) {
      const item = doc.paths[op.http.path];
      expect(item, op.name).toBeDefined();
      expect(item?.[op.http.method.toLowerCase()]?.operationId, op.name).toBe(op.name);
    }
    const apiPaths = Object.keys(doc.paths).filter((p) => p.startsWith('/api/'));
    expect(apiPaths.sort()).toEqual(OPERATIONS.map((o) => o.http.path).sort());
    expect(doc.paths['/api/humanize']).toBeUndefined();
  });

  it('GET operations use query parameters, POST operations a JSON body, and both document the error statuses', () => {
    expect(doc.paths['/api/profile']?.get.parameters).toEqual([expect.objectContaining({ name: 'authorId', in: 'query', required: true })]);
    expect(doc.paths['/api/generate']?.post.requestBody.content['application/json'].schema.required).toEqual(expect.arrayContaining(['authorId', 'persona', 'text']));
    expect(doc.paths['/api/generate']?.post.requestBody.content['application/json'].schema.additionalProperties).toBe(false);
    for (const status of errorStatuses()) expect(doc.paths['/api/score']?.post.responses[String(status)], String(status)).toBeDefined();
    expect(errorStatuses()).toEqual([...new Set(Object.values(ERROR_TABLE).map((s) => s.http))].sort((a, b) => a - b));
  });

  it('responses are { ok: true, ...output }', () => {
    const schema = doc.paths['/api/authors']?.get.responses['200'].content['application/json'].schema;
    expect(schema.required).toContain('ok');
    expect(schema.properties.ok).toEqual({ type: 'boolean', const: true });
    expect(schema.properties.authors.type).toBe('array');
  });

  it('regenerating twice is byte-identical, and the document equals one built from the registry alone (no hand edits, no x- extensions)', () => {
    const a = serializeOpenApi(buildOpenApi({ version: '1.0.0' }));
    const b = serializeOpenApi(buildOpenApi({ version: '1.0.0' }));
    expect(a).toBe(b);
    expect(a).not.toMatch(/"x-/);
    const src = readFileSync(join(here, '..', '..', '..', 'src', 'service', 'openapi.ts'), 'utf8');
    for (const op of OPERATIONS) expect(src, `openapi.ts must not name ${op.http.path}`).not.toContain(op.http.path);
  });

  it('drift: removing an operation from the registry removes its path; adding one adds it', () => {
    const without = buildOpenApi({ version: '1' }, OPERATIONS.filter((o) => o.name !== 'score')) as typeof doc;
    expect(without.paths['/api/score']).toBeUndefined();
    const extra = { ...operation('personas'), name: 'personas' as const, http: { method: 'GET' as const, path: '/api/zzz' } };
    expect((buildOpenApi({ version: '1' }, [...OPERATIONS, extra]) as typeof doc).paths['/api/zzz']).toBeDefined();
  });

  it('the running server serves exactly this document at /openapi.json, and routes only what the registry declares', async () => {
    const rig = await makeRuntime();
    const server = await startTestServer(rig);
    try {
      const r = await raw(server, '/openapi.json');
      expect(r.status).toBe(200);
      const served = r.json();
      expect(Object.keys(served.paths).sort()).toEqual(Object.keys(buildOpenApi({ version: 'x' }).paths as object).sort());
      // a route that is in the document answers; one that is not does not
      expect((await raw(server, '/api/personas')).status).toBe(200);
      expect((await raw(server, '/api/humanize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(404);
    } finally {
      await server.close();
      rig.cleanup();
    }
  });

  it('the server source names no /api/ route of its own (routes are derived from the registry)', () => {
    const src = readFileSync(join(here, '..', '..', '..', 'src', 'api', 'server.ts'), 'utf8');
    expect(src.match(/\/api\/[a-z]/g) ?? []).toEqual([]); // only the bare '/api/' prefix appears
  });
});
