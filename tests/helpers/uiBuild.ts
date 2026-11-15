// Vitest global setup: the UI integration tests serve the real build, so make sure `ui/dist` exists. `scripts/verify.sh`
// always rebuilds it first; this only covers a bare `npm test` after `npm run ui:install`. A failure is loud, never a skip.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export default function setup(): void {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  if (existsSync(join(root, 'ui', 'dist', 'index.html'))) return;
  if (!existsSync(join(root, 'ui', 'node_modules'))) {
    throw new Error('ui/dist is missing and ui/node_modules is not installed: run "npm run ui:install" then "npm run ui:build"');
  }
  const res = spawnSync('npm', ['--prefix', 'ui', 'run', 'build'], { cwd: root, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`ui build failed:\n${res.stdout}\n${res.stderr}`);
}
