import {
  API_KEY_ENV,
  BUILTIN_PROVIDERS,
  SETTINGS,
  SETTING_KEYS,
  coerceValue,
  defaults,
  toEnvName,
  type BuiltinProviderId,
  type GlobalFile,
  type ProviderDef,
  type SettingKey,
  type Settings,
  type SettingsLayer,
} from './schema.js';
import { readGlobalConfig } from './global.js';
import { readProjectConfig, type ProjectConfigResult } from './project.js';
import { UsageError } from '../utils/errors.js';

export type Source = 'cli' | 'env' | 'project' | 'global' | 'default';

export interface ResolvedConfig {
  settings: Settings;
  sources: Record<SettingKey, Source>;
  warnings: string[];
  global: GlobalFile;
  projectPath: string | undefined;
  projectExists: boolean;
}

export interface ResolveInput {
  /** Values given as command-line flags (highest priority). */
  cli?: SettingsLayer;
  env?: NodeJS.ProcessEnv;
  repoRoot?: string | undefined;
  /** Injectable for tests; read from disk when omitted. */
  global?: GlobalFile;
  project?: ProjectConfigResult;
}

/** Environment layer: AIC_<SNAKE_CASE_KEY>, e.g. AIC_MAX_CHARS. OLLAMA_HOST is honoured as a weak fallback for ollamaUrl. */
export function envLayer(env: NodeJS.ProcessEnv): { layer: SettingsLayer; warnings: string[] } {
  const layer: Record<string, unknown> = {};
  const warnings: string[] = [];
  for (const key of SETTING_KEYS) {
    const name = toEnvName(key);
    const raw = env[name];
    if (raw === undefined || raw === '') continue;
    try {
      layer[key] = coerceValue(key, raw);
    } catch (e) {
      warnings.push(`${name}: ${e instanceof Error ? e.message : String(e)} (ignored)`);
    }
  }
  if (layer['ollamaUrl'] === undefined && env['OLLAMA_HOST']) layer['ollamaUrl'] = env['OLLAMA_HOST'];
  return { layer: layer as SettingsLayer, warnings };
}

/** Drop what a cloned repository's .aic.json is not allowed to do (see SettingMeta.project). */
export function applyProjectPolicy(layer: SettingsLayer, warnings: string[]): SettingsLayer {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(layer)) {
    const key = k as SettingKey;
    const policy = SETTINGS[key].project;
    if (policy === 'deny') {
      warnings.push(`.aic.json: "${key}" can only be set in your global config or environment (ignored)`);
    } else if (policy === 'only-true' && v !== true) {
      warnings.push(`.aic.json: "${key}" cannot be switched off from a project file (ignored)`);
    } else if (policy === 'only-false' && v !== false) {
      warnings.push(`.aic.json: "${key}" can only restrict what is sent, not widen it (ignored)`);
    } else {
      out[key] = v;
    }
  }
  return out as SettingsLayer;
}

function union(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])];
}

/**
 * Precedence (highest first): CLI flags > environment > project (.aic.json) > global config > defaults.
 * `exclude` is additive across layers, as it was in the PowerShell version.
 */
export function resolveConfig(input: ResolveInput = {}): ResolvedConfig {
  const env = input.env ?? process.env;
  const warnings: string[] = [];
  const global = input.global ?? readGlobalConfig(env);
  const project = input.project ?? readProjectConfig(input.repoRoot);
  warnings.push(...project.warnings);

  const projectLayer = applyProjectPolicy(project.layer, warnings);
  const { layer: envL, warnings: envWarnings } = envLayer(env);
  warnings.push(...envWarnings);

  const layers: Array<[Source, SettingsLayer]> = [
    ['global', pickSettings(global)],
    ['project', projectLayer],
    ['env', envL],
    ['cli', stripUndefined(input.cli ?? {})],
  ];

  const settings = defaults() as unknown as Record<string, unknown>;
  const sources = Object.fromEntries(SETTING_KEYS.map((k) => [k, 'default'])) as Record<SettingKey, Source>;

  for (const [source, layer] of layers) {
    for (const [k, v] of Object.entries(layer)) {
      const key = k as SettingKey;
      if (v === undefined) continue;
      const meta = SETTINGS[key];
      if (meta.kind === 'string[]' && 'merge' in meta && meta.merge === 'union') {
        settings[key] = union((settings[key] as string[]) ?? [], v as string[]);
      } else {
        settings[key] = v;
      }
      sources[key] = source;
    }
  }

  return {
    settings: settings as unknown as Settings,
    sources,
    warnings,
    global,
    projectPath: project.exists ? project.path : undefined,
    projectExists: project.exists,
  };
}

function pickSettings(file: GlobalFile): SettingsLayer {
  const out: Record<string, unknown> = {};
  for (const k of SETTING_KEYS) {
    const v = (file as Record<string, unknown>)[k];
    if (v !== undefined) out[k] = v;
  }
  return out as SettingsLayer;
}

function stripUndefined(l: SettingsLayer): SettingsLayer {
  return Object.fromEntries(Object.entries(l).filter(([, v]) => v !== undefined)) as SettingsLayer;
}

// ---------------------------------------------------------------------------------------------
// providers + API keys
// ---------------------------------------------------------------------------------------------

export function isBuiltinProvider(id: string): id is BuiltinProviderId {
  return (BUILTIN_PROVIDERS as readonly string[]).includes(id);
}

export function customProviders(global: GlobalFile): Record<string, ProviderDef> {
  return global.providers ?? {};
}

export interface ApiKeyLookup {
  key: string | undefined;
  /** where it came from, never the value itself */
  source: string | undefined;
  /** names that were checked, for error messages */
  checked: string[];
}

/**
 * API key lookup order: AIC_API_KEY (applies to the active provider) > provider specific env var >
 * key stored in the global config (mode 0600). Keys are never read from a project file.
 */
export function resolveApiKey(providerId: string, global: GlobalFile, env: NodeJS.ProcessEnv = process.env, activeProviderId?: string): ApiKeyLookup {
  const checked: string[] = [];
  const def = global.providers?.[providerId];
  if ((activeProviderId ?? providerId) === providerId && env['AIC_API_KEY']) {
    return { key: env['AIC_API_KEY'], source: 'env:AIC_API_KEY', checked: ['AIC_API_KEY'] };
  }
  checked.push('AIC_API_KEY');
  const names: string[] = [];
  if (isBuiltinProvider(providerId) && providerId !== 'ollama') names.push(...API_KEY_ENV[providerId]);
  if (def?.apiKeyEnv) names.push(def.apiKeyEnv);
  for (const n of names) {
    checked.push(n);
    if (env[n]) return { key: env[n], source: `env:${n}`, checked };
  }
  const stored = global.apiKeys?.[providerId];
  if (stored) return { key: stored, source: 'config', checked };
  return { key: undefined, source: undefined, checked };
}

export function requireProviderKnown(id: string, global: GlobalFile): void {
  if (isBuiltinProvider(id) || global.providers?.[id]) return;
  const known = [...BUILTIN_PROVIDERS, ...Object.keys(global.providers ?? {})];
  throw new UsageError(`Unknown provider "${id}".`, {
    details: `Available: ${known.join(', ')}`,
    try: ['aic provider list', 'aic provider add <name>'],
  });
}
