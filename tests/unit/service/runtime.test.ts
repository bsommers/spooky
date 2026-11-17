import { describe, expect, it, vi } from 'vitest';
import { Engine } from '../../../src/engine.js';
import { loadConfig } from '../../../src/config/load.js';
import { PERSONA, corpus, fastRetry } from '../../helpers/rig.js';
import { MockLlmClient } from '../../../src/llm/mockClient.js';
import { makeRuntime } from '../../helpers/surfaces.js';

describe('ServiceRuntime state refresh', () => {
  it('after a local ingest the state is re-read on the next read (our own write is not recorded as "seen"), and not again after that', async () => {
    const rig = await makeRuntime();
    const load = vi.spyOn(rig.engine, 'load');
    try {
      await rig.runtime.run('ingest', { authorId: 'second', name: 'Second', text: corpus() });
      expect(load).not.toHaveBeenCalled();
      const authors = await rig.runtime.run('authors', {});
      expect((authors.authors as { authorId: string }[]).map((a) => a.authorId)).toEqual(['second', 'terse']);
      expect(load).toHaveBeenCalledTimes(1);
      await rig.runtime.run('authors', {});
      expect(load).toHaveBeenCalledTimes(1); // unchanged files: no reload
    } finally {
      rig.cleanup();
    }
  });

  it('a write by another process that lands right after our ingest is picked up, not masked', async () => {
    const rig = await makeRuntime({ ingest: false });
    try {
      await rig.runtime.run('ingest', { authorId: 'mine', name: 'Mine', text: corpus() });
      // another process (a second Engine on the same state dir) ingests immediately afterwards
      const other = await Engine.create({ config: loadConfig({ llm: { model: 'm' }, personas: [PERSONA], limits: { maxInputChars: 5000 } }), stateDir: rig.stateDir, llm: new MockLlmClient([]), retry: fastRetry, env: {} });
      await other.ingest('theirs', 'Theirs', corpus());
      const authors = await rig.runtime.run('authors', {});
      expect((authors.authors as { authorId: string }[]).map((a) => a.authorId).sort()).toEqual(['mine', 'theirs']);
    } finally {
      rig.cleanup();
    }
  });
});
