---
phase: quick
plan: topic-generate
subsystem: generate (engine, service registry, CLI, HTTP, MCP, OpenAPI, web UI, docs)
status: complete
commits: 3
plan_head_before: f87d9c9eb17bcf99123773ef08a2a73a083536d8
plan_head_after: a292cbe
---

# Quick: topic-based generation

## Design chosen

One operation, a second mode: `generate` input gains `mode: 'rewrite' | 'topic'` (default `rewrite`, backwards compatible), with `text` meaning the draft or the topic, plus optional `notes` and `length` (`short|medium|long`), valid only with `mode: 'topic'`. Output gains `mode` (always) and `caveat` (topic only).

Why not a separate `generate_topic` operation: the entire pipeline is shared (persona/author lookup, PRE confidentiality, retrieval, model call with retry, POST filters, banned phrases, humanizer option, limits, errors). A second operation would duplicate all of it on four surfaces plus OpenAPI and the UI and let the two drift. Cost: `notes`/`length` need a cross-field rule, enforced in the zod schema (USAGE) and again in the Engine for library callers (ConfigError).

Pieces:
- `config/topic.ts`: modes, lengths, `TOPIC_LENGTH_WORDS`, fixed `TOPIC_CAVEAT`.
- `promptBuilder`: topic system prompt with exported `TOPIC_HONESTY_RULES` (no internet; use ONLY the notes for specific facts, numbers, names, dates, quotes; say plainly when lacking information instead of inventing); `<topic>` and `<notes>` fences; `neutralize` now also covers `topic`/`notes` tags.
- `Orchestrator.generate`: topic and notes each go through the PRE pipeline with their own fail-closed confidentiality check; both capped at `limits.maxInputChars`; retrieval query is topic + notes (redacted); result carries `caveat`. `Engine.generate` keeps the caveat through the humanizer.
- Registry/schemas/operations: fields, output, description, render (CLI text prints `note: <caveat>` after the text).
- CLI: `generate --topic <text> [--notes-file <path|->] [--length short|medium|long]`; `--topic` with a draft file/positional, or `--notes-file`/`--length` without `--topic`, is a USAGE error (exit 2) before any model call; topic mode never reads stdin for the draft.
- UI: radio mode switch ("Rewrite my draft" / "Write about a topic"), "Topic we're researching", "Notes and facts to use (optional)", Length select, help text saying nothing is looked up online, `TopicCaveat` above every topic result (server text, bundled mirror checked equal by a security test). Each mode keeps its own text; rewrite requests are byte-identical to before. Typed client regenerated.
- Docs: README, API, MCP, SURFACES, UI, ARCHITECTURE.

## Commits
- 15ce047 feat: engine, registry, CLI, HTTP/MCP/OpenAPI, tests, regenerated UI API client
- d5e06d0 feat: UI topic mode, component + Playwright tests, visual baselines
- a292cbe docs

## Tests (scripts/verify.sh: PASS, 0 skipped)
root: unit 979, integration 315, system 67, security 510, smoke 4, torture 5 (was 957/295/67/501/4/5: +22 unit, +20 integration, +9 security); ui vitest 455; Playwright 114 (was 102: +6 topic flow/keyboard/axe, +6 topic visual baselines).
New: `tests/unit/promptBuilder.topic.test.ts` (honesty instruction pinned), `tests/unit/service/generate-topic.test.ts`, `tests/integration/topic-generate.test.ts` (Engine, HTTP, MCP, CLI), golden library==CLI==HTTP==MCP case for topic in `surfaces.test.ts`, parity `CLI_FIELDS` extended, `tests/security/topic-confidentiality.test.ts`, `tests/security/ui-topic-caveat.test.ts`, `ui/tests/component/generate.test.tsx` (topic block), `ui/tests/e2e/topic.spec.ts`, `topic-a11y.spec.ts`.

## Visual baselines
Regenerated, intentionally, only for the Generate screen (layout gained the mode switch and a longer lede): generate (desktop+phone, both themes), generate-result, generate-error (8 files). New: generate-topic (desktop+phone) and generate-topic-result, both themes (6 files). Generated in the pinned Playwright container; the full suite also passes on the host Chromium. No other baseline changed.

## Deviations
- [Rule 3] Existing Playwright locators `getByLabel('Draft')` became ambiguous (substring match with the new radio "Rewrite my draft"); made them `{ exact: true }` in 7 e2e files.
- Existing component keyboard test updated: the mode switch is a new tab stop between Persona and the text box.
- `neutralize` extended to `topic`/`notes` look-alikes globally, so a rewrite draft containing a literal `<topic>`/`<notes>` tag is now also made inert (benign, security-positive).
- Ran the host e2e with `GW_E2E_PORT=4973` because the user's own `ghostwriter serve` occupies 4873; not touched.

## Open issues
- `scripts/verify.sh` with `GW_E2E_CONTAINER=1` reports "no report produced" even when the container run is green (114/114): the JSON report path is a host temp dir not mounted into the container. Pre-existing; host run is PASS.
- Pre-existing, noticed: a USAGE error for an unknown input field echoes the field name verbatim, so a secret used as a field name appears in that error body (returned only to the caller who sent it).
- The honesty rules cannot stop a model inventing facts; that is why the caveat is mandatory on every surface. No real-model evaluation of how well it complies was run (tests use the scripted model).
