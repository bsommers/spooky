#!/usr/bin/env bash
# Verification gate: typecheck, then every test tier, with per-tier counts.
#
#   scripts/verify.sh                   run everything
#   scripts/verify.sh --only <pattern>  run only test files whose path matches <pattern>
#   scripts/verify.sh --coverage        also enforce the coverage gate (src/filters, src/registry >= 90% lines)
#   scripts/verify.sh --no-ui           skip the web UI checks (ui/: typecheck, css lint, license audit, unit/component/a11y/build tests, Playwright)
#   scripts/verify.sh --no-e2e          run the UI checks but not the Playwright suite (needs a Chromium; GW_E2E_CONTAINER=1 runs it in the pinned container)
#
# The web UI (ui/, Phases 10-11) is its own package: `npm run ui:install` once. --only skips the UI checks (it selects root tests).

# Tiers (tests/<tier>/): smoke unit integration system security torture.
# A tier directory that does not exist yet reports "0 tests"; it is not an error.
# Exits nonzero if the typecheck fails, any test fails, or --only matches nothing.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 2

TIERS=(smoke unit integration system security torture)
ONLY=""
COVERAGE=0
UI=1
E2E=1

while [ $# -gt 0 ]; do
  case "$1" in
    --only)
      if [ $# -lt 2 ] || [ -z "$2" ]; then
        echo "verify.sh: --only requires a pattern" >&2
        exit 2
      fi
      ONLY="$2"
      shift 2
      ;;
    --coverage)
      COVERAGE=1
      shift
      ;;
    --no-ui)
      UI=0
      shift
      ;;
    --no-e2e)
      E2E=0
      shift
      ;;
    -h|--help)
      sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "verify.sh: unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [ ! -d node_modules ]; then
  echo "verify.sh: node_modules missing; run 'npm install' first" >&2
  exit 2
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
FAIL=0

echo "== typecheck (tsc --noEmit) =="
if npx --no-install tsc --noEmit; then
  echo "typecheck: ok"
else
  echo "typecheck: FAILED" >&2
  FAIL=1
fi

