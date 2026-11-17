---
phase: 07-scorer
reviewed: 2026-11-14T00:00:00Z
depth: deep
files_reviewed: 14
files_reviewed_list:
  - config/scorer.ts
  - src/scoring/features.ts
  - src/scoring/scorer.ts
  - src/scoring/detectorAdapter.ts
  - src/scoring/ensemble.ts
  - src/scoring/calibration.ts
  - src/config/schema.ts
  - src/models/types.ts
  - src/engine.ts
  - src/cli/main.ts
  - scripts/calibrate.ts
  - docs/CALIBRATION.md
  - tests/system/calibration.test.ts
  - tests/fixtures/corpus/manifest.json
findings:
  critical: 0
  warning: 7
  info: 7
  total: 14
status: issues_found
---

# Phase 7: Code Review Report

**Reviewed:** 2026-11-14
**Depth:** deep
**Files Reviewed:** 14 (plus the 73 corpus fixtures, inspected statistically)

## Summary

Core scoring is sound. Features are pure and deterministic. The score is always in [0,1] with no NaN path: empty, whitespace and lone-surrogate input all return 0.5 with `insufficient_text`. Regexes are linear, and my adversarial inputs at 2M chars (dots, abbreviations, closers, fences, URLs) all finished in under 250 ms. The HTTP adapter is mostly well built: `redirect: 'error'`, a 64 KiB body cap, a timeout, and no URL or token in errors.

I re-ran `npm run calibrate` and every number in CALIBRATION.md reproduces: AUC 0.7293, CI 0.6026-0.8424, the per-feature AUCs, the confound AUCs, and the 0.8575 / 0.7715 exploratory figures. The doc is arithmetically honest. The problems are in what the corpus can support and in how weakly the doc is guarded. Details below.

## Warnings

### WR-01: AI fixtures contain no em dashes, semicolons or curly quotes, so the best feature (punctuation, AUC 0.8956) is largely a corpus artifact

**File:** `tests/fixtures/corpus/ai/*.txt`, `src/scoring/features.ts:119`, `docs/CALIBRATION.md:66,91-94`
**Issue:** Counted over the fixtures:
- Human: 40 em dashes, 53 semicolons, 42/41 curly double quotes, 60 curly apostrophes. 19 of 39 files contain non-ASCII characters.
- AI: 0 em dashes, 0 semicolons, 0 curly quotes. 0 of 34 files contain non-ASCII characters.

The `punctuation` feature rewards exactly these marks, and it counts the em dash as a human marker. Real assistant output is well known to be em-dash-heavy, so on real AI text this feature points the wrong way, as lexicalDiversity and repetition do on this corpus. The doc discloses the genre confound (literary vs RFC) but not this one. It does not break out any per-feature AUC on the RFC subset, where the punctuation advantage presumably vanishes: the RFC-only AUC is 0.509 overall. The "ranks AI above human 73% of the time" framing overstates what the corpus shows.
**Fix:**
1. Add a "typography confound" row to CALIBRATION.md with the counts above.
2. Normalize typography before scoring in the harness, and report that AUC (curly to straight quotes, em dash to " -- " in both classes).
3. Add AI fixtures that use semicolons and em dashes. Report per-feature AUC on the RFC-only subset.

### WR-02: Drift guard covers three numbers only, and the ship gate is a point estimate

**File:** `tests/system/calibration.test.ts:36-51`, `docs/CALIBRATION.md:8`
**Issue:** The test checks only the `<!-- auc= human= ai= -->` comment against the recomputed AUC and counts. The CI, accuracy, mean scores, histogram, all per-feature AUCs, all confound AUCs, the "wrong-direction" prose and the exploratory 0.8575 are unguarded. Someone can change a weight, the phrase list or a feature, and the visible table stays stale while the test passes, provided the headline AUC is unchanged.

The gate `report.auc >= 0.70` passes at 0.7293 while the 95% lower bound is 0.60. The doc says "met, by a margin smaller than the interval", but the test enforces nothing about that. It also does not assert that the shipped default weights equal those measured.
**Fix:**
- Generate the tables between markers (`<!-- calibration:begin -->` / `end`) from `runCalibration`. In the test, assert the file content between the markers equals the generated text.
- Alternatively, parse every numeric cell.
- Assert that `DEFAULT_SCORER_WEIGHTS` hashes to a value recorded in the doc.
- Gate on `ci95.lo` or state explicitly that the gate is not a significance test.

### WR-03: "Nothing tuned / pre-registered" is overstated, and the cliche feature is test-set contaminated by construction

