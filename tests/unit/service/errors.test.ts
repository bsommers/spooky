import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXIT_CODES as CLI_EXIT_CODES } from '../../../src/cli/main.js';
import {
  ConfigError,
  DetectorsFailedError,
  FilterFailedError,
  GhostwriterError,
  InputTooLargeError,
  LlmError,
  ProfileError,
  StateLockedError,
  StoreCorruptError,
  UnknownAuthorError,
  UnknownPersonaError,
} from '../../../src/models/errors.js';
import { ERROR_TABLE, EXIT_CODES, InputError, SurfaceError, describeError, errorDocument } from '../../../src/service/errors.js';

const errorsSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'src', 'models', 'errors.ts'), 'utf8');

describe('error table', () => {
  it('covers every GhostwriterError code declared in src/models/errors.ts (read from the source, so a new subclass fails here)', () => {
    const codes = [...errorsSource.matchAll(/super\(\s*'([A-Z_]+)'/g)].map((m) => m[1] as string);
    expect(codes.length).toBeGreaterThanOrEqual(10);
    for (const c of codes) expect(ERROR_TABLE[c], c).toBeDefined();
  });

  it('maps each typed error instance through describeError with its table row', () => {
    const errs: GhostwriterError[] = [
      new ConfigError('bad'),
      new FilterFailedError('confidentiality'),
      new UnknownPersonaError('x', ['a']),
      new UnknownAuthorError('x'),
      new InputTooLargeError(2, 1),
      new LlmError(1),
      new ProfileError('empty'),
      new StoreCorruptError('bad'),
      new StateLockedError(10),
      new DetectorsFailedError([]),
    ];
    for (const e of errs) {
      const d = describeError(e);
      expect(d.code).toBe(e.code);
      expect(d.exit).toBe(ERROR_TABLE[e.code]?.exit);
      expect(d.http).toBe(ERROR_TABLE[e.code]?.http);
      if (!(e instanceof UnknownPersonaError)) expect(d.message).toBe(e.message);
    }
  });

  it('an unknown persona is reported without echoing the (caller-supplied, possibly secret-shaped) key', () => {
    const d = describeError(new UnknownPersonaError('sk-live-ABCDEFGHIJKLMNOPQRSTUV', ['exec', 'ops']));
    expect(d).toMatchObject({ code: 'UNKNOWN_PERSONA', http: 404, exit: 3 });
    expect(d.message).toBe('unknown persona (30 characters); valid personas: exec, ops');
  });

  it('keeps the documented CLI exit codes (CONTRACTS.md) and the CLI re-exports the same table', () => {
    expect(CLI_EXIT_CODES).toBe(EXIT_CODES);
    expect(EXIT_CODES).toMatchObject({ CONFIG_INVALID: 2, PROFILE_INVALID: 2, USAGE: 2, UNKNOWN_PERSONA: 3, UNKNOWN_AUTHOR: 3, FILTER_FAILED: 4, LLM_FAILED: 5, INPUT_TOO_LARGE: 6, STORE_CORRUPT: 7, STATE_LOCKED: 8, DETECTORS_FAILED: 9 });
  });

  it('every row has a valid exit code (0..9), HTTP status (4xx/5xx) and an MCP category', () => {
    for (const [code, s] of Object.entries(ERROR_TABLE)) {
      expect(s.exit, code).toBeGreaterThan(0);
      expect(s.exit, code).toBeLessThanOrEqual(9);
      expect(s.http, code).toBeGreaterThanOrEqual(400);
      expect(s.http, code).toBeLessThan(600);
      expect(s.mcp, code).toMatch(/^[a-z_]+$/);
    }
  });

  it('an unknown error is INTERNAL / 500 / exit 1 and reports the class name only, never the message', () => {
    class Weird extends Error {
      override name = 'Weird';
    }
    const d = describeError(new Weird('contains the secret sk-live-123456789012345678901'));
    expect(d).toMatchObject({ code: 'INTERNAL', http: 500, exit: 1 });
    expect(d.message).toBe('internal error (Weird)');
    expect(JSON.stringify(d)).not.toContain('sk-live');
    expect(describeError('plain string').message).toBe('internal error (string)');
  });

  it('a file-system errno is IO_ERROR with the errno only', () => {
    const e = Object.assign(new Error('ENOENT: no such file /home/u/secret/path'), { code: 'ENOENT' });
    const d = describeError(e);
    expect(d).toMatchObject({ code: 'IO_ERROR', http: 500, exit: 1, message: 'file system error (ENOENT)' });
  });

  it('SurfaceError and InputError carry their code, and Retry-After survives', () => {
    expect(describeError(new SurfaceError('OVERLOADED', 'busy', { retryAfterSeconds: 2 }))).toMatchObject({ code: 'OVERLOADED', http: 503, retryAfterSeconds: 2 });
    expect(describeError(new InputError('bad', [{ path: 'a', message: 'b' }]))).toMatchObject({ code: 'USAGE', http: 400, exit: 2 });
  });

  it('errorDocument is the one shape every surface reports', () => {
    expect(errorDocument({ code: 'X', message: 'm' })).toEqual({ ok: false, error: { code: 'X', message: 'm' } });
  });
});
