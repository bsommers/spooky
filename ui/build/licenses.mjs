// Third-party license audit for the UI's PRODUCTION dependencies (what ships in the bundle) and its fonts.
// Source of truth: ui/package-lock.json (which packages are installed for production) plus each package's own
// package.json (its declared license). Allowed: Apache-2.0, MIT, BSD, ISC, OFL fonts and a few equally permissive ones;
// GPL/AGPL/LGPL, unknown, missing or "see license in file" fail. Used by scripts/licenses.mjs and tests/build/licenses.test.ts.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const ALLOWED = new Set(['Apache-2.0', 'MIT', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD', 'OFL-1.1', 'CC0-1.0', 'BlueOak-1.0.0']);

/** @param {unknown} pkgJson */
export function declaredLicense(pkgJson) {
  const p = /** @type {any} */ (pkgJson);
  if (typeof p.license === 'string') return p.license;
  if (p.license && typeof p.license.type === 'string') return p.license.type;
  if (Array.isArray(p.licenses) && p.licenses.length > 0) return p.licenses.map((l) => (typeof l === 'string' ? l : l.type)).join(' OR ');
  return 'UNKNOWN';
}

/**
 * Is an SPDX expression acceptable? `A OR B`: one acceptable alternative is enough (we may pick it); `A AND B`: both must be;
 * AND binds tighter than OR and parentheses group (a small recursive-descent parser, so `(MIT OR GPL-3.0) AND LGPL-3.0`
 * fails on the LGPL it requires). `X WITH exception` is judged by X. An expression that does not parse is rejected.
 * @param {string} expr
 * @returns {{ ok: boolean, reason: string }}
 */
export function classifyLicense(expr) {
  const text = String(expr).trim();
  if (text === '' || /unknown|unlicensed|see license|custom/i.test(text)) return { ok: false, reason: `license is ${text === '' ? 'missing' : `"${text}"`}` };
  const tokens = text.match(/\(|\)|[^\s()]+/g) ?? [];
  let i = 0;
  let malformed = false;
  const fail = (reason) => ({ ok: false, reason });
  const syntax = () => {
    malformed = true;
    return fail(`"${text}" is not a valid license expression`);
  };
  const peek = () => tokens[i];
  const isOp = (t, op) => t !== undefined && t.toUpperCase() === op;
  function parseOr() {
    const verdicts = [parseAnd()];
    while (isOp(peek(), 'OR')) {
      i += 1;
      verdicts.push(parseAnd());
    }
    return verdicts.find((v) => v.ok) ?? fail(verdicts.map((v) => v.reason).join('; '));
  }
  function parseAnd() {
    const verdicts = [parseAtom()];
    while (isOp(peek(), 'AND')) {
      i += 1;
      verdicts.push(parseAtom());
    }
    return verdicts.find((v) => !v.ok) ?? { ok: true, reason: '' };
  }
  function parseAtom() {
    const t = peek();
    if (t === undefined || t === ')' || isOp(t, 'AND') || isOp(t, 'OR')) return syntax();
    i += 1;
    if (t === '(') {
      const inner = parseOr();
      if (peek() !== ')') return syntax();
      i += 1;
      return inner;
    }
    if (isOp(peek(), 'WITH')) i += 2; // the exception id only ever widens what the license permits
    return ALLOWED.has(t) ? { ok: true, reason: '' } : fail(`"${t}" is not an allowed license`);
  }
  const verdict = parseOr();
  if (malformed || i < tokens.length) return fail(`"${text}" is not a valid license expression`);
  return verdict;
}