**File:** `docs/CALIBRATION.md:47-58,77-78`, `config/scorer.ts:1-3,47-53`
**Issue:** The doc says the stock-phrase list was "fixed before the corpus was scored" and "nothing was tuned". The same doc and `config/scorer.ts` also say the list was written after the AI fixtures, with them in context, and that "phrases that appeared to be echoes of a specific fixture were removed". Deleting phrases because of what the fixtures contain is tuning on the corpus. The fixtures, the phrase list and the doc are all authored by one model, in one session, and the "before any feature was written" claim is self-attested. Git shows features at 23:15:47 and corpus at 23:20:25, with no external evidence about when the fixtures were written. The cliche AUC (0.7440) is flagged "optimistic", but the headline AUC includes it at weight 0.25 with no adjusted figure.
**Fix:**
- Report the headline AUC with `cliche` weight 0 next to the shipped figure.
- Reword to "weights and curves were fixed first; the phrase list was written with the AI fixtures in view".
- Drop "nothing was tuned".

### WR-04: CLI exits 0 when every named detector fails, and exclusion reasons discard the failure kind

**File:** `src/cli/main.ts` (score action, the `r.excluded` loop), `src/scoring/ensemble.ts:29-31`
**Issue:** `ghostwriter score --detector x` with an unset key env var, a timeout, an HTTP 500 or an oversize body prints a stderr warning and exits 0 with the local-only score. A script that asked for an external opinion cannot tell it did not get one. `reasonOf` returns `error:LlmTransportError` for timeout, http, network and too-large alike, and `error:ConfigError` for a missing key. The `kind` and `status` carried by `LlmTransportError` are dropped, so the user cannot tell the causes apart. The reason also uses an LLM-named class for a detector.
**Fix:**
- Add a distinct non-zero exit code (or a `--strict` flag) when any requested detector is excluded.
- In `reasonOf`, special-case errors that expose a safe `kind` and use `error:${kind}`.
- Wrap detector transport errors as `DetectorTransportError`.

### WR-05: Detector endpoint policy allows keyless cleartext egress and private or metadata hosts; apiKeyEnv can name any env var

**File:** `src/llm/endpoint.ts:28-34` (reused at `src/scoring/detectorAdapter.ts:60`, `src/config/schema.ts` detectorSchema)
**Issue:** Without `apiKeyEnv`, any `http://` host is accepted, including remote hosts, `169.254.169.254` and RFC1918 ranges. The user's text is sent in the clear, redacted but still private prose. No resolved-address check exists. `apiKeyEnv` is a free-form env name (for example `AWS_SECRET_ACCESS_KEY`) and is sent as a bearer token to whatever https host the config names, so a config file the user did not author can exfiltrate any env var. This is the same policy as the LLM clients, and the exposure only applies when the config is untrusted (`GHOSTWRITER_CONFIG`, a project-local file). Phase 7 widens it with a second egress path.
**Fix:**
- For detectors, require https or loopback regardless of key.
- Optionally restrict `apiKeyEnv` to an allow-list pattern such as `/^[A-Z0-9_]*(KEY|TOKEN)$/`.
- Reject link-local, metadata and private literal IPs unless an explicit `allowPrivate` is set.

### WR-06: Sentence splitter treats ordinary words and every single capital as abbreviations, which merges sentences and skews burstiness

**File:** `src/scoring/features.ts:40,71-79`
**Issue:** `ABBREVIATIONS` includes real sentence-final words: `no`, `co`, `st`, `fig`, `sr`, `jr`, `etc`. The check `token.length === 1 && uppercase` swallows every sentence ending in "I." Verified:
- `"I said no. Then he left."` gives one 6-word sentence.
- `"She met Prof. Lee, and so did I. Then we left the co. in peace."` gives one 15-word sentence.

Burstiness (weight 0.25, AUC 0.696) is a coefficient of variation over these lengths, so the merging adds systematic noise, and the noise differs by genre.
**Fix:**
- Require that the next non-space character is a lowercase letter or digit before suppressing a boundary after `no`, `co`, `st`, `fig`.
- Drop `no` and `co` from the set.
- Treat "I." as a boundary.

### WR-07: Ensemble weight semantics leave silent holes

**File:** `src/scoring/ensemble.ts:63-70,86-90`, `src/engine.ts` (`#detectorWeights`), `src/scoring/scorer.ts:21-34`
**Issue:**
- `localWeight: 0` with every detector failing returns the local score with member weight 1 and no marker. The user asked for local to be ignored and gets it silently.
- Weights keys that match no member (typos in library use) are ignored.
- `#detectorWeights` is a plain object keyed by a detector name that may legally be `__proto__` (`DETECTOR_NAME_RE` allows `_`). Assigning it is a no-op, so the configured weight is lost and defaults to 1.
- `normalizeWeights` validates finiteness per weight but not the sum: `{burstiness: 1e308, cliche: 1e308}` makes the total Infinity, so every normalized weight becomes 0 and the result is `insufficient_text`.
**Fix:**
- Use a `Map` for detector weights.
- Add a flag such as `local_only_fallback` on the result when the equal-mean fallback fires.
- Reject unknown weight keys in `runEnsemble`.
- Check `Number.isFinite(total)` in `normalizeWeights`.

