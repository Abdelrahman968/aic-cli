# Custom providers

Add any endpoint without touching source code.

```bash
aic provider add my-provider \
  --base-url https://example.com/v1 \
  --api-key-env MY_API_KEY \
  --model my-model
aic provider use my-provider
aic provider test my-provider
```

Without flags in a terminal, `aic provider add` asks for each value.

## Definition

Stored in the global config under `providers.<name>`:

| Field | Meaning |
|---|---|
| `name` | Letters, digits, `.`, `_`, `-`. Cannot reuse a built-in id. |
| `protocol` | `openai-compatible` (default), `anthropic` or `ollama` |
| `baseUrl` | For `openai-compatible`: the URL that has `/chat/completions` and `/models` below it (usually ends in `/v1`) |
| `apiKeyEnv` | Name of the environment variable holding the key. If set, the key is required. |
| `model` | Default model for this provider |
| `headers` | Extra static headers. Not for secrets: values are stored in plain text. |
| `timeoutSec` | Reserved for per-provider timeouts; the global `timeoutSec` applies today |
| `stream` | `false` for endpoints without SSE streaming |
| `contextLength` | Informational |
| `temperature`, `maxTokens` | Defaults when the request does not set them |

```json
{
  "providers": {
    "lmstudio": { "name": "lmstudio", "protocol": "openai-compatible", "baseUrl": "http://127.0.0.1:1234/v1", "model": "qwen2.5-coder-7b-instruct" }
  }
}
```

## Recipes

- **LM Studio / llama.cpp server / vLLM:** `--base-url http://127.0.0.1:1234/v1`, no `--api-key-env`. Loopback URLs count as local.
- **Corporate gateway:** `--base-url https://llm.corp.example/v1 --api-key-env CORP_LLM_KEY --header x-team=platform`.
- **Anthropic-compatible proxy:** `--protocol anthropic --base-url https://proxy.example`.
- **Remote Ollama:** `--protocol ollama --base-url http://gpu-box:11434` (treated as cloud for privacy since it is not loopback).
- **No streaming:** `--no-stream`.

## Management

```bash
aic provider list [--json]
aic provider remove my-provider [--yes]
aic provider add my-provider ... --force    # replace
```

Removing the active provider switches back to Ollama and clears its stored key and remembered model.

## Notes

- Custom providers live only in the **global** config. A `.aic.json` in a repository cannot define providers or change base URLs, so a cloned repo cannot redirect your diffs.
- `aic provider test` lists models (a missing `/models` route is tolerated) and sends a tiny prompt. No repository data is included.
