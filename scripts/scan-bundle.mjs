#!/usr/bin/env node
// Secret scan of the built web UI (ui/dist). The UI never holds a provider key (keys stay in the server's environment), so
// nothing in the bundle may look like one:
//   1. the confidentiality filter's own secret rules (the same detectors that protect model traffic) run over every text file;
//   2. any long, high-entropy token that is not a known build artifact (hashed asset names, the CSP hash);
//   3. every value passed with --planted (a canary the caller put in the server's environment) must be absent.
//
//   node scripts/scan-bundle.mjs [dir] [--planted VALUE]...      exits 1 on any finding; prints file, line and kind, never the value
//
// Needs `npm run build` first (the filter is imported from dist/).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TEXT = new Set(['.js', '.mjs', '.css', '.html', '.json', '.svg', '.webmanifest', '.txt', '.md', '.map']);
/** Minimum token length and Shannon entropy (bits per character) for the generic check. Random base64/hex secrets are above 4.3 at 32+. */
export const ENTROPY_MIN_LENGTH = 32;
export const ENTROPY_MIN_BITS = 4.5;

export function entropy(s) {
  const counts = new Map();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (TEXT.has(extname(e.name))) yield p;
  }
}

/** `password: "..."` / `apiKey = '...'` with a 16+ character literal on the right. */
const SECRET_LITERAL = /(?:password|passwd|secret|api[_-]?key|apikey|private[_-]?key|token)["'`]?\s{0,5}[:=]\s{0,5}["'`][^"'`\s]{16,}["'`]/i;

/**
 * Letters in words joined by single `-`, `_` or `.` (at least 4 letters in all). Written without nested quantifiers: the
 * obvious `(?:[a-z]+[-_.]?){4,}` backtracks exponentially on a long identifier followed by a digit or `=` (a React
 * development bundle held one that took two minutes), and this scanner reads whole minified bundles.
 */
function isWordy(token) {
  return /^[a-z]+(?:[-_.][a-z]+)*[-_.]?$/i.test(token) && token.replace(/[-_.]/g, '').length >= 4;
}

/**
 * A file path, not a secret. Base64 uses `/` too, so slashes alone prove nothing: a 40-character secret access key with a
 * `/` in it must still reach the entropy check. A path has a file extension (`.` is not a base64 character) or is a
 * lowercase-only relative or absolute path; anything else with a slash is treated as a possible secret.
 */
function isPath(token) {
  if (!/^[./-]*(?:[A-Za-z0-9_-]+\/)+[A-Za-z0-9._-]+$/.test(token)) return false;
  if (/\.[A-Za-z0-9]{1,8}$/.test(token)) return true;
  return /^\.{0,2}\//.test(token) && /^[a-z0-9_./-]+$/.test(token);
}

/** A token that is a known, public build artifact rather than a secret. */
function benign(token) {
  return (
    /^[A-Za-z]+$/.test(token) || // a long identifier or word
    isWordy(token) || // kebab/snake/dotted names
    isPath(token)
  );
}

export async function loadFilter(root) {
  const entry = resolve(root, 'dist', 'src', 'index.js');
  try {
    statSync(entry);
  } catch {
    throw new Error('scan-bundle: dist/ is missing; run "npm run build" first');
  }
  const { ConfidentialityFilter } = await import(pathToFileURL(entry).href);
  return new ConfidentialityFilter();
}

/** Scan `dir`; returns findings `{ file, line, kind }` (never the matched value). */
export async function scanDir(dir, { planted = [], filter } = {}) {
  const f = filter ?? (await loadFilter(resolve(fileURLToPath(import.meta.url), '..', '..')));
  const findings = [];
  for (const file of walk(dir)) {
    const text = readFileSync(file, 'utf8');
    const rel = relative(dir, file);
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      const { counts } = f.redact(line);
      for (const [kind, n] of Object.entries(counts)) {
        // The filter's loose `name: value` rule reads minified code (`password:!0`, `credentials:\`omit\``) as a leak; the literal check below replaces it.
        if (n > 0 && kind !== 'secret_assignment') findings.push({ file: rel, line: i + 1, kind: `secret-pattern:${kind}` });
      }
      if (SECRET_LITERAL.test(line)) findings.push({ file: rel, line: i + 1, kind: 'secret-assignment-literal' });
      for (const m of line.matchAll(/[A-Za-z0-9+/_=-]{32,}/g)) {
        const t = m[0];
        if (!benign(t) && entropy(t) >= ENTROPY_MIN_BITS) findings.push({ file: rel, line: i + 1, kind: 'high-entropy-token' });
      }
      for (const p of planted) if (p !== '' && line.includes(p)) findings.push({ file: rel, line: i + 1, kind: 'planted-secret' });
    });
  }
  return findings;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const planted = [];
  let dir = resolve(fileURLToPath(import.meta.url), '..', '..', 'ui', 'dist');
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--planted') planted.push(args[++i] ?? '');
    else dir = resolve(args[i]);
  }
  try {
    statSync(dir);
  } catch {
    console.error(`scan-bundle: ${dir} does not exist; run "npm run ui:build" first`);
    process.exit(2);
  }
  const findings = await scanDir(dir, { planted });
  for (const f of findings) console.error(`${f.file}:${f.line}: ${f.kind}`);
  console.log(`scan-bundle: ${findings.length === 0 ? 'clean' : `${findings.length} finding(s)`} (${dir})`);
  process.exit(findings.length === 0 ? 0 : 1);
}
