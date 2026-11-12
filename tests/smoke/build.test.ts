import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);

describe('smoke: build', () => {
  it('tsc --noEmit passes under strict', () => {
    const tscBin = require.resolve('typescript/bin/tsc');
    const res = spawnSync(process.execPath, [tscBin, '--noEmit', '-p', resolve(root, 'tsconfig.json')], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(res.stdout + res.stderr).toBe('');
    expect(res.status).toBe(0);
  }, 120_000);

  it('src/index.ts imports without throwing', async () => {
    const mod = await import('../../src/index.js');
    expect(mod).toBeTypeOf('object');
  });
});
