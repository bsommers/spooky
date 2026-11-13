// Config loader: validate once at startup, fail fast with path-qualified errors, never at first request.
import type { ZodIssue } from 'zod';
import { ConfidentialityFilter } from '../filters/confidentiality.js';
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

/** True when `path` does not resolve to a defined value in `raw` (structural check, independent of zod's message text). */
function isMissing(raw: unknown, path: readonly PropertyKey[]): boolean {
  let cur: unknown = raw;
  for (const seg of path) {
    if (cur === null || typeof cur !== 'object') return true;
    cur = (cur as Record<PropertyKey, unknown>)[seg];
  }
  return cur === undefined;
}

function toIssues(issues: readonly ZodIssue[], raw: unknown): ConfigIssue[] {
  const out: ConfigIssue[] = [];
  for (const issue of issues) {
    const base = issue.path;
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) out.push({ path: formatPath([...base, key]), message: 'unknown key' });
    } else if (issue.code === 'invalid_type' && isMissing(raw, base)) {
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
  const input = raw === undefined ? {} : raw;
  const parsed = configSchema.safeParse(input);
  if (!parsed.success) {
    const issues = toIssues(parsed.error.issues, input);
    throw new ConfigError(
      `invalid config: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`,
      issues,
    );
  }
  const config: Config = parsed.data; // compile-time proof that the schema output matches the declared Config
  if (config.confidentiality !== undefined) assertConfidentialityBuilds(config.confidentiality);
  return structuredClone(config);
}

/**
 * Custom rules are compiled (and ReDoS-checked) by the filter itself. Do it here so a bad rule fails at startup with a
 * config path, not at the first request. The filter's message never echoes input text; it may name the offending rule.
 */
function assertConfidentialityBuilds(c: NonNullable<Config['confidentiality']>): void {
  try {
    new ConfidentialityFilter(c);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    throw new ConfigError(`invalid config: confidentiality: ${err.message}`, [{ path: 'confidentiality.customRules', message: err.message }]);
  }
}
