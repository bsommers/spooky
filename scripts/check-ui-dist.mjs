// Release guard: the package lists `ui/dist`, which is gitignored build output. Fail the pack when it is missing or
// has no index.html, so a publish cannot silently ship without the web UI.
//   node scripts/check-ui-dist.mjs [dir]      (default: ui/dist next to this repo)
import { statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'dist'));
try {
  if (!statSync(join(dir, 'index.html')).isFile()) throw new Error('not a file');
} catch {
  console.error('check-ui-dist: ui/dist/index.html is missing; run "npm run ui:build" before packing');
  process.exit(1);
}
console.log('check-ui-dist: ok');
