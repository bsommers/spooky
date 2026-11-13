import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);

// Emit inside node_modules/.cache (gitignored) so the emitted JS can resolve the project's dependencies.
const cacheDir = join(root, 'node_modules', '.cache');
let outDir = '';

beforeAll(() => {
  mkdirSync(cacheDir, { recursive: true });
  outDir = mkdtempSync(join(cacheDir, 'smoke-build-'));
});

afterAll(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

describe('smoke: build', () => {
  // The strict typecheck of the full project (tests included) is the first gate in scripts/verify.sh.
  it('tsconfig.build.json compiles and emits the layout package.json main/types point at', () => {
    const tscBin = require.resolve('typescript/bin/tsc');
    const res = spawnSync(process.execPath, [tscBin, '-p', resolve(root, 'tsconfig.build.json'), '--outDir', outDir], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(res.stdout + res.stderr).toBe('');
    expect(res.status).toBe(0);
    // package.json: "main": "dist/src/index.js", "types": "dist/src/index.d.ts"
    expect(existsSync(join(outDir, 'src', 'index.js'))).toBe(true);
    expect(existsSync(join(outDir, 'src', 'index.d.ts'))).toBe(true);
  }, 120_000);

  it('the emitted src/index.js imports without throwing', async () => {
    const entry = join(outDir, 'src', 'index.js');
    expect(existsSync(entry)).toBe(true);
    const mod = await import(pathToFileURL(entry).href);
    expect(mod).toBeTypeOf('object');
  });

  it('src/index.ts imports without throwing', async () => {
    const mod = await import('../../src/index.js');
    expect(mod).toBeTypeOf('object');
  });
});
