# Providers

AIC talks to models through one small interface (`src/providers/types.ts`):

```ts
interface AIProvider {
  id: string; name: string; local: boolean; endpoint: string;
  listModels(): Promise<ModelInfo[]>;
  generate(request): Promise<GenerateResponse>;
  stream?(request): AsyncIterable<StreamChunk>;
  check(): Promise<ProviderStatus>;
}
```

The agent, the commit generator and the commands only use this interface. Every built-in provider implements
`stream()`; `generate()` is the stream collected into one response, so streaming works everywhere.

Select a provider with `aic config set provider <id>`, `aic provider use <id>`, `AIC_PROVIDER=<id>` or `-p <id>`.

## Ollama (`ollama`)

- Local models, custom URL (`ollamaUrl`, `AIC_OLLAMA_URL`, `OLLAMA_HOST`), model discovery (`aic model list`).
- Streaming over `/api/chat`. The context window (`num_ctx`) is raised automatically so the prompt fits.
- If the model advertises the `thinking` capability, thinking is switched off so the answer is not starved.
- Not running? `--start-ollama` / `autoStartOllama` starts `ollama serve` in the background (only for loopback URLs). Interactive runs offer to start it.
- A missing model is reported with `ollama pull <model>`; in a terminal you can pick an installed one instead.
- `--unload` / `unloadModel` frees (V)RAM when AIC exits.
- `local` is true only for loopback URLs. A remote Ollama is treated as a cloud endpoint for privacy purposes.

## OpenAI (`openai`)

Chat Completions at `https://api.openai.com/v1`. Key: `OPENAI_API_KEY`. Default model `gpt-4o-mini`.
AIC uses `max_completion_tokens` and omits `temperature` for reasoning-style models (`o*`, `gpt-5*`), and adapts
once if the server rejects a parameter name.

## Anthropic (`anthropic`)

Messages API at `https://api.anthropic.com`. Key: `ANTHROPIC_API_KEY`. System prompts are sent in the top-level
`system` field and roles are merged to alternate strictly. Streaming via server-sent events.

## Google Gemini (`gemini`)

`generativelanguage.googleapis.com/v1beta`, `streamGenerateContent`. Key: `GEMINI_API_KEY` or `GOOGLE_API_KEY`.
The key is sent in the `x-goog-api-key` header, never in the URL. For 2.5/3 models, which count "thinking" tokens
against the output limit, AIC disables thinking on Flash models and leaves headroom on others.

## OpenRouter (`openrouter`)

OpenAI-compatible at `https://openrouter.ai/api/v1`. Key: `OPENROUTER_API_KEY`. Model ids look like
`anthropic/claude-3.5-sonnet`. `aic model list` shows context lengths.

## Custom providers

See [custom-providers.md](custom-providers.md).

## API keys

Lookup order for the active provider:

1. `AIC_API_KEY` (applies to whichever provider is active)
2. The provider's own variable (`OPENAI_API_KEY`, ...; for custom providers the `apiKeyEnv` you configured)
3. A key stored with `aic config set api-key <key> --provider <id>` (global config, file mode `0600`)

Keys are never read from `.aic.json`, never printed (output is scrubbed of known keys), and shown masked by
`aic config get api-key`. Prefer environment variables; a stored key is convenient but lives in a file.

## Models per provider

Each provider keeps its own model (`modelByProvider` in the global config). Switching provider restores that
provider's model or falls back to its default, so an Ollama model name is never sent to a cloud API. A model from
the global config is ignored if a flag, env var or project file selects a different provider; pass `-m` explicitly.

| Provider | Default model |
|---|---|
| ollama | `qwen2.5-coder:7b` |
| openai | `gpt-4o-mini` |
| anthropic | `claude-haiku-5-5` |
| gemini | `gemini-2.5-flash` |
| openrouter | `openai/gpt-4o-mini` |

Defaults are suggestions that may age; set your own with `aic model use`.

## Errors

Provider failures use exit code 3 and say what happened, likely causes and what to run next: unreachable server,
401/403 (credentials), 404 (model or URL), 429 (rate limit or quota), 5xx, timeouts. Secrets are scrubbed from every message.
