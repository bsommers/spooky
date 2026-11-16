// The server the end-to-end specs run against: the REAL API server and the REAL built UI, with the model replaced by the
// library's MockLlmClient (a fixed answer) and an author already ingested. No network, no key: a canary value stands in
// for the provider key in the environment, so the specs can prove it never reaches the browser.
//
//   node tests/e2e/server/start.mjs --port 4873 --state-dir .e2e-state
//   node tests/e2e/server/start.mjs --port 4874 --state-dir .e2e-state-token --token-env GW_E2E_TOKEN --lockout-failures 5
//     the second form requires a bearer token (read from that environment variable, like `ghostwriter serve --token-env`) and
//     locks an address out after a few wrong ones, so the specs can drive the 401 and 429 paths in a real browser.
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { KEY_ENV, MODEL_ANSWER, PLANTED_KEY } from './constants.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..', '..');
const dist = (p) => import(pathToFileURL(join(root, 'dist', 'src', p)).href);
const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? dflt : process.argv[i + 1];
};

const tokenEnv = arg('--token-env', undefined);
const token = tokenEnv === undefined ? undefined : process.env[tokenEnv];
if (tokenEnv !== undefined && (token === undefined || token === '')) throw new Error(`--token-env ${tokenEnv}: the variable is not set`);
const lockoutFailures = Number(arg('--lockout-failures', '20'));

const { Engine, MockLlmClient, loadConfig } = await dist('index.js');
const { startApiServer } = await dist('api/server.js');
const { createStaticHandler } = await dist('api/static.js');
const { ServiceRuntime } = await dist('service/runtime.js');

const port = Number(arg('--port', '4873'));
const stateDir = resolve(arg('--state-dir', '.e2e-state'));
rmSync(stateDir, { recursive: true, force: true });
mkdirSync(stateDir, { recursive: true });

const config = loadConfig({
  llm: { provider: 'anthropic', model: 'mock-model', apiKeyEnv: KEY_ENV },
  limits: { maxInputChars: 5000 },
  personas: [
    { key: 'exec', name: 'Executive', cognitiveLoad: 'low', informationDensity: 'medium', structuralMandates: ['lead with the decision'], bannedPhrases: ['synergy'] },
    { key: 'engineer', name: 'Engineer', cognitiveLoad: 'high', informationDensity: 'high', structuralMandates: [], bannedPhrases: [] },
  ],
});
const llm = new MockLlmClient(() => MODEL_ANSWER);
const engine = await Engine.create({ config, stateDir, llm, env: { [KEY_ENV]: PLANTED_KEY }, retry: { baseMs: 0, sleep: async () => undefined } });
await engine.ingest('terse', 'Terse Author', readFileSync(join(root, 'tests', 'fixtures', 'authors', 'terse-technical.txt'), 'utf8'));
const runtime = new ServiceRuntime(engine, { stateDir });
await runtime.markLoaded();
const staticHandler = await createStaticHandler({ root: join(root, 'ui', 'dist') });
const server = await startApiServer({
  runtime,
  port,
  staticHandler,
  log: () => undefined,
  ...(token === undefined ? {} : { token, authThrottle: { freeFailures: 2, baseDelayMs: 10, maxDelayMs: 40, lockoutFailures, windowMs: 60_000, lockoutMs: 5_000 } }),
});
process.stderr.write(`e2e server on ${server.url}\n`);
for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => void server.close().then(() => process.exit(0)));
