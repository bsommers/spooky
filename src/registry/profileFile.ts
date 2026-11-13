// Persistence of author profiles (the vector store persists chunks, not profiles). One JSON file, written atomically
// with mode 0600, validated field by field on load:
//
//  * The file is untrusted input. Size is checked before reading; unknown keys, wrong types, non-finite numbers and
//    a `vectorCollectionName` that is not the one derived from the author id (it would point one author at another's
//    chunks) are all rejected. Profile text ends up in the LLM system prompt, so lengths are bounded too.
//  * Errors are typed and never carry file content: `StoreCorruptError` for the file, `ProfileError` for one record
//    (`validateProfile`, also used by `SourceManager.restoreProfiles`).
//  * Profiles hold only redacted text: the display name goes through the confidentiality pipeline at ingest, and every
//    other field is a number or a punctuation / transition token.
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { vectorCollectionName } from '../ingestion/stylometry.js';
import { InputTooLargeError, ProfileError, StoreCorruptError } from '../models/errors.js';
import type { StylometricProfile } from '../models/types.js';

const FORMAT = 'ghostwriter-profiles';
const VERSION = 1;
export const AUTHOR_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const MAX_DISPLAY_NAME = 200;
/** Largest profiles file read or written (1,000 authors are ~1 MiB; this leaves ample headroom). */
export const MAX_PROFILES_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOKEN_CHARS = 100;
const MAX_TOKENS = 10;

const KEYS = [
  'authorId', 'displayName', 'avgSentenceLength', 'sentenceLengthStdDev', 'lexicalDensityRatio', 'preferredPunctuation',
  'hedgingFrequency', 'activePassiveRatio', 'commonTransitionWords', 'vectorCollectionName', 'corpusWordCount',
] as const;

const isObj = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);

/**
 * Check one profile record and return a clean copy. Throws `ProfileError` naming the field (never the value).
 * `where` prefixes the message, e.g. `profiles[2]`.
 */
export function validateProfile(raw: unknown, where = 'profile'): StylometricProfile {
  const bad = (field: string, why: string): never => {
    throw new ProfileError(`invalid ${where}.${field}: ${why}`);
  };
  if (!isObj(raw)) return bad('<root>', 'not an object');
  for (const k of Object.keys(raw)) if (!(KEYS as readonly string[]).includes(k)) bad(k, 'unknown field');
  const str = (field: string, max: number): string => {
    const v = raw[field];
    if (typeof v !== 'string' || v.trim() === '' || v.length > max) return bad(field, `not a non-blank string of at most ${max} characters`);
    return v;
  };
  const num = (field: string, min: number, max = Number.MAX_VALUE): number => {
    const v = raw[field];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) return bad(field, 'not a finite number in range');
    return v;
  };
  const tokens = (field: string): string[] => {
    const v = raw[field];
    if (!Array.isArray(v) || v.length > MAX_TOKENS) return bad(field, `not an array of at most ${MAX_TOKENS} strings`);
    return v.map((t: unknown) => {
      if (typeof t !== 'string' || t === '' || t.length > MAX_TOKEN_CHARS) return bad(field, 'contains an invalid entry');
      return t;
    });
  };
  const authorId = str('authorId', 64);
  if (!AUTHOR_ID.test(authorId)) bad('authorId', 'not a valid author id');
  const corpusWordCount = num('corpusWordCount', 0);
  if (!Number.isInteger(corpusWordCount)) bad('corpusWordCount', 'not an integer');
  const out: StylometricProfile = {
    authorId,
    displayName: str('displayName', MAX_DISPLAY_NAME),
    avgSentenceLength: num('avgSentenceLength', 0),
    sentenceLengthStdDev: num('sentenceLengthStdDev', 0),
    lexicalDensityRatio: num('lexicalDensityRatio', 0, 1),
    preferredPunctuation: tokens('preferredPunctuation'),
    hedgingFrequency: num('hedgingFrequency', 0),
    activePassiveRatio: num('activePassiveRatio', 0, 1),
    commonTransitionWords: tokens('commonTransitionWords'),
    vectorCollectionName: str('vectorCollectionName', 200),
    corpusWordCount,
  };
  if (out.vectorCollectionName !== vectorCollectionName(authorId)) bad('vectorCollectionName', 'does not match the author id');
  return out;
}

