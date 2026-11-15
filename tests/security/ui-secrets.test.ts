// Security tier, web UI (Phase 11): the browser is an untrusted holder of secrets. The key stays in the server's
// environment; the optional API token is page memory only. These tests cover the static side: nothing in the built bundle
// or the source can hold, store or hard-code a secret. The runtime side (storage after a full flow, API responses
// carrying a planted key) is ui/tests/e2e/secrets.spec.ts.
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const uiDist = join(root, 'ui', 'dist');
const uiSrc = join(root, 'ui', 'src');

interface Finding {
  file: string;
  line: number;
  kind: string;
}
type Scanner = { scanDir(dir: string, o?: { planted?: string[] }): Promise<Finding[]>; entropy(s: string): number };
const scanner = (await import(pathToFileURL(join(root, 'scripts', 'scan-bundle.mjs')).href)) as unknown as Scanner;

const scratch = mkdtempSync(join(tmpdir(), 'gw-scan-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
function dirWith(files: Record<string, string>): string {
  const d = mkdtempSync(join(scratch, 'd-'));
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(d, name)), { recursive: true });
    writeFileSync(join(d, name), body);
  }
  return d;
}
/** Source with comments removed: a comment saying "never in localStorage" is not a use of it. */
const code = (file: string): string => readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));

// Fake secrets built at run time so this file is not itself a secret-shaped string.
const OPENAI = 'sk-' + 'proj-' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4';
const ANTHROPIC = 'sk-ant-' + 'api03-' + 'Zy9Xw8Vu7Ts6Rq5Po4Nm3Lk2Ji1';
const GITHUB = 'ghp_' + 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fH3jL5';
const AWS = 'AKIA' + 'IOSFODNN7EXAMPLE';
const RANDOM = 'q8Zr1VxN4kLw0TyP7bGm3HcJ6sDfA2uEoX9iRnB5';
const PLANTED = 'sk-' + 'planted-canary-8d41f0c7a95e2b6d1034';

describe('the scanner (so a clean bundle means something)', () => {
  it.each([
    ['an OpenAI-style key', `const k = "${OPENAI}";`],
    ['an Anthropic key', `fetch(u, {headers: {"x-api-key": "${ANTHROPIC}"}})`],
    ['a GitHub token', `const t = '${GITHUB}'`],
    ['an AWS access key', `aws=${AWS}`],
    ['a private key block', '-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----'],
    ['a long high-entropy token', `var x="${RANDOM}"`],
    ['a hard-coded password literal', 'const cfg = {password: "correct-horse-battery-staple"}'],
    ['a token assigned from a long literal', 'const apiKey = "abcdefghijklmnopqrstuvwxyz0123"'],
  ])('flags %s', async (_name, body) => {
    const found = await scanner.scanDir(dirWith({ 'assets/app.js': body }));
    expect(found.length, body).toBeGreaterThan(0);
    expect(JSON.stringify(found)).not.toMatch(/sk-|ghp_|AKIA|correct-horse/); // findings name file, line and kind, never the value
  });

  it('flags a planted canary value anywhere, in any text file, and in none when it is absent', async () => {
    const d = dirWith({ 'a/b/index.html': `<p>${PLANTED}</p>`, 'assets/x.css': '.a{color:red}' });
    expect((await scanner.scanDir(d, { planted: [PLANTED] })).map((f) => f.kind)).toContain('planted-secret');
    expect(await scanner.scanDir(dirWith({ 'index.html': '<p>nothing here</p>' }), { planted: ['sk-not-here-0000000000000000'] })).toEqual([]);
  });

  it('does not flag what a real bundle contains: hashed asset names, minified assignments, identifiers, paths', async () => {
    const body = [
      'import("./ScoreScreen-BoZo5lpW.js");const e={password:!0,range:!0};fetch(u,{credentials:`omit`});',
      'const path="/assets/very-long-descriptive-chunk-name-without-secrets.js";',
      'class VeryLongIdentifierNameThatIsJustCodeAndNotAKeyAtAll{}',
    ].join('\n');
    expect(await scanner.scanDir(dirWith({ 'assets/index-DXn5wVGR.js': body }))).toEqual([]);
  });

  it('entropy: random base64 is above the bar, English and hex identifiers are below', () => {
    expect(scanner.entropy(RANDOM)).toBeGreaterThan(4.5);
    expect(scanner.entropy('aaaaaaaabbbbbbbbccccccccdddddddd')).toBeLessThan(2.5);
  });
});

describe('the built UI', () => {
  it('ui/dist holds no secret-shaped string, no high-entropy token and no planted canary', async () => {
    const found = await scanner.scanDir(uiDist, { planted: [PLANTED, OPENAI, ANTHROPIC] });
    expect(found).toEqual([]);
  }, 120_000); // the filter reads 400 KB of minified code line by line

  it('does not name a provider key variable of its own: key variable names only ever arrive from the API', () => {
    for (const f of walk(uiDist).filter((p) => /\.(js|html|css)$/.test(p))) {
      expect(readFileSync(f, 'utf8'), relative(root, f)).not.toMatch(/ANTHROPIC_API_KEY|OPENAI_API_KEY|x-api-key|anthropic-version/i);
    }
  });
});

describe('the UI source', () => {
  const sources = walk(uiSrc).filter((f) => /\.tsx?$/.test(f));

  it('uses web storage in one place only: the theme engine, for the theme id', () => {
    const users = sources.filter((f) => /localStorage|sessionStorage|indexedDB|document\.cookie|caches\.open|openDatabase/.test(code(f))).map((f) => relative(uiSrc, f));
    expect(users).toEqual(['theme/engine.ts']);
    const engine = code(join(uiSrc, 'theme', 'engine.ts'));
    expect([...engine.matchAll(/\.setItem\(([^)]*)\)/g)].map((m) => m[1])).toEqual(['STORAGE_KEY, id']); // the interface declaration is `setItem(key`, not a call
  });

  it('the API client keeps the token in a closure variable: no storage, no URL, no cookie, no log', () => {
    const client = code(join(uiSrc, 'api', 'client.ts'));
    expect(client).not.toMatch(/localStorage|sessionStorage|document\.cookie|console\./);
    expect(client).toMatch(/credentials: 'omit'/);
    expect(client.match(/Authorization/g)?.length).toBe(1);
  });

  it('no source file hard-codes a key-shaped literal or reads process.env / import.meta.env for a secret', () => {
    for (const f of sources) {
      const text = code(f);
      expect(text, relative(root, f)).not.toMatch(/\bsk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}/);
      expect(text, relative(root, f)).not.toMatch(/process\.env|import\.meta\.env/);
    }
  });
});
