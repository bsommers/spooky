// Zod schemas shared by every surface: input field rules (untrusted on HTTP and MCP) and output shapes.
// The output schemas document and test the data every surface returns; they are the source of the OpenAPI and MCP
// output schemas. Inputs are strict objects: an unknown field is an error, never ignored.
import { z } from 'zod';
import { MAX_HUMANIZE_ITERATIONS } from '../../config/humanize.js';
import { GENERATE_MODES, TOPIC_LENGTHS } from '../../config/topic.js';
import { AUTHOR_ID, MAX_DISPLAY_NAME } from '../registry/profileFile.js';

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;
// eslint-disable-next-line no-control-regex
const NUL = /\u0000/;

/** An id-like token (persona key, detector name): short, no whitespace, no control characters. */
const token = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((v) => !CONTROL.test(v), { error: 'must not contain control characters' })
    .refine((v) => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(v), { error: 'may contain only letters, digits, ".", "_" and "-"' });

export const authorIdSchema = z
  .string()
  .regex(AUTHOR_ID, { error: 'authorId must be 1-64 characters: letters, digits, ".", "_" or "-", starting with a letter or digit' });

export const displayNameSchema = z
  .string()
  .min(1)
  .max(MAX_DISPLAY_NAME)
  .refine((v) => v.trim() !== '', { error: 'must not be blank' })
  .refine((v) => !CONTROL.test(v), { error: 'must not contain control characters' });

export const personaKeySchema = token(64);
export const detectorNameSchema = token(40);

/** Free text (a corpus, a draft). Length limits are the engine's (`limits.maxInputChars`, `maxCorpusChars`); a NUL byte is never text. */
export const textSchema = z.string().refine((v) => !NUL.test(v), { error: 'must not contain NUL characters' });

// ---------- inputs ----------
export const emptyInput = z.strictObject({});
export const ingestInput = z.strictObject({ authorId: authorIdSchema, name: displayNameSchema, text: textSchema });
export const generateInput = z.strictObject({
  authorId: authorIdSchema,
  persona: personaKeySchema,
  /** The draft to rewrite (mode `rewrite`, the default) or the topic to write about (mode `topic`). */
  text: textSchema,
  /** `rewrite` (default): `text` is a draft. `topic`: `text` is a subject and the model writes NEW text about it. No web research. */
  mode: z.enum(GENERATE_MODES).optional(),
  /** Topic mode only: facts and source material the caller supplies. Capped like `text` (`limits.maxInputChars`), redacted like it. */
  notes: textSchema.optional(),
  /** Topic mode only: the length to aim for. */
  length: z.enum(TOPIC_LENGTHS).optional(),
  exemplars: z.number().int().min(0).max(20).optional(),
  maxTokens: z.number().int().min(1).max(200_000).optional(),
  temperature: z.number().min(0).max(1).optional(),
  /** Phase 8: run the humanizer loop on the generated text. */
  humanize: z.boolean().optional(),
  /** Phase 8: humanizer target score (needs `humanize`). */
  target: z.number().min(0).max(1).optional(),
})
  .refine((v) => v.target === undefined || v.humanize === true, { error: 'target needs humanize: true', path: ['target'] })
  .refine((v) => v.notes === undefined || v.mode === 'topic', { error: 'notes need mode "topic"', path: ['notes'] })
  .refine((v) => v.length === undefined || v.mode === 'topic', { error: 'length needs mode "topic"', path: ['length'] });
export const profileInput = z.strictObject({ authorId: authorIdSchema });
export const humanizeInput = z.strictObject({
  text: textSchema,
  authorId: authorIdSchema.optional(),
  target: z.number().min(0).max(1).optional(),
  maxIterations: z.number().int().min(0).max(MAX_HUMANIZE_ITERATIONS).optional(),
  /** `false`: deterministic edits only, no model call. */
  llm: z.boolean().optional(),
});
export const scoreInput = z.strictObject({ text: textSchema, detectors: z.array(detectorNameSchema).max(16).optional() });

// ---------- outputs ----------
export const profileSchema = z.object({
  authorId: z.string(),
  displayName: z.string(),
  avgSentenceLength: z.number(),
  sentenceLengthStdDev: z.number(),
  lexicalDensityRatio: z.number(),
  preferredPunctuation: z.array(z.string()),
  hedgingFrequency: z.number(),
  activePassiveRatio: z.number(),
  commonTransitionWords: z.array(z.string()),
  vectorCollectionName: z.string(),
  corpusWordCount: z.number(),
});

export const traceEntrySchema = z.object({
  filter: z.string(),
  modified: z.boolean(),
  ms: z.number(),
  metadata: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])),
  error: z.string().optional(),
});

