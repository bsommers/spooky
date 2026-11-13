// Shared wiring for orchestration / engine tests: real config, filters, embedder, store; scripted LLM.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/config/load.js';
import { HashEmbedder } from '../../src/embedding/hashEmbedder.js';
import { buildPipeline } from '../../src/filters/registry.js';
import type { FilterFactories } from '../../src/filters/registry.js';
import { MockLlmClient } from '../../src/llm/mockClient.js';
import type { MockStep } from '../../src/llm/mockClient.js';
import type { Config, Filter, FilterResult, PipelineContext } from '../../src/models/types.js';
import { Orchestrator } from '../../src/orchestration/orchestrator.js';
import type { OrchestratorDeps } from '../../src/orchestration/orchestrator.js';
import { SourceManager } from '../../src/registry/sourceManager.js';
import { TargetManager } from '../../src/registry/targetManager.js';
import { InMemoryVectorStore } from '../../src/store/inMemoryVectorStore.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
export const corpus = (name = 'terse-technical.txt'): string => readFileSync(join(fixtures, 'authors', name), 'utf8');

export const PERSONA = {
  key: 'exec',
  name: 'Executive',
  cognitiveLoad: 'low',
  informationDensity: 'medium',
  structuralMandates: ['lead with the decision'],
  bannedPhrases: ['synergy'],
};

export const fastRetry = { baseMs: 0, sleep: async () => undefined } as const;

export interface Rig {
  config: Config;
  sources: SourceManager;
  targets: TargetManager;
  llm: MockLlmClient;
  orchestrator: Orchestrator;
  deps: OrchestratorDeps;
}

export async function makeRig(
  script: MockStep[] | ((req: never, n: number) => string) = ['A clean rewritten paragraph.'],
  opts: { config?: unknown; factories?: FilterFactories; ingest?: boolean; deps?: Partial<OrchestratorDeps> } = {},
): Promise<Rig> {
  const config = loadConfig(opts.config ?? { llm: { model: 'm' }, personas: [PERSONA], limits: { maxInputChars: 5000 } });
  const pre = buildPipeline(config, 'pre', opts.factories);
  const post = buildPipeline(config, 'post', opts.factories);
  const sources = new SourceManager({ store: new InMemoryVectorStore(), embedder: new HashEmbedder(), confidentiality: pre, chunkCfg: config.chunk });
  if (opts.ingest !== false) await sources.ingest('terse', 'Terse Author', corpus());
  const targets = new TargetManager(Object.fromEntries(config.personas.map((p) => [p.key, p])));
  const llm = new MockLlmClient(script as MockStep[]);
  const deps: OrchestratorDeps = { config, sources, targets, pre, post, llm, retry: fastRetry, ...opts.deps };
  return { config, sources, targets, llm, orchestrator: new Orchestrator(deps), deps };
}

/** A pass-through filter named `name` that records every call. */
export class SpyFilter implements Filter {
  calls: Array<{ text: string; ctx: PipelineContext }> = [];
  constructor(
    readonly name: string,
    readonly stages: readonly ('pre' | 'post')[] = ['pre', 'post'],
    readonly onError: 'fail-closed' | 'skip' = 'fail-closed',
    private readonly inner?: Filter,
    private readonly failWith?: Error,
  ) {}
  async process(text: string, ctx: PipelineContext): Promise<FilterResult> {
    this.calls.push({ text, ctx });
    if (this.failWith) throw this.failWith;
    if (this.inner) return this.inner.process(text, ctx);
    return { content: text, modified: false, metadata: {} };
  }
}
