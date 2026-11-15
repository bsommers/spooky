// Calibration harness (SCR-04): scores the labeled fixture corpus with the local heuristic and reports AUC, a bootstrap
// interval, per-feature AUC, score distributions and a few confound checks. Read-only: it prints, it never edits the
// scorer or the docs. The numbers in docs/CALIBRATION.md come from this script (a test re-computes and compares them).
//
//   npm run calibrate            # markdown report on stdout
//   npm run calibrate -- --json  # the same data as one JSON document
//   npm run calibrate -- --weights '{"repetition":0}'   # exploratory what-if with other weights (in-sample)
//
// Corpus: tests/fixtures/corpus/{human,ai}/*.txt plus tests/fixtures/corpus/manifest.json (provenance per file).
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FEATURE_NAMES } from '../config/scorer.js';
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
  return {
    counts: { human: of(0).length, ai: of(1).length },
    auc: round(auc(labeled)),
    ci95: (({ lo, hi }) => ({ lo: round(lo), hi: round(hi) }))(bootstrapAuc(labeled)),
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
  };
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
  lines.push(`two interleaved subsamples (even / odd index; the weights are not fit, so this is NOT a holdout): AUC ${r.confounds.evenIndexAuc.toFixed(4)} / ${r.confounds.oddIndexAuc.toFixed(4)}`);
  return lines.join('\n');
}

const USAGE = `usage: calibrate [--json] [--weights '{"cliche":2,"repetition":0}']`;

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
    process.stdout.write(process.argv.includes('--json') ? `${JSON.stringify(report, null, 2)}\n` : `${markdown(report)}\n`);
    return 0;
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    process.stderr.write(`calibrate: ${err.message}\n`);
    return 2;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = main();
