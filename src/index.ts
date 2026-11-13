// Public entry point: shared types, typed errors, the config loader, and the filter pipeline.
export type * from './models/types.js';
export * from './models/errors.js';
export { loadConfig } from './config/load.js';
export { FilterPipeline } from './filters/pipeline.js';
export { buildPipeline, defaultFactories } from './filters/registry.js';
export type { BuiltinFilterOptions, FilterFactories, FilterFactory } from './filters/registry.js';
export { ConfidentialityFilter } from './filters/confidentiality.js';
export type { ConfidentialityOptions, CustomRule } from './filters/confidentiality.js';
export { StyleFilter } from './filters/style.js';
export type { PhraseEntry, RhythmSettings, StyleOptions } from './filters/style.js';
export { TargetManager } from './registry/targetManager.js';
export { buildPrompt } from './pipeline/promptBuilder.js';
export type { BuildPromptArgs, BuiltPrompt } from './pipeline/promptBuilder.js';
export { splitProtected, join as joinSegments } from './filters/protectedSpans.js';
export type { Segment } from './filters/protectedSpans.js';
