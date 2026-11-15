// MCP tools from the operations registry (Phase 9): one tool per operation, same name, same strict input schema, same
// error codes as the other surfaces. Tool arguments come from a model that may have been steered by hostile text, so
// they are treated exactly like untrusted HTTP input: validated against the operation's strict schema, never used as a
// path, command or query. Tools take an author id, never a file path; the engine decides where state lives.
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { jsonSchemaOf, successSchemaOf } from '../service/openapi.js';
import { describeError, errorDocument } from '../service/errors.js';
import { OPERATIONS, findOperation, successDocument } from '../service/operations.js';
import type { AnyOperation } from '../service/operations.js';
import type { ServiceRuntime } from '../service/runtime.js';

/** `tools/list` entries, in registry order. `ingest` is the only tool with `readOnlyHint: false`. */
export function toolDefinitions(ops: readonly AnyOperation[] = OPERATIONS): Tool[] {
  return ops.map((op) => ({
    name: op.name,
    description: op.description,
    inputSchema: jsonSchemaOf(op.input, 'input') as Tool['inputSchema'],
    outputSchema: successSchemaOf(op) as Tool['outputSchema'],
    annotations: {
      title: op.name,
      readOnlyHint: !op.mutates,
      // `ingest` replaces an earlier ingest of the same author id, so it is destructive in the MCP sense, and repeating it is harmless.
      ...(op.mutates ? { destructiveHint: true, idempotentHint: true } : {}),
      openWorldHint: op.openWorld,
    },
  })) as Tool[];
}

/** Run a tool call. Domain failures are tool results with `isError: true` and the shared `{ok:false, error:{code,message}}`. */
export async function callTool(runtime: ServiceRuntime, name: string, args: unknown, ops: readonly AnyOperation[] = OPERATIONS): Promise<CallToolResult | undefined> {
  const op = ops.find((o) => o.name === name) ?? findOperation(name);
  if (op === undefined) return undefined; // the caller turns an unknown tool into a protocol error
  try {
    const doc = successDocument(await runtime.runOperation(op, args));
    return { content: [{ type: 'text', text: JSON.stringify(doc) }], structuredContent: doc };
  } catch (err) {
    const d = describeError(err);
    const doc = errorDocument(d);
    // No structuredContent here: a client validates it against `outputSchema`, which describes the success document only.
    return { isError: true, content: [{ type: 'text', text: JSON.stringify(doc) }], _meta: { 'ghostwriter/category': d.mcp } };
  }
}
