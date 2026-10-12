# Command reference

```text
aic [command] [options]
```

Run `aic help <command>` for the live option list. All commands accept the global options.

## Global options

| Option | |
|---|---|
| `-m, --model <model>` | model to use |
| `-p, --provider <id>` | provider to use |
| `--ollama-url <url>` | Ollama server URL |
| `--start-ollama` | start `ollama serve` if it is not running |
| `-n, --dry-run` | show the message, commit nothing |
| `-y, --yes` | skip the review prompt. Never skips the secret scan, the format check, or confirmations for push (without `--push`) and undo of pushed commits |
| `--no-scan` | skip the secret scan |
| `--verbose` / `-q, --quiet` | more / less output |
| `--plain`, `--no-color`, `--no-anim` | ASCII only / no colours / no animation (`NO_COLOR` and `CI` are honoured) |
| `--cwd <dir>` | run as if started in `<dir>` |
| `-h, --help` / `-v, --version` | |

## Agent

### `aic` / `aic chat`
Interactive agent. Needs a terminal (otherwise `aic` prints help and `aic chat` exits 2). See the README for slash commands.

## Commit workflow

### `aic commit`, `aic generate` (alias `gen`), `aic push`
`generate` never commits (like the old `-DryRun`). `commit` reviews and commits. `push` is `commit --push`; with nothing
to commit it pushes existing commits.

| Option | |
|---|---|
| `-a, --all` | `git add -A` first |
| `--pick` | file checklist |
| `--amend` | rewrite the last commit message (cannot be combined with `--all`) |
| `--push` | push afterwards (asks unless `--yes`) |
| `--copy` | message to the clipboard, commit nothing |
| `--pass-thru` | print only the final message on stdout |
| `--no-verify` / `--signoff` | git hooks / `Signed-off-by` |
| `-t, --type <type>` | force the type (validated against `types`) |
| `-s, --scope <scope>` | force the scope |
| `--scopes <list>` | allowed scopes, comma separated |
| `--breaking` | `type(scope)!:` |
| `--emoji` | gitmoji |
| `--hint <text>` | extra context for the model |
| `-l, --language <lang>` | language of subject and bullets |
| `--bullets <n>` / `--history <n>` | body bullets (0 = subject only) / recent commits shown as style reference |
| `--ref <ref>` | adds a `Refs: <ref>` footer |
| `-x, --exclude <glob>` | hide paths from the model (repeatable) |
| `--max-chars`, `--retries`, `--temperature`, `--num-ctx`, `--num-predict`, `--timeout`, `--keep-alive` | tuning |
| `--unload` | unload the Ollama model when done |

Review keys (interactive): `Enter` commit · `e` edit in `$EDITOR` · `r` regenerate · `h` hint · `p` commit and push ·
`t` type · `s` scope · `b` toggle breaking · `m` model · `c` copy · `d` diff · `q` quit. `Esc` during generation cancels it.

Behaviour notes: `--yes` with secret findings exits 5 before contacting the model. `--yes` without a terminal and with a message that still fails the
format check exits 1 instead of committing (in a terminal it falls back to the review prompt). Without a terminal and without `--yes`, `commit`/`push` exit 2.

### `aic split`
Split uncommitted changes into several commits (whole files). `--max-commits <n>` (2-12, default 6), `--hint <text>`, `--json` (print the plan),
global `--dry-run` (print the plan), `--yes` (no prompts), `--no-scan`.
Each group is staged in turn (the current index is replaced; file contents never change), secret-scanned, then committed with a generated message.
A finding stops the run with exit 5 and leaves that group staged. Without a terminal and without `--yes` it exits 2.

### `aic pr`
Pull request title and description from `base..HEAD` and the three-dot diff. `--base <ref>` (default `origin/HEAD`, `main`, `master`),
`--template <file>` / `--no-template`, `--conventional`, `--title-max <n>`, `--hint`, `-l/--language`, `--copy`, `--pass-thru` (title, blank line, body on stdout), `--json`.
Exit 1 when the branch has no commits beyond the base, 4 for an unknown base.

