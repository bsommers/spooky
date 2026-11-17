import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildOpenApi, serializeOpenApi } from '../../../src/service/openapi.js';

const snapshot = join(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'), 'ui', 'src', 'api', 'openapi.json');

describe('the UI API client is typed from the registry', () => {
  it('ui/src/api/openapi.json is exactly what the operations registry generates now (run "npm run gen:api" in ui/ after changing an operation)', () => {
    expect(readFileSync(snapshot, 'utf8')).toBe(serializeOpenApi(buildOpenApi({ version: '0.0.0' })));
  });
});
