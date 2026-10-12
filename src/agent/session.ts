import { openRepo, type Git } from '../git/exec.js';
import { resolveConfig, resolveApiKey, type ResolvedConfig } from '../config/resolve.js';
import { DEFAULT_MODELS, type Settings, type SettingsLayer } from '../config/schema.js';
import { createProvider, defaultModelFor } from '../providers/registry.js';
import type { AIProvider } from '../providers/types.js';
import { findRepoRoot } from '../git/exec.js';

export interface Session {
  cwd: string;
  /** undefined only for commands that do not need a repository (config, provider, doctor ...) */
  git: Git | undefined;
  resolved: ResolvedConfig;
  settings: Settings;
  provider: AIProvider;
  model: string;
  /** stdin and stderr are terminals: prompts are possible */
  interactive: boolean;
  /** --yes */
  yes: boolean;
  /** strip secrets from outgoing context (any non-local provider) */
  redact: boolean;
  /** API key value, only to register it with the output scrubber */
  apiKey: string | undefined;
}

export interface SessionArgs {
  cli: SettingsLayer;
  yes?: boolean | undefined;
  cwd?: string | undefined;
  requireRepo?: boolean;
  /** build the provider even when no API key is available (provider list/test/add) */
  lenient?: boolean;
  env?: NodeJS.ProcessEnv;
  interactive?: boolean;
  /** argument checks that need the resolved settings; runs before any provider is built (so usage errors win over provider errors) */
  validate?: (settings: Settings) => void;
}

/**
 * The model from the *global* config belongs to the *global* provider. If a flag, env var or project file selected
 * another provider, do not send e.g. an Ollama model name to OpenAI.
 */
export function pickModel(r: ResolvedConfig): string {
  const s = r.settings;
  const global = r.global;
  const provider = s.provider;
  let model = s.model;
  if (model && r.sources.model === 'global' && (global.provider ?? 'ollama') !== provider) model = undefined;
  if (!model) model = global.modelByProvider?.[provider];
  if (!model) model = defaultModelFor(provider, global) ?? DEFAULT_MODELS.ollama;
  return model;
}

export async function createSession(a: SessionArgs): Promise<Session> {
  const cwd = a.cwd ?? process.cwd();
  const env = a.env ?? process.env;
  const git = a.requireRepo ? await openRepo(cwd) : undefined;
  const repoRoot = git?.root ?? (await findRepoRoot(cwd));
  const resolved = resolveConfig({ cli: a.cli, env, repoRoot });
  const settings = resolved.settings;
  a.validate?.(settings);
  const provider = createProvider(settings.provider, { settings, global: resolved.global, env }, { requireKey: !a.lenient });
  const apiKey = resolveApiKey(settings.provider, resolved.global, env, settings.provider).key;
  return {
    cwd, git, resolved, settings, provider, model: pickModel(resolved),
    interactive: a.interactive ?? Boolean(process.stdin.isTTY && process.stderr.isTTY),
    yes: a.yes ?? false,
    redact: !provider.local,
    apiKey,
  };
}

/** Switch provider inside a running session (REPL `/provider`). */
export function rebuildProvider(s: Session, providerId: string, model?: string, env: NodeJS.ProcessEnv = process.env): void {
  const settings: Settings = { ...s.settings, provider: providerId };
  const provider = createProvider(providerId, { settings, global: s.resolved.global, env });
  s.settings = settings;
  s.provider = provider;
  s.redact = !provider.local;
  s.apiKey = resolveApiKey(providerId, s.resolved.global, env, providerId).key;
  s.model = model ?? s.resolved.global.modelByProvider?.[providerId] ?? defaultModelFor(providerId, s.resolved.global) ?? s.model;
}
