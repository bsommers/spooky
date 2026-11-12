// Config loader: validate once at startup, fail fast with path-qualified errors, never at first request.
import type { ZodIssue } from 'zod';
import { ConfigError } from '../models/errors.js';
import type { Config, ConfigIssue } from '../models/types.js';
import { configSchema } from './schema.js';

/** `['filters','pipeline',1,'name']` -> `filters.pipeline[1].name`. */
function formatPath(path: readonly PropertyKey[]): string {
  let out = '';
  for (const seg of path) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else out += out === '' ? String(seg) : `.${String(seg)}`;
  }
  return out === '' ? '<root>' : out;
}

function toIssues(issues: readonly ZodIssue[]): ConfigIssue[] {
  const out: ConfigIssue[] = [];
  for (const issue of issues) {
    const base = issue.path;
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) out.push({ path: formatPath([...base, key]), message: 'unknown key' });
    } else if (issue.code === 'invalid_type' && issue.message.endsWith('received undefined')) {
      out.push({ path: formatPath(base), message: 'is required' });
    } else {
      out.push({ path: formatPath(base), message: issue.message });
    }
  }
  return out;
}

/**
 * Validate `raw` (parsed JSON, an object literal, ...) and return a fully defaulted `Config`.
 * Throws `ConfigError` listing every problem as `path: message`. The result shares no references
 * with the input or with module-level defaults.
 */
export function loadConfig(raw?: unknown): Config {
  const parsed = configSchema.safeParse(raw === undefined ? {} : raw);
  if (!parsed.success) {
    const issues = toIssues(parsed.error.issues);
    throw new ConfigError(
      `invalid config: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`,
      issues,
    );
  }
  const config: Config = parsed.data; // compile-time proof that the schema output matches the declared Config
  return structuredClone(config);
}
