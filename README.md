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
- **Surfaces:** every capability is a library call and a CLI command.
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

With Anthropic instead: `export ANTHROPIC_API_KEY=...` and `generate --author ann --persona executive --model <anthropic-model-id>`. The key is only ever read from the environment variable named by `llm.apiKeyEnv` (default `ANTHROPIC_API_KEY`); it is never put in a config file, flag value, log or trace.

`ghostwriter` is the installed bin name (`npm link` or `npx ghostwriter ...` after a build).

## CLI

| Command | What it does |
|---|---|
| `ghostwriter ingest --author <id> --name <name> [file]` | Profile and store an author's corpus (file, `--file <path>` or stdin). |
| `ghostwriter generate --author <id> --persona <key> [file]` | Rewrite a draft (file, `--file <path>` or stdin). Options: `--exemplars <0-20>`, `--max-tokens`, `--temperature <0-1>`, `--model`, `--provider anthropic\|openai-compat`, `--base-url`, `--api-key-env <NAME>`. |
| `ghostwriter profile <id>` | Show the stored stylometric profile. |
| `ghostwriter personas` | List target personas (`engineer`, `executive`, `newcomer` by default). |
| `ghostwriter filters` | List the filter pipeline in execution order. |

Every command takes `--config <file.json>` (default `$GHOSTWRITER_CONFIG`), `--state-dir <dir>` (default `$GHOSTWRITER_STATE_DIR`, else `~/.local/state/ghostwriter`) and `--json`. The result goes to stdout and nothing else does; warnings and errors go to stderr. With `--json` stdout is exactly one document, `{ok:true,...}` or `{ok:false,error:{code,message}}`.

Exit codes: `0` ok, `1` unexpected or file-system error, `2` usage/config/input, `3` unknown persona or author, `4` a fail-closed filter failed, `5` LLM failed, `6` input too large, `7` stored state corrupt, `8` state directory locked.

Config (JSON, unknown keys are rejected; every key is optional except `llm.model`):

```json
{
  "llm": { "provider": "openai-compat", "baseUrl": "http://localhost:11434/v1", "model": "llama3.1", "maxRetries": 2 },
  "limits": { "maxInputChars": 200000 },
  "confidentiality": { "blocklist": ["Acme Corp", "Project Falcon"], "caseInsensitive": true,
                       "customRules": [{ "name": "ticket", "pattern": "TKT-[0-9]{4,8}" }] },
  "personas": [{ "key": "board", "name": "Board member", "cognitiveLoad": "low", "informationDensity": "medium",
                 "structuralMandates": ["first sentence is the recommendation"], "bannedPhrases": ["deep dive"] }]
}
```

## Library

```ts
import { Engine, loadConfig } from 'spooky';

const engine = await Engine.create({ config: loadConfig({ llm: { model: 'claude-...' } }), stateDir: './state' });
await engine.ingest('ann', 'Ann Author', corpusText);
const { text, trace } = await engine.generate('ann', 'executive', draft);
```

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
// 2. Config: { filters: { pipeline: [...default entries..., { name: 'noEmoji', stage: 'post' }] } }, before the last confidentiality.
// 3. Engine: new Engine({ config, factories: { ...defaultFactories(), noEmoji: () => noEmoji } })
```

Step 1 is a one-line edit in the source tree: config validation only accepts names from `KNOWN_FILTER_NAMES`. The pipeline refuses a config where any filter runs after the final post-stage `confidentiality`, because nothing would re-check its output. The example is executed by `tests/integration/readmeExample.test.ts`.

## Privacy: what goes to the LLM provider

The provider receives, on every `generate` call:

1. The **redacted draft**, inside `<input>` tags.
2. Up to `--exemplars` (default 3) **redacted excerpts of the author's ingested corpus**.
3. The author's numeric style profile and the persona's text (name, load, density, mandates, banned phrases).

"Redacted" means the confidentiality filter ran: it replaces credentials (AWS, GitHub, GitLab, Slack, Stripe, Google, npm, SendGrid and Hugging Face tokens, JWTs, bearer tokens, PEM private keys, URL credentials, `password=`-style assignments), your `blocklist` terms and your `customRules` with `[REDACTED:<type>]`. **Everything else is sent as real text.** Names, email addresses, customer data, internal project names and prose are not detected unless you add them to `blocklist` or `customRules`. Do not send a draft to a hosted provider that you would not paste into that provider's chat window. For sensitive material use a local endpoint (Ollama, vLLM, LM Studio) or a provider you have a data agreement with.

Also: the model's answer is redacted again before you see it; the state directory (`store.json`, `profiles.json`) holds redacted chunk text, mode 0600; the API key is sent only over `https`, or `http` to loopback. Details and residual risks are in [docs/AS-BUILT.md](docs/AS-BUILT.md).

## Develop

```bash
npm run build           # tsc -> dist/
scripts/verify.sh       # typecheck + every tier: smoke unit integration system security torture
scripts/verify.sh --coverage   # also enforce >= 90% line coverage on src/filters and src/registry
```

Tests are offline: the LLM is `MockLlmClient` or a local `127.0.0.1` stub server.

## Roadmap

| Milestone | Phases |
|---|---|
| v1 (built) | 1 Foundation, 2 Filters, 3 Target axis, 4 Source axis, 5 Orchestration/LLM/CLI, 6 Hardening |
| v2 (planned) | 7 AI-likeness scorer (0..1, explainable, pluggable detector adapters), 8 Score-driven humanizer |

The v2 scorer and humanizer will report measured results only; a score from the local scorer is a proxy, and results against any third-party detector will be published as measured, including where it does not work. Plans: [`.planning/`](.planning/).

## Origin

Seeded from a design chat export in [`docs/source/`](docs/source/dual-axis-ghostwriter.md); [docs/AS-BUILT.md](docs/AS-BUILT.md) lists the nine defects in that code and the test that pins each one fixed.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
