// zod schema for the engine config (FND-03). The Config TYPE is declared once in models/types.ts;
// load.ts proves at compile time that this schema's output is assignable to it.
import { z } from 'zod';
import { DEFAULT_CHUNK, DEFAULT_LIMITS, DEFAULT_LLM, MAX_LLM_RETRIES } from '../../config/settings.js';
import { DEFAULT_PERSONAS } from '../../config/targetPersonas.js';
import { DEFAULT_PIPELINE, KNOWN_FILTER_NAMES, firstFilterAfterFinalConfidentiality } from '../../config/filters.js';

const positiveInt = z.number().int().positive();
/** Trimmed, non-empty string: whitespace-only values are rejected. */
const nonBlank = z.string().trim().min(1);

const filterSpecSchema = z.strictObject({
  name: z.string().refine((v) => KNOWN_FILTER_NAMES.includes(v), {
    error: (iss) => `unknown filter "${String(iss.input)}"`,
  }),
  stage: z.enum(['pre', 'post', 'both']),
  onError: z.enum(['fail-closed', 'skip']).default('fail-closed'),
  enabled: z.boolean().default(true),
});

// D6 / FLT-03: confidentiality must run before the LLM call (pre) and after generation (post), and must fail
// closed. A config that removes, disables or relaxes it is rejected at load instead of silently becoming pass-through.
const pipelineSchema = z.array(filterSpecSchema).superRefine((pipeline, ctx) => {
  for (const stage of ['pre', 'post'] as const) {
    const covered = pipeline.some(
      (f) =>
        f.name === 'confidentiality' &&
        f.enabled &&
        f.onError === 'fail-closed' &&
        (f.stage === stage || f.stage === 'both'),
    );
    if (!covered) {
      ctx.addIssue({
        code: 'custom',
        path: [],
        message: `confidentiality must be enabled and fail-closed at stage "${stage}"`,
      });
    }
  }
  // Confidentiality must be the LAST filter at post: anything after it edits redacted text that is never re-checked.
  const late = firstFilterAfterFinalConfidentiality(pipeline);
  if (late !== -1) {
    ctx.addIssue({
      code: 'custom',
      path: [late],
      message: `confidentiality must be the last enabled filter at stage "post"; "${pipeline[late]?.name}" runs after it`,
    });
  }
  pipeline.forEach((f, i) => {
    if (f.name === 'confidentiality' && f.onError !== 'fail-closed') {
      ctx.addIssue({ code: 'custom', path: [i, 'onError'], message: 'confidentiality must be fail-closed' });
    }
  });
});

const personaSchema = z.strictObject({
  key: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'must start with a letter or digit and contain only letters, digits, "_" or "-"'),
  name: nonBlank,
  cognitiveLoad: nonBlank,
  informationDensity: nonBlank,
  structuralMandates: z.array(nonBlank),
  bannedPhrases: z.array(nonBlank), // an empty or whitespace-only phrase would match everywhere
});

const personasSchema = z
  .array(personaSchema)
  .min(1, 'at least one persona is required')
  .superRefine((personas, ctx) => {
    const seen = new Set<string>();
    personas.forEach((p, i) => {
      if (seen.has(p.key)) {
        ctx.addIssue({ code: 'custom', path: [i, 'key'], message: `duplicate persona key "${p.key}"` });
      }
      seen.add(p.key);
    });
  });

const customRuleSchema = z.strictObject({
  name: z.string().regex(/^[a-z0-9_]{1,40}$/, 'must be 1-40 characters: lowercase letters, digits or "_"'),
  pattern: z.string().min(1, 'must not be empty').max(256, 'must be at most 256 characters'),
  caseInsensitive: z.boolean().optional(),
});

const confidentialitySchema = z.strictObject({
  blocklist: z.array(z.string().trim().min(1, 'must not be blank').max(1000, 'must be at most 1000 characters')).max(10_000, 'at most 10000 entries').default(() => []),
  caseInsensitive: z.boolean().default(false),
  customRules: z.array(customRuleSchema).max(100, 'at most 100 rules').default(() => []),
});

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** http(s) URL only: `file:`, `data:` and friends are never an LLM endpoint. */
const httpUrl = z.string().refine((v) => {
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}, 'must be an http(s) URL');

const llmSchema = z
  .strictObject({
    model: nonBlank,
    maxTokens: positiveInt.default(DEFAULT_LLM.maxTokens),
    // capped at 1: the default provider (Anthropic) rejects higher values, so fail at startup, not at first request
    temperature: z.number().min(0).max(1).default(DEFAULT_LLM.temperature),
    maxRetries: z.number().int().min(0).max(MAX_LLM_RETRIES).default(DEFAULT_LLM.maxRetries),
    provider: z.enum(['anthropic', 'openai-compat']).optional(),
    baseUrl: httpUrl.optional(),
    // The message must not echo the value: someone may have pasted the key itself here.
    apiKeyEnv: z.string().regex(ENV_NAME, 'must be an environment variable name, not a key').optional(),
  })
  .superRefine((llm, ctx) => {
    if (llm.provider === 'openai-compat' && llm.baseUrl === undefined) {
      ctx.addIssue({ code: 'custom', path: ['baseUrl'], message: 'is required for provider "openai-compat"' });
    }
    if (llm.provider !== 'openai-compat' && llm.baseUrl !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['baseUrl'], message: 'only applies to provider "openai-compat"' });
    }
  });

export const configSchema = z.strictObject({
  limits: z
    .strictObject({ maxInputChars: positiveInt.default(DEFAULT_LIMITS.maxInputChars) })
    .default(() => ({ ...DEFAULT_LIMITS })),
  chunk: z
    .strictObject({
      size: positiveInt.default(DEFAULT_CHUNK.size),
      overlap: z.number().int().nonnegative().default(DEFAULT_CHUNK.overlap),
    })
    .refine((c) => c.overlap < c.size, { path: ['overlap'], error: 'must be smaller than chunk.size' })
    .default(() => ({ ...DEFAULT_CHUNK })),
  llm: llmSchema,
  filters: z
    .strictObject({
      pipeline: pipelineSchema.default(() => DEFAULT_PIPELINE.map((f) => ({ ...f }))),
    })
    .default(() => ({ pipeline: DEFAULT_PIPELINE.map((f) => ({ ...f })) })),
  personas: personasSchema.default(() => DEFAULT_PERSONAS.map((p) => structuredClone(p))),
  confidentiality: confidentialitySchema.optional(),
});
