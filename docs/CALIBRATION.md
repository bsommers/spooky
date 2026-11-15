# Scorer calibration (Phase 7)

The local AI-likeness scorer (`src/scoring/scorer.ts`) is a weighted mean of six interpretable text features. This page
records what was measured on a labeled fixture corpus and what that does and does not support. Regenerate every number
with `npm run calibrate`; `tests/system/calibration.test.ts` recomputes the headline numbers and fails if this page
drifts from the code or the corpus.

<!-- calibration: auc=0.7293 human=39 ai=34 -->

## Headline

| | |
|---|---|
| Corpus | 39 human-written samples, 34 AI-written samples |
| **AUC** (shipped default weights) | **0.7293** |
| 95% bootstrap interval | 0.6026 to 0.8424 (2000 stratified resamples, seed 20260101) |
| Ship gate | AUC >= 0.70: met, by a margin smaller than the interval |
| Accuracy at a fixed cut of 0.5 | 0.5890 (barely above the 0.534 majority-class rate) |
| Best cut on the same data | 0.3862 gives 0.7397 accuracy (chosen on the data it is measured on, so optimistic) |
| Mean score | human 0.3024, AI 0.3938 |

Read this as: the score ranks a random AI sample above a random human sample about 73% of the time on this corpus, with
a wide margin of error. It is a weak signal. Scores cluster between 0.2 and 0.6, so there is no meaningful absolute
threshold; do not treat 0.5 as "this is AI".

```
score histogram (10 bins over [0,1])
bin        human | AI
0.0-0.1    1 #             |   0
0.1-0.2    4 ####          |   3 ###
0.2-0.3   16 ################|   2 ##
0.3-0.4   11 ###########   |   8 ########
0.4-0.5    6 ######        |  16 ################
0.5-0.6    1 #             |   5 #####
0.6-1.0    0               |   0
```

## Corpus and provenance

Everything is under `tests/fixtures/corpus/`; `manifest.json` has one entry per file (source, URL or generating prompt,
license, note) and the harness refuses a file without an entry or an entry without a file.

- **Human (39).** Excerpts of whole paragraphs, 150 to 310 words, line wraps joined, no other edits. 26 are public
  domain prose from Project Gutenberg published 1787 to 1907 (essays, novels, memoir, natural history). 13 are
  sections of IETF RFCs from 1995 to 2020 (informational and process documents; the IETF Trust permits reproduction).
  All of it predates widespread LLM text.
- **AI (34).** Written by Claude (Sonnet 5.5) in the session that built this phase, one text per prompt, 130 to 205
  words, no style steering beyond the genre named in the prompt (essay, explainer, email, blog post, product copy,
  fiction scene, README, speech, review, newsletter, plain Q&A answer). The prompt is stored per file. They were
  written before any feature was implemented or measured.

## Method and what was changed after looking at the data

- Feature curves, the six default weights and the stock-phrase list were fixed **before** the corpus was scored
  (`config/scorer.ts`). The shipped numbers above come from the first and only measurement of those defaults; nothing was
  tuned to reach the gate.
- Two features turned out to point the wrong way (below). The defaults were **not** changed in response, because
  choosing weights after seeing 73 samples would fit those 73 samples. See the exploratory run.

## Per-feature results

AUC of the feature value alone (0.5 = no signal, below 0.5 = points the wrong way on this corpus).

| Feature | AUC | Computable (human / AI) |
|---|---|---|
| punctuation | 0.8956 | 39 / 34 |
| cliche | 0.7440 | 39 / 34 |
| paragraphUniformity | 0.7017 | 21 / 34 |
| burstiness | 0.6961 | 39 / 34 |
| repetition | 0.1538 | 39 / 34 |
| lexicalDiversity | 0.1282 | 39 / 34 |

- `lexicalDiversity` and `repetition` assume machine text has a narrower vocabulary and repeats phrases more. On this
  corpus the opposite holds: the AI samples have **higher** moving-average type-token ratio and fewer repeated
  trigrams than the human samples (the RFCs and the 19th-century prose repeat function-word phrases). Inverted, they
  would score 0.8718 and 0.8462. These two features currently lower the overall AUC.
- `cliche` was scored with a phrase list written by the same model that wrote the AI samples, after them, with them in
  context. Phrases that looked like echoes of a specific sample were removed, but its 0.7440 is optimistic.
- `paragraphUniformity` needs three paragraphs; 18 of the 39 human excerpts have fewer, so it is left out for them
  (their weights renormalize). Availability itself differs between the classes.

## Confound checks

| Check | AUC |
|---|---|
| Word count alone used as the score | 0.3420 (inverted 0.6580: human samples are longer, so length alone carries signal) |
| AI vs the 26 literary human samples only | 0.8394 |
| AI vs the 13 RFC human samples only | **0.5090** (no better than chance) |
| Even-index half / odd-index half of the corpus | 0.6941 / 0.7647 |

The headline AUC is mostly the scorer separating modern assistant prose from 19th-century literary prose. Against
modern technical human writing (the RFCs) it does no better than chance on this corpus. The corpus has no modern casual
human writing (blogs, emails, forum posts, student essays), which is where such a scorer would actually be used, and
no AI text from any model other than one, or from prompts that ask for a human voice.

## Exploratory, in-sample, not adopted

Setting `lexicalDiversity` and `repetition` to weight 0 (`npm run calibrate -- --weights '{"lexicalDiversity":0,"repetition":0}'`)
gives AUC 0.8575 (95% interval 0.7466 to 0.9502) on the same 73 samples, 0.7715 against the RFCs alone. This was found by
looking at the per-feature results above, so it is an in-sample fit and not evidence that those weights generalize. The
defaults stay as pre-registered; the weights are configurable (`scorer.weights`), and the right fix is a larger,
genre-matched corpus including modern casual human text and several generator models, then re-deciding the weights on
a held-out split.

## What this score is not

- Not a detector verdict. It measures stylistic regularity that assistant-written text often shows and that careful
  human writing sometimes shows too. A low score does not show a text is human; a high one does not show it is AI.
- Not a calibrated probability.
- Third-party detectors use different signals and change without notice; their scores do not line up with this one.
  The `DetectorAdapter` ensemble averages whatever the adapters return and records any that fail or return an invalid
  value; it does not validate their accuracy.
- External adapters send the (already redacted) text to a third-party endpoint. They run only when you name them
  (`--detector <name>` / `engine.score(text, { detectors: [...] })`), and only for detectors declared in
  `scorer.detectors`.

## Reproduce

```
npm run calibrate                  # this report, as text
npm run calibrate -- --json        # same data as JSON
npm run calibrate -- --weights '{"repetition":0}'   # exploratory what-if (in-sample)
```
