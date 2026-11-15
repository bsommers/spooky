// OpenAPI 3.1 document generated from the operations registry (Phase 9). Nothing here is hand-written per route: a
// registry entry gets a path, request schema, response schema and error responses by construction, so the document
// cannot drift from the server. tests/unit/service/openapi.test.ts validates the document with a schema validator,
// checks every operation is present, and fails when the server has a route the registry lacks.
import { z } from 'zod';
import { ERROR_TABLE } from './errors.js';
import { OPERATIONS } from './operations.js';
import type { AnyOperation } from './operations.js';

type Json = Record<string, unknown>;

/** JSON Schema (2020-12, which OpenAPI 3.1 uses) of a zod schema; `io` picks the input or output side. */
export function jsonSchemaOf(schema: z.ZodType, io: 'input' | 'output'): Json {
  const out = z.toJSONSchema(schema, { target: 'draft-2020-12', io, unrepresentable: 'any' }) as Json;
  delete out.$schema;
  return out;
}

/** The schema of the `{ ok: true, ...output }` document a successful call returns. */
export function successSchemaOf(op: AnyOperation): Json {
  const body = jsonSchemaOf(op.output, 'output');
  const props = (body.properties ?? {}) as Json;
  const required = [...((body.required as string[] | undefined) ?? [])];
  return { ...body, properties: { ok: { type: 'boolean', const: true }, ...props }, required: ['ok', ...required] };
}

const ERROR_SCHEMA: Json = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', const: false },
    error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } }, required: ['code', 'message'], additionalProperties: false },
  },
  required: ['ok', 'error'],
  additionalProperties: false,
};

const STATUS_TEXT: Readonly<Record<number, string>> = {
  400: 'Invalid input (USAGE, CONFIG_INVALID)',
  401: 'Missing or wrong bearer token (UNAUTHORIZED)',
  403: 'Origin not allowed (FORBIDDEN)',
  404: 'Unknown author, persona or route (UNKNOWN_AUTHOR, UNKNOWN_PERSONA, NOT_FOUND)',
  405: 'Method not allowed (METHOD_NOT_ALLOWED)',
  408: 'Request not received in time (REQUEST_TIMEOUT)',
  413: 'Body or text too large (INPUT_TOO_LARGE)',
  415: 'Content-Type must be application/json (UNSUPPORTED_MEDIA_TYPE)',
  421: 'Host header does not name this server (MISDIRECTED_REQUEST)',
  422: 'Corpus yields no profile (PROFILE_INVALID)',
  429: 'Too many failed token attempts from this address; see Retry-After (RATE_LIMITED)',
  500: 'Internal failure (FILTER_FAILED, STORE_CORRUPT, INTERNAL)',
  502: 'Language model or detector failed (LLM_FAILED, DETECTORS_FAILED)',
  503: 'Busy or state locked (OVERLOADED, STATE_LOCKED)',
};

/** HTTP statuses the error table can produce, ascending. */
export function errorStatuses(): number[] {
  return [...new Set(Object.values(ERROR_TABLE).map((s) => s.http))].sort((a, b) => a - b);
}

function pathItem(op: AnyOperation): Json {
  const input = jsonSchemaOf(op.input, 'input');
  const responses: Json = {
    '200': { description: 'Success', content: { 'application/json': { schema: successSchemaOf(op) } } },
  };
  for (const status of errorStatuses()) {
    responses[String(status)] = { description: STATUS_TEXT[status] ?? 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
  }
  const base: Json = { operationId: op.name, summary: op.description, tags: [op.mutates ? 'write' : 'read'], responses, security: [{}, { bearer: [] }] };
  if (op.http.method === 'GET') {
    const props = (input.properties ?? {}) as Record<string, Json>;
    const required = new Set((input.required as string[] | undefined) ?? []);
    base.parameters = Object.entries(props).map(([name, schema]) => ({ name, in: 'query', required: required.has(name), schema }));
  } else {
    base.requestBody = { required: true, content: { 'application/json': { schema: input } } };
  }
  return { [op.http.method.toLowerCase()]: base };
}

export interface OpenApiOptions {
  version: string;
  title?: string;
}

export function buildOpenApi(options: OpenApiOptions, ops: readonly AnyOperation[] = OPERATIONS): Json {
  const paths: Json = {};
  for (const op of ops) paths[op.http.path] = { ...(paths[op.http.path] as Json | undefined), ...pathItem(op) };
  paths['/openapi.json'] = {
    get: {
      operationId: 'openapi',
      summary: 'This document, generated from the operations registry.',
      tags: ['read'],
      responses: { '200': { description: 'The OpenAPI 3.1 document', content: { 'application/json': { schema: { type: 'object' } } } } },
      security: [{}, { bearer: [] }],
    },
  };
  return {
    openapi: '3.1.0',
    info: {
      title: options.title ?? 'ghostwriter service',
      version: options.version,
      description:
        'Generated from the operations registry (src/service/operations.ts). The same operations exist on the CLI and as MCP tools. Binds to loopback by default; an optional bearer token protects every route.',
      license: { name: 'Apache-2.0', identifier: 'Apache-2.0' },
    },
    servers: [{ url: 'http://127.0.0.1:8787' }],
    tags: [{ name: 'read' }, { name: 'write' }],
    paths,
    components: {
      schemas: { Error: ERROR_SCHEMA },
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
    },
  };
}

/** Canonical text of the document: stable key order, two-space indent, trailing newline. */
export function serializeOpenApi(doc: Json): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}
