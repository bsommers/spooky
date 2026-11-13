// Default engine settings. `llm.model` has no default: the model is provider specific and must be chosen explicitly.
export const DEFAULT_LIMITS = { maxInputChars: 200000 } as const;

export const DEFAULT_CHUNK = { size: 800, overlap: 100 } as const;

/** temperature must stay within [0,1] (enforced in src/config/schema.ts). */
export const DEFAULT_LLM = { maxTokens: 1500, temperature: 0.7, maxRetries: 2 } as const;

/** Upper bound on llm.maxRetries (ORC-02: bounded retries, max 2). */
export const MAX_LLM_RETRIES = 2;
