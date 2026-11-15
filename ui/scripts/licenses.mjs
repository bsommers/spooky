// `node scripts/licenses.mjs`         regenerate THIRD_PARTY.md (and fail on a disallowed license)
// `node scripts/licenses.mjs --check` fail if THIRD_PARTY.md is stale or any license is not allowed
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditProblems, collectProductionPackages, inspectFonts, renderThirdParty } from '../build/licenses.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packages = collectProductionPackages(root);
const { fonts, problems: fontProblems } = inspectFonts(root);
const problems = auditProblems(packages, fontProblems);
const doc = renderThirdParty(packages, fonts);
const file = resolve(root, 'THIRD_PARTY.md');

if (problems.length > 0) {
  console.error(`licenses: ${problems.length} problem(s):\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
if (process.argv.includes('--check')) {
  let have = '';
  try {
    have = readFileSync(file, 'utf8');
  } catch {
    /* missing is stale */
  }
  if (have !== doc) {
    console.error('licenses: THIRD_PARTY.md is stale; run "npm run licenses" in ui/');
    process.exit(1);
  }
  console.log(`licenses: ok (${packages.length} production packages, ${fonts.length} font packages)`);
} else {
  writeFileSync(file, doc);
  console.log(`licenses: wrote THIRD_PARTY.md (${packages.length} production packages, ${fonts.length} font packages)`);
}
