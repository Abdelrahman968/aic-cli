import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ProjectFileSchema, SETTING_KEYS, type SettingsLayer } from './schema.js';
import { PROJECT_CONFIG_NAME } from './paths.js';
import { readJsonFile, writeJsonFile } from './files.js';
import { AicError, ExitCode } from '../utils/errors.js';

export function projectConfigPath(repoRoot: string): string {
  return join(repoRoot, PROJECT_CONFIG_NAME);
}

export interface ProjectConfigResult {
  layer: SettingsLayer;
  path: string;
  exists: boolean;
  warnings: string[];
}

/** Reads .aic.json. Unknown keys and invalid values are ignored with a warning instead of failing the whole run. */
export function readProjectConfig(repoRoot: string | undefined): ProjectConfigResult {
  if (!repoRoot) return { layer: {}, path: '', exists: false, warnings: [] };
  const path = projectConfigPath(repoRoot);
  if (!existsSync(path)) return { layer: {}, path, exists: false, warnings: [] };
  const warnings: string[] = [];
  let raw: unknown;
  try {
    raw = readJsonFile(path);
  } catch (e) {
    warnings.push(`${PROJECT_CONFIG_NAME} could not be read and was ignored (${e instanceof Error ? e.message : String(e)})`);
    return { layer: {}, path, exists: true, warnings };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push(`${PROJECT_CONFIG_NAME} must contain a JSON object and was ignored`);
    return { layer: {}, path, exists: true, warnings };
  }
  const layer: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!(SETTING_KEYS as string[]).includes(k)) {
      warnings.push(`${PROJECT_CONFIG_NAME}: unknown key "${k}" ignored`);
      continue;
    }
    const one = ProjectFileSchema.safeParse({ [k]: v });
    if (!one.success) {
      warnings.push(`${PROJECT_CONFIG_NAME}: invalid value for "${k}" ignored (${one.error.issues[0]?.message ?? 'invalid'})`);
      continue;
    }
    layer[k] = v;
  }
  return { layer: layer as SettingsLayer, path, exists: true, warnings };
}

export function writeProjectConfig(repoRoot: string, data: Record<string, unknown>): string {
  const path = projectConfigPath(repoRoot);
  writeJsonFile(path, data);
  return path;
}

export function updateProjectConfig(repoRoot: string, mutate: (cfg: Record<string, unknown>) => void): string {
  const path = projectConfigPath(repoRoot);
  const existing = readJsonFile(path);
  if (existing !== undefined && (existing === null || typeof existing !== 'object' || Array.isArray(existing))) {
    throw new AicError(`${path} must contain a JSON object`, ExitCode.GENERAL);
  }
  const cfg = (existing as Record<string, unknown> | undefined) ?? {};
  mutate(cfg);
  writeJsonFile(path, cfg);
  return path;
}
