# Development

## Layout

```text
src/
  index.ts            bin entry (signal handling, exit code)
  lib.ts              programmatic API
  cli/
    program.ts        commander wiring, help text, main()
    options.ts        shared flags -> config layer
    legacy.ts         aic.ps1 flag translation
    commands/         one file per command group
    interactive/      commit-flow (shared), repl (agent mode), readiness, rendering
    ui/               theme, output (stderr), spinner, key input, prompts
  agent/              session, agent (conversation), loop (tool calls), tools (+approval), planner, context
  providers/          types, http/SSE helpers, base, ollama, openai-compatible, anthropic, gemini, registry
  git/                exec (safe runner), status, diff, history, branch, commit
  commit/             prompt, format (normalize/validate), generate (retry loop)
  split/ pr/ changelog/ hook/   pure cores of the corresponding commands (no UI; unit-tested)
  security/           secret-scanner
  config/             schema (single source of truth), paths, files, global, project, resolve
  utils/              errors/exit codes, redaction, text, process, clipboard
test/                 vitest; mock HTTP servers; temp repositories
```

Dependency direction: `cli` -> `agent` -> `providers`/`git`/`commit`/`security`/`config` -> `utils`. Providers and git know nothing about the UI.

## Scripts

```bash
npm run dev -- <args>      # tsx src/index.ts
npm run typecheck          # tsc --noEmit (src and tests)
npm run lint               # eslint
npm test                   # vitest run (no network, no keys, no Ollama)
npm run test:watch
npm run build              # tsc -> dist/ (+ chmod +x on the bin)
npm run pack               # npm pack --dry-run
npm run prepublishOnly     # typecheck + lint + test + build
```

## Adding a built-in provider

1. Implement `AIProvider` (extend `BaseProvider`; implement `listModels()` and `stream()`). Use `providerFetch`/`readSse`/`readLines` from `providers/http.ts` so errors, timeouts and secret scrubbing are uniform.
2. Register it in `providers/registry.ts` (`createProvider`, `listProviderEntries`), add its id and default model to `config/schema.ts`, and key env names to `API_KEY_ENV`.
3. Add tests with a mock server (see `test/providers.test.ts`). No real keys, ever.

Most services do not need this: use a [custom provider](custom-providers.md).

## Adding a setting

Add one entry to `SETTINGS` in `config/schema.ts` (type, default, range, project policy) and the `Settings` interface. Validation, `config set`, env variable
`AIC_<NAME>`, the interactive editor and `config list` pick it up automatically. Decide the project policy deliberately: anything that affects where data goes or what runs is `deny`.

## Adding an agent tool

Add a `ToolDef` in `agent/tools.ts` with an honest `risk`. Make `describe()` return the exact command, because that is what the user sees when confirming. Add policy tests in
`test/agent.test.ts`. Do not add tools that force-push, hard reset, clean or delete.

## Conventions

- Decorative output to **stderr** via `ui`; **stdout is data** (`ui.data`).
- Throw `AicError` subclasses with `try`/`causes` so users get next steps; exit codes come from the class.
- Validate arguments before contacting providers (`createSession({ validate })`).
- No shell. Use `Git.raw/out` with argument arrays.

## Platform status

Developed and tested on Linux with Node 22. Windows and macOS paths use Node APIs only (`APPDATA` config directory, `clip`/`pbcopy`, PATHEXT lookup for `ollama`), but the
automated tests have not been run on those platforms. CI on all three is recommended before a stable release.

## Releasing

```bash
npm version patch|minor|major
npm run prepublishOnly
npm pack --dry-run
npm publish --access public
```
