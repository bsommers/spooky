// Vitest global setup: the UI integration tests serve the real build, so make sure `ui/dist` exists AND is current:
// built from the UI source as it is now. `scripts/verify.sh` also rebuilds it first, but a bare `npm test` (or --no-ui) must
// not run ui-csp, ui-secrets and ui-serve against an old `dist` that passes after the source has regressed. A failure is loud,
// never a skip.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isStale } from './staleness.js';

export default function setup(): void {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const ui = join(root, 'ui');
  const inputs = ['src', 'public', 'index.html', 'package.json', 'vite.config.ts', 'tsconfig.json', 'scripts'].map((p) => join(ui, p));
  if (!isStale(join(ui, 'dist', 'index.html'), inputs)) return;
  if (!existsSync(join(ui, 'node_modules'))) {
    throw new Error('ui/dist is missing or older than ui/src and ui/node_modules is not installed: run "npm run ui:install" then "npm run ui:build"');
  }
  // vitest runs with NODE_ENV=test, which a child build would inherit and bundle React's development build (3x slower to scan, with its warnings in the bundle).
  const res = spawnSync('npm', ['--prefix', 'ui', 'run', 'build'], { cwd: root, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'production' } });
  if (res.status !== 0) throw new Error(`ui build failed:\n${res.stdout}\n${res.stderr}`);
}
