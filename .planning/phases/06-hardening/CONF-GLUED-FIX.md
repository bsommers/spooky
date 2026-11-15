# Confidentiality: glued tokens

Fixed: sk-, sk_live_/rk/pk, npm_, hf_, SG., eyJ JWT were not redacted when glued to a preceding letter/digit/underscore.
Design: each rule = `boundary + normal floor` | `unanchored + real-token-length floor` (sk- 32+ with a digit; Stripe 24+; npm 36;
hf_ 34+; SG. 22/43 segments; JWT header 14-100). Lookaheads and the JWT header are bounded, so scans stay linear
(an unbounded glued JWT header was quadratic on `eyJ` repetition). Bearer glued: 20+ chars with a digit. Idempotence and the NFKC index map are unchanged.
Residual: glued secrets under those floors, or a glued JWT header over 100 chars, still leak.
Tests: tests/unit/filters/confidentiality.test.ts (glued matrix, FP guard, ReDoS, ZWSP); torture now plants glued.
