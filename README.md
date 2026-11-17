<p align="center"><img src="assets/spooky-logo.png" width="200" alt="Spooky the black cat"></p>

# Spooky

Spooky is a TypeScript ghostwriting engine with two axes. It rewrites a draft in a **source author's voice** (a stylometric profile plus retrieved writing samples) for a **target audience** (a persona with structure rules and banned phrases), with an inline, pluggable **filter pipeline** around the LLM call.

```
input -> size cap -> PRE filters (confidentiality redaction)
      -> author voice (stylometric profile + retrieved exemplars) x audience persona
      -> LLM (Anthropic SDK or any OpenAI-compatible server)
      -> POST filters (style editor, then confidentiality again) -> text + trace
```

- **Providers:** Anthropic, or any OpenAI-compatible `/v1/chat/completions` endpoint (OpenAI, Ollama, vLLM, LM Studio, OpenRouter) through `baseUrl`.
- **Filters:** async, ordered, configurable. Confidentiality fails closed: if it cannot demonstrably run, no text is returned.
- **Surfaces:** every capability is a library call, a CLI command, an HTTP route (OpenAPI 3.1) and an MCP tool, all generated from one operations registry ([docs/SURFACES.md](docs/SURFACES.md)).
- **Deterministic:** the same input, corpus and model answer give byte-identical output.

Status: v1 is built (phases 1-6). See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design and [docs/AS-BUILT.md](docs/AS-BUILT.md) for what differs from the plan, measured numbers, and known limits.

## Quickstart

Requires Node `^20.19.0 || >=22.12.0`.

```bash
npm ci
npm run build

# 1. Teach it an author (secrets are redacted before anything is stored or embedded).
node dist/src/cli/bin.js ingest --author ann --name "Ann Author" ann-posts.txt

# 2. Rewrite a draft for a persona. Local Ollama, no API key:
echo "We should ship the billing fix Friday." | node dist/src/cli/bin.js generate \
  --author ann --persona executive \
  --provider openai-compat --base-url http://localhost:11434/v1 --model llama3.1
```

