// Vitest global setup: build the UI once so the build-output tests (offline scan, CSP-compatible output, licenses)
// look at the real production bundle, not a guess about it.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

export default async function setup(): Promise<void> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const before = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production'; // vitest sets "test"; the bundle under test must be the production one
  try {
    await build({ root, mode: 'production', logLevel: 'error' });
  } finally {
    if (before === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = before;
  }
}
