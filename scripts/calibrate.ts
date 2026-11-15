// Calibration harness (SCR-04): scores the labeled fixture corpus with the local heuristic and reports AUC, a bootstrap
// interval, per-feature AUC, score distributions and a few confound checks. Read-only: it prints, it never edits the
// scorer or the docs. The numbers in docs/CALIBRATION.md come from this script (a test re-computes and compares them).
//
//   npm run calibrate            # markdown report on stdout
//   npm run calibrate -- --json  # the same data as one JSON document
//   npm run calibrate -- --weights '{"repetition":0}'   # exploratory what-if with other weights (in-sample)
//   npm run calibrate -- --update-doc                    # regenerate the marked block of docs/CALIBRATION.md
//
// Corpus: tests/fixtures/corpus/{human,ai}/*.txt plus tests/fixtures/corpus/manifest.json (provenance per file).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CLICHE_PHRASES, DEFAULT_SCORER_WEIGHTS, FEATURE_NAMES, FEATURE_PARAMS } from '../config/scorer.js';
import { auc, bestThreshold, bootstrapAuc, histogram, mean } from '../src/scoring/calibration.js';
import type { Labeled } from '../src/scoring/calibration.js';
import { ConfigError } from '../src/models/errors.js';
import { HeuristicScorer } from '../src/scoring/scorer.js';

export interface ManifestEntry {
  file: string;
  label: 'human' | 'ai';
  source: string;
  url?: string;
  prompt?: string;
  license: string;
  note: string;
}
export interface CorpusSample extends ManifestEntry {
  text: string;
}

/** Nearest ancestor directory holding a package.json (works from scripts/ and from dist/scripts/). */
export function packageRoot(from = dirname(fileURLToPath(import.meta.url))): string {
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    if (dirname(dir) === dir) throw new Error('package.json not found');
  }
}

export function corpusDir(root = packageRoot()): string {
  return join(root, 'tests', 'fixtures', 'corpus');
}

/** Load every corpus file with its manifest entry. Throws if a file has no entry or an entry has no file. */
export function loadCorpus(dir = corpusDir()): CorpusSample[] {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { files: ManifestEntry[] };
  const onDisk = ['human', 'ai'].flatMap((label) => readdirSync(join(dir, label)).filter((f) => f.endsWith('.txt')).sort().map((f) => `${label}/${f}`));
  const listed = manifest.files.map((e) => e.file).sort();
  const missingEntry = onDisk.filter((f) => !listed.includes(f));
  const missingFile = listed.filter((f) => !onDisk.includes(f));
  if (missingEntry.length > 0 || missingFile.length > 0) {
    throw new Error(`corpus/manifest mismatch: no manifest entry for [${missingEntry.join(', ')}]; no file for [${missingFile.join(', ')}]`);
  }
  return manifest.files.map((e) => {
    if (!e.file.startsWith(`${e.label}/`)) throw new Error(`manifest: ${e.file} is labeled ${e.label} but lives elsewhere`);
    if (!e.source || !e.license) throw new Error(`manifest: ${e.file} lacks provenance`);
    return { ...e, text: readFileSync(join(dir, e.file), 'utf8') };
  });
}

const words = (t: string): number => t.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
const round = (x: number, d = 4): number => Math.round(x * 10 ** d) / 10 ** d;

