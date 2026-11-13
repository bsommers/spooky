import { describe, expect, it } from 'vitest';
import { LlmError } from '../../src/models/errors.js';
import { LlmTransportError, isRetryableLlmError, parseRetryAfter, withRetry } from '../../src/llm/retry.js';

const http = (status: number, retryAfterMs?: number) => new LlmTransportError('http', retryAfterMs === undefined ? { status } : { status, retryAfterMs });

/** Fails with each error in turn, then returns 'ok'. */
function flaky(errors: unknown[]) {
  let calls = 0;
  const fn = async (): Promise<string> => {
    const e = errors[calls];
    calls++;
    if (e !== undefined) throw e;
    return 'ok';
  };
  return { fn, calls: () => calls };
}
const fakeSleep = () => {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
};

describe('withRetry', () => {
  it('returns on the first success without sleeping', async () => {
    const s = fakeSleep();
    const f = flaky([]);
    expect(await withRetry(f.fn, { sleep: s.sleep })).toBe('ok');
    expect(f.calls()).toBe(1);
    expect(s.waits).toEqual([]);
  });

  it('fail, fail, ok succeeds after 2 retries with 1x then 2x base delay', async () => {
    const s = fakeSleep();
    const f = flaky([http(503), new LlmTransportError('network')]);
    expect(await withRetry(f.fn, { maxRetries: 2, baseMs: 100, sleep: s.sleep })).toBe('ok');
    expect(f.calls()).toBe(3);
    expect(s.waits).toEqual([100, 200]);
  });

  it('three failures throw LlmError with attempts=3 and no value', async () => {
    const s = fakeSleep();
    const f = flaky([http(500), http(502), http(429)]);
    const err = await withRetry(f.fn, { maxRetries: 2, baseMs: 10, sleep: s.sleep }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).attempts).toBe(3);
    expect((err as LlmError).code).toBe('LLM_FAILED');
    expect(f.calls()).toBe(3);
    expect(s.waits).toEqual([10, 20]);
  });

  it('does not retry a non-retryable 400', async () => {
    const s = fakeSleep();
    const f = flaky([http(400), http(400)]);
    const err = await withRetry(f.fn, { sleep: s.sleep }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).attempts).toBe(1);
    expect(f.calls()).toBe(1);
    expect(s.waits).toEqual([]);
  });

  it('treats unknown errors, invalid responses and empty responses as final', async () => {
    for (const e of [new Error('boom'), new LlmTransportError('invalid-response'), new LlmTransportError('empty-response'), new LlmTransportError('too-large')]) {
      const f = flaky([e]);
      const err = await withRetry(f.fn, { sleep: async () => {} }).catch((x: unknown) => x);
      expect((err as LlmError).attempts).toBe(1);
      expect(f.calls()).toBe(1);
    }
  });

  it('passes an LlmError through without retrying or re-wrapping it', async () => {
    const inner = new LlmError(3);
    const f = flaky([inner]);
    const err = await withRetry(f.fn, { sleep: async () => {} }).catch((e: unknown) => e);
    expect(err).toBe(inner);
    expect(f.calls()).toBe(1);
  });

  it('honors Retry-After when larger than backoff, bounded by maxDelayMs', async () => {
    const s = fakeSleep();
    const f = flaky([http(429, 5_000), http(429, 10_000_000)]);
    await withRetry(f.fn, { maxRetries: 2, baseMs: 100, maxDelayMs: 60_000, sleep: s.sleep });
    expect(s.waits).toEqual([5_000, 60_000]);
  });

  it('clamps backoff itself to maxDelayMs', async () => {
    const s = fakeSleep();
    const f = flaky([http(500), http(500), http(500)]);
    await withRetry(f.fn, { maxRetries: 3, baseMs: 1000, maxDelayMs: 1500, sleep: s.sleep });
    expect(s.waits).toEqual([1000, 1500, 1500]);
  });

  it('maxRetries 0 means a single attempt; a huge maxRetries is clamped', async () => {
    const f0 = flaky([http(500), http(500)]);
    const e0 = await withRetry(f0.fn, { maxRetries: 0, sleep: async () => {} }).catch((e: unknown) => e);
    expect((e0 as LlmError).attempts).toBe(1);
    const always = flaky(Array.from({ length: 100 }, () => http(500)));
    const e1 = await withRetry(always.fn, { maxRetries: 1e9, sleep: async () => {} }).catch((e: unknown) => e);
    expect((e1 as LlmError).attempts).toBe(11);
  });

  it('ignores nonsense option values and falls back to defaults', async () => {
    const s = fakeSleep();
    const f = flaky([http(500)]);
    await withRetry(f.fn, { maxRetries: Number.NaN, baseMs: -5, sleep: s.sleep });
    expect(s.waits).toEqual([500]);
  });

  it('supports a custom isRetryable predicate', async () => {
    const f = flaky([new Error('transient')]);
    expect(await withRetry(f.fn, { sleep: async () => {}, isRetryable: () => true })).toBe('ok');
  });

  it('does not put foreign error text in the LlmError message or cause', async () => {
    const secret = 'sk-ant-SECRET-KEY-VALUE';
    const f = flaky([new Error(`request to https://x/?key=${secret} failed`)]);
    const err = (await withRetry(f.fn, { sleep: async () => {} }).catch((e: unknown) => e)) as LlmError;
    expect(JSON.stringify([err.message, String(err.cause), (err.cause as Error).message])).not.toContain(secret);
  });

  it('passes the 1-based attempt number to fn', async () => {
    const seen: number[] = [];
    await withRetry(async (a) => {
      seen.push(a);
      if (a < 3) throw http(500);
      return 1;
    }, { sleep: async () => {} });
    expect(seen).toEqual([1, 2, 3]);
  });
});

describe('isRetryableLlmError', () => {
  it('retries 429, 5xx, network and timeout only', () => {
    for (const s of [429, 500, 502, 503, 599]) expect(isRetryableLlmError(http(s))).toBe(true);
    for (const s of [400, 401, 403, 404, 422, 499, 600]) expect(isRetryableLlmError(http(s))).toBe(false);
    expect(isRetryableLlmError(new LlmTransportError('network'))).toBe(true);
    expect(isRetryableLlmError(new LlmTransportError('timeout'))).toBe(true);
    expect(isRetryableLlmError(new LlmTransportError('invalid-response'))).toBe(false);
    expect(isRetryableLlmError(new Error('x'))).toBe(false);
    expect(isRetryableLlmError(undefined)).toBe(false);
  });
});

describe('parseRetryAfter', () => {
  it('parses delta-seconds and HTTP dates; rejects junk', () => {
    expect(parseRetryAfter('2')).toBe(2000);
    expect(parseRetryAfter(' 0 ')).toBe(0);
    expect(parseRetryAfter('Wed, 21 Oct 2015 07:28:05 GMT', () => Date.parse('Wed, 21 Oct 2015 07:28:00 GMT'))).toBe(5000);
    expect(parseRetryAfter('Wed, 21 Oct 2015 07:28:05 GMT', () => Date.parse('Thu, 22 Oct 2015 07:28:00 GMT'))).toBe(0);
    for (const bad of [undefined, null, '', 'soon', '-3', '1.5', '99999999999999']) expect(parseRetryAfter(bad as string | undefined)).toBeUndefined();
  });
});
