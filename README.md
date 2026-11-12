<p align="center"><img src="assets/spooky-logo.png" width="200" alt="Spooky the black cat"></p>

# Spooky

Spooky is a TypeScript ghostwriting engine with two axes. It writes in a **source author's voice** for a **target audience**, with an inline, pluggable **filter pipeline** around the LLM call.

> **Status: planning.** No code yet. The full build plan is in [`.planning/`](.planning/). Nothing below works until the phases in the roadmap are executed.

## Planned design

```
input -> size cap -> PRE filters (confidentiality redaction)
      -> author voice (stylometric profile + retrieved exemplars) x audience persona
      -> LLM (Anthropic SDK or any OpenAI-compatible server)
      -> POST filters (style editor, confidentiality again) -> text + trace
```

- **LLM providers:** Anthropic, or any OpenAI-compatible `/v1/chat/completions` endpoint (OpenAI, Ollama, vLLM, LM Studio, OpenRouter) via configurable `baseUrl`.
- **Filters:** async, ordered, configurable. Confidentiality fails closed.
- **Surfaces:** every capability is available as a library call and a CLI command.

## Roadmap

| Milestone | Phases |
|---|---|
| v1 | 1 Foundation, 2 Filters, 3 Target axis, 4 Source axis, 5 Orchestration/LLM/CLI, 6 Hardening |
| v2 | 7 AI-likeness scorer (0..1, explainable, pluggable detector adapters), 8 Score-driven humanizer |

The v2 scorer and humanizer report measured results only. A score from the local scorer is a proxy, and results against any particular third-party detector will be published as measured, including where it does not work.

See [`.planning/ROADMAP.md`](.planning/ROADMAP.md), [`REQUIREMENTS.md`](.planning/REQUIREMENTS.md) and [`CONTRACTS.md`](.planning/CONTRACTS.md).

## Origin

Seeded from a design chat export in [`docs/source/`](docs/source/dual-axis-ghostwriter.md); the plan documents known defects in that code and how they are avoided.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