# --- web UI: its own package (ui/), its own tiers; counted and held to zero skipped like the root tiers ---
# Prints "<label> passed/total" from a JSON report; returns nonzero on any failure or skip. $1 = vitest|playwright.
ui_report() {
  node - "$1" "$2" "$3" <<'NODE'
const fs = require('node:fs');
const [, , kind, file, label] = process.argv;
let r;
try { r = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { console.error(`${label}: no report produced`); process.exit(1); }
let passed, failed, skipped, total;
if (kind === 'vitest') {
  passed = r.numPassedTests; failed = r.numFailedTests; skipped = r.numPendingTests + r.numTodoTests;
  total = r.numTotalTests; failed += (r.testResults ?? []).filter((s) => s.status === 'failed' && (s.assertionResults ?? []).length === 0).length;
} else {
  passed = r.stats.expected; failed = r.stats.unexpected + r.stats.flaky; skipped = r.stats.skipped; total = passed + failed + skipped;
}
console.log(`${label.padEnd(12)} ${passed}/${total} passed` + (failed ? `, ${failed} FAILED` : '') + (skipped ? `, ${skipped} SKIPPED` : ''));
if (failed || skipped || total === 0) { if (skipped) console.error(`${label}: a skipped test proves nothing, so this fails`); process.exit(1); }
NODE
}

UI_COUNTS=""
if [ "$UI" -eq 1 ] && [ -z "$ONLY" ]; then
  echo
  echo "== web UI (ui/) =="
  if [ ! -d ui/node_modules ]; then
    echo "verify.sh: ui/node_modules missing; run 'npm run ui:install' first (or pass --no-ui)" >&2
    FAIL=1
  else
    (cd ui && npx --no-install tsc --noEmit) && echo "ui typecheck: ok" || { echo "ui typecheck: FAILED" >&2; FAIL=1; }
    (cd ui && npx --no-install stylelint "src/**/*.css") && echo "ui css lint (no raw colors in components): ok" || { echo "ui css lint: FAILED" >&2; FAIL=1; }
    (cd ui && node scripts/gen-api.mjs --check) && echo "ui generated API types and operation manifest: in sync" || { echo "ui gen-api drift: FAILED" >&2; FAIL=1; }
    (cd ui && node scripts/licenses.mjs --check) || { echo "ui license audit: FAILED" >&2; FAIL=1; }
    # vitest's global setup builds ui/dist (production) first; the build itself fails on a bad theme or contrast pair.
    (cd ui && npx --no-install vitest run --reporter=default --reporter=json "--outputFile.json=$TMP/ui-results.json")
    [ $? -eq 0 ] || FAIL=1
    ui_report vitest "$TMP/ui-results.json" "ui" || FAIL=1
  fi
fi

echo
echo "== build (tsc -p tsconfig.build.json: dist/ for the bundle scan and the e2e server) =="
# The security tier's bundle scan loads the confidentiality filter from dist/, which is gitignored. Build it here so the
# tests never run against a missing or stale dist/ (vitest's global setup also rebuilds a stale one for a bare `npm test`).
if npx --no-install tsc -p tsconfig.build.json; then
  echo "build: ok"
else
  echo "build: FAILED" >&2
  FAIL=1
fi

echo
echo "== tests =="
VITEST_ARGS=(run --reporter=default --reporter=json "--outputFile.json=$TMP/results.json")
if [ "$COVERAGE" -eq 1 ]; then
  VITEST_ARGS+=(--coverage)
fi
if [ -n "$ONLY" ]; then
  VITEST_ARGS+=("$ONLY")
fi
npx --no-install vitest "${VITEST_ARGS[@]}"
VITEST_RC=$?
if [ "$VITEST_RC" -ne 0 ]; then
  FAIL=1
fi

echo
echo "== per-tier counts =="
if [ -f "$TMP/results.json" ]; then
  COVERAGE="$COVERAGE" node - "$TMP/results.json" "$ROOT" "${TIERS[@]}" <<'NODE' || FAIL=1
const fs = require('node:fs');
const path = require('node:path');
const [, , file, root, ...tiers] = process.argv;
const report = JSON.parse(fs.readFileSync(file, 'utf8'));
const counts = Object.fromEntries(tiers.map((t) => [t, { total: 0, passed: 0, failed: 0, skipped: 0 }]));
counts.other = { total: 0, passed: 0, failed: 0, skipped: 0 };
const coverageRun = process.env.COVERAGE === '1';
for (const suite of report.testResults ?? []) {
  const rel = path.relative(root, suite.name).split(path.sep);
  const tier = rel[0] === 'tests' && tiers.includes(rel[1]) ? rel[1] : 'other';
  for (const t of suite.assertionResults ?? []) {
    counts[tier].total += 1;
    if (t.status === 'passed') counts[tier].passed += 1;
    else if (t.status === 'failed') counts[tier].failed += 1;
    else counts[tier].skipped += 1; // skipped, todo, pending
  }
  // A suite that failed to load has no assertions but is still a failure.
  if (suite.status === 'failed' && (suite.assertionResults ?? []).length === 0) {
    counts[tier].total += 1;
    counts[tier].failed += 1;
  }
}
let bad = false;
let skipped = 0;
for (const [tier, c] of Object.entries(counts)) {
  if (tier === 'other' && c.total === 0) continue;
  const line =
    c.total === 0
      ? '0 tests'
      : `${c.passed}/${c.total} passed` + (c.failed ? `, ${c.failed} FAILED` : '') + (c.skipped ? `, ${c.skipped} SKIPPED` : '');
  console.log(`${tier.padEnd(12)} ${line}`);
  if (c.failed) bad = true;
  skipped += c.skipped;
}
if (skipped > 0 && !coverageRun) {
  console.error(`verify.sh: ${skipped} test(s) skipped outside --coverage mode; a skipped test proves nothing, so this fails`);
  bad = true;
} else if (skipped > 0) {
  console.log(`skipped: ${skipped} (allowed under --coverage: the wall-clock chunker test opts out)`);
} else {
  console.log('skipped: 0');
}
process.exit(bad ? 1 : 0);
NODE
else
  echo "no test report produced (vitest exit code $VITEST_RC)" >&2
  FAIL=1
fi

if [ "$UI" -eq 1 ] && [ "$E2E" -eq 1 ] && [ -z "$ONLY" ] && [ -d ui/node_modules ]; then
  echo
  echo "== web UI end-to-end (Playwright: visual, a11y with contrast, offline, CSP, themes) =="
  # The suite drives the real `ghostwriter serve` from dist/, built above.
  if [ -f dist/src/index.js ]; then
    if [ "${GW_E2E_CONTAINER:-0}" = "1" ]; then
      PLAYWRIGHT_JSON_OUTPUT_NAME="$TMP/e2e.json" ui/scripts/e2e-container.sh --reporter=json || FAIL=1
    else
      (cd ui && PLAYWRIGHT_JSON_OUTPUT_NAME="$TMP/e2e.json" npx --no-install playwright test --reporter=json >/dev/null 2>"$TMP/e2e.err") || { cat "$TMP/e2e.err" >&2; FAIL=1; }
    fi
    ui_report playwright "$TMP/e2e.json" "ui e2e" || FAIL=1
  else
    echo "dist/ is missing: the root build above failed, so the e2e server cannot start" >&2
    FAIL=1
  fi
fi

echo
if [ "$FAIL" -eq 0 ]; then
  echo "verify: PASS"
else
  echo "verify: FAIL" >&2
fi
exit "$FAIL"
