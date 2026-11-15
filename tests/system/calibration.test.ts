// Calibration gate (SCR-04). Ships only if the local heuristic separates the labeled fixture corpus with AUC >= 0.70.
// If it does not, the PLAN fails: do not lower the threshold. docs/CALIBRATION.md must record the measured value; this
// test recomputes it and fails when the doc drifts from the code or the corpus.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CI_LOWER_FLOOR, DOC_BEGIN, DOC_END, MIN_AUC, loadCorpus, neutralizeTypography, packageRoot, renderDocBlock, runCalibration, spliceDocBlock } from '../../scripts/calibrate.js';

const corpus = loadCorpus();
const report = runCalibration(corpus);

describe('calibration corpus', () => {
  it('has at least 30 human and 30 AI samples, each with provenance', () => {
    expect(report.counts.human).toBeGreaterThanOrEqual(30);
    expect(report.counts.ai).toBeGreaterThanOrEqual(30);
    for (const s of corpus) {
      expect(s.source.length, s.file).toBeGreaterThan(10);
      expect(s.license.length, s.file).toBeGreaterThan(3);
      if (s.label === 'human') expect(s.url, s.file).toMatch(/^https:\/\//);
      if (s.label === 'ai') expect(s.prompt, s.file).toBeTruthy();
    }
  });

  it('files are plain prose: no provenance header inside the scored text, and a usable length', () => {
    for (const s of corpus) {
      expect(s.text, s.file).not.toMatch(/provenance|Project Gutenberg|\*\*\* START/i);
      expect(s.text.split(/\s+/).length, s.file).toBeGreaterThanOrEqual(100);
    }
  });
});

describe('calibration', () => {
  it(`point-estimate AUC on the labeled corpus is at least ${MIN_AUC}`, () => {
    expect(report.auc).toBeGreaterThanOrEqual(MIN_AUC);
  });

  // The point estimate alone is a weak gate: the 95% interval's lower bound must at least clear chance. It does NOT have
  // to reach MIN_AUC (it does not today; docs/CALIBRATION.md says so in the generated table). Do not weaken this to pass.
  it(`the 95% bootstrap interval's lower bound is above chance (${CI_LOWER_FLOOR})`, () => {
    expect(report.ci95.lo).toBeGreaterThan(CI_LOWER_FLOOR);
  });

  it('docs/CALIBRATION.md generated block equals the regenerated report (every table cell, histogram, hashes)', () => {
    const doc = readFileSync(join(packageRoot(), 'docs', 'CALIBRATION.md'), 'utf8');
    expect(doc.includes(DOC_BEGIN) && doc.includes(DOC_END), 'markers missing; run npm run calibrate -- --update-doc').toBe(true);
    const a = doc.indexOf(DOC_BEGIN);
    const b = doc.indexOf(DOC_END) + DOC_END.length;
    expect(doc.slice(a, b), 'CALIBRATION.md is stale: run npm run calibrate -- --update-doc').toBe(renderDocBlock(report));
    expect(spliceDocBlock(doc, renderDocBlock(report))).toBe(doc);
  });

  it('prose claims outside the generated block still hold: lexicalDiversity and repetition point the wrong way', () => {
    expect(report.perFeature.lexicalDiversity?.auc).toBeLessThan(0.5);
    expect(report.perFeature.repetition?.auc).toBeLessThan(0.5);
  });

  it('every variant AUC is a number in [0,1] and the weight / phrase hashes are recorded', () => {
    for (const v of Object.values(report.variants)) expect(v >= 0 && v <= 1, String(v)).toBe(true);
    expect(report.hashes.weights).toMatch(/^[0-9a-f]{12}$/);
    expect(report.hashes.phrasesAndParams).toMatch(/^[0-9a-f]{12}$/);
  });

  it('is deterministic: scoring the corpus twice gives the identical report', () => {
    expect(runCalibration(corpus)).toEqual(report);
  });
});

describe('neutralizeTypography', () => {
  it('flattens curly quotes, dashes and semicolons and leaves plain prose alone', () => {
    expect(neutralizeTypography('He said \u201chi\u201d \u2014 it\u2019s fine; really -- ok')).toBe('He said "hi", it\'s fine, really, ok');
    expect(neutralizeTypography('Plain text, nothing to do.')).toBe('Plain text, nothing to do.');
  });
});
