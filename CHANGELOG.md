# Changelog

## 1.0.0

First release of the Node.js CLI, replacing the PowerShell script (kept in `legacy/aic.ps1`).

- Interactive agent (`aic`) with slash commands, natural-language routing, streaming answers and tool use with approvals.
- Provider abstraction: Ollama, OpenAI, Anthropic, Gemini, OpenRouter and user-defined providers (`aic provider add`).
- All aic.ps1 options preserved (`-All -Pick -Amend -Undo -DryRun -Yes -Push ...`), with PowerShell-style flags still accepted.
- Global and project configuration with documented precedence, environment variables and an interactive editor.
- Secret scanner with file/line/type reporting, entropy detection and redaction before sending to cloud providers.
- `aic doctor`, `aic init`, `aic status`, `aic model`, meaningful exit codes, `--pass-thru` and `--json` for scripting.
