#!/usr/bin/env bash
# Verification gate: typecheck, then every test tier, with per-tier counts.
#
#   scripts/verify.sh                   run everything
#   scripts/verify.sh --only <pattern>  run only test files whose path matches <pattern>
#   scripts/verify.sh --coverage        also enforce the coverage gate (src/filters, src/registry >= 90% lines)
#
# Tiers (tests/<tier>/): smoke unit integration system security torture.
# A tier directory that does not exist yet reports "0 tests"; it is not an error.
# Exits nonzero if the typecheck fails, any test fails, or --only matches nothing.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 2

TIERS=(smoke unit integration system security torture)
ONLY=""
COVERAGE=0

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
    -h|--help)
      sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
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

echo
if [ "$FAIL" -eq 0 ]; then
  echo "verify: PASS"
else
  echo "verify: FAIL" >&2
fi
exit "$FAIL"