export interface CalibrationReport {
  counts: { human: number; ai: number };
  auc: number;
  ci95: { lo: number; hi: number };
  meanScore: { human: number; ai: number };
  histogram: { bins: number; human: number[]; ai: number[] };
  bestThreshold: { threshold: number; accuracy: number };
  accuracyAt05: number;
  perFeature: Record<string, { auc: number; humanAvailable: number; aiAvailable: number }>;
  confounds: { wordCountOnlyAuc: number; aiVsLiteraryHumanAuc: number; aiVsRfcHumanAuc: number; evenIndexAuc: number; oddIndexAuc: number };
  words: { humanMean: number; aiMean: number };
  /** Same per-feature AUC, restricted to AI vs the RFC human samples (technical prose, the closest genre match). */
  perFeatureRfc: Record<string, number>;
  /** Raw typographic markers per class (counted on the files as stored). */
  typography: Record<'human' | 'ai', TypographyCounts>;
  /** Headline AUC with parts of the scorer removed or the text normalized. All computed with the weights in effect, in-sample. */
  variants: {
    noPunctuationAuc: number;
    noClicheAuc: number;
    noPunctuationNoClicheAuc: number;
    typographyNeutralizedAuc: number;
    typographyNeutralizedNoClicheAuc: number;
    typographyNeutralizedRfcAuc: number;
  };
  /** lexicalDiversity and repetition set to weight 0: chosen after looking at the per-feature table, so in-sample. */
  exploratory: { auc: number; ci95: { lo: number; hi: number }; rfcAuc: number };
  corpus: { literary: number; rfc: number };
  /** The ship gate: the point estimate must reach `minAuc`; the interval's lower bound must at least clear chance. */
  gate: { minAuc: number; aucMet: boolean; ciLowerFloor: number; ciLowerAboveFloor: boolean; ciLowerClearsMinAuc: boolean };
  /** Short sha256 of the shipped weights / phrase list + curve constants: changes when either is edited. */
  hashes: { weights: string; phrasesAndParams: string };
}

export interface TypographyCounts {
  files: number;
  filesWithNonAscii: number;
  emDashes: number;
  semicolons: number;
  curlyDoubleQuotes: number;
  curlyApostrophes: number;
}

export const MIN_AUC = 0.7;
export const CI_LOWER_FLOOR = 0.5;
export const DOC_BEGIN = '<!-- calibration:begin (generated by `npm run calibrate -- --update-doc`; do not edit by hand) -->';
export const DOC_END = '<!-- calibration:end -->';

const sha = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 12);
const count = (t: string, re: RegExp): number => t.match(re)?.length ?? 0;

/** Remove the typographic marks that separate the two classes of this corpus (curly quotes, em/en dashes, ` -- `, semicolons) from the text. */
export function neutralizeTypography(text: string): string {
  return text
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s*(?:[\u2014\u2013]|--)\s*/g, ', ')
    .replace(/;/g, ',');
}

