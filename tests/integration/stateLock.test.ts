// CR-04: the state directory is guarded by an advisory lock; overlapping ingests merge instead of overwriting.
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Engine } from '../../src/engine.js';
import { loadConfig } from '../../src/config/load.js';
import { MockLlmClient } from '../../src/llm/mockClient.js';
import { ConfigError, StateLockedError } from '../../src/models/errors.js';
import { LOCK_FILE, withStateLock } from '../../src/registry/stateLock.js';
import { runCli } from '../helpers/cli.js';
import { PERSONA, corpus } from '../helpers/rig.js';

let dir = '';
beforeEach(async () => void (dir = await mkdtemp(join(tmpdir(), 'gw-lock-'))));
afterEach(async () => rm(dir, { recursive: true, force: true }));

const lockPath = () => join(dir, LOCK_FILE);
const cfg = () => loadConfig({ llm: { model: 'm' }, personas: [PERSONA] });
const engine = (stateLock = {}) => Engine.create({ config: cfg(), stateDir: dir, llm: new MockLlmClient(), stateLock });
const writeLock = (info: Record<string, unknown>) => writeFile(lockPath(), JSON.stringify(info));
const deadPid = (): number => {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
  return Number(r.stdout.toString());
};

describe('Engine.ingest under the state lock', () => {
  it('overlapping ingests from engines that loaded the same (empty) state keep both authors', async () => {
    const a = await engine();
    const b = await engine();
    await Promise.all([a.ingest('ann', 'Ann', corpus()), b.ingest('bob', 'Bob', corpus('verbose-hedging.txt'))]);
    const fresh = await engine();
    expect(fresh.getProfile('ann').authorId).toBe('ann');
    expect(fresh.getProfile('bob').authorId).toBe('bob');
    expect((await readdir(dir)).sort()).toEqual(['profiles.json', 'store.json']); // lock released, no temp files
  });

  it('releases the lock when the ingest fails', async () => {
    const e = await engine();
    await expect(e.ingest('bad id!', 'X', corpus())).rejects.toBeInstanceOf(ConfigError);
    expect(await readdir(dir)).not.toContain(LOCK_FILE);
  });
});

describe('withStateLock', () => {
  it('a live holder makes a second caller fail with StateLockedError after the bounded wait, and keeps the lock', async () => {
    let inner = false;
    await withStateLock(dir, async () => {
      const t0 = Date.now();
      await expect(
        withStateLock(dir, async () => void (inner = true), { waitMs: 150, pollMs: 10 }),
      ).rejects.toBeInstanceOf(StateLockedError);
      expect(Date.now() - t0).toBeLessThan(2000);
      expect(await readdir(dir)).toContain(LOCK_FILE); // the loser did not delete the winner's lock
    });
    expect(inner).toBe(false);
    expect(await readdir(dir)).not.toContain(LOCK_FILE);
  });

  it('reclaims a lock whose process is gone', async () => {
    await writeLock({ pid: deadPid(), host: hostname(), token: 'dead', at: Date.now() });
    await expect(withStateLock(dir, async () => 'ran', { waitMs: 500, pollMs: 10 })).resolves.toBe('ran');
    expect(await readdir(dir)).not.toContain(LOCK_FILE);
  });

  it('reclaims a lock older than staleMs even when its pid looks alive', async () => {
    await writeLock({ pid: process.pid, host: hostname(), token: 'old', at: Date.now() - 60_000 });
    await expect(withStateLock(dir, async () => 'ran', { waitMs: 500, pollMs: 10, staleMs: 1000 })).resolves.toBe('ran');
  });

  it('does not reclaim a fresh lock held by a live process on this host', async () => {
    await writeLock({ pid: process.pid, host: hostname(), token: 'mine', at: Date.now() });
    await expect(withStateLock(dir, async () => 'ran', { waitMs: 100, pollMs: 10 })).rejects.toBeInstanceOf(StateLockedError);
    expect(JSON.parse(await readFile(lockPath(), 'utf8')).token).toBe('mine');
  });

  it('treats an unparseable fresh lock as held and an old one as stale', async () => {
    await writeFile(lockPath(), 'not json');
    await expect(withStateLock(dir, async () => 'ran', { waitMs: 100, pollMs: 10 })).rejects.toBeInstanceOf(StateLockedError);
    await expect(withStateLock(dir, async () => 'ran', { waitMs: 500, pollMs: 10, staleMs: -1 })).resolves.toBe('ran');
  });

  it('creates the directory (0700) and the lock file is mode 0600 while held', async () => {
    const sub = join(dir, 'new', 'state');
    await withStateLock(sub, async () => {
      const { statSync } = await import('node:fs');
      expect(statSync(join(sub, LOCK_FILE)).mode & 0o777).toBe(0o600);
      expect(statSync(sub).mode & 0o777).toBe(0o700);
    });
  });

  it('serializes concurrent critical sections', async () => {
    let active = 0;
    let max = 0;
    await Promise.all(
      Array.from({ length: 5 }, () =>
        withStateLock(
          dir,
          async () => {
            max = Math.max(max, ++active);
            await new Promise((r) => setTimeout(r, 10));
            active--;
          },
          { pollMs: 5 },
        ),
      ),
    );
    expect(max).toBe(1);
  });
});

describe('cli ingest with a held state lock', () => {
  it('exits 8 with a STATE_LOCKED json document and writes nothing', async () => {
    await mkdir(dir, { recursive: true });
    await writeLock({ pid: process.pid, host: hostname(), token: 'held', at: Date.now() });
    const cfgPath = join(dir, 'config.json');
    const corpusPath = join(dir, 'corpus.txt');
    await writeFile(cfgPath, JSON.stringify({ llm: { model: 'm' }, personas: [PERSONA] }));
    await writeFile(corpusPath, corpus());
    const r = await runCli(['ingest', '--author', 'ann', '--name', 'Ann', corpusPath, '--config', cfgPath, '--state-dir', dir, '--json'], {}, { stateLock: { waitMs: 100, pollMs: 10 } });
    expect(r.code).toBe(8);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false, error: { code: 'STATE_LOCKED' } });
    expect(r.out).not.toContain(dir);
    expect(await readdir(dir)).not.toContain('store.json');
  });
});