### `aic changelog`
Release notes from Conventional Commits. Offline unless `--ai`.
`--from <ref>` (default: latest tag), `--to <ref>` (default `HEAD`), `--release <label>`, `--date`, `--include-all` (chores), `--no-hashes`,
`--compare` (link the heading to a compare view), `--ai`, `--json`, `--write [file]` (insert into `CHANGELOG.md`, newest first; replaces an
`## Unreleased` section; refuses to duplicate a version without `--force`).

### `aic hook`
`install [--force]` · `uninstall` · `status`. Installs a `prepare-commit-msg` hook (respects `core.hooksPath`). It runs `aic hook run` (internal) only when git
would open the editor with an empty message, and always exits 0.

### `aic undo`
`git reset --soft HEAD~1`: the commit disappears, its changes stay staged. Asks first. `--yes` skips the question unless the
commit is already on the remote (then a person must confirm). Without a terminal and without `--yes` it exits 6.

## Information

### `aic status [--json]`
Branch, upstream (ahead/behind) and changed files grouped as staged / modified / untracked.

### `aic doctor`
Checks Node.js, Git, the repository, configuration, provider, credentials, reachability, model and the secret scanner.
Exit code is that of the first failed check (3 provider, 4 git, 1 other).

## Setup

### `aic init [--global] [--force]`
`.aic.json` with inferred scopes; `--global` runs a small setup for the global config.

### `aic provider`
`list [--json]` · `add [name]` · `remove <name> [--yes]` · `use [name] [--model m]` · `test [name] [--no-generate]`.
`add` options: `--base-url`, `--protocol`, `--api-key-env`, `--model`, `--header NAME=value` (repeatable), `--timeout`, `--no-stream`,
`--context-length`, `--temperature`, `--max-tokens`, `--force`.

### `aic model`
`list [--json]` · `current [--json]` · `use [name] [--project]` · `test [name]`.

### `aic config`
`list` · `get` · `set` · `unset` · `reset` · `edit` · `path`, or no subcommand for the interactive editor. See [configuration.md](configuration.md).

## Exit codes

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | general failure (nothing staged, empty model output, ...) |
| 2 | invalid arguments or usage (also: a terminal is required) |
| 3 | provider error |
| 4 | Git error |
| 5 | secret detected |
| 6 | cancelled by the user, or a confirmation was needed but there is no terminal |

Usage errors are detected before any provider is contacted, so `aic commit --type nope` is always 2, even when the provider is down.

## Migrating from aic.ps1

PowerShell-style parameters are still accepted and translated (case-insensitive). Without an explicit subcommand they run `commit`.

| `aic.ps1` | New |
|---|---|
| `-All` | `aic commit --all` |
| `-Pick` | `--pick` |
| `-Amend` | `--amend` |
| `-Undo` | `aic undo` |
| `-DryRun` | `--dry-run` (`aic generate`) |
| `-Yes` | `--yes` |
| `-Push` | `--push` or `aic push` |
| `-Copy` | `--copy` |
| `-PassThru` | `--pass-thru` |
| `-NoScan` | `--no-scan` |
| `-StartOllama` | `--start-ollama` / `autoStartOllama` |
| `-OllamaUrl` | `--ollama-url` / `ollamaUrl` |
| `-Model` | `-m, --model` |
| `-Hint` | `--hint` |
| `-Type` | `-t, --type` |
| `-Scope` | `-s, --scope` |
| `-Scopes` | `--scopes` / `scopes` |
| `-Breaking` | `--breaking` |
| `-Language` | `-l, --language` |
| `-Bullets` | `--bullets` |
| `-History` | `--history` |
| `-MaxChars` | `--max-chars` |
| `-Exclude` | `-x, --exclude` |
| `-Emoji` | `--emoji` |
| `-Init` | `aic init` |
| `.aic.json` | unchanged and still read |

One intentional change: a project `.aic.json` can no longer set `ollamaUrl` and cannot turn the secret scan off (see [security.md](security.md)).
