// Redacted, read-only view of a validated Config for the `config get` operation (Phase 9, all surfaces).
//
// What it shows: provider, model, the HOST of each endpoint (never the path or query: a URL can carry a token there),
// the environment variable NAMES that hold keys (never their values; whether the variable is set is a boolean), the
// limits, the filter pipeline, persona keys, and the scorer settings. What it never shows: any env value, the
// confidentiality blocklist or custom-rule patterns (counts only), persona prose. A name that is not shaped like an
// environment variable name is withheld, so a key pasted into `apiKeyEnv` cannot leak through this view.
import type { Config, FilterSpec } from '../models/types.js';

export interface DetectorView {
  name: string;
  /** Host (with port) of the detector endpoint. */
  host: string;
  scheme: 'http' | 'https';
  apiKeyEnv?: string;
  /** True when that environment variable is set and non-empty (the value is never read into the view). */
  apiKeyEnvSet?: boolean;
  weight: number;
  timeoutMs: number;
}

export interface ConfigView {
  llm: {
    provider: 'anthropic' | 'openai-compat';
    model: string;
    maxTokens: number;
    temperature: number;
    maxRetries: number;
    baseUrlHost?: string;
    apiKeyEnv?: string;
    apiKeyEnvSet?: boolean;
  };
  limits: { maxInputChars: number };
  chunk: { size: number; overlap: number };
  filters: FilterSpec[];
  personas: string[];
  confidentiality: { blocklistTerms: number; customRules: number };
  scorer: { localWeight: number; weights: Record<string, number>; detectors: DetectorView[] };
}

/** Shown in place of a name that does not look like an environment variable name. */
export const WITHHELD = '(withheld)';
const ENV_NAME_VIEW = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const MAX_SHOWN = 200;

function envName(name: string | undefined, env: Readonly<Record<string, string | undefined>>): { apiKeyEnv: string; apiKeyEnvSet: boolean } | Record<string, never> {
  if (name === undefined) return {};
  if (!ENV_NAME_VIEW.test(name)) return { apiKeyEnv: WITHHELD, apiKeyEnvSet: false };
  const v = env[name];
  return { apiKeyEnv: name, apiKeyEnvSet: v !== undefined && v !== '' };
}

function hostOf(raw: string): { host: string; scheme: 'http' | 'https' } {
  try {
    const u = new URL(raw);
    return { host: u.host.slice(0, MAX_SHOWN), scheme: u.protocol === 'https:' ? 'https' : 'http' };
  } catch {
    return { host: WITHHELD, scheme: 'https' };
  }
}

/** Pure: reads `env` only to report whether a named variable is set. */
export function buildConfigView(config: Config, env: Readonly<Record<string, string | undefined>>): ConfigView {
  const llm = config.llm;
  const provider = llm.provider ?? 'anthropic';
  const defaultKeyEnv = provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : undefined;
  const scorer = config.scorer;
  return {
    llm: {
      provider,
      model: llm.model.slice(0, MAX_SHOWN),
      maxTokens: llm.maxTokens,
      temperature: llm.temperature,
      maxRetries: llm.maxRetries,
      ...(llm.baseUrl === undefined ? {} : { baseUrlHost: hostOf(llm.baseUrl).host }),
      ...envName(llm.apiKeyEnv ?? defaultKeyEnv, env),
    },
    limits: { maxInputChars: config.limits.maxInputChars },
    chunk: { size: config.chunk.size, overlap: config.chunk.overlap },
    filters: config.filters.pipeline.map((f) => ({ name: f.name, stage: f.stage, onError: f.onError, enabled: f.enabled })),
    personas: config.personas.map((p) => p.key).sort(),
    confidentiality: {
      blocklistTerms: config.confidentiality?.blocklist.length ?? 0,
      customRules: config.confidentiality?.customRules.length ?? 0,
    },
    scorer: {
      localWeight: scorer?.localWeight ?? 1,
      weights: { ...(scorer?.weights ?? {}) },
      detectors: (scorer?.detectors ?? []).map((d) => ({
        name: d.name,
        ...hostOf(d.url),
        ...envName(d.apiKeyEnv, env),
        weight: d.weight,
        timeoutMs: d.timeoutMs,
      })),
    },
  };
}
