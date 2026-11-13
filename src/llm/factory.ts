// Build an LlmClient from a ProviderConfig. This is the only place API keys are read, and only from the environment
// variable the config names. A missing key for a provider that needs one is a `ConfigError` that names the variable
// but never a value.
import { ConfigError } from '../models/errors.js';
import type { LlmClient, ProviderConfig } from '../models/types.js';
import { AnthropicClient } from './anthropicClient.js';
import type { FetchLike } from './http.js';
import { OpenAICompatClient } from './openaiCompatClient.js';
import type { RetryOptions } from './retry.js';

export interface CreateLlmClientOptions {
  /** Environment to read keys from. Default process.env. */
  env?: Readonly<Record<string, string | undefined>>;
  retry?: RetryOptions;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetch?: FetchLike;
  /** Test/proxy override of the Anthropic API origin. */
  anthropicBaseUrl?: string;
}

const DEFAULT_ANTHROPIC_KEY_ENV = 'ANTHROPIC_API_KEY';
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function createLlmClient(config: ProviderConfig, options: CreateLlmClientOptions = {}): LlmClient {
  const env = options.env ?? process.env;
  const shared = {
    ...(options.retry === undefined ? {} : { retry: options.retry }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.maxResponseBytes === undefined ? {} : { maxResponseBytes: options.maxResponseBytes }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  };
  switch (config.provider) {
    case 'anthropic': {
      const name = keyEnvName(config.apiKeyEnv || DEFAULT_ANTHROPIC_KEY_ENV);
      const apiKey = env[name];
      if (apiKey === undefined || apiKey === '') throw new ConfigError(`environment variable ${name} is not set; the anthropic provider needs an API key`);
      return new AnthropicClient({
        model: config.model,
        apiKey,
        ...(options.anthropicBaseUrl === undefined ? {} : { baseUrl: options.anthropicBaseUrl }),
        ...shared,
      });
    }
    case 'openai-compat': {
      let apiKey: string | undefined;
      if (config.apiKeyEnv !== undefined && config.apiKeyEnv !== '') {
        const value = env[keyEnvName(config.apiKeyEnv)];
        apiKey = value === '' ? undefined : value;
      }
      return new OpenAICompatClient({ model: config.model, baseUrl: config.baseUrl, ...(apiKey === undefined ? {} : { apiKey }), ...shared });
    }
    default:
      throw new ConfigError(`unknown LLM provider "${String((config as { provider?: unknown }).provider)}"`);
  }
}

function keyEnvName(name: string): string {
  if (!ENV_NAME.test(name)) throw new ConfigError('apiKeyEnv must be an environment variable name, not a key');
  return name;
}
