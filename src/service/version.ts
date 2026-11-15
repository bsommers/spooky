// The package version, read from package.json (found from `src/` in development and `dist/src/` when built).
import { readFileSync } from 'node:fs';

let cached: string | undefined;

export function packageVersion(): string {
  if (cached !== undefined) return cached;
  for (const rel of ['../../package.json', '../../../package.json']) {
    try {
      const pkg = JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8')) as { name?: unknown; version?: unknown };
      if (pkg.name === 'spooky' && typeof pkg.version === 'string') return (cached = pkg.version);
    } catch {
      // try the next location
    }
  }
  return (cached = '0.0.0');
}
