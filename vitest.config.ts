import { defineConfig } from 'vitest/config';

// Set for `vitest --coverage` runs so wall-clock-only tests can opt out (v8 instrumentation slows tight loops ~20x).
const coverageRun = process.argv.includes('--coverage');

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    env: { GHOSTWRITER_COVERAGE_RUN: coverageRun ? '1' : '0' },
    // Only active with `--coverage` (npm run coverage, scripts/verify.sh --coverage).
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/cli/bin.ts', 'src/**/*.d.ts'], // bin.ts is the 3-line shebang entry, exercised only by the spawned system test
      reporter: ['text-summary', 'text', 'json-summary'],
      reportsDirectory: 'coverage',
      // Phase 6 gate: the two extension surfaces must stay >= 90% on lines. Uncovered lines/branches are listed in
      // docs/AS-BUILT.md rather than lowering these numbers.
      thresholds: {
        'src/filters/**': { lines: 90 },
        'src/registry/**': { lines: 90 },
      },
    },
  },
});