export const personaSchema = z.object({
  key: z.string(),
  name: z.string(),
  cognitiveLoad: z.string(),
  informationDensity: z.string(),
  structuralMandates: z.array(z.string()),
  bannedPhrases: z.array(z.string()),
});

export const filterSpecSchema = z.object({
  name: z.string(),
  stage: z.enum(['pre', 'post', 'both']),
  onError: z.enum(['fail-closed', 'skip']),
  enabled: z.boolean(),
});

export const scoreBreakdownSchema = z.object({
  score: z.number(),
  features: z.record(z.string(), z.object({ value: z.number(), weight: z.number(), contribution: z.number() })),
  flags: z.array(z.string()).optional(),
  stats: z.object({ words: z.number(), sentences: z.number(), paragraphs: z.number() }).optional(),
});

const detectorViewSchema = z.object({
  name: z.string(),
  host: z.string(),
  scheme: z.enum(['http', 'https']),
  apiKeyEnv: z.string().optional(),
  apiKeyEnvSet: z.boolean().optional(),
  weight: z.number(),
  timeoutMs: z.number(),
});

export const configViewSchema = z.object({
  llm: z.object({
    provider: z.enum(['anthropic', 'openai-compat']),
    model: z.string(),
    maxTokens: z.number(),
    temperature: z.number(),
    maxRetries: z.number(),
    baseUrlHost: z.string().optional(),
    apiKeyEnv: z.string().optional(),
    apiKeyEnvSet: z.boolean().optional(),
  }),
  limits: z.object({ maxInputChars: z.number() }),
  chunk: z.object({ size: z.number(), overlap: z.number() }),
  filters: z.array(filterSpecSchema),
  personas: z.array(z.string()),
  confidentiality: z.object({ blocklistTerms: z.number(), customRules: z.number() }),
  scorer: z.object({ localWeight: z.number(), weights: z.record(z.string(), z.number()), detectors: z.array(detectorViewSchema) }),
  humanize: z.object({ targetScore: z.number(), maxIterations: z.number() }),
  stateDir: z.string().optional(),
});

export const ingestOutput = z.object({ profile: profileSchema });
export const profileOutput = z.object({ profile: profileSchema });
export const authorsOutput = z.object({ authors: z.array(profileSchema) });
export const personasOutput = z.object({ personas: z.array(personaSchema) });
export const filtersOutput = z.object({ filters: z.array(filterSpecSchema) });
export const configOutput = z.object({ config: configViewSchema });
export const generateOutput = z.object({
  text: z.string(),
  trace: z.array(traceEntrySchema),
  promptTokensEstimate: z.number(),
  /** Which mode produced `text`. */
  mode: z.enum(GENERATE_MODES),
  /** Topic mode only, fixed text: facts are not verified (nothing was looked up). Absent in rewrite mode. */
  caveat: z.string().optional(),
});
export const scoreOutput = z.object({
  score: z.number(),
  local: scoreBreakdownSchema,
  members: z.array(z.object({ name: z.string(), score: z.number(), weight: z.number() })),
  excluded: z.array(z.object({ name: z.string(), reason: z.string() })),
  trace: z.array(traceEntrySchema),
  /** True when named detectors were requested, none answered, and `score` is the local heuristic alone. */
  localOnly: z.boolean().optional(),
});
const humanizeStepSchema = z.object({
  iteration: z.number(),
  step: z.enum(['deterministic', 'llm']),
  features: z.array(z.string()),
  scoreBefore: z.number(),
  scoreAfter: z.number(),
  kept: z.boolean(),
  outcome: z.enum(['improved', 'no_improvement', 'guard_rejected', 'llm_error']),
  redacted: z.boolean(),
  guard: z.array(z.string()),
  featureDeltas: z.record(z.string(), z.number()),
  error: z.string().optional(),
});
export const humanizeOutput = z.object({
  text: z.string(),
  initialScore: z.number(),
  finalScore: z.number(),
  reachedTarget: z.boolean(),
  iterations: z.number(),
  llmCalls: z.number(),
  guardRejections: z.number(),
  featureDeltas: z.record(z.string(), z.number()),
  featuresBefore: z.record(z.string(), z.number()),
  featuresAfter: z.record(z.string(), z.number()),
  steps: z.array(humanizeStepSchema),
  trace: z.array(traceEntrySchema),
  /** Fixed reminder, on every surface: what the scores are and are not. */
  caveat: z.string(),
});
export const capabilitiesOutput = z.object({
  operations: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      mutates: z.boolean(),
      http: z.object({ method: z.enum(['GET', 'POST']), path: z.string() }),
      cli: z.string(),
      mcpTool: z.string(),
    }),
  ),
  pending: z.array(z.object({ name: z.string(), phase: z.number(), summary: z.string() })),
});