To write NEW text about a topic instead of rewriting a draft (no web search: see [Topic mode](#topic-mode-write-about-a-subject)):

```bash
node dist/src/cli/bin.js generate --author ann --persona executive \
  --topic "Why small teams ship faster" --notes-file facts.txt --length short \
  --provider openai-compat --base-url http://localhost:11434/v1 --model llama3.1
```

With Anthropic instead: `export ANTHROPIC_API_KEY=...` and `generate --author ann --persona executive --model <anthropic-model-id>`. The key is only ever read from the environment variable named by `llm.apiKeyEnv` (default `ANTHROPIC_API_KEY`); it is never put in a config file, flag value, log or trace.

`ghostwriter` is the bin name after `npm link` in a built checkout; the commands above call `node dist/src/cli/bin.js` directly. The package is named `spooky` and is not published, so do not run `npx ghostwriter`: outside a linked checkout it would fetch an unrelated registry package of that name.

## CLI

| Command | What it does |
|---|---|
| `ghostwriter ingest --author <id> --name <name> [file]` | Profile and store an author's corpus (file, `--file <path>` or stdin). |
| `ghostwriter generate --author <id> --persona <key> [file]` | Rewrite a draft (file, `--file <path>` or stdin). **Topic mode:** `--topic <text> [--notes-file <path>] [--length short\|medium\|long]` writes new text about the topic instead (not with a draft file or stdin; `--notes-file` and `--length` need `--topic`; usage error, exit 2). Options: `--exemplars <0-20>`, `--max-tokens`, `--temperature <0-1>`, `--humanize [--target <0-1>]`, `--model`, `--provider anthropic\|openai-compat`, `--base-url`, `--api-key-env <NAME>`. |
| `ghostwriter score [file] [--detector <name>]...` | Rate how machine-written a text reads, 0 to 1, with a per-feature breakdown (file, `--file <path>` or stdin). Local, offline, deterministic; needs no model or key. `--detector` also asks a detector you declared under `scorer.detectors` and **sends the redacted text to it**; nothing is sent unless you name one. A heuristic proxy, not a detector verdict: [docs/CALIBRATION.md](docs/CALIBRATION.md) has the measured numbers (AUC 0.73 on a small corpus, wide interval, chance level against modern technical prose). |
| `ghostwriter humanize [file] [--author <id>] [--target <0-1>] [--max-iterations <n>] [--no-llm]` | Rewrite a text to score lower on the local heuristic while a guard keeps numbers, names, quotes, code and URLs unchanged; bounded loop (default target 0.3, 3 iterations), each edit re-redacted and kept only if it scores lower. `generate --humanize [--target]` runs it on the result. The scores come from a weak, confounded heuristic (held-out AUC 0.694) and nothing here is claimed against any real detector: [docs/HUMANIZING.md](docs/HUMANIZING.md) has the measured results, including that the mean drop on the corpus is small (0.593 to 0.543). |
| `ghostwriter profile <id>` | Show the stored stylometric profile. |
| `ghostwriter personas` | List target personas (`engineer`, `executive`, `newcomer` by default). |
| `ghostwriter filters` | List the filter pipeline in execution order. |
| `ghostwriter authors` | List every ingested author with their profile. |
| `ghostwriter config get` | Show the effective config, redacted (endpoint hosts, key variable NAMES, never values). Read-only. |
| `ghostwriter capabilities` | List the operations and any planned but not built (none at present). |
| `ghostwriter serve [--token-env NAME] [--mcp]` | HTTP API on `127.0.0.1:8787` with `GET /openapi.json`: [docs/API.md](docs/API.md). Without a token any local process can use it; set one. Also serves the web UI at `/` once built (`npm run ui:install && npm run ui:build`; two themes, fully offline): [docs/UI.md](docs/UI.md). |
| `ghostwriter mcp [--stdio\|--http]` | MCP server exposing the same operations as tools: [docs/MCP.md](docs/MCP.md). |

Every command takes `--config <file.json>` (default `$GHOSTWRITER_CONFIG`), `--state-dir <dir>` (default `$GHOSTWRITER_STATE_DIR`, else `$XDG_STATE_HOME/ghostwriter`, else `~/.local/state/ghostwriter`) and `--json`. The result goes to stdout and nothing else does; warnings and errors go to stderr. With `--json` stdout is exactly one document, `{ok:true,...}` or `{ok:false,error:{code,message}}`.

Exit codes: `0` ok, `1` unexpected or file-system error, `2` usage/config/input, `3` unknown persona or author, `4` a fail-closed filter failed, `5` LLM failed, `6` input too large, `7` stored state corrupt, `8` state directory locked, `9` score: no detector answered (see `ghostwriter score`).

Config (JSON, unknown keys are rejected; every key is optional except `llm.model`):

```json
{
  "llm": { "provider": "openai-compat", "baseUrl": "http://localhost:11434/v1", "model": "llama3.1", "maxRetries": 2 },
  "limits": { "maxInputChars": 200000 },
  "confidentiality": { "blocklist": ["Acme Corp", "Project Falcon"], "caseInsensitive": true,
                       "customRules": [{ "name": "ticket", "pattern": "TKT-[0-9]{4,8}" }] },
  "personas": [{ "key": "board", "name": "Board member", "cognitiveLoad": "low", "informationDensity": "medium",
                 "structuralMandates": ["first sentence is the recommendation"], "bannedPhrases": ["deep dive"] }],
  "scorer": { "weights": { "cliche": 0.4, "repetition": 0 },
              "detectors": [{ "name": "acme", "url": "https://detector.example/v1/score", "apiKeyEnv": "ACME_DETECTOR_KEY" }] },
  "humanize": { "targetScore": 0.3, "maxIterations": 3 }
}
```

## Library

```ts
import { Engine, loadConfig } from 'spooky';

const engine = await Engine.create({ config: loadConfig({ llm: { model: 'claude-...' } }), stateDir: './state' });
await engine.ingest('ann', 'Ann Author', corpusText);
const { text, trace } = await engine.generate('ann', 'executive', draft);
```

```ts
const { score, local, members, excluded } = await engine.score(text);                     // local heuristic only, nothing leaves the process
const withDetector = await engine.score(text, { detectors: ['acme'] });                   // averages in a declared / registered detector
```

`score` is in [0,1] (0 reads human, 1 reads machine-generated) and `local.features` explains it: each feature's `value`, applied `weight` and `contribution`, summing to the score. A detector speaks `POST {"text"}` -> `{"score": 0..1}` (or implement `DetectorAdapter` and pass `detectors` to `Engine`); one that fails or answers outside [0,1] is listed in `excluded`, never fatal.

```ts
const r = await engine.humanize(text, { authorId: 'ann', target: 0.3, maxIterations: 3 });   // bounded, guarded rewrite; r.initialScore -> r.finalScore, r.steps
const g = await engine.generate('ann', 'executive', draft, { humanize: true });              // generate, then the same loop on the result
```

## Topic mode: write about a subject

`generate` has two input modes. **Rewrite** (the default) takes a draft and rewrites it in the author's voice. **Topic** takes a subject we are researching, optionally with notes (facts and source material you supply) and a length (`short`, `medium`, `long`), and the model writes NEW text about it in the author's voice for the persona.

```ts
const t = await engine.generate('ann', 'executive', 'Why small teams ship faster', { mode: 'topic', notes: 'The team shipped 12 releases in 2024.', length: 'short' });
t.text;    // new text in Ann's voice
t.caveat;  // TOPIC_CAVEAT: always present on a topic result
```

Over HTTP and MCP it is the same `generate` operation: `{"authorId":"ann","persona":"executive","text":"<the topic>","mode":"topic","notes":"...","length":"short"}`. The Generate screen of the web UI has a switch, "Rewrite my draft" or "Write about a topic".

**There is no web search and no research.** The model writes from the topic, your notes and its own knowledge, and it may state things that are wrong or out of date. The prompt tells it to take specific facts, numbers, names, dates and quotes only from your notes, and to say plainly when it lacks information instead of inventing it; that lowers the risk, it does not remove it. Every topic result carries a fixed caveat (`caveat`, and printed after the text by the CLI, shown above the text by the UI): **facts are not verified; check them against a source before you use the text.** If you need a fact in the text, put it in the notes.

Topic and notes get the same treatment as a draft: each is held to `limits.maxInputChars`, redacted by the fail-closed confidentiality filter before anything is sent, and the result is style-checked and redacted again. Instructions written inside the topic or notes are data, not commands (see Privacy below).

`humanize` lowers the LOCAL heuristic score, which is weak and confounded (held-out AUC 0.694); read [docs/HUMANIZING.md](docs/HUMANIZING.md) for what it does, the guard, and the measured results before relying on it.

`trace` lists one entry per stage (`confidentiality`, `llm`, `style`, `confidentiality`, and `persona-banned` when a banned phrase survived) with `modified`, `ms` and counts. It never contains matched text.

## Add a filter in under 20 lines

A filter is an object with `name`, `stages`, `onError` and an async `process`. This one strips emoji from the model's answer:

```ts
const noEmoji: Filter = {
  name: 'noEmoji',
  stages: ['post'],
  onError: 'skip', // a failure is recorded in the trace and the text passes on unchanged
  async process(text) {
    const content = text.replace(/\p{Extended_Pictographic}/gu, '');
    return { content, modified: content !== text, metadata: { removed: text.length - content.length } };
  },
};
// 1. config/filters.ts: add 'noEmoji' to KNOWN_FILTER_NAMES.
// 2. Config filters.pipeline: insert { name: 'noEmoji', stage: 'post' } between the 'style' entry and the final 'confidentiality' entry.
// 3. Engine: new Engine({ config, factories: { ...defaultFactories(), noEmoji: () => noEmoji } })
```

Step 1 is a one-line edit in the source tree: config validation only accepts names from `KNOWN_FILTER_NAMES`. The pipeline refuses a config where any filter runs after the final post-stage `confidentiality`, because nothing would re-check its output. The example is executed by `tests/integration/readmeExample.test.ts`.

## Privacy: what goes to the LLM provider

The provider receives, on every `generate` call:

1. The **redacted draft**, inside `<input>` tags. In topic mode, instead, the **redacted topic** (inside `<topic>` tags) and the **redacted notes** (inside `<notes>` tags): they go to the provider exactly as a draft would, so the paragraph below applies to them equally.
2. Up to `--exemplars` (default 3) **redacted excerpts of the author's ingested corpus**.
3. The author's numeric style profile and the persona's text (name, load, density, mandates, banned phrases).

"Redacted" means the confidentiality filter ran: it replaces credentials (AWS, GitHub, GitLab, Slack, Stripe, Google, npm, SendGrid and Hugging Face tokens, JWTs, bearer tokens, PEM private keys, URL credentials, `password=`-style assignments), your `blocklist` terms and your `customRules` with `[REDACTED:<type>]`. **Everything else is sent as real text.** Names, email addresses, customer data, internal project names and prose are not detected unless you add them to `blocklist` or `customRules`. Detection is also pattern-based: short-prefix tokens (npm, Hugging Face, `sk-` keys, Stripe, SendGrid, JWTs, bearer tokens) are redacted even when glued to a preceding word, but only if they are as long and as random-looking as a real token, so unusually short or malformed secrets can slip through (for example a glued `sk-` key made of letters only, or the tail of a glued npm token), and rare lookalikes such as `pallbearer` followed by a long number can be redacted needlessly; see Known limits in [docs/AS-BUILT.md](docs/AS-BUILT.md). Do not send a draft to a hosted provider that you would not paste into that provider's chat window. For sensitive material use a local endpoint (Ollama, vLLM, LM Studio) or a provider you have a data agreement with.

Also: the model's answer is redacted again before you see it; the state directory (`store.json`, `profiles.json`) holds redacted chunk text, mode 0600; the API key is sent only over `https`, or `http` to loopback. Details and residual risks are in [docs/AS-BUILT.md](docs/AS-BUILT.md).

## Develop

```bash
npm run build           # tsc -> dist/
scripts/verify.sh       # typecheck + every tier: smoke unit integration system security torture
scripts/verify.sh --coverage   # also enforce >= 90% line coverage on src/filters and src/registry
npm run ui:install      # once: the web UI (ui/) is its own package; verify.sh also runs its tests (--no-ui / --no-e2e skip them)
```

Tests are offline: the LLM is `MockLlmClient` or a local `127.0.0.1` stub server.

## Roadmap

| Milestone | Phases |
|---|---|
| v1 (built) | 1 Foundation, 2 Filters, 3 Target axis, 4 Source axis, 5 Orchestration/LLM/CLI, 6 Hardening |
| v2 | 7 AI-likeness scorer (0..1, explainable, pluggable detector adapters; built, measured in [docs/CALIBRATION.md](docs/CALIBRATION.md)), 8 Score-driven humanizer (built, measured in [docs/HUMANIZING.md](docs/HUMANIZING.md)) |

The scorer and the humanizer report measured results only; a score from the local scorer is a proxy, and results against any third-party detector will be published as measured, including where it does not work. Plans: [`.planning/`](.planning/).

## Origin

Seeded from a design chat export in [`docs/source/`](docs/source/dual-axis-ghostwriter.md); [docs/AS-BUILT.md](docs/AS-BUILT.md) lists the nine defects in that code and the test that pins each one fixed.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
