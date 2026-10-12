# Configuration

## Precedence

```text
CLI flags  >  environment variables  >  .aic.json (project)  >  global config  >  defaults
```

`aic config list` shows every value and its source (`cli`, `env`, `project`, `global`, `default`).
`exclude` is additive across all layers.

## Locations

| | Path |
|---|---|
| Global | `$XDG_CONFIG_HOME/aic/config.json` or `~/.config/aic/config.json`; `%APPDATA%\aic\config.json` on Windows |
| Override | `AIC_CONFIG_DIR=/some/dir` |
| Project | `.aic.json` in the repository root |

The global file is written with mode `0600` because it may contain API keys and provider definitions. Writes are atomic.

## Settings

Every setting can be set with `aic config set <key> <value>` (camelCase or kebab-case), `AIC_<SNAKE_CASE>`, and in `.aic.json`
unless marked otherwise. Lists are comma separated or JSON.

| Key | Default | Description | Project file |
|---|---|---|---|
| `provider` | `ollama` | Active provider | yes |
| `model` | provider default | Model | yes |
| `language` | `English` | Language of subject and bullets (type and scope stay English) | yes |
| `bullets` | `3` | Max body bullets (0 = subject only) | yes |
| `history` | `3` | Recent commit subjects shown as style reference | yes |
| `maxChars` | `6000` | Diff size cap sent to the model | yes |
| `emoji` | `false` | Gitmoji after the colon | yes |
| `scopes` | `[]` | Allowed scopes (empty = any) | yes |
| `types` | conventional set | Allowed commit types | yes |
| `subjectMax` | `72` | Max subject length | yes |
| `instructions` | | Extra prompt instructions | yes |
| `exclude` | `[]` | Extra pathspecs hidden from the model | yes |
| `retries` | `1` | Retries when the format check fails | yes |
| `temperature` | `0.2` | Sampling temperature (rises on retry/regenerate) | yes |
| `numCtx` | `4096` | Minimum context window (raised automatically when needed) | yes |
| `numPredict` | `256` | Max answer tokens | yes |
| `timeoutSec` | `180` | Request timeout | yes |
| `keepAlive` | `10m` | Ollama keep-alive | yes |
| `unloadModel` | `false` | Unload Ollama model on exit | **no** |
| `ollamaUrl` | `http://localhost:11434` | Ollama server | **no** |
| `autoStartOllama` | `false` | Start `ollama serve` when it is down | **no** |
| `secretScan` | `true` | Scan staged changes for secrets | only `true` |
| `sendDiff` | `true` | Send diff content to the provider | only `false` |
| `sendHistory` | `true` | Send recent commit subjects | only `false` |
| `sendBranch` | `true` | Send the branch name | only `false` |
| `signoff` | `false` | `Signed-off-by` on commits | yes |
| `noVerify` | `false` | Skip git hooks | **no** |
| `autoApprove` | `[]` | Agent tools that run without asking: `git_add`, `git_commit`, `git_push` (`git_reset` is rejected) | **no** |

"Project file: no" means a repository cannot set it, so cloning a hostile repo cannot change where your code is
sent or what runs on your machine. "only true / only false" means the project may tighten but not loosen.
Ignored project keys are reported as warnings.

## Environment variables

`AIC_PROVIDER`, `AIC_MODEL`, `AIC_API_KEY`, `AIC_OLLAMA_URL`, `AIC_LANGUAGE`, `AIC_SECRET_SCAN`, `AIC_MAX_CHARS`,
`AIC_BULLETS`, `AIC_HISTORY`, `AIC_EMOJI`, `AIC_SCOPES`, `AIC_EXCLUDE`, `AIC_TEMPERATURE`, `AIC_NUM_CTX`,
`AIC_NUM_PREDICT`, `AIC_TIMEOUT_SEC`, `AIC_KEEP_ALIVE`, `AIC_AUTO_START_OLLAMA`, `AIC_UNLOAD_MODEL`, `AIC_SEND_DIFF`,
`AIC_SEND_HISTORY`, `AIC_SEND_BRANCH`, `AIC_SIGNOFF`, `AIC_NO_VERIFY`, `AIC_AUTO_APPROVE`, `AIC_TYPES`,
`AIC_SUBJECT_MAX`, `AIC_INSTRUCTIONS`, `AIC_CONFIG_DIR`.
Provider keys: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`/`GOOGLE_API_KEY`, `OPENROUTER_API_KEY`, and any
`apiKeyEnv` of a custom provider. Also read: `OLLAMA_HOST` (weak fallback for `ollamaUrl`), `NO_COLOR`, `AIC_ASCII`.
Invalid values are ignored with a warning, never a crash.

## Commands

```bash
aic config                      # interactive: pick a setting, pick where to save it
aic config list [--json]
aic config get <key>            # api-key prints a masked value and its source
aic config set <key> <value> [--project]
aic config set api-key [key] [--provider id]     # omit the key to be prompted without echo
aic config unset <key> [--project]
aic config reset [--all] [--yes]                 # --all also removes providers and keys
aic config edit [--project]                      # opens $VISUAL / $EDITOR, then validates
aic config path
```

`aic init` writes a starter `.aic.json` (inferred `scopes`); `aic init --global` runs a small setup for the global file.
