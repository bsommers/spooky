// Typed error hierarchy (.planning/CONTRACTS.md "Errors"). Every error carries a stable string `code`
// that callers and the CLI exit-code mapping key off; never match on `message`.
import type { ConfigIssue } from './types.js';

export abstract class GhostwriterError extends Error {
  readonly code: string;

  protected constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
    this.name = new.target.name;
  }
}

export class ConfigError extends GhostwriterError {
  readonly issues: readonly ConfigIssue[];

  constructor(message: string, issues: readonly ConfigIssue[] = []) {
    super('CONFIG_INVALID', message);
    this.issues = issues.map((i) => ({ path: i.path, message: i.message }));
  }
}

export class FilterFailedError extends GhostwriterError {
  readonly filter: string;

  constructor(filter: string, cause?: unknown) {
    super('FILTER_FAILED', `filter "${filter}" failed`, cause === undefined ? undefined : { cause });
    this.filter = filter;
  }
}

export class UnknownPersonaError extends GhostwriterError {
  readonly key: string;
  readonly valid: readonly string[];

  constructor(key: string, valid: readonly string[]) {
    super('UNKNOWN_PERSONA', `unknown persona "${key}"; valid personas: ${valid.join(', ')}`);
    this.key = key;
    this.valid = [...valid];
  }
}

export class UnknownAuthorError extends GhostwriterError {
  readonly authorId: string;

  constructor(authorId: string) {
    super('UNKNOWN_AUTHOR', `unknown author "${authorId}"`);
    this.authorId = authorId;
  }
}

export class InputTooLargeError extends GhostwriterError {
  readonly size: number;
  readonly limit: number;
  readonly unit: string;

  /** `unit` names what `size` and `limit` count (default characters; the corpus guards also count chunks). */
  constructor(size: number, limit: number, unit = 'characters') {
    super('INPUT_TOO_LARGE', `input is ${size} ${unit}; limit is ${limit}`);
    this.size = size;
    this.limit = limit;
    this.unit = unit;
  }
}

export class LlmError extends GhostwriterError {
  readonly attempts: number;

  constructor(attempts: number, cause?: unknown) {
    super('LLM_FAILED', `LLM call failed after ${attempts} attempt${attempts === 1 ? '' : 's'}`, cause === undefined ? undefined : { cause });
    this.attempts = attempts;
  }
}

/** A corpus that cannot yield a stylometric profile (no words, no sentences). Carries no corpus text. */
export class ProfileError extends GhostwriterError {
  constructor(message: string) {
    super('PROFILE_INVALID', message);
  }
}

/** A persisted vector-store file that is not valid JSON or does not match the store schema. Never carries file content. */
export class StoreCorruptError extends GhostwriterError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('STORE_CORRUPT', message, options);
  }
}