export function runCalibration(corpus: readonly CorpusSample[] = loadCorpus(), weights?: Record<string, number>): CalibrationReport {
  const scorer = new HeuristicScorer(weights);
  const rows = corpus.map((s) => ({ s, label: (s.label === 'ai' ? 1 : 0) as 0 | 1, b: scorer.score(s.text), words: words(s.text) }));
  const labeled: Labeled[] = rows.map((r) => ({ score: r.b.score, label: r.label }));
  const of = (label: 0 | 1) => rows.filter((r) => r.label === label);

  const perFeature: CalibrationReport['perFeature'] = {};
  for (const name of FEATURE_NAMES) {
    const have = rows.filter((r) => (r.b.features[name]?.weight ?? 0) > 0);
    perFeature[name] = {
      auc: round(auc(have.map((r) => ({ score: r.b.features[name]?.value ?? 0.5, label: r.label })))),
      humanAvailable: have.filter((r) => r.label === 0).length,
      aiAvailable: have.filter((r) => r.label === 1).length,
    };
  }
  const subset = (pred: (r: (typeof rows)[number]) => boolean): Labeled[] => rows.filter(pred).map((r) => ({ score: r.b.score, label: r.label }));
  const isRfc = (r: (typeof rows)[number]): boolean => (r.s.url ?? '').includes('rfc-editor.org');
  const best = bestThreshold(labeled);
  const aucWith = (override: Record<string, number>, prep: (t: string) => string = (t) => t, only?: (r: (typeof rows)[number]) => boolean): number => {
    const sc = new HeuristicScorer({ ...(weights ?? {}), ...override });
    return round(auc(rows.filter(only ?? (() => true)).map((r) => ({ score: sc.score(prep(r.s.text)).score, label: r.label }))));
  };
  const typo = (label: 'human' | 'ai'): TypographyCounts => {
    const texts = corpus.filter((s) => s.label === label).map((s) => s.text);
    return {
      files: texts.length,
      filesWithNonAscii: texts.filter((t) => /[^\x00-\x7f]/.test(t)).length,
      emDashes: texts.reduce((a, t) => a + count(t, /\u2014/g), 0),
      semicolons: texts.reduce((a, t) => a + count(t, /;/g), 0),
      curlyDoubleQuotes: texts.reduce((a, t) => a + count(t, /[\u201c\u201d]/g), 0),
      curlyApostrophes: texts.reduce((a, t) => a + count(t, /[\u2018\u2019]/g), 0),
    };
  };
  const rfcRows = (r: (typeof rows)[number]): boolean => r.label === 1 || isRfc(r);
  const perFeatureRfc: Record<string, number> = {};
  for (const name of FEATURE_NAMES) {
    const have = rows.filter((r) => rfcRows(r) && (r.b.features[name]?.weight ?? 0) > 0);
    perFeatureRfc[name] = round(auc(have.map((r) => ({ score: r.b.features[name]?.value ?? 0.5, label: r.label }))));
  }
  const explore = new HeuristicScorer({ ...(weights ?? {}), lexicalDiversity: 0, repetition: 0 });
  const exploreLabeled = rows.map((r) => ({ score: explore.score(r.s.text).score, label: r.label }));
  const exploreRfc = rows.filter(rfcRows).map((r) => ({ score: explore.score(r.s.text).score, label: r.label }));
  const headlineAuc = round(auc(labeled));
  const ci95 = (({ lo, hi }) => ({ lo: round(lo), hi: round(hi) }))(bootstrapAuc(labeled));
  return {
    counts: { human: of(0).length, ai: of(1).length },
    auc: headlineAuc,
    ci95,
    meanScore: { human: round(mean(of(0).map((r) => r.b.score))), ai: round(mean(of(1).map((r) => r.b.score))) },
    histogram: { bins: 10, human: histogram(of(0).map((r) => r.b.score)), ai: histogram(of(1).map((r) => r.b.score)) },
    bestThreshold: { threshold: round(best.threshold), accuracy: round(best.accuracy) },
    accuracyAt05: round(labeled.filter((x) => (x.score >= 0.5 ? 1 : 0) === x.label).length / labeled.length),
    perFeature,
    confounds: {
      wordCountOnlyAuc: round(auc(rows.map((r) => ({ score: r.words, label: r.label })))),
      aiVsLiteraryHumanAuc: round(auc(subset((r) => r.label === 1 || !isRfc(r)))),
      aiVsRfcHumanAuc: round(auc(subset((r) => r.label === 1 || isRfc(r)))),
      evenIndexAuc: round(auc(rows.map((r, i) => ({ r, i })).filter((x) => x.i % 2 === 0).map((x) => ({ score: x.r.b.score, label: x.r.label })))),
      oddIndexAuc: round(auc(rows.map((r, i) => ({ r, i })).filter((x) => x.i % 2 === 1).map((x) => ({ score: x.r.b.score, label: x.r.label })))),
    },
    words: { humanMean: round(mean(of(0).map((r) => r.words)), 1), aiMean: round(mean(of(1).map((r) => r.words)), 1) },
    perFeatureRfc,
    typography: { human: typo('human'), ai: typo('ai') },
    variants: {
      noPunctuationAuc: aucWith({ punctuation: 0 }),
      noClicheAuc: aucWith({ cliche: 0 }),
      noPunctuationNoClicheAuc: aucWith({ punctuation: 0, cliche: 0 }),
      typographyNeutralizedAuc: aucWith({}, neutralizeTypography),
      typographyNeutralizedNoClicheAuc: aucWith({ cliche: 0 }, neutralizeTypography),
      typographyNeutralizedRfcAuc: aucWith({}, neutralizeTypography, rfcRows),
    },
    exploratory: {
      auc: round(auc(exploreLabeled)),
      ci95: (({ lo, hi }) => ({ lo: round(lo), hi: round(hi) }))(bootstrapAuc(exploreLabeled)),
      rfcAuc: round(auc(exploreRfc)),
    },
    corpus: { literary: rows.filter((r) => r.label === 0 && !isRfc(r)).length, rfc: rows.filter((r) => r.label === 0 && isRfc(r)).length },
    gate: { minAuc: MIN_AUC, aucMet: headlineAuc >= MIN_AUC, ciLowerFloor: CI_LOWER_FLOOR, ciLowerAboveFloor: ci95.lo > CI_LOWER_FLOOR, ciLowerClearsMinAuc: ci95.lo >= MIN_AUC },
    hashes: { weights: sha(DEFAULT_SCORER_WEIGHTS), phrasesAndParams: sha({ CLICHE_PHRASES, FEATURE_PARAMS }) },
  };
}

