import { defineConfig } from '@playwright/test';

// End-to-end and visual tests run against the REAL server (`ghostwriter serve`) with the built UI, on a fixed viewport,
// animations off, fonts awaited. Baselines are committed PNGs generated in a pinned container: see docs/UI.md.
const PORT = Number(process.env.GW_E2E_PORT ?? 4873);

export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: 'test-results',
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFilePath}/{arg}{ext}',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: [['list']],
  timeout: 30_000,
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.002, animations: 'disabled', caret: 'hide' } },
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    colorScheme: 'dark',
    reducedMotion: 'no-preference',
    locale: 'en-US',
    timezoneId: 'UTC',
  },
  webServer: {
    command: `node ../dist/src/cli/bin.js serve --port ${PORT} --state-dir ${process.env.GW_E2E_STATE ?? '.e2e-state'}`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: false,
    stdout: 'ignore',
    stderr: 'ignore',
    timeout: 30_000,
  },
});
