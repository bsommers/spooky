# Checkpoint (2026-11-15, after P10 close)

**Status (2026-11-15):** v1 P1-6 done, main pushed (e198796); branch gsd/phase-01-foundation unpushed. P7, P9 closed by hand (human_needed waived by user, WAIVER.md); P8 humanizer done+reviewed+fixed+verified+closed (mean AI score drop only 0.050, scorer weak AUC 0.694, no live-model run, guard heuristic limits in docs/HUMANIZING.md). Gate: unit 922, integration 285, system 65, security 472, torture 5, 0 skipped. P10 UI foundation DONE+closed by waiver (WAIVER.md; border contrast exemption accepted; UI 167 vitest, 34 e2e; deferred LW-03, LW-08, IN-01..04). NEXT: P11 UI features (plan .planning/phases/11-ui-features/11-01-PLAN.md). Old: P10 UI foundation (plan .planning/phases/10-ui-foundation/10-01-PLAN.md; Black Cat/Tron themes, React Aria Components, 5 decisions accepted), then P11. Per phase: gsd_run query dispatch-isolation --raw --phase NN --force-isolation none, no isolation arg; sonnet agents; executor -> reviewer -> fixer -> verifier -> phase.complete -> ROADMAP -> commit explicit paths. No push/PR without say-so.

## Goal (user's words)
"/gsd-execute-phase 1 - ... parallel subagents using the best and cheapest model", then "/gsd-autonomous" (all remaining phases). User confirmed D2 (LLM adapters) and deps @anthropic-ai/sdk ^0.40, commander ^12; D3/D4/D5 kept as written.

## State (verify by command after compact)
- Repo https://github.com/bsommers/spooky. Branch `gsd/phase-01-foundation`, far ahead of `main` (97b526f). main pushed; branch not pushed; no PR.
- Docs commits: P1 534e935, P2 e956e8a, P3 5a346d9, P4 f69c48c, P5 2ab63a1 (code commits precede each).
- Untracked, never commit: `.planning/config.json`, `.planning/state.json`.
- No background agents running.

## Dispatch facts
- Worktrees impossible (origin/HEAD unresolved; no node_modules in worktrees). Per phase: `gsd_run query dispatch-isolation --raw --phase NN --force-isolation none`, then Agent with no isolation arg.
- gsd_run bootstrap: `eval "$(sed -n '/^```bash/,/^```/p' ~/.claude/gsd-core/references/gsd-run-resolver.md | sed '1d;$d')"`.
- Models: sonnet for executor/reviewer/fixer/verifier (always pass explicit model; opus only on request).
- Gate recipe per phase: gsd-executor -> gsd-code-reviewer -> gsd-code-fixer (high/medium) -> gsd-verifier (VERIFICATION.md + fingerprint) -> `gsd_run query phase.complete NN` -> hand-edit ROADMAP row ("✓ (date)") + REQUIREMENTS boxes -> commit explicit paths with Co-Authored-By trailer.

## Phase 6 plan (.planning/phases/06-hardening/06-01-PLAN.md)
E2E test, 1k-input fuzz torture (only GhostwriterError thrown), perf budget 3x measured on 50k chars, coverage gate (filters/ & registry/ >= 90% lines), README (quickstart, CLI, add-a-filter <20 lines, privacy note: provider receives redacted-but-real text), ARCHITECTURE, AS-BUILT (plan deviations + PROJECT.md defect list 1-9 mapped to tests), clean-clone `npm ci && scripts/verify.sh`.

## Open items (deliberately unfixed)
- P1: CR-06 (verify.sh skipped tests), CR-08, CR-09, IN-01/02. P2: CR-09..12, IN-01..03 (ReDoS guard heuristic; RE2/worker candidate). P3: CR-06, IN-01/02. P4: WR-06, IN-01..04, items x dim cap. P5: WR-07, WR-10, IN-*; readers not locked vs ingest; private/metadata IPs not blocked for baseUrl; save-failure rollback not exact.
- Node 20 untested (only v26.8.1). No live Anthropic call ever made.
- Optional: `git remote set-head origin -a`; SCR-*/HUM-* missing from REQUIREMENTS traceability.

## Authorizations
- Push of main done once (2026-11-14). Any further push/PR/release needs fresh say-so.

## Decisions still open
- Run v2 phases 7-8? Fix glued-secret leak in confidentiality filter (documented limit) or keep?