const f4 = (x: number): string => x.toFixed(4);
const yes = (b: boolean): string => (b ? 'yes' : 'no');

/** The generated part of docs/CALIBRATION.md: every number in it comes from `r`. The test compares the file with this text. */
export function renderDocBlock(r: CalibrationReport): string {
  const L: string[] = [];
  const chance = (a: number): string => (a < 0.5 ? 'points the wrong way' : a === 0.5 ? 'no signal' : 'right way');
  L.push(DOC_BEGIN, `<!-- calibration: auc=${r.auc} human=${r.counts.human} ai=${r.counts.ai} -->`, '');
  L.push('### Headline', '', '| | |', '|---|---|');
  L.push(`| Corpus | ${r.counts.human} human-written (${r.corpus.literary} literary, ${r.corpus.rfc} RFC), ${r.counts.ai} AI-written; mean words ${r.words.humanMean} human / ${r.words.aiMean} AI |`);
  L.push(`| **AUC** (shipped default weights) | **${f4(r.auc)}** |`);
  L.push(`| 95% bootstrap interval | ${f4(r.ci95.lo)} to ${f4(r.ci95.hi)} (2000 stratified resamples, seed 20260101) |`);
  L.push(`| Gate: point estimate >= ${r.gate.minAuc} | ${r.gate.aucMet ? 'met' : 'NOT met'} |`);
  L.push(`| Gate: interval lower bound >= ${r.gate.minAuc} (statistically established) | ${r.gate.ciLowerClearsMinAuc ? 'met' : 'NOT met: the lower bound is below the gate, so "AUC >= 0.70" is not established, only the point estimate'} |`);
  L.push(`| Gate: interval lower bound above chance (${r.gate.ciLowerFloor}); enforced by the test | ${yes(r.gate.ciLowerAboveFloor)} |`);
  L.push(`| Accuracy at a fixed cut of 0.5 | ${f4(r.accuracyAt05)} |`);
  L.push(`| Best cut on the same data | ${f4(r.bestThreshold.threshold)} gives ${f4(r.bestThreshold.accuracy)} accuracy (chosen on the data it is measured on, so optimistic) |`);
  L.push(`| Mean score | human ${f4(r.meanScore.human)}, AI ${f4(r.meanScore.ai)} |`);
  L.push(`| Shipped weights / phrase list + curve constants (sha256 prefix) | \`${r.hashes.weights}\` / \`${r.hashes.phrasesAndParams}\` |`, '');
  L.push('```', 'score histogram (10 bins over [0,1])', 'bin        human | AI');
  for (let i = 0; i < r.histogram.bins; i++) {
    const h = r.histogram.human[i] ?? 0;
    const a = r.histogram.ai[i] ?? 0;
    L.push(`${(i / r.histogram.bins).toFixed(1)}-${((i + 1) / r.histogram.bins).toFixed(1)}  ${String(h).padStart(3)} ${'#'.repeat(h).padEnd(16)}| ${String(a).padStart(3)} ${'#'.repeat(a)}`.trimEnd());
  }
  L.push('```', '');
  L.push('### Per-feature results', '', 'AUC of the feature value alone (0.5 = no signal, below 0.5 = points the wrong way on this corpus). "RFC only" is AI vs the RFC human samples, where genre is matched best.', '');
  L.push('| Feature | AUC | Direction | Inverted AUC | RFC only | Computable (human / AI) |', '|---|---|---|---|---|---|');
  for (const [name, f] of Object.entries(r.perFeature).sort((a, b) => b[1].auc - a[1].auc)) {
    L.push(`| ${name} | ${f4(f.auc)} | ${chance(f.auc)} | ${f4(1 - f.auc)} | ${f4(r.perFeatureRfc[name] ?? Number.NaN)} | ${f.humanAvailable} / ${f.aiAvailable} |`);
  }
  L.push('');
  L.push('### Typography confound', '', 'The `punctuation` feature rewards semicolons, dashes and quote marks. Raw counts over the stored files:', '');
  L.push('| Class | Files | Files with non-ASCII | Em dashes | Semicolons | Curly double quotes | Curly apostrophes |', '|---|---|---|---|---|---|---|');
  for (const c of ['human', 'ai'] as const) {
    const t = r.typography[c];
    L.push(`| ${c} | ${t.files} | ${t.filesWithNonAscii} | ${t.emDashes} | ${t.semicolons} | ${t.curlyDoubleQuotes} | ${t.curlyApostrophes} |`);
  }
  L.push('', 'Headline AUC with parts of the scorer removed or the typography normalized in both classes (curly quotes to straight, em/en dashes and ` -- ` to a comma, semicolons to a comma):', '');
  L.push('| Variant | AUC |', '|---|---|');
  L.push(`| Shipped scorer, text as stored | ${f4(r.auc)} |`);
  L.push(`| \`punctuation\` weight 0 | ${f4(r.variants.noPunctuationAuc)} |`);
  L.push(`| \`cliche\` weight 0 (list is test-set contaminated; see "What was and was not tuned") | ${f4(r.variants.noClicheAuc)} |`);
  L.push(`| \`punctuation\` and \`cliche\` weight 0 | ${f4(r.variants.noPunctuationNoClicheAuc)} |`);
  L.push(`| Typography neutralized, all weights | ${f4(r.variants.typographyNeutralizedAuc)} |`);
  L.push(`| Typography neutralized, \`cliche\` weight 0 | ${f4(r.variants.typographyNeutralizedNoClicheAuc)} |`);
  L.push(`| Typography neutralized, AI vs RFC only | ${f4(r.variants.typographyNeutralizedRfcAuc)} |`, '');
  L.push('### Other confound checks', '', '| Check | AUC |', '|---|---|');
  L.push(`| Word count alone used as the score | ${f4(r.confounds.wordCountOnlyAuc)} (inverted ${f4(1 - r.confounds.wordCountOnlyAuc)}) |`);
  L.push(`| AI vs the ${r.corpus.literary} literary human samples only | ${f4(r.confounds.aiVsLiteraryHumanAuc)} |`);
  L.push(`| AI vs the ${r.corpus.rfc} RFC human samples only | ${f4(r.confounds.aiVsRfcHumanAuc)} |`);
  L.push(`| Two interleaved subsamples (even / odd index; weights are not fit, so NOT a holdout) | ${f4(r.confounds.evenIndexAuc)} / ${f4(r.confounds.oddIndexAuc)} |`, '');
  L.push('### Exploratory, in-sample, not adopted', '');
  L.push(`\`lexicalDiversity\` and \`repetition\` at weight 0: AUC ${f4(r.exploratory.auc)} (95% interval ${f4(r.exploratory.ci95.lo)} to ${f4(r.exploratory.ci95.hi)}), ${f4(r.exploratory.rfcAuc)} against the RFCs alone. Chosen after looking at the per-feature table above, so it is a fit to these samples and not evidence the weights generalize.`);
  L.push(DOC_END);
  return L.join('\n');
}

