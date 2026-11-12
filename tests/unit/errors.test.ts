import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  FilterFailedError,
  GhostwriterError,
  InputTooLargeError,
  LlmError,
  UnknownAuthorError,
  UnknownPersonaError,
} from '../../src/models/errors.js';

const cases: ReadonlyArray<{ name: string; code: string; make: () => GhostwriterError }> = [
  { name: 'ConfigError', code: 'CONFIG_INVALID', make: () => new ConfigError('llm.model: required') },
  { name: 'FilterFailedError', code: 'FILTER_FAILED', make: () => new FilterFailedError('confidentiality') },
  { name: 'UnknownPersonaError', code: 'UNKNOWN_PERSONA', make: () => new UnknownPersonaError('x', ['a', 'b']) },
  { name: 'UnknownAuthorError', code: 'UNKNOWN_AUTHOR', make: () => new UnknownAuthorError('nobody') },
  { name: 'InputTooLargeError', code: 'INPUT_TOO_LARGE', make: () => new InputTooLargeError(300_000, 200_000) },
  { name: 'LlmError', code: 'LLM_FAILED', make: () => new LlmError(3) },
];

describe('GhostwriterError hierarchy', () => {
  it.each(cases)('$name has stable code $code', ({ code, make }) => {
    const err = make();
    expect(err.code).toBe(code);
    expect(JSON.stringify(err.code)).toBe(JSON.stringify(code));
  });

  it.each(cases)('$name is instanceof itself, GhostwriterError and Error', ({ make }) => {
    const err = make();
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(GhostwriterError);
    expect(err).toBeInstanceOf(err.constructor);
  });

  it.each(cases)('$name keeps instanceof and code after JSON.stringify of .code', ({ code, make }) => {
    const err = make();
    const serialised = JSON.stringify({ code: err.code });
    expect(JSON.parse(serialised)).toEqual({ code });
    expect(err).toBeInstanceOf(GhostwriterError);
    expect(err.name).toBe(err.constructor.name);
  });

  it('codes are unique across subclasses', () => {
    const codes = cases.map((c) => c.make().code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('UnknownPersonaError carries the valid keys and names them in the message', () => {
    const err = new UnknownPersonaError('exec', ['engineer', 'analyst']);
    expect(err.valid).toEqual(['engineer', 'analyst']);
    expect(err.message).toContain('exec');
    expect(err.message).toContain('engineer');
    expect(err.message).toContain('analyst');
  });

  it('UnknownPersonaError snapshot of valid keys is not affected by later mutation', () => {
    const valid = ['a'];
    const err = new UnknownPersonaError('z', valid);
    valid.push('b');
    expect(err.valid).toEqual(['a']);
  });

  it('FilterFailedError exposes the filter name and preserves the cause', () => {
    const cause = new Error('boom');
    const err = new FilterFailedError('confidentiality', cause);
    expect(err.filter).toBe('confidentiality');
    expect(err.cause).toBe(cause);
    expect(err.message).toContain('confidentiality');
  });

  it('LlmError exposes attempts', () => {
    const err = new LlmError(3, new Error('503'));
    expect(err.attempts).toBe(3);
    expect(err.message).toContain('3');
  });

  it('ConfigError exposes path-qualified issues', () => {
    const err = new ConfigError('invalid config', [{ path: 'chunk.size', message: 'must be positive' }]);
    expect(err.issues).toEqual([{ path: 'chunk.size', message: 'must be positive' }]);
  });

  it('InputTooLargeError exposes size and limit', () => {
    const err = new InputTooLargeError(10, 5);
    expect(err.size).toBe(10);
    expect(err.limit).toBe(5);
  });
});
