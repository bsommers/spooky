# Waiver

On 2026-11-17 the user instructed "close 11, accept (b)". `phase.complete` refuses while status is `human_needed`, so the ROADMAP row was closed by hand. 11-VERIFICATION.md is unchanged; its human items remain open (visual review of every screen in both themes, real screen-reader pass, real-provider run).

Accepted by the user: deviation (b). UI-12 text says a lint rule enforces the no-`dangerouslySetInnerHTML` ban; eslint could not be installed, and the TypeScript-syntax-tree test `ui/tests/unit/source-bans.test.ts` (run in `scripts/verify.sh`) enforces the bans instead.

Deviation (a), the state directory in Settings, was fixed rather than waived (f0cfc9a, baselines fa912da). Deferred Phase 10 review items were fixed in the same pass (8a0fc73).
