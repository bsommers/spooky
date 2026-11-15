// A throwaway "ui/dist" for the static-handler tests: a tiny SPA, a hashed asset, a dotfile, a secret OUTSIDE the root and
// a symlink inside the root that points at it.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const SECRET = 'TOP-SECRET-OUTSIDE-THE-UI-ROOT';

export interface UiFixture {
  base: string;
  root: string;
  cleanup(): void;
}

export function makeUiFixture(): UiFixture {
  const base = mkdtempSync(join(tmpdir(), 'gw-ui-'));
  const root = join(base, 'dist');
  mkdirSync(join(root, 'assets'), { recursive: true });
  mkdirSync(join(root, 'sub'), { recursive: true });
  writeFileSync(join(root, 'index.html'), '<!doctype html><html><body><div id="root">shell</div></body></html>');
  writeFileSync(join(root, 'sub', 'index.html'), '<!doctype html><p>sub index</p>');
  writeFileSync(join(root, 'assets', 'app-AbCdEf12.js'), 'console.log(1)');
  writeFileSync(join(root, 'assets', 'app-AbCdEf12.css'), 'body{margin:0}');
  writeFileSync(join(root, 'assets', 'font-AbCdEf12.woff2'), Buffer.from([0x77, 0x4f, 0x46, 0x32]));
  writeFileSync(join(root, 'assets', 'font-regular.woff2'), Buffer.from([0x77, 0x4f, 0x46, 0x32])); // hyphenated, but not a Vite hash
  writeFileSync(join(root, 'assets', 'my-notes.txt'), 'notes');
  symlinkSync(join(root, 'assets', 'app-AbCdEf12.js'), join(root, 'assets', 'plain.js')); // an unhashed name pointing at a hashed file
  writeFileSync(join(root, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(join(root, 'theme-init.js'), '/* init */');
  writeFileSync(join(root, '.hidden'), 'dotfile');
  writeFileSync(join(base, 'secret.txt'), SECRET);
  writeFileSync(join(base, 'dist-sibling.txt'), SECRET); // shares the "dist" name prefix: a startsWith(root) check would let it through
  symlinkSync(join(base, 'secret.txt'), join(root, 'link.txt'));
  mkdirSync(join(root, 'sub2'), { recursive: true });
  symlinkSync(join(base, 'secret.txt'), join(root, 'sub2', 'index.html')); // a directory whose implicit index points outside
  return { base, root, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}