/** Replace the generated block of `doc` with `block`. `undefined` when the markers are missing. */
export function spliceDocBlock(doc: string, block: string): string | undefined {
  const a = doc.indexOf('<!-- calibration:begin');
  const b = doc.indexOf(DOC_END);
  if (a === -1 || b === -1 || b < a) return undefined;
  return doc.slice(0, a) + block + doc.slice(b + DOC_END.length);
}

function markdown(r: CalibrationReport): string {
  const bar = (n: number): string => '#'.repeat(n);
  const lines: string[] = [];
  lines.push(`corpus: ${r.counts.human} human, ${r.counts.ai} AI (mean words ${r.words.humanMean} / ${r.words.aiMean})`);
  lines.push(`AUC: ${r.auc.toFixed(4)}  (95% bootstrap CI ${r.ci95.lo.toFixed(4)} - ${r.ci95.hi.toFixed(4)}, 2000 stratified resamples, seed 20260101)`);
  lines.push(`mean score: human ${r.meanScore.human.toFixed(4)}, AI ${r.meanScore.ai.toFixed(4)}`);
  lines.push(`accuracy at threshold 0.5: ${r.accuracyAt05.toFixed(4)}; best cut on this same data: ${r.bestThreshold.threshold.toFixed(4)} -> ${r.bestThreshold.accuracy.toFixed(4)} (optimistic: chosen on the data it is measured on)`);
  lines.push('', 'score histogram (10 bins over [0,1])', 'bin        human | AI');
  for (let i = 0; i < r.histogram.bins; i++) {
    const lo = (i / r.histogram.bins).toFixed(1);
    const hi = ((i + 1) / r.histogram.bins).toFixed(1);
    lines.push(`${lo}-${hi}  ${String(r.histogram.human[i]).padStart(3)} ${bar(r.histogram.human[i] ?? 0).padEnd(14)}| ${String(r.histogram.ai[i]).padStart(3)} ${bar(r.histogram.ai[i] ?? 0)}`);
  }
  lines.push('', 'per-feature AUC (feature value alone; only samples where the feature was computable)');
  for (const [name, f] of Object.entries(r.perFeature)) lines.push(`${name.padEnd(20)} ${f.auc.toFixed(4)}  (computable: ${f.humanAvailable} human, ${f.aiAvailable} AI)`);
  lines.push('', 'confound checks');
  lines.push(`word count alone as the score: AUC ${r.confounds.wordCountOnlyAuc.toFixed(4)}`);
  lines.push(`AI vs literary human only: AUC ${r.confounds.aiVsLiteraryHumanAuc.toFixed(4)}; AI vs RFC human only: AUC ${r.confounds.aiVsRfcHumanAuc.toFixed(4)}`);
  lines.push('', 'per-feature AUC, AI vs RFC human only');
  for (const [name, v] of Object.entries(r.perFeatureRfc)) lines.push(`${name.padEnd(20)} ${v.toFixed(4)}`);
  lines.push('', 'variants (headline AUC)');
  for (const [name, v] of Object.entries(r.variants)) lines.push(`${name.padEnd(36)} ${v.toFixed(4)}`);
  lines.push(`gate: point estimate >= ${r.gate.minAuc}: ${yes(r.gate.aucMet)}; CI lower bound >= ${r.gate.minAuc}: ${yes(r.gate.ciLowerClearsMinAuc)}; CI lower bound > ${r.gate.ciLowerFloor}: ${yes(r.gate.ciLowerAboveFloor)}`);
  lines.push(`two interleaved subsamples (even / odd index; the weights are not fit, so this is NOT a holdout): AUC ${r.confounds.evenIndexAuc.toFixed(4)} / ${r.confounds.oddIndexAuc.toFixed(4)}`);
  return lines.join('\n');
}

