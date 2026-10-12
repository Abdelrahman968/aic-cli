# Security and privacy

## What AIC sends where

| Provider | Receives |
|---|---|
| Ollama on loopback | nothing leaves your machine |
| Anything else | the staged diff (shrunk to `maxChars`), changed file names and line counts, recent commit subjects, the branch name, your hint, and (in agent mode) a repository status snapshot plus whatever read-only tools return |

Before sending to a non-local provider AIC:

1. **withholds** the diff of credential-like files (`.env*`, `*.pem`, `id_rsa`, service-account files, ...),
2. **redacts** anything matching a secret rule with `[REDACTED]`,
3. prints how many characters of diff are being sent, and asks once per provider for consent (stored in `acknowledgedProviders`).

You can narrow it further: `sendDiff=false` (names and counts only), `sendHistory=false`, `sendBranch=false`, `exclude`, `maxChars`.
A project file may only tighten these.

AIC never sends the whole repository. Agent tools `read_file` and `search_files` only serve files inside the repository, refuse
files ignored by `.gitignore`, credential files and your `exclude` patterns, and do not follow symlinks out of the repo. Their output goes
through the same redaction.

## Secret scanner

Runs locally on the **added lines** of the staged diff and on staged paths, before generation and before every commit.

- Detects: AWS access key ids, GitHub tokens, Slack tokens, Stripe live keys, Google API keys, OpenAI and Anthropic keys, npm tokens, JWTs,
  private key blocks, database URLs with passwords, `password/secret/token/api_key = "..."` assignments, `.env` and key/credential files, and
  high-entropy strings near words like key/token/secret.
- Ignores placeholders (`your-...`, `changeme`, `process.env.X`, `user:password@localhost`), `*.example/.sample/.template` files and lockfiles/minified/binary assets for the entropy rule.
- Reports **file, line, type**. The matched value is not stored in the finding, so it cannot reach logs or the terminal.
- A finding blocks `--yes` commits (exit 5) before the model is contacted. In a terminal you can still choose to commit after an explicit warning. `--no-scan` disables the scan entirely.
- It is a safety net, not a guarantee. Entropy heuristics are deliberately conservative, and novel token formats are not recognized. Keep real secrets out of Git.

## Git safety

Tools are grouped by risk: read, write, remote (push), history (soft undo). Anything that is not read-only is shown as an exact command and needs
confirmation; `--yes` only covers what is documented to be bypassable ([commands.md](commands.md)). There is no force-push, hard reset, clean or delete
tool, and `autoApprove` cannot include `git_reset`. Commits go through a temp file (`git commit -F`), so message text is never parsed by a shell. No command is
run through a shell except the optional `config edit` editor launch.

## API keys

Environment variables first; a stored key lives in the global config with mode `0600`. Keys are never read from `.aic.json`, never printed (output is scrubbed of
known key values and common header/query patterns), masked in `config get/list`, sent only in headers (Gemini uses `x-goog-api-key`, not a URL parameter), and
excluded from error messages.

## Hostile repositories

A repository's `.aic.json` cannot: change `ollamaUrl`, define providers or base URLs, store keys, enable `autoApprove`, enable `autoStartOllama`, skip hooks,
turn the secret scan off or widen what is sent. Violations are ignored with a warning.

## Reporting

Please report vulnerabilities privately through the repository's security advisory page rather than a public issue.