/** Atomic, 0600 write (temp file + rename; a symlink at `path` is replaced, not followed). Creates parents with 0700. */
export async function writeFileAtomic(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    const fh = await open(tmp, 'wx', 0o600);
    try {
      await fh.writeFile(data, 'utf8');
      await fh.chmod(0o600); // the open mode is masked by the umask; state the permissions explicitly
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, path);
    await chmod(path, 0o600);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

/** Write `profiles` (sorted by author id, validated first) to `path`. Output is byte-deterministic. */
export async function saveProfiles(path: string, profiles: readonly StylometricProfile[]): Promise<void> {
  const sorted = profiles
    .map((p, i) => validateProfile(p, `profiles[${i}]`))
    .sort((a, b) => (a.authorId < b.authorId ? -1 : a.authorId > b.authorId ? 1 : 0));
  const data = JSON.stringify({ format: FORMAT, version: VERSION, profiles: sorted });
  const bytes = Buffer.byteLength(data, 'utf8');
  if (bytes > MAX_PROFILES_FILE_BYTES) throw new InputTooLargeError(bytes, MAX_PROFILES_FILE_BYTES, 'bytes');
  await writeFileAtomic(path, data);
}

/**
 * Read and validate a profiles file. `StoreCorruptError` for anything that is not a valid file (bad JSON, wrong
 * format/version, a bad or duplicate record, more than `maxProfiles`), `InputTooLargeError` for an oversized file, and
 * the native error (e.g. `ENOENT`, `EACCES`) when it cannot be read.
 */
export async function loadProfiles(path: string, maxProfiles = 1_000): Promise<StylometricProfile[]> {
  const st = await stat(path);
  if (!st.isFile()) throw new StoreCorruptError('profiles path is not a regular file');
  if (st.size > MAX_PROFILES_FILE_BYTES) throw new InputTooLargeError(st.size, MAX_PROFILES_FILE_BYTES, 'bytes');
  const buf = await readFile(path);
  if (buf.length > MAX_PROFILES_FILE_BYTES) throw new InputTooLargeError(buf.length, MAX_PROFILES_FILE_BYTES, 'bytes');
  let parsed: unknown;
  try {
    parsed = JSON.parse(buf.toString('utf8'));
  } catch (err) {
    throw new StoreCorruptError('profiles file is not valid JSON', { cause: err });
  }
  if (!isObj(parsed)) throw new StoreCorruptError('invalid profiles file: root: not an object');
  if (parsed.format !== FORMAT) throw new StoreCorruptError('invalid profiles file: format: unrecognised');
  if (parsed.version !== VERSION) throw new StoreCorruptError('invalid profiles file: version: unsupported');
  if (!Array.isArray(parsed.profiles)) throw new StoreCorruptError('invalid profiles file: profiles: not an array');
  if (parsed.profiles.length > maxProfiles) throw new StoreCorruptError(`invalid profiles file: profiles: more than ${maxProfiles}`);
  const seen = new Set<string>();
  return parsed.profiles.map((raw: unknown, i: number) => {
    let p: StylometricProfile;
    try {
      p = validateProfile(raw, `profiles[${i}]`);
    } catch (err) {
      if (err instanceof ProfileError) throw new StoreCorruptError(`invalid profiles file: ${err.message}`);
      throw err;
    }
    if (seen.has(p.authorId)) throw new StoreCorruptError(`invalid profiles file: profiles[${i}].authorId: duplicate`);
    seen.add(p.authorId);
    return p;
  });
}