const USAGE = `usage: calibrate [--json | --update-doc] [--weights '{"cliche":2,"repetition":0}']`;

/** Parse the value of `--weights` (a JSON object of feature weights). `ConfigError` with a one-line message for anything else. */
export function parseWeightsArg(raw: string | undefined): Record<string, number> {
  if (raw === undefined || raw.startsWith('--')) throw new ConfigError(`--weights needs a JSON object value; ${USAGE}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError(`--weights is not valid JSON; ${USAGE}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ConfigError(`--weights must be a JSON object; ${USAGE}`);
  return parsed as Record<string, number>;
}

function main(): number {
  try {
    // Exploratory what-if only: `--weights '{"cliche":2,"repetition":0}'` merges over the default weights. Never changes the shipped defaults.
    const i = process.argv.indexOf('--weights');
    const weights = i === -1 ? undefined : parseWeightsArg(process.argv[i + 1]);
    const report = runCalibration(undefined, weights);
    if (process.argv.includes('--update-doc')) {
      if (weights !== undefined) throw new ConfigError('--update-doc records the shipped defaults; it cannot be combined with --weights');
      const path = join(packageRoot(), 'docs', 'CALIBRATION.md');
      const next = spliceDocBlock(readFileSync(path, 'utf8'), renderDocBlock(report));
      if (next === undefined) throw new ConfigError('docs/CALIBRATION.md has no calibration:begin / calibration:end markers');
      writeFileSync(path, next);
      process.stdout.write('docs/CALIBRATION.md updated\n');
      return 0;
    }
    process.stdout.write(process.argv.includes('--json') ? `${JSON.stringify(report, null, 2)}\n` : `${markdown(report)}\n`);
    return 0;
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    process.stderr.write(`calibrate: ${err.message}\n`);
    return 2;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = main();
