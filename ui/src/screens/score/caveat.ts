// The weak-scorer caveat, shown on this screen whether or not a result is on it. tests/security/ui-score-caveat.test.ts
// fails if this text differs from HUMANIZE_CAVEAT in the operations registry (src/service/operations.ts), which every
// surface returns with a humanize result.
export const HUMANIZE_CAVEAT =
  'Scores are from the local heuristic, a weak and confounded proxy (held-out AUC 0.694, docs/CALIBRATION.md), not a detector verdict. A lower score is not evidence that any real detector would pass the text. No external detector has been tested (docs/HUMANIZING.md).';
