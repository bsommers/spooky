# Confidentiality: glued tokens

Fixed: sk-, sk_live_/rk/pk, npm_, hf_, SG., eyJ JWT, Bearer were not redacted when glued to a preceding letter/digit.
Design: each rule = `boundary + normal floor` | `unanchored + real-token shape`. All lookaheads are bounded (linear scans).

## Review follow-up (CONF-GLUED-REVIEW.md)
- WR-01 fixed: glued `sk-` now needs 32+ chars after an optional `proj-`/`svcacct-`/`admin-`/`ant-xxx-` infix, with upper + lower + digit
  in the first 64 and fewer than four `-` separators with <=15-char gaps. Digit-bearing slugs/branches/filenames are untouched.
  Measured on 1500 fixture secrets glued after a letter: `sk` 0 missed, `sk-proj` 3 missed, `sk-ant` 3 missed (~0.2%, early hyphens).
- WR-02 fixed: docs/AS-BUILT.md and README.md rewritten to the real behavior, with an explicit residual-leak list (letters-only glued
  `sk-`, ~0.2% hyphen-heavy proj/ant keys, glued npm/SendGrid tail, JWT header >100 or payload <10) and known false positives.
- WR-03 fixed: glued SendGrid is exactly `SG.{22}.{43}` (no trailing bound, so a glued key followed by text is still caught).
- IN-01 fixed: redundant npm alternative removed; comment corrected.
- IN-02 skipped (documented): glued `bearer` kept, because the previously tested letter/word-glued cases require it; `pallbearer <20+ chars with digit>` stays a known FP.
- IN-03 accepted (documented): base64url blobs containing `sk-`/`hf_` mid-run are still partly redacted.
- IN-04 fixed: tests added for digit slugs, SG/MSG dotted identifiers, glued SendGrid, letters-only sk-/npm-tail known limits,
  bearer / `risk-` / `Rsk-aA1-` / SG. repetition in the ReDoS test; torture now plants half padded, half glued.

Tests: tests/unit/filters/confidentiality.test.ts, tests/torture/engine-torture.test.ts.
