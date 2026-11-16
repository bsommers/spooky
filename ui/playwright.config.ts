import { defineConfig } from '@playwright/test';
import { E2E_TOKEN, TOKEN_ENV } from './tests/e2e/server/constants.mjs';

// End-to-end and visual tests run against the REAL server (`ghostwriter serve`) with the built UI, on a fixed viewport,
// animations off, fonts awaited. Baselines are committed PNGs generated in a pinned container: see docs/UI.md.
const PORT = Number(process.env.GW_E2E_PORT ?? 4873);
/** The second server requires a bearer token (tests/e2e/token.spec.ts); everything else runs against the first, which does not. */
const TOKEN_PORT = PORT + 1;

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
  webServer: [
    {
      // the real API server and built UI, with the model scripted (MockLlmClient) and one author ingested; see tests/e2e/server/start.mjs
      command: `node tests/e2e/server/start.mjs --port ${PORT} --state-dir ${process.env.GW_E2E_STATE ?? '.e2e-state'}`,
      url: `http://127.0.0.1:${PORT}/`,
      reuseExistingServer: false,
      stdout: 'ignore',
      stderr: 'ignore',
      timeout: 30_000,
    },
    {
      // the same server with a bearer token required and a short lockout, for the 401 / 429 flows in a real browser
      command: `node tests/e2e/server/start.mjs --port ${TOKEN_PORT} --state-dir ${process.env.GW_E2E_STATE ?? '.e2e-state'}-token --token-env ${TOKEN_ENV} --lockout-failures 5`,
      url: `http://127.0.0.1:${TOKEN_PORT}/`,
      env: { [TOKEN_ENV]: E2E_TOKEN },
      reuseExistingServer: false,
      stdout: 'ignore',
      stderr: 'ignore',
      timeout: 30_000,
    },
  ],
});
