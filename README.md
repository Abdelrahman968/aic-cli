# AIC

**AI coding agent for Git, in your terminal.** AIC reads your repository state, writes
[Conventional Commit](https://www.conventionalcommits.org) messages, answers questions about your changes, and runs
Git actions for you, always showing the exact command and asking before anything that changes history or touches
the network.

It started as a PowerShell script (`aic.ps1`) for local Ollama models. It is now a cross-platform Node.js CLI with
a provider-agnostic core: Ollama, OpenAI, Anthropic, Google Gemini, OpenRouter, or any OpenAI-compatible endpoint
you configure yourself.

```text
$ aic commit

  ╭─ Staged changes ──────────────────────────────────── 1 file  +1 -1
  │ +1 -1  src/auth/token.ts
  ╰─
  ● Ollama · qwen2.5-coder:7b

  ╭─ Suggested commit ─────────────────────────────────
  │ feat(auth): add refresh token rotation
  │
  │ - rotate tokens on use
  │ - revoke old sessions
  ╰ 20 tok · 1.4s · 14.3 tok/s · qwen2.5-coder:7b

   Enter  commit   e  edit   r  regenerate   h  hint   p  commit & push
   t  type   s  scope   b  breaking   m  model   c  copy   d  diff   q  quit
```

## Contents

[Install](#install) · [Quick start](#quick-start) · [Requirements](#requirements) · [Agent mode](#agent-mode) ·
[Commit workflow](#commit-workflow) · [More workflows](#more-workflows) · [Providers](#providers) · [Custom providers](#custom-providers) ·
[Configuration](#configuration) · [Commands](#commands) · [Secret scanning](#secret-scanning) ·
[Privacy](#privacy) · [Safety model](#safety-model) · [Scripting and CI](#scripting-and-ci) ·
[Coming from aic.ps1](#coming-from-the-powershell-script) · [Troubleshooting](#troubleshooting) ·
[Development](#development) · [Publishing](#publishing) · [License](#license)

## Install

```bash
npm install -g @aic/cli     # then run: aic
npx @aic/cli                # no install
```

Node.js 18.17 or newer and Git are required. Works on Windows (PowerShell, CMD, Git Bash), macOS and Linux.

## Quick start

With [Ollama](https://ollama.com) (local, nothing leaves your machine):

```bash
ollama pull qwen2.5-coder:7b
cd my-project
git add -A
aic commit
```

With a cloud provider:

```bash
export OPENAI_API_KEY=...          # PowerShell: $env:OPENAI_API_KEY="..."
aic config set provider openai
aic doctor                         # verifies Node, Git, provider, key, model
aic commit
```

Not sure what is wrong? Run `aic doctor`:

```text
  AIC Doctor

  ✓ Node.js 22.22.2
  ✓ Git 2.43.0
  ✓ Repository detected
  ✓ Configuration valid
  ✓ Provider Ollama
  ✓ Ollama reachable
  ✓ qwen2.5-coder:7b available
  ✓ Secret scanner working

  AIC is ready.
```

## Requirements

| | |
|---|---|
| Node.js | 18.17+ (developed on 22) |
| Git | any recent version, on `PATH` |
| A model | Ollama running locally, **or** an API key for a cloud provider |

### Ollama setup

1. Install Ollama and pull a coding model: `ollama pull qwen2.5-coder:7b`. Smaller (`qwen2.5-coder:3b`) is faster, larger is more accurate.
2. Make sure it is running (`ollama serve`), or let AIC start it: `aic commit --start-ollama` or `aic config set autoStartOllama true`.
3. Non-default address: `aic config set ollamaUrl http://gpu-box:11434` (or `AIC_OLLAMA_URL`, or `OLLAMA_HOST`).
4. `aic model list` shows what is installed; `aic model use <name>` selects one.

AIC raises Ollama's context window automatically when the prompt needs it, disables "thinking" on reasoning
models so they do not burn the token budget, and can unload the model when it is done (`--unload`).

## Agent mode

Run `aic` in a terminal to start the interactive agent. Ask in plain English or use slash commands.

```text
╭───────────────────────────╮
│ AIC  •  AI Coding Agent   │
│ Ollama • qwen2.5-coder:7b │
╰───────────────────────────╯

  Repository  sarahah-api
  Branch      feature/auth
  Provider    Ollama  local only: nothing leaves your machine

You › explain what changed

  ✓ Git status
  ✓ Diff
  ✓ Commit history

AIC:
  Authentication and session handling changed.
  • Refresh tokens are now rotated on every use
  • Old sessions are revoked when a token is reused
  • The auth middleware validates the new claims

You › commit my changes
```

| Slash command | Does |
|---|---|
| `/status` `/diff [unstaged]` `/history [n]` | Inspect the repository |
| `/commit [push]` `/generate` `/regenerate [hint]` | Commit workflow |
| `/split` | Split the changes into several logical commits |
| `/push` `/undo` | Push (asks first) · soft-undo the last commit |
| `/model [name]` `/provider [id]` `/config` | Switch model or provider without leaving |
| `/clear` `/help` `/exit` | |

Natural language works for the common requests ("commit my changes", "use a shorter commit message",
"regenerate using another model", "show me the diff"). These are routed by rules, not by the model, so they
work reliably even with small local models. Anything else is sent to the model together with a compact snapshot of
your repository, and the model may call read-only tools (`git_log`, `read_file`, `search_files`, ...) to look
things up. `Esc` cancels a running request, `Ctrl+C` leaves.

## Commit workflow

```bash
aic commit                  # staged changes; offers a file checklist when nothing is staged
aic commit --all            # git add -A first
aic commit --pick           # choose files from a checklist
aic commit --amend          # rewrite the last commit message
aic commit --dry-run        # show the message, commit nothing
aic commit --type fix --scope auth --breaking
aic commit --hint "fixes the login redirect loop" --ref "#42"
aic generate --copy         # message to the clipboard
aic push                    # commit and push (asks before pushing)
aic undo                    # soft-undo the last commit; changes stay staged
```

AIC streams the answer, then cleans it up: strips `<think>` blocks, fences and preambles, lowercases the subject,
removes the trailing period, fixes bullets, and enforces any `--type`, `--scope`, `--breaking` you forced, even if
the model ignored them. If the result still fails the format check it retries with feedback and a slightly higher
temperature. Subject length, allowed types, allowed scopes, bullets, language, gitmoji and extra instructions are all
configurable (see [Configuration](#configuration)).

Lockfiles, minified files and source maps are excluded from the diff by default. Large diffs are shrunk fairly:
every file gets a share of `maxChars`, small files free budget for big ones.

## More workflows

### Split a messy working tree into several commits

```text
$ aic split

  ╭─ 1/3 ─────────────────────────────── 2 files
  │ feat(auth)  rotate refresh tokens
  │ src/auth/token.ts
  │ src/auth/refresh.ts
  ╰─
  ╭─ 2/3 ─────────────────────────────── 1 file
  │ fix  fix route handling
  │ src/api/routes.ts
  ╰─
  ╭─ 3/3 ─────────────────────────────── 1 file
  │ docs  document it
  │ README.md
  ╰─

? Create 3 commits? (Use arrow keys)
❯ Yes, create 3
  Plan again
  Cancel
```

The model proposes the grouping (at most `--max-commits`, default 6); AIC guarantees every changed file lands in exactly
one commit, falls back to grouping by area if the model's plan is unusable, then stages and commits one group at a time,
writing a message for each (you can edit, regenerate, skip or stop per group). Each group is secret-scanned before
anything is sent; a finding stops the run (exit 5) and keeps the commits already made. `--dry-run` and `--json` only print
the plan. Splitting works on whole files, not hunks. Also available in the chat as `/split`.

### Pull request title and description

```bash
aic pr                       # compares with origin/HEAD, main or master
aic pr --base develop --conventional
aic pr --copy                # title + description to the clipboard
aic pr --json | jq -r .title      # for gh and other tools
aic pr --json
```

Uses the commits and the three-dot diff against the base branch, and fills in `.github/pull_request_template.md` when
the repository has one (`--template`, `--no-template`). It never invents test results. For `gh`, the JSON form is easier:
`aic pr --json | jq -r .title`.

### Release notes and CHANGELOG

```bash
aic changelog                              # since the latest tag, grouped by type, printed to stdout
aic changelog --release 1.2.0 --write      # insert into CHANGELOG.md (newest first)
aic changelog --from v1.0.0 --to v1.1.0 --json
aic changelog --ai --release 1.2.0         # user-facing prose from the same commits
```

The default mode needs **no model and no network**: it groups Conventional Commits into Features, Bug Fixes, Performance, ...,
puts breaking changes (`!` or a `BREAKING CHANGE:` footer) first, and hides chores. `--ai` rewrites it as release notes; only commit
subjects are sent, never diffs.

### `git commit` with a generated message

```bash
aic hook install
git add -A
git commit            # the editor opens with a ready message
```

Installs a `prepare-commit-msg` hook. It only acts when git would open the editor with an empty message (never for `-m`,
amend, merge or squash), skips silently when Ollama is down, a cloud provider has not been approved yet, or secrets are
staged, and **never blocks a commit**. Switch it off once with `AIC_HOOK_DISABLE=1`; remove it with `aic hook uninstall`
(an existing foreign hook is never overwritten without `--force`, and is restored afterwards).

## Providers

| Id | Notes | Key |
|---|---|---|
| `ollama` | Local. Streaming, model discovery, auto-start. | none |
| `openai` | Chat Completions API. | `OPENAI_API_KEY` |
| `anthropic` | Messages API. | `ANTHROPIC_API_KEY` |
| `gemini` | Google Gemini API. | `GEMINI_API_KEY` or `GOOGLE_API_KEY` |
| `openrouter` | Many models behind one key. | `OPENROUTER_API_KEY` |
| *your own* | Any OpenAI-compatible, Anthropic-compatible or Ollama-compatible endpoint. | your env var |

```text
$ aic provider list

  AIC Providers

  ✓ Ollama  (current)  local
  ○ OpenAI  cloud, needs API key
  ○ Anthropic  cloud, needs API key
  ○ Google Gemini  cloud, needs API key
  ○ OpenRouter  cloud, needs API key
  ✓ my-provider  custom, cloud

  Current:
  Ollama → qwen2.5-coder:7b
```

```bash
aic provider use openai --model gpt-4o-mini   # or: aic config set provider openai
aic provider test                             # connectivity, credentials, tiny generation
aic -p anthropic commit                       # one-off override
```

Each provider remembers its own model, so switching back and forth does not send an Ollama model name to OpenAI.
Details in [docs/providers.md](docs/providers.md).

## Custom providers

No source changes needed. Describe the endpoint once:

```bash
aic provider add my-provider \
  --base-url https://example.com/v1 \
  --api-key-env MY_API_KEY \
  --model my-model

aic config set provider my-provider
aic provider test
```

Stored in the global config as:

```json
{
  "providers": {
    "my-provider": {
      "name": "my-provider",
      "protocol": "openai-compatible",
      "baseUrl": "https://example.com/v1",
      "apiKeyEnv": "MY_API_KEY",
      "model": "my-model"
    }
  }
}
```

Optional fields: `headers`, `timeoutSec`, `stream`, `contextLength`, `temperature`, `maxTokens`. `protocol` is
`openai-compatible` (default), `anthropic` or `ollama`. See [docs/custom-providers.md](docs/custom-providers.md)
for LM Studio, llama.cpp, vLLM, Azure-style gateways and corporate proxies.

## Configuration

Precedence, highest first:

```text
CLI flags  >  environment variables  >  .aic.json (project)  >  global config  >  defaults
```

```bash
aic config                       # interactive editor
aic config list                  # every value and where it comes from
aic config get model
aic config set language en
aic config set secretScan true
aic config set bullets 2 --project     # writes .aic.json
aic config edit                  # open in $EDITOR
aic config reset                 # defaults (keeps providers and keys)
```

Global file: `~/.config/aic/config.json` (`%APPDATA%\aic\config.json` on Windows; override the directory with
`AIC_CONFIG_DIR`). Project file: `.aic.json` at the repository root. `aic init` creates it and infers scopes from
your folder layout.

```json
{
  "model": "qwen2.5-coder:7b",
  "language": "English",
  "bullets": 3,
  "emoji": false,
  "scopes": ["api", "web", "auth"],
  "exclude": ["*.svg", "docs/generated/**"],
  "instructions": "Mention the ticket id from the branch name."
}
```

Every setting has an environment variable named `AIC_<SNAKE_CASE>`: `AIC_PROVIDER`, `AIC_MODEL`, `AIC_API_KEY`,
`AIC_OLLAMA_URL`, `AIC_LANGUAGE`, `AIC_SECRET_SCAN`, `AIC_MAX_CHARS`, `AIC_AUTO_START_OLLAMA`, ... Full list in
[docs/configuration.md](docs/configuration.md).

A cloned repository's `.aic.json` cannot weaken your security: it may not change `ollamaUrl`, `autoApprove`,
`autoStartOllama` or `noVerify`, cannot switch the secret scan off, and can only *reduce* what is sent to a provider.
It never holds API keys.

## Commands

```text
aic                   interactive agent (in a terminal)
aic chat              same, explicit
aic commit            generate, review, commit
aic generate          generate only, commit nothing
aic push              commit and push
aic split             split uncommitted changes into several commits
aic pr                pull request title and description
aic changelog         release notes from Conventional Commits
aic hook              install | uninstall | status (prepare-commit-msg)
aic undo              soft-undo the last commit
aic status            repository status (--json)
aic init              create .aic.json (--global for user config)
aic doctor            check the whole setup
aic provider          list | add | remove | use | test
aic model             list | use | current | test
aic config            list | get | set | unset | reset | edit | path
aic help [command]
```

Global options: `-m, --model` `-p, --provider` `--ollama-url` `--start-ollama` `-n, --dry-run` `-y, --yes`
`--no-scan` `--verbose` `-q, --quiet` `--plain` `--no-color` `--no-anim` `-h` `-v`. Full reference with every option and
exit code: [docs/commands.md](docs/commands.md).

## Secret scanning

Before every commit, the staged changes are scanned locally for credentials. Findings name the file, the line and
the kind of secret. **The value is never printed, logged or sent anywhere.**

```text
  ⚠ Potential secrets detected

    File: .env
    Type: environment file (usually holds secrets)

    File: src/auth/leak.ts
    Line: 1
    Type: AWS access key id

    The values are never printed or sent anywhere. Remove them, or use --no-scan only if you understand the risk.

  ✗ Possible secrets are staged, so --yes will not commit
```

It looks for AWS, GitHub, Slack, Stripe, Google, OpenAI and Anthropic keys, npm tokens, JWTs, private key blocks,
database URLs with passwords, hard-coded `password = "..."` assignments, `.env` and key files, and high-entropy
strings next to words like `token` or `secret`. Placeholders and `.env.example` are ignored. With `--yes` a finding
blocks the commit (exit code 5) **before anything is sent to the model**. Details in [docs/security.md](docs/security.md).

## Privacy

- **Ollama on localhost:** nothing leaves your machine.
- **Cloud providers:** the staged diff, file names, recent commit subjects and the branch name are sent to the provider. The header, the first-use prompt and a line before every request say so. Control it with `sendDiff`, `sendHistory` and `sendBranch`; with `sendDiff=false` only file names and line counts are shared.
- Before anything is sent to a cloud provider, secret-like values are replaced with `[REDACTED]` and the diffs of `.env`/key files are withheld entirely.
- Only the minimum is sent: the staged diff (shrunk to `maxChars`), never "the repository". `read_file` and `search_files` refuse ignored files, credential files and anything outside the repo.

## Safety model

AIC never silently runs a destructive command.

| Risk | Tools | Asks? | `--yes` |
|---|---|---|---|
| read | status, diff, log, branch, read_file, search_files | never | n/a |
| write | `git add`, `git commit`, unstage | yes | skips the question |
| remote | `git push` (never forced) | yes, showing the command | skips it **only with an explicit `--push`** (or `autoApprove`) |
| history | `git reset --soft HEAD~1` (undo) | yes | skips it **only for `aic undo --yes`**, and never for a commit that is already pushed |

There is no tool for force-push, hard reset, `git clean` or deleting files. `--yes` is not "ignore all safety": it
never bypasses the secret scan, the format check, or confirmations that exist for a reason.

```text
  AIC wants to run:

    git push -u origin HEAD

? Continue? (y/N)
```

## Scripting and CI

UI goes to **stderr**; **stdout carries data only**.

```bash
msg=$(aic generate --pass-thru)            # message only
aic commit --yes                           # unattended commit
aic commit --yes --push                    # unattended commit and push
aic status --json | jq .branch
aic provider list --json
```

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | general failure (e.g. nothing staged) |
| 2 | invalid arguments |
| 3 | provider error (unreachable, bad key, missing model) |
| 4 | Git error (not a repo, no remote, hook failed) |
| 5 | secret detected |
| 6 | cancelled by the user (or confirmation needed but no terminal) |

## Coming from the PowerShell script

`aic -All -Push -DryRun` still works, and PowerShell-style parameters (`-All`, `-Type fix`, `-Undo`, `-Init`, ...) are
translated automatically with a one-line notice. The original is kept in [`legacy/aic.ps1`](legacy/aic.ps1).
The mapping table is in [docs/commands.md](docs/commands.md#migrating-from-aicps1).

## Troubleshooting

Start with `aic doctor`. Common cases:

```text
  ✗ Unable to connect to Ollama

    URL: http://localhost:11434

    Possible causes:
      • Ollama is not running
      • The configured URL is incorrect
      • Firewall/network issue

    Try:
      aic doctor
      aic config get ollamaUrl
      ollama serve
```

| Symptom | Fix |
|---|---|
| `Model '...' is not installed` | `ollama pull <model>`, or `aic model use <installed-model>` |
| `No API key for OpenAI` | set `OPENAI_API_KEY`, or `aic config set api-key <key> --provider openai` |
| `rejected the credentials (HTTP 401)` | wrong or expired key; keys are never printed, check where it comes from with `aic config get api-key` |
| Empty message from a "thinking" model | `aic config set numPredict 1024` or pick a non-reasoning model |
| Garbled box characters on an old Windows console | `--plain` or `AIC_ASCII=1` |
| Slow first answer with Ollama | the model is loading; raise `timeoutSec` and keep it warm with `keepAlive` |

`--verbose` adds diagnostics and stack traces. Your API key is never included in output.

## Development

```bash
git clone https://github.com/aic-cli/aic && cd aic
npm install
npm run dev -- --help        # run from source
npm run typecheck && npm run lint && npm test
npm run build                # dist/
npm pack --dry-run           # what would be published
```

Tests need no API keys, no network and no Ollama: providers are exercised against local mock HTTP servers and the
CLI is run end to end against a temp Git repository. Architecture and conventions: [docs/development.md](docs/development.md).

## Contributing

Issues and pull requests are welcome. Please include a test with every behaviour change, keep `npm run typecheck`,
`npm run lint` and `npm test` green, and keep new output on stderr (stdout is for data). For anything that touches
Git actions, state which risk tier (read/write/remote/history) it belongs to.

## Publishing

```bash
npm run prepublishOnly          # typecheck, lint, test, build
npm pack --dry-run              # inspect the file list
npm publish --access public     # scoped packages are private by default
```

## License

MIT, see [LICENSE](LICENSE).
