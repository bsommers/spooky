// Advisory lock for the state directory (CR-04): serializes load-ingest-save across PROCESSES, which the
// SourceManager's in-process queue cannot do. Without it two overlapping `ghostwriter ingest` runs both load the same
// state and the later writer silently drops the other's author.
//
//   `<dir>/.lock` is created with O_EXCL (flag 'wx', mode 0600) and holds `{pid, host, token, at}`.
//   A holder that is gone is reclaimed: same host and the pid no longer exists, or the lock is older than `staleMs`
//   (covers a pid reused by another process and a lock left by a machine that shares the directory).
//   Waiting is bounded: after `waitMs` the call rejects with `StateLockedError`; there is no unbounded block.
//   Release removes the file only if it still carries our token, so a reclaimed lock is never deleted by its old owner.
import { randomBytes } from 'node:crypto';
import { link, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { StateLockedError } from '../models/errors.js';

export const LOCK_FILE = '.lock';

export interface StateLockOptions {
  /** Longest total wait for a held lock (ms). Default 30,000. */
  waitMs?: number;
  /** A lock older than this is reclaimed even if its pid looks alive (ms). Default 900,000 (15 minutes). */
  staleMs?: number;
  /** Delay between attempts (ms). Default 50. */
  pollMs?: number;
}

interface LockInfo {
  pid: number;
  host: string;
  token: string;
  at: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH'; // EPERM = exists, owned by someone else
  }
}

function parse(raw: string): LockInfo | undefined {
  try {
    const v = JSON.parse(raw) as Partial<LockInfo>;
    if (typeof v.pid === 'number' && typeof v.host === 'string' && typeof v.token === 'string' && typeof v.at === 'number') return v as LockInfo;
  } catch {
    // unreadable content: judged by age below
  }
  return undefined;
}

async function isStale(path: string, raw: string, staleMs: number): Promise<boolean> {
  const info = parse(raw);
  if (info !== undefined && info.host === hostname() && !pidAlive(info.pid)) return true;
  // A lock that is only just created may not have its content yet (open then write): judge by the file's mtime, not by "unparseable".
  const age = Date.now() - (info?.at ?? (await stat(path)).mtimeMs);
  return age > staleMs;
}

/** Take the lock, run `fn`, release. Rejects with `StateLockedError` if the lock is not free within `waitMs`. */
export async function withStateLock<T>(dir: string, fn: () => Promise<T>, options: StateLockOptions = {}): Promise<T> {
  const waitMs = options.waitMs ?? 30_000;
  const staleMs = options.staleMs ?? 900_000;
  const pollMs = options.pollMs ?? 50;
  const path = join(dir, LOCK_FILE);
  const token = randomBytes(16).toString('hex');
  const body = JSON.stringify({ pid: process.pid, host: hostname(), token, at: Date.now() } satisfies LockInfo);
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const start = Date.now();
  for (;;) {
    try {
      const fh = await open(path, 'wx', 0o600);
      try {
        await fh.writeFile(body);
      } catch (werr) {
        await fh.close();
        await unlink(path).catch(() => undefined);
        throw werr;
      }
      await fh.close();
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    await reclaimIfStale(path, staleMs);
    const waited = Date.now() - start;
    if (waited >= waitMs) throw new StateLockedError(waited);
    await sleep(Math.min(pollMs, Math.max(1, waitMs - waited)));
  }

  try {
    return await fn();
  } finally {
    try {
      const raw = await readFile(path, 'utf8');
      if (parse(raw)?.token === token) await unlink(path);
    } catch {
      // already gone or reclaimed: nothing of ours to remove
    }
  }
}

/** Remove a dead holder's lock. The claim is a rename, so only one reclaimer wins; a live lock grabbed by mistake is put back. */
async function reclaimIfStale(path: string, staleMs: number): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
    if (!(await isStale(path, raw, staleMs))) return;
  } catch {
    return; // vanished or unreadable: the next attempt decides
  }
  const claim = `${path}.reclaim-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    await rename(path, claim);
  } catch {
    return;
  }
  try {
    const taken = await readFile(claim, 'utf8');
    if (taken !== raw) await link(claim, path).catch(() => undefined); // not the lock we judged: restore it
  } finally {
    await unlink(claim).catch(() => undefined);
  }
}
