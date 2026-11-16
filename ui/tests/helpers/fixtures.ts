// Deterministic API documents for the component, accessibility and visual tiers. Pure data (no test-runner imports), so
// vitest and Playwright share them. Timings are fixed numbers; nothing here depends on the clock or the machine.
const op = (name: string, method: 'GET' | 'POST', path: string, mutates = false) => ({
  name,
  description: `${name} operation`,
  mutates,
  http: { method, path },
  cli: `ghostwriter ${name}`,
  mcpTool: name,
});

const BASE_OPS = [
  op('ingest', 'POST', '/api/ingest', true),
  op('generate', 'POST', '/api/generate'),
  op('profile', 'GET', '/api/profile'),
  op('authors', 'GET', '/api/authors'),
  op('personas', 'GET', '/api/personas'),
  op('filters', 'GET', '/api/filters'),
  op('config_get', 'GET', '/api/config'),
  op('capabilities', 'GET', '/api/capabilities'),
];
const PHASE8_OPS = [op('score', 'POST', '/api/score'), op('humanize', 'POST', '/api/humanize')];

export const CAPS_FULL = { ok: true, operations: [...BASE_OPS, ...PHASE8_OPS], pending: [] };
export const CAPS_NO_PHASE8 = { ok: true, operations: BASE_OPS, pending: [{ name: 'humanize', phase: 8, summary: 'planned' }] };

export const PROFILE_TERSE = {
  authorId: 'terse',
  displayName: 'Terse Author',
  avgSentenceLength: 11.4,
  sentenceLengthStdDev: 4.2,
  lexicalDensityRatio: 0.61,
  preferredPunctuation: ['.', ',', ';'],
  hedgingFrequency: 0.8,
  activePassiveRatio: 0.92,
  commonTransitionWords: ['however', 'therefore', 'then'],
  vectorCollectionName: 'author_terse',
  corpusWordCount: 4210,
};
export const PROFILE_LONG = {
  ...PROFILE_TERSE,
  authorId: 'long-form',
  displayName: 'Long Form',
  avgSentenceLength: 27.9,
  sentenceLengthStdDev: 11.3,
  lexicalDensityRatio: 0.42,
  preferredPunctuation: [',', '-', ':'],
  hedgingFrequency: 2.1,
  activePassiveRatio: 0.71,
  commonTransitionWords: ['moreover', 'meanwhile'],
  vectorCollectionName: 'author_long_form',
  corpusWordCount: 18890,
};
export const AUTHORS = { ok: true, authors: [PROFILE_TERSE, PROFILE_LONG] };

export const PERSONAS = {
  ok: true,
  personas: [
    { key: 'exec', name: 'Executive', cognitiveLoad: 'low', informationDensity: 'medium', structuralMandates: ['lead with the decision', 'one idea per paragraph'], bannedPhrases: ['synergy', 'circle back'] },
    { key: 'engineer', name: 'Engineer', cognitiveLoad: 'high', informationDensity: 'high', structuralMandates: [], bannedPhrases: [] },
  ],
};

export const FILTERS = {
  ok: true,
  filters: [
    { name: 'confidentiality', stage: 'pre', onError: 'fail-closed', enabled: true },
    { name: 'style', stage: 'post', onError: 'skip', enabled: true },
    { name: 'confidentiality', stage: 'post', onError: 'fail-closed', enabled: true },
  ],
};

export const CONFIG = {
  ok: true,
  config: {
    llm: { provider: 'anthropic', model: 'claude-example', maxTokens: 1500, temperature: 0.7, maxRetries: 2, apiKeyEnv: 'GW_E2E_FAKE_KEY', apiKeyEnvSet: true },
    limits: { maxInputChars: 5000 },
    chunk: { size: 800, overlap: 100 },
    filters: FILTERS.filters,
    personas: ['exec', 'engineer'],
    confidentiality: { blocklistTerms: 3, customRules: 1 },
    scorer: { localWeight: 1, weights: { punctuation: 0.5 }, detectors: [] },
    humanize: { targetScore: 0.3, maxIterations: 3 },
  },
};

export interface TraceFx {
  filter: string;
  modified: boolean;
  ms: number;
  metadata: Record<string, string | number | boolean>;
  error?: string;
}
export const TRACE: TraceFx[] = [
  { filter: 'confidentiality', modified: true, ms: 1.25, metadata: { email: 1, api_key: 0 } },
  { filter: 'llm', modified: true, ms: 120.75, metadata: { attempts: 1, exemplars: 2, chars: 76 } },
  { filter: 'style', modified: true, ms: 3.5, metadata: { phrases_removed: 2, phrases_replaced: 1, rhythm: 'applied' } },
  { filter: 'confidentiality', modified: false, ms: 0.5, metadata: {} },
];