## Info

### IN-01: Quadratic time in `splitProtected` on newline-heavy input, reachable through the library scorer

**File:** `src/scoring/features.ts:48-54` (calling `src/filters/protectedSpans.ts`)
**Issue:** `'\n'.repeat(N)` takes 41 ms at 100k, 504 ms at 400k and 14.8 s at 2M. `Engine.score` is capped at `maxInputChars` (200k, roughly 130 ms). `HeuristicScorer.score` and the exported `prepareText` have no cap, and the library exports them.
**Fix:** Cap input in `HeuristicScorer.score`, or fix the per-line scan in `splitProtected`.

### IN-02: Ensemble timeout does not cancel the adapter

**File:** `src/scoring/ensemble.ts:34-48`
**Issue:** `Promise.race` abandons a slow adapter but does not abort it. A custom adapter keeps running and keeps its socket and the text. The built-in adapter has its own `AbortSignal.timeout`, so this only affects library adapters.
**Fix:** Add an optional `signal` argument to `DetectorAdapter.score` and abort it on timeout.

### IN-03: Detector score direction and scale are unverified

**File:** `src/scoring/detectorAdapter.ts:100-101`
**Issue:** Any number in [0,1] is accepted and averaged. A detector that returns P(human) silently inverts the ensemble. This is documented as "does not validate their accuracy", but the adapter contract in the types doesn't say which direction counts.
**Fix:** State the direction in the `DetectorConfig` JSDoc. Optionally add an `invert` config flag.

### IN-04: Human fixture licensing and NOTICE

**File:** `tests/fixtures/corpus/manifest.json` (13 RFC entries), `NOTICE`
**Issue:** The 13 RFC excerpts are labeled "reproduction permitted". RFCs published before Nov 2008 (1855, 1925, 1958, 2551, 2775, 3439 and others) generally carry verbatim-only terms, and the fixtures are excerpts with line wraps joined. The repo is Apache-2.0 and NOTICE does not mention the bundled third-party text (the Gutenberg public-domain texts are fine). Fixtures also keep no per-file excerpt location, so the "no other edits" claim cannot be audited.
**Fix:** Add a NOTICE entry. Cite each RFC's legal notice, or swap the pre-2008 RFCs for post-2008 ones. Record paragraph offsets in the manifest.

### IN-05: Cliche list includes common non-AI words

**File:** `config/scorer.ts:61-65`
**Issue:** `essential`, `vital`, `significant`, `valuable`, `overall`, `navigate`, `journey`, `landscape`, `of course`, `not only` and `beyond the` are ordinary prose in human text. This is a likely source of false positives on non-literary human writing. The list is also an overfit to the same-author fixtures (see WR-03).
**Fix:** Prune to multi-word frames and genuine outliers, or weight by measured human/AI frequency from a held-out corpus.

### IN-06: Minor calibration-harness issues

**File:** `scripts/calibrate.ts:107-108,139`, `package.json` (the `calibrate` script)
**Issue:**
- The "even/odd half" check is presented as stability, but the manifest is ordered human-then-AI and the weights are not fit, so it is just two subsamples and not a holdout.
- `--weights '{bad'` crashes with a raw SyntaxError stack.
- `npm run calibrate` runs `tsc` and writes `dist/` as a side effect.
- `process.argv[i + 1]` can be another flag.
**Fix:** Drop or relabel the even/odd row. Catch the JSON parse error and print a one-line usage message. Run the script via `tsx`.

### IN-07: Small cosmetics

**File:** `src/scoring/features.ts:92`, `src/scoring/scorer.ts:55-69`, `src/cli/main.ts` (score action)
**Issue:**
- The `.slice()` after `.match(...) ?? []` is a no-op.
- The clamp of the score means the breakdown contributions can differ from `score` by an ulp, which weakens the "exact decomposition" claim in the scorer header.
- Empty or whitespace-only input prints `score: 0.500` and exits 0. The `insufficient_text` flag is shown, but a script that consumes only the number cannot tell it from a real 0.5.
**Fix:** Remove `.slice()`. Say "to within floating-point error" in the header. Consider an exit code or a `null` score for `insufficient_text`.

---

_Reviewed: 2026-11-14_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: deep_
