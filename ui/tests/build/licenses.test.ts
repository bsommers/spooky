// License tier: THIRD_PARTY.md is generated and current, every production dependency and font has an allowed license,
// every bundled font ships its license file, and the audit demonstrably fails on a disallowed license.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { auditProblems, classifyLicense, collectProductionPackages, inspectFonts, renderThirdParty } from '../../build/licenses.mjs';
import { UI_ROOT } from '../helpers/themes';

describe('classifyLicense', () => {
  it('accepts the permissive licenses and SPDX expressions with an acceptable choice', () => {
    for (const ok of ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', 'OFL-1.1', '0BSD', '(MIT OR GPL-3.0-only)', 'MIT AND Apache-2.0', '(BSD-2-Clause OR MIT OR Apache-2.0)']) {
      expect(classifyLicense(ok).ok, ok).toBe(true);
    }
  });
  it('rejects GPL/AGPL/LGPL, unknown, missing, custom and "see license" values, and an AND with one bad side', () => {
    for (const bad of ['GPL-3.0', 'GPL-2.0-only', 'AGPL-3.0-or-later', 'LGPL-2.1', 'SSPL-1.0', 'UNKNOWN', 'UNLICENSED', '', 'SEE LICENSE IN LICENSE.md', 'Custom: https://example.com', 'MIT AND GPL-3.0', 'GPL-3.0 OR AGPL-3.0', 'Proprietary']) {
      expect(classifyLicense(bad).ok, bad).toBe(false);
    }
  });
});

describe('classifyLicense: parenthesised expressions', () => {
  it('judges AND and OR by the real expression structure, not by stripping parentheses', () => {
    const bad = ['(MIT OR GPL-3.0) AND LGPL-3.0', '(MIT OR Apache-2.0) AND GPL-3.0', 'MIT AND (GPL-3.0 OR AGPL-3.0)', '(MIT', 'MIT)', 'MIT OR', 'AND MIT', '()'];
    for (const b of bad) expect(classifyLicense(b).ok, b).toBe(false);
    expect(classifyLicense('(MIT OR GPL-3.0) AND LGPL-3.0').reason).toMatch(/"LGPL-3.0" is not an allowed license/);
    const good = ['(MIT OR GPL-3.0) AND Apache-2.0', 'MIT AND (GPL-3.0 OR ISC)', '((MIT))', 'MIT OR GPL-3.0 AND LGPL-3.0', 'Apache-2.0 WITH LLVM-exception'];
    for (const g of good) expect(classifyLicense(g).ok, g).toBe(true);
  });
});

