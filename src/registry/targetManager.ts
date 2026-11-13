// Target axis: the audience personas a draft can be written for. Personas come from config; this registry owns
// lookup, a stable listing order and the "unknown persona" error that names the valid keys.
import { ConfigError, UnknownPersonaError } from '../models/errors.js';
import type { ConfigIssue, TargetPersonaConfig } from '../models/types.js';

const copyPersona = (p: TargetPersonaConfig): TargetPersonaConfig => ({
  ...p,
  structuralMandates: [...p.structuralMandates],
  bannedPhrases: [...p.bannedPhrases],
});

export class TargetManager {
  readonly #personas: ReadonlyMap<string, TargetPersonaConfig>;

  /**
   * `personas` is keyed by persona key. Throws `ConfigError` (one issue per offender) when a persona's own `key`
   * differs from the key it is registered under: a mismatch means `get(k).key !== k` and silently routes the wrong
   * persona's rules to a request.
   */
  constructor(personas: Record<string, TargetPersonaConfig>) {
    const issues: ConfigIssue[] = [];
    const map = new Map<string, TargetPersonaConfig>();
    for (const [key, persona] of Object.entries(personas)) {
      if (persona.key !== key) {
        issues.push({ path: `personas.${key}.key`, message: `key "${persona.key}" does not match its map key "${key}"` });
        continue;
      }
      map.set(key, copyPersona(persona));
    }
    if (issues.length > 0) throw new ConfigError('persona key does not match its map key', issues);
    this.#personas = map;
  }

  /** The persona registered under `key`. Throws `UnknownPersonaError` (with the sorted valid keys) otherwise. */
  get(key: string): TargetPersonaConfig {
    const persona = this.#personas.get(key);
    if (persona === undefined) throw new UnknownPersonaError(key, this.#keys());
    return copyPersona(persona);
  }

  /** Every persona, sorted by key. A fresh array of fresh copies on each call. */
  list(): TargetPersonaConfig[] {
    return this.#keys().map((k) => copyPersona(this.#personas.get(k)!));
  }

  #keys(): string[] {
    return [...this.#personas.keys()].sort(compareCodeUnits);
  }
}

/** Locale-independent ordering, so listings and error messages are identical on every machine. */
function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