export const GENERATE_OK = {
  ok: true,
  text: 'The decision is made. Ship it on Friday.\nQuestions go to the release owner.',
  trace: TRACE,
  promptTokensEstimate: 412,
};

export const SCORE_OK = {
  ok: true,
  score: 0.62,
  local: {
    score: 0.62,
    features: {
      punctuation_variety: { value: 0.31, weight: 0.54, contribution: 0.17 },
      sentence_length_variance: { value: 0.12, weight: 0.2, contribution: 0.024 },
      hedging: { value: 0.0, weight: 0.1, contribution: 0 },
    },
    flags: ['uniform-sentences'],
    stats: { words: 120, sentences: 8, paragraphs: 2 },
  },
  members: [{ name: 'local', score: 0.62, weight: 1 }],
  excluded: [],
  trace: [TRACE[0]],
  localOnly: true,
};

export const HUMANIZE_CAVEAT_TEXT =
  'Scores are from the local heuristic, a weak and confounded proxy (held-out AUC 0.694, docs/CALIBRATION.md), not a detector verdict. A lower score is not evidence that any real detector would pass the text. No external detector has been tested (docs/HUMANIZING.md).';

export const HUMANIZE_OK = {
  ok: true,
  text: 'Shorter now. The numbers, 42 and 7.5, are unchanged.',
  initialScore: 0.62,
  finalScore: 0.28,
  reachedTarget: true,
  iterations: 2,
  llmCalls: 1,
  guardRejections: 1,
  featureDeltas: { punctuation_variety: -0.12, sentence_length_variance: 0.05 },
  featuresBefore: { punctuation_variety: 0.31, sentence_length_variance: 0.12 },
  featuresAfter: { punctuation_variety: 0.19, sentence_length_variance: 0.17 },
  steps: [
    { iteration: 1, step: 'deterministic', features: ['punctuation_variety'], scoreBefore: 0.62, scoreAfter: 0.41, kept: true, outcome: 'improved', redacted: false, guard: [], featureDeltas: { punctuation_variety: -0.12 } },
    { iteration: 2, step: 'llm', features: ['sentence_length_variance'], scoreBefore: 0.41, scoreAfter: 0.3, kept: false, outcome: 'guard_rejected', redacted: false, guard: ['number 7.5 changed'], featureDeltas: {} },
  ],
  trace: [TRACE[0]],
  caveat: HUMANIZE_CAVEAT_TEXT,
};

export const ERR = (code: string, message: string) => ({ ok: false, error: { code, message } });
export const INGEST_OK = { ok: true, profile: { ...PROFILE_TERSE, authorId: 'new-author', displayName: 'New Author' } };

/** Hostile strings a model, a corpus or a config could carry. The UI must show every one of them as literal text. */
export const HOSTILE = {
  img: '<img src=x onerror="window.__pwned=1">',
  script: '<script>window.__pwned=1</script>',
  link: '[click](javascript:window.__pwned=1) javascript:window.__pwned=1',
  mixed: '<b>bold</b> &amp; <a href="javascript:alert(1)">x</a>',
};

export interface Reply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}
export type Overrides = Partial<Record<string, (init: { method: string; url: string; body: unknown }) => Reply>>;

/** The mock server. `overrides` is keyed by "METHOD /path". */
export function respond(method: string, url: string, body: unknown, overrides: Overrides = {}): Reply {
  const path = url.split('?')[0] ?? url;
  const key = `${method} ${path}`;
  const o = overrides[key];
  if (o !== undefined) return o({ method, url, body });
  switch (key) {
    case 'GET /api/capabilities':
      return { status: 200, body: CAPS_FULL };
    case 'GET /api/authors':
      return { status: 200, body: AUTHORS };
    case 'GET /api/personas':
      return { status: 200, body: PERSONAS };
    case 'GET /api/filters':
      return { status: 200, body: FILTERS };
    case 'GET /api/config':
      return { status: 200, body: CONFIG };
    case 'GET /api/profile': {
      const id = new URL(url, 'http://x').searchParams.get('authorId');
      const p = id === 'long-form' ? PROFILE_LONG : id === 'new-author' ? INGEST_OK.profile : PROFILE_TERSE;
      return { status: 200, body: { ok: true, profile: p } };
    }
    case 'POST /api/generate':
      return { status: 200, body: GENERATE_OK };
    case 'POST /api/score':
      return { status: 200, body: SCORE_OK };
    case 'POST /api/humanize':
      return { status: 200, body: HUMANIZE_OK };
    case 'POST /api/ingest':
      return { status: 200, body: INGEST_OK };
    default:
      return { status: 404, body: ERR('NOT_FOUND', 'no such route') };
  }
}
