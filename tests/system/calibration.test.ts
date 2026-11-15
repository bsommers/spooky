// Calibration gate (SCR-04). Ships only if the local heuristic separates the labeled fixture corpus with AUC >= 0.70.
// If it does not, the PLAN fails: do not lower the threshold. docs/CALIBRATION.md must record the measured value; this
// test recomputes it and fails when the doc drifts from the code or the corpus.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadCorpus, packageRoot, runCalibration } from '../../scripts/calibrate.js';

const MIN_AUC = 0.7;
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
  it(`AUC on the labeled corpus is at least ${MIN_AUC}`, () => {
    expect(report.auc).toBeGreaterThanOrEqual(MIN_AUC);
  });

  it('docs/CALIBRATION.md records the measured AUC and corpus size', () => {
    const doc = readFileSync(join(packageRoot(), 'docs', 'CALIBRATION.md'), 'utf8');
    const m = /<!-- calibration: auc=([0-9.]+) human=(\d+) ai=(\d+) -->/.exec(doc);
    expect(m, 'CALIBRATION.md must contain the <!-- calibration: auc=... human=N ai=N --> marker').not.toBeNull();
    expect(Number(m?.[1])).toBe(report.auc);
    expect(Number(m?.[2])).toBe(report.counts.human);
    expect(Number(m?.[3])).toBe(report.counts.ai);
  });

  it('is deterministic: scoring the corpus twice gives the identical report', () => {
    expect(runCalibration(corpus)).toEqual(report);
  });
});
