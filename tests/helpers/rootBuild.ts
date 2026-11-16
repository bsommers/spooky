// Vitest global setup: the UI security tests load the library's own ConfidentialityFilter from the root `dist/` (the bundle
// scanner uses the same secret rules that protect model traffic), and the UI e2e server runs from it. `dist/` is gitignored,
// so a clean checkout has none and an old one may predate the source. Build it here, before any test, whenever it is
// missing or older than `src/` or `config/`: the tests never depend on the order of an outer script. A failure is loud.
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isStale } from './staleness.js';

export default function setup(): void {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const entry = join(root, 'dist', 'src', 'index.js');
  if (!isStale(entry, [join(root, 'src'), join(root, 'config'), join(root, 'tsconfig.json'), join(root, 'tsconfig.build.json')])) return;
  const res = spawnSync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.build.json'], { cwd: root, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`root build (tsc -p tsconfig.build.json) failed:\n${res.stdout}\n${res.stderr}`);
}