/** Packages installed for production (everything in the lock file not marked dev-only), with their declared license. */
export function collectProductionPackages(uiRoot) {
  const lock = JSON.parse(readFileSync(join(uiRoot, 'package-lock.json'), 'utf8'));
  const out = [];
  for (const [path, meta] of Object.entries(lock.packages ?? {})) {
    if (path === '' || meta.dev === true) continue;
    const idx = path.lastIndexOf('node_modules/');
    const name = idx < 0 ? path : path.slice(idx + 'node_modules/'.length);
    const dir = join(uiRoot, path);
    const pkgFile = join(dir, 'package.json');
    const pkg = existsSync(pkgFile) ? JSON.parse(readFileSync(pkgFile, 'utf8')) : {};
    const hasLicenseFile = existsSync(dir) && readdirSync(dir).some((f) => /^(licen[sc]e|copying|notice)/i.test(f));
    out.push({ name, version: String(meta.version ?? pkg.version ?? '?'), license: existsSync(pkgFile) ? declaredLicense(pkg) : 'UNKNOWN', hasLicenseFile });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

/**
 * The font packages `fonts.css` pulls woff2 files from, each with its declared license and whether a LICENSE file ships
 * with it. A woff2 that does not come from a package with an OFL license and a LICENSE file is a problem.
 */
export function inspectFonts(uiRoot, fontsCssPath = join(uiRoot, 'src', 'assets', 'fonts.css')) {
  const css = readFileSync(fontsCssPath, 'utf8');
  const problems = [];
  const families = new Map();
  for (const m of css.matchAll(/url\(([^)]+\.woff2)\)/g)) {
    const url = m[1].replace(/["']/g, '');
    const pm = /node_modules\/((?:@[^/]+\/)?[^/]+)\/files\/([^/]+\.woff2)$/.exec(url);
    if (!pm) {
      problems.push(`font file ${url} does not come from a package under node_modules (no license can be checked)`);
      continue;
    }
    const [, pkg, file] = pm;
    if (!families.has(pkg)) families.set(pkg, { pkg, files: [] });
    families.get(pkg).files.push(file);
  }
  const result = [];
  for (const { pkg, files } of families.values()) {
    const dir = join(uiRoot, 'node_modules', pkg);
    const pkgJson = existsSync(join(dir, 'package.json')) ? JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) : undefined;
    const license = pkgJson === undefined ? 'UNKNOWN' : declaredLicense(pkgJson);
    const licenseFile = join(dir, 'LICENSE');
    const hasFile = existsSync(licenseFile);
    const isOfl = hasFile && /SIL OPEN FONT LICENSE/i.test(readFileSync(licenseFile, 'utf8'));
    if (license !== 'OFL-1.1') problems.push(`${pkg}: font license is ${license}, expected OFL-1.1`);
    if (!hasFile) problems.push(`${pkg}: no LICENSE file next to the font; refusing to ship it`);
    else if (!isOfl) problems.push(`${pkg}: LICENSE file is not the SIL Open Font License`);
    result.push({ pkg, license, files: [...new Set(files)].sort(), licenseFile: hasFile ? 'LICENSE' : undefined });
  }
  return { fonts: result.sort((a, b) => a.pkg.localeCompare(b.pkg)), problems };
}

export function auditProblems(packages, fontProblems) {
  const problems = [...fontProblems];
  for (const p of packages) {
    const v = classifyLicense(p.license);
    if (!v.ok) problems.push(`${p.name}@${p.version}: ${v.reason}`);
  }
  return problems;
}

/** Deterministic THIRD_PARTY.md: no dates, sorted. */
export function renderThirdParty(packages, fonts) {
  const lines = [
    '# Third-party software in the UI',
    '',
    'Generated by `npm run licenses` in `ui/` (do not edit by hand; `node scripts/licenses.mjs --check` and the test suite fail when this file is stale or a license is not allowed).',
    '',
    'Spooky itself is Apache-2.0. The UI bundle contains only the production packages below. Allowed licenses: ' + [...ALLOWED].join(', ') + '. GPL, AGPL, LGPL, unknown and missing licenses fail the audit.',
    '',
    'The full license text of every bundled package is written into the build as `licenses/THIRD_PARTY_LICENSES.md`, and each font package\'s license file is copied to `licenses/<font>-OFL.txt`.',
    '',
    '## Fonts (SIL Open Font License 1.1, self-hosted, no CDN)',
    '',
    '| Package | License | Files bundled |',
    '|---|---|---|',
    ...fonts.map((f) => `| \`${f.pkg}\` | ${f.license} | ${f.files.map((x) => `\`${x}\``).join(', ')} |`),
    '',
    'Families: Orbitron, Inter and JetBrains Mono (Tron Neon, matching lumagrid), Fraunces (Black Cat display).',
    '',
    '## Production dependencies',
    '',
    '| Package | Version | License |',
    '|---|---|---|',
    ...packages.map((p) => `| \`${p.name}\` | ${p.version} | ${p.license} |`),
    '',
    '## Development tools (not shipped)',
    '',
    'Build and test tooling (Vite, Vitest, Playwright, Testing Library, jsdom, axe-core, stylelint, openapi-typescript, TypeScript) is used only on a developer machine and is not part of the served bundle. `axe-core` is MPL-2.0 and is a test-only dependency.',
    '',
  ];
  return lines.join('\n');
}
