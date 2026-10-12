import { existsSync, rmSync } from 'node:fs';
import { GlobalFileSchema, isSettingKey, type GlobalFile, type SettingKey } from './schema.js';
import { globalConfigPath } from './paths.js';
import { readJsonFile, writeJsonFile } from './files.js';
import { AicError, ExitCode } from '../utils/errors.js';

export function readGlobalConfig(env: NodeJS.ProcessEnv = process.env): GlobalFile {
  const path = globalConfigPath(env);
  const raw = readJsonFile(path);
  if (raw === undefined) return {};
  const parsed = GlobalFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new AicError(`Invalid global configuration: ${path}`, ExitCode.GENERAL, {
      details: issues.join('\n'),
      try: ['aic config edit', 'aic config reset'],
    });
  }
  return parsed.data as GlobalFile;
}

export function writeGlobalConfig(cfg: GlobalFile, env: NodeJS.ProcessEnv = process.env): void {
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cfg)) if (v !== undefined) cleaned[k] = v;
  // may hold API keys: owner-only permissions
  writeJsonFile(globalConfigPath(env), cleaned, { secret: true });
}

export function updateGlobalConfig(mutate: (cfg: GlobalFile) => void, env: NodeJS.ProcessEnv = process.env): GlobalFile {
  const cfg = readGlobalConfig(env);
  mutate(cfg);
  writeGlobalConfig(cfg, env);
  return cfg;
}

export function setGlobalSetting(key: SettingKey, value: unknown, env: NodeJS.ProcessEnv = process.env): void {
  if (!isSettingKey(key)) throw new AicError(`Unknown setting: ${key}`, ExitCode.USAGE);
  updateGlobalConfig((cfg) => { (cfg as Record<string, unknown>)[key] = value; }, env);
}

export function unsetGlobalSetting(key: SettingKey, env: NodeJS.ProcessEnv = process.env): void {
  updateGlobalConfig((cfg) => { delete (cfg as Record<string, unknown>)[key]; }, env);
}

/** Remove settings but keep provider definitions and stored keys unless `everything` is set. */
export function resetGlobalConfig(everything: boolean, env: NodeJS.ProcessEnv = process.env): void {
  const path = globalConfigPath(env);
  if (everything) {
    if (existsSync(path)) rmSync(path);
    return;
  }
  const old = readGlobalConfig(env);
  const keep: GlobalFile = {};
  if (old.providers) keep.providers = old.providers;
  if (old.apiKeys) keep.apiKeys = old.apiKeys;
  if (old.acknowledgedProviders) keep.acknowledgedProviders = old.acknowledgedProviders;
  writeGlobalConfig(keep, env);
}

/** Switch provider, restoring the model remembered for it (or clearing `model` so the provider default applies). */
export function switchProvider(providerId: string, explicitModel?: string, env: NodeJS.ProcessEnv = process.env): void {
  updateGlobalConfig((cfg) => {
    cfg.provider = providerId;
    const remembered = cfg.modelByProvider?.[providerId];
    const model = explicitModel ?? remembered;
    if (model) {
      cfg.model = model;
      cfg.modelByProvider = { ...(cfg.modelByProvider ?? {}), [providerId]: model };
    } else {
      delete cfg.model;
    }
  }, env);
}

export function rememberModel(providerId: string, model: string, env: NodeJS.ProcessEnv = process.env): void {
  updateGlobalConfig((cfg) => {
    cfg.model = model;
    cfg.modelByProvider = { ...(cfg.modelByProvider ?? {}), [providerId]: model };
  }, env);
}
