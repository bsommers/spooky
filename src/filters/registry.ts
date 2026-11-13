// Config -> pipeline wiring (FLT-04): the ordered `filters.pipeline` list decides which filters run, in what order,
// at which stage, and with which error policy. No code changes are needed to enable, disable or reorder a filter.
import { firstFilterAfterFinalConfidentiality } from '../../config/filters.js';
import { DEFAULT_PHRASES } from '../../config/phrases.js';
import { ConfigError } from '../models/errors.js';
import type { Filter, FilterSpec, Stage } from '../models/types.js';
import { ConfidentialityFilter } from './confidentiality.js';
import type { ConfidentialityOptions } from './confidentiality.js';
import { FilterPipeline } from './pipeline.js';
import { StyleFilter } from './style.js';
import type { PhraseEntry, RhythmSettings } from './style.js';

/** Builds one filter instance from its config entry. */
export type FilterFactory = (spec: FilterSpec) => Filter;
export type FilterFactories = Readonly<Record<string, FilterFactory>>;

/**
 * Per-filter construction options that do not live in the pipeline config entry (blocklist, custom rules, phrase
 * list). The config schema only carries `{name,stage,onError,enabled}`; callers pass these programmatically.
 */
export interface BuiltinFilterOptions {
  confidentiality?: ConfidentialityOptions;
  style?: { phrases?: readonly PhraseEntry[]; rhythm?: Partial<RhythmSettings> };
}

/** The factories for the two built-in filters. */
export function defaultFactories(options: BuiltinFilterOptions = {}): FilterFactories {
  return {
    confidentiality: (spec) => {
      // loadConfig already rejects this; a hand-built config must not be able to relax it either.
      if (spec.onError !== 'fail-closed') throw new ConfigError('confidentiality must be fail-closed');
      return new ConfidentialityFilter(options.confidentiality);
    },
    style: (spec) =>
      new StyleFilter({
        phrases: options.style?.phrases ?? DEFAULT_PHRASES,
        onError: spec.onError,
        ...(options.style?.rhythm ? { rhythm: options.style.rhythm } : {}),
      }),
  };
}

const appliesAt = (spec: FilterSpec, stage: Stage): boolean => spec.stage === stage || spec.stage === 'both';

/**
 * Build the pipeline for one stage from `cfg.filters.pipeline`: disabled entries are dropped, entries for other
 * stages are dropped, the rest are built in list order.
 *
 * Throws `ConfigError` for an unknown filter name, an entry whose filter cannot run at the stage it names, two entries
 * with the same name at one stage, or (defence in depth for hand-built configs) a stage with no enabled fail-closed
 * confidentiality filter, or at `post` any enabled filter ordered after the final confidentiality filter.
 */
export function buildPipeline(
  cfg: { filters: { pipeline: readonly FilterSpec[] } },
  stage: Stage,
  factories: FilterFactories = defaultFactories(),
): FilterPipeline {
  const specs = cfg.filters.pipeline;
  const guarded = specs.some(
    (s) => s.name === 'confidentiality' && s.enabled && s.onError === 'fail-closed' && appliesAt(s, stage),
  );
  if (!guarded) {
    throw new ConfigError(`confidentiality must be enabled and fail-closed at stage "${stage}"`, [
      { path: 'filters.pipeline', message: `no enabled fail-closed confidentiality filter at stage "${stage}"` },
    ]);
  }
  if (stage === 'post') {
    const late = firstFilterAfterFinalConfidentiality(specs);
    if (late !== -1) {
      throw new ConfigError(`confidentiality must be the last enabled filter at stage "post"; "${specs[late]?.name}" runs after it`, [
        { path: `filters.pipeline[${late}]`, message: 'runs after the final confidentiality filter at stage "post"' },
      ]);
    }
  }

  const pipeline = new FilterPipeline({ stage, requireConfidentiality: true });
  specs.forEach((spec, i) => {
    if (!spec.enabled || !appliesAt(spec, stage)) return;
    const factory = Object.hasOwn(factories, spec.name) ? factories[spec.name] : undefined;
    if (factory === undefined) {
      throw new ConfigError(`filters.pipeline[${i}]: no factory for filter "${spec.name}"`, [
        { path: `filters.pipeline[${i}].name`, message: `unknown filter "${spec.name}"` },
      ]);
    }
    const filter = factory(spec);
    if (filter.name !== spec.name) {
      throw new ConfigError(`filters.pipeline[${i}]: factory for "${spec.name}" built a filter named "${filter.name}"`);
    }
    if (!filter.stages.includes(stage)) {
      if (spec.stage === 'both') return; // "both" means "wherever the filter can run"
      throw new ConfigError(`filters.pipeline[${i}]: filter "${spec.name}" cannot run at stage "${stage}"`, [
        { path: `filters.pipeline[${i}].stage`, message: `"${spec.name}" does not support stage "${stage}"` },
      ]);
    }
    pipeline.use(filter);
  });
  return pipeline;
}

