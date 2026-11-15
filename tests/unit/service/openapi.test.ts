import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Validator } from '@seriousme/openapi-schema-validator';
import { describe, expect, it } from 'vitest';
import { buildOpenApi, errorStatuses, operationErrorStatuses, serializeOpenApi } from '../../../src/service/openapi.js';
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
    for (const status of operationErrorStatuses(operation('score'), false)) expect(doc.paths['/api/score']?.post.responses[String(status)], String(status)).toBeDefined();
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
      expect(served.servers).toEqual([{ url: server.url }]); // the address it actually bound, not a hard-coded one
      // a route that is in the document answers; one that is not does not
      expect((await raw(server, '/api/personas')).status).toBe(200);
      expect((await raw(server, '/api/humanize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(404);
    } finally {
      await server.close();
      rig.cleanup();
    }
  });

  describe('the document reflects the server it is served by (token, base URL, per-method statuses)', () => {
    const TOKEN = 'a-long-enough-token-1234';
    const docOf = (o: Parameters<typeof buildOpenApi>[0]): any => buildOpenApi(o);

    it('with a token every operation (and /openapi.json) requires the bearer scheme and documents 401/429; without one, none does', async () => {
      const withToken = docOf({ version: '1', tokenRequired: true });
      const without = docOf({ version: '1' });
      for (const [path, item] of Object.entries<any>(withToken.paths)) {
        for (const op of Object.values<any>(item)) expect(op.security, path).toEqual([{ bearer: [] }]);
      }
      expect(withToken.components.securitySchemes.bearer).toEqual({ type: 'http', scheme: 'bearer' });
      expect(withToken.paths['/api/score'].post.responses['401']).toBeDefined();
      expect(withToken.paths['/api/score'].post.responses['429']).toBeDefined();
      for (const item of Object.values<any>(without.paths)) for (const op of Object.values<any>(item)) expect(op.security).toEqual([]);
      expect(without.components.securitySchemes).toBeUndefined();
      expect(without.paths['/api/score'].post.responses['401']).toBeUndefined();
      for (const d of [withToken, without]) expect((await new Validator().validate(JSON.parse(JSON.stringify(d)))).valid).toBe(true);
      // the old "auth optional" form is gone
      expect(JSON.stringify(withToken)).not.toContain('"security":[{},');
    });

    it('servers come from the given base URL; with none given the document names no server', () => {
      expect(docOf({ version: '1', serverUrl: 'http://127.0.0.1:9191' }).servers).toEqual([{ url: 'http://127.0.0.1:9191' }]);
      expect(docOf({ version: '1' }).servers).toBeUndefined();
      expect(JSON.stringify(docOf({ version: '1', serverUrl: 'http://[::1]:1' }))).not.toContain('8787');
    });

    it('413, 415 and 408 are listed for operations that read a body (POST) and not for GET operations', () => {
      const d = docOf({ version: '1', tokenRequired: true });
      for (const op of OPERATIONS) {
        const responses = d.paths[op.http.path][op.http.method.toLowerCase()].responses;
        for (const status of [408, 413, 415]) expect(responses[String(status)] !== undefined, `${op.name} ${status}`).toBe(op.http.method === 'POST');
        for (const status of [400, 403, 404, 405, 421, 500, 503]) expect(responses[String(status)], `${op.name} ${status}`).toBeDefined();
      }
    });

    it('a live token-protected server: the served document says bearer + its own URL, and the routes behave as it says', async () => {
      const rig = await makeRuntime();
      const server = await startTestServer(rig, { token: TOKEN, port: 0 });
      try {
        const noToken = await raw(server, '/openapi.json');
        expect(noToken.status).toBe(401); // the document itself is behind the token it advertises
        const served = (await raw(server, '/openapi.json', { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
        expect(served.servers).toEqual([{ url: server.url }]);
        for (const op of OPERATIONS) {
          const item = served.paths[op.http.path][op.http.method.toLowerCase()];
          expect(item.security, op.name).toEqual([{ bearer: [] }]);
          // documented = observed: a request without the token is the 401 the document lists
          const r = await raw(server, op.http.path, op.http.method === 'GET' ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
          expect(r.status, op.name).toBe(401);
          expect(item.responses[String(r.status)], op.name).toBeDefined();
          // a GET never answers 415/413 whatever Content-Type it carries
          if (op.http.method === 'GET') {
            const g = await raw(server, op.http.path, { headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'text/plain' } });
            expect([413, 415]).not.toContain(g.status);
            expect(item.responses['413'] ?? item.responses['415']).toBeUndefined();
          }
        }
      } finally {
        await server.close();
        rig.cleanup();
      }
    });
  });

  it('the server source names no /api/ route of its own (routes are derived from the registry)', () => {
    const src = readFileSync(join(here, '..', '..', '..', 'src', 'api', 'server.ts'), 'utf8');
    expect(src.match(/\/api\/[a-z]/g) ?? []).toEqual([]); // only the bare '/api/' prefix appears
  });
});
