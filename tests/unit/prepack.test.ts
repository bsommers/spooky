import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The package lists ui/dist (gitignored build output): packing must build it, and must fail when it is absent.
const root = join(import.meta.dirname, '..', '..');

describe('release packaging ships the web UI', () => {
  it('prepack builds the server and the UI, then checks that ui/dist/index.html exists', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string>; files: string[] };
    expect(pkg.files).toContain('ui/dist');
    const steps = (pkg.scripts.prepack ?? '').split('&&').map((s) => s.trim());
    expect(steps).toEqual(['npm run build', 'npm run ui:build', 'node scripts/check-ui-dist.mjs']);
  });

  it('the check fails on a missing or empty ui/dist and passes with an index.html', () => {
    const base = mkdtempSync(join(tmpdir(), 'gw-prepack-'));
    try {
      const run = (dir: string) => spawnSync(process.execPath, [join(root, 'scripts', 'check-ui-dist.mjs'), dir], { encoding: 'utf8' });
      expect(run(join(base, 'nope')).status).toBe(1);
      mkdirSync(join(base, 'dist'));
      const empty = run(join(base, 'dist'));
      expect([empty.status, empty.stderr]).toEqual([1, expect.stringContaining('npm run ui:build')]);
      writeFileSync(join(base, 'dist', 'index.html'), '<!doctype html>');
      expect(run(join(base, 'dist')).status).toBe(0);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