describe('production dependencies', () => {
  const packages = collectProductionPackages(UI_ROOT);
  const fonts = inspectFonts(UI_ROOT);

  it('includes React Aria Components under Apache-2.0 and no dev-only tooling', () => {
    const names = packages.map((p) => p.name);
    expect(packages.find((p) => p.name === 'react-aria-components')?.license).toBe('Apache-2.0');
    for (const dev of ['vite', 'vitest', 'playwright', '@playwright/test', 'axe-core', 'jsdom', 'stylelint', 'typescript']) expect(names, dev).not.toContain(dev);
  });

  it('zod is build/test-time only: not a production dependency, not in the audit, and no shipped source imports it as a value', () => {
    const pkg = JSON.parse(readFileSync(join(UI_ROOT, 'package.json'), 'utf8')) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies)).not.toContain('zod');
    expect(Object.keys(pkg.devDependencies)).toContain('zod');
    expect(packages.map((p) => p.name)).not.toContain('zod');
    // The theme contract is the one module that uses zod (build and tests); the app must only ever import its types.
    const offenders = readdirSync(join(UI_ROOT, 'src'), { recursive: true, encoding: 'utf8' })
      .filter((f) => /\.(ts|tsx)$/.test(f) && f !== join('theme', 'contract.ts'))
      .filter((f) => /^import\s+(?!type\b)[^;]*from\s+['"](zod|\.{1,2}\/(?:[^'"]*\/)?theme\/contract|\.\/contract)['"]/m.test(readFileSync(join(UI_ROOT, 'src', f), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('every production package has an allowed license and the audit reports no problem', () => {
    expect(auditProblems(packages, fonts.problems)).toEqual([]);
    expect(packages.every((p) => p.license !== 'UNKNOWN')).toBe(true);
  });

  it('the audit fails on a GPL package or an unknown license', () => {
    const tainted = [...packages, { name: 'left-pad-gpl', version: '1.0.0', license: 'GPL-3.0', hasLicenseFile: true }, { name: 'mystery', version: '0.0.1', license: 'UNKNOWN', hasLicenseFile: false }];
    const problems = auditProblems(tainted, []);
    expect(problems.join('\n')).toMatch(/left-pad-gpl@1.0.0: "GPL-3.0" is not an allowed license/);
    expect(problems.join('\n')).toMatch(/mystery@0.0.1/);
  });

  it('THIRD_PARTY.md is generated from the lock file and is current', () => {
    const committed = readFileSync(join(UI_ROOT, 'THIRD_PARTY.md'), 'utf8');
    expect(committed).toBe(renderThirdParty(packages, fonts.fonts));
    expect(committed).toContain('react-aria-components');
    expect(committed).toContain('@fontsource-variable/orbitron');
  });
});

describe('fonts', () => {
  it('every font family in fonts.css is an OFL-1.1 package whose LICENSE file exists and is the SIL OFL', () => {
    const { fonts, problems } = inspectFonts(UI_ROOT);
    expect(problems).toEqual([]);
    expect(fonts.map((f) => f.pkg)).toEqual(['@fontsource-variable/fraunces', '@fontsource-variable/inter', '@fontsource-variable/jetbrains-mono', '@fontsource-variable/orbitron']);
  });

  it('each license file is copied into the build next to the fonts, and the bundled packages\' licenses are listed', () => {
    for (const name of ['fraunces', 'inter', 'jetbrains-mono', 'orbitron']) {
      const f = join(UI_ROOT, 'dist', 'licenses', `${name}-OFL.txt`);
      expect(existsSync(f), f).toBe(true);
      expect(readFileSync(f, 'utf8')).toMatch(/SIL OPEN FONT LICENSE/i);
    }
    const bundled = readFileSync(join(UI_ROOT, 'dist', 'licenses', 'THIRD_PARTY_LICENSES.md'), 'utf8');
    expect(bundled).toContain('react-aria-components');
    expect(bundled).toMatch(/Apache License/);
  });

  function scratchFonts(opts: { license?: string; licenseFile?: string | null; css?: string }): string {
    const root = mkdtempSync(join(tmpdir(), 'gw-lic-'));
    const pkg = join(root, 'node_modules', '@fontsource-variable', 'fake');
    mkdirSync(join(pkg, 'files'), { recursive: true });
    writeFileSync(join(pkg, 'files', 'fake-latin-wght-normal.woff2'), 'wOF2');
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@fontsource-variable/fake', license: opts.license ?? 'OFL-1.1' }));
    if (opts.licenseFile !== null) writeFileSync(join(pkg, 'LICENSE'), opts.licenseFile ?? 'SIL OPEN FONT LICENSE Version 1.1');
    mkdirSync(join(root, 'src', 'assets'), { recursive: true });
    writeFileSync(join(root, 'src', 'assets', 'fonts.css'), opts.css ?? '@font-face { src: url(../../node_modules/@fontsource-variable/fake/files/fake-latin-wght-normal.woff2) format("woff2"); }');
    return root;
  }

  it('a font without a license file fails the audit (the test the plan asks for)', () => {
    expect(inspectFonts(scratchFonts({})).problems).toEqual([]);
    expect(inspectFonts(scratchFonts({ licenseFile: null })).problems.join('\n')).toMatch(/no LICENSE file/);
  });
  it('a font that is not OFL, or whose LICENSE is some other text, fails', () => {
    expect(inspectFonts(scratchFonts({ license: 'GPL-3.0' })).problems.join('\n')).toMatch(/expected OFL-1.1/);
    expect(inspectFonts(scratchFonts({ licenseFile: 'All rights reserved.' })).problems.join('\n')).toMatch(/not the SIL Open Font License/);
  });
  it('a font file that does not come from a package (vendored, hot-linked) fails because no license can be checked', () => {
    expect(inspectFonts(scratchFonts({ css: '@font-face { src: url(./local-font.woff2) format("woff2"); }' })).problems.join('\n')).toMatch(/does not come from a package/);
  });
});
