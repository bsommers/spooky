// What the long-running surfaces (HTTP server, MCP server) share: one Engine, one execution path, and a cheap check
// that picks up an ingest written by ANOTHER process (for example `ghostwriter ingest` while the server runs).
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { PROFILES_FILE, STORE_FILE } from '../engine.js';
import type { Engine } from '../engine.js';
import { findOperation, invokeOperation, successDocument } from './operations.js';
import type { AnyOperation } from './operations.js';
import { SurfaceError } from './errors.js';

/** A signature no real state directory can have (`#currentSignature` always has a `|`), so the next `refresh` reloads. */
const STALE = '(stale)';

export class ServiceRuntime {
  readonly engine: Engine;
  readonly #stateDir: string | undefined;
  #signature = '';

  constructor(engine: Engine, options: { stateDir?: string } = {}) {
    this.engine = engine;
    this.#stateDir = options.stateDir;
  }

  async #currentSignature(): Promise<string> {
    if (this.#stateDir === undefined) return '';
    const parts: string[] = [];
    for (const f of [STORE_FILE, PROFILES_FILE]) {
      try {
        const st = await stat(join(this.#stateDir, f));
        parts.push(`${st.mtimeMs}:${st.size}`);
      } catch {
        parts.push('-');
      }
    }
    return parts.join('|');
  }

  /** Mark the state directory as seen (call after the engine loaded it, e.g. `Engine.create`). */
  async markLoaded(): Promise<void> {
    this.#signature = await this.#currentSignature();
  }

  /** Re-read the state files when another process changed them since the last load. */
  async refresh(): Promise<void> {
    if (this.#stateDir === undefined) return;
    const now = await this.#currentSignature();
    if (now === this.#signature) return;
    await this.engine.load();
    this.#signature = now;
  }

  /** Run a registered operation by name with untrusted input; resolves to the data (without `ok`). */
  async run(name: string, raw: unknown): Promise<Record<string, unknown>> {
    const op = findOperation(name);
    if (op === undefined) throw new SurfaceError('NOT_FOUND', 'no such operation');
    return this.runOperation(op, raw);
  }

  async runOperation(op: AnyOperation, raw: unknown): Promise<Record<string, unknown>> {
    if (op.readsState) await this.refresh();
    const out = await invokeOperation(op, this.engine, raw);
    // Do NOT record the state files as "seen" after our own write: a write by another process between our save and the
    // stat would be marked as seen and never reloaded. Forget the signature instead; the next read re-reads the files
    // (they hold what we just saved, plus anything another process added), which is cheap next to an ingest.
    if (op.mutates) this.#signature = STALE;
    return out;
  }

  /** `{ ok: true, ...data }`, the document every surface reports. */
  async runDocument(op: AnyOperation, raw: unknown): Promise<Record<string, unknown>> {
    return successDocument(await this.runOperation(op, raw));
  }
}
