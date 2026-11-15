# Checkpoint (2026-11-13, autonomous run mid-flight)

**Status:** v1 (P1-6) done and main pushed (e198796). Since then on branch gsd/phase-01-foundation (unpushed): glued-secret confidentiality fix (f0733bc, c25d2e5, reviewed+fixed, gate 1249), Phase 7 scorer built (3be6602..d7d1535; AUC 0.7293 CI 0.60-0.84, confounded corpus; review found 7 WR, fixer running), Milestone v3 spec written (b835e23: phases 9 API/MCP, 10 UI foundation + Black Cat/Tron themes, 11 UI features; React Aria Components). Next: finish P7 gate (verify, phase.complete 07), then P8 humanizer, then P9-11. User approved P7, P8, conf fix; v3 phases not yet approved to build; 5 open decisions in docs/SURFACES.md (recs: node:http, config read-only, optional loopback token, fontsource fonts, committed Playwright baselines). Open decision: build bigger genre-matched corpus before P8 targets the score. No push of branch/PR without say-so.

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
