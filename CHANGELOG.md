# Changelog

## 1.1.0

- `aic split`: split uncommitted changes into several logical commits, with a validated plan, per-group secret scan, review menus and a heuristic fallback. Also `/split` in the chat.
- `aic pr`: pull request title and description from the branch, using the repository's PR template when present.
- `aic changelog`: offline release notes from Conventional Commits (`--write`, `--json`, `--compare`), optional `--ai` prose.
- `aic hook install|uninstall|status`: `prepare-commit-msg` hook that fills the editor with a generated message and never blocks a commit.
- `--scopes` flag (allowed scopes), previously only available through `.aic.json`.
- Fixes: `explain what changed` and `commit and push everything` are routed correctly in the chat; REPL no longer exits after an agent answer.

## 1.0.0

First release of the Node.js CLI, replacing the PowerShell script (kept in `legacy/aic.ps1`).

- Interactive agent (`aic`) with slash commands, natural-language routing, streaming answers and tool use with approvals.
- Provider abstraction: Ollama, OpenAI, Anthropic, Gemini, OpenRouter and user-defined providers (`aic provider add`).
- All aic.ps1 options preserved (`-All -Pick -Amend -Undo -DryRun -Yes -Push ...`), with PowerShell-style flags still accepted.
- Global and project configuration with documented precedence, environment variables and an interactive editor.
- Secret scanner with file/line/type reporting, entropy detection and redaction before sending to cloud providers.
- `aic doctor`, `aic init`, `aic status`, `aic model`, meaningful exit codes, `--pass-thru` and `--json` for scripting.
