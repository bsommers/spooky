// Scripted LLM client for tests and offline runs. Deterministic: the n-th call returns the n-th script entry.
// Records a deep copy of every request it receives so tests can assert exactly what would have left the process.
import type { LlmClient, LlmRequest } from '../models/types.js';

export type MockStep = string | Error | ((req: LlmRequest, callNumber: number) => string | Promise<string>);

export class MockLlmClient implements LlmClient {
  /** Every request received, in order (copies; mutating them does not affect the client). */
  readonly requests: LlmRequest[] = [];
  private readonly script: MockStep[] | ((req: LlmRequest, callNumber: number) => string | Promise<string>);
  private calls = 0;

  /**
   * `script` is either a list consumed one entry per call (a string is returned, an `Error` is thrown, a function is
   * invoked) or a single function used for every call. A call past the end of a list throws a plain `Error`, so a test
   * that makes more calls than it scripted fails loudly instead of silently getting an empty answer.
   */
  constructor(script: MockStep[] | ((req: LlmRequest, callNumber: number) => string | Promise<string>) = []) {
    this.script = Array.isArray(script) ? [...script] : script;
  }

  get callCount(): number {
    return this.calls;
  }

  async complete(req: LlmRequest): Promise<string> {
    this.requests.push({ ...req });
    const n = this.calls++;
    const step = typeof this.script === 'function' ? this.script : this.script[n];
    if (step === undefined) throw new Error(`MockLlmClient: no scripted response for call ${n + 1}`);
    if (step instanceof Error) throw step;
    return typeof step === 'function' ? step(req, n + 1) : step;
  }
}
