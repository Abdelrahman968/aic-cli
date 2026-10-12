import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Command } from 'commander';
import {
  SETTINGS, SETTING_KEYS, canonicalKey, coerceValue, type SettingKey, type SettingsLayer,
} from '../../config/schema.js';
import { readGlobalConfig, rememberModel, resetGlobalConfig, setGlobalSetting, switchProvider, unsetGlobalSetting, updateGlobalConfig } from '../../config/global.js';
import { projectConfigPath, updateProjectConfig } from '../../config/project.js';
import { isBuiltinProvider, requireProviderKnown, resolveApiKey, resolveConfig } from '../../config/resolve.js';
import { globalConfigPath } from '../../config/paths.js';
import { writeJsonFile } from '../../config/files.js';
import { findRepoRoot } from '../../git/exec.js';
import { which } from '../../utils/process.js';
import { maskSecret } from '../../utils/redact.js';
import { AicError, CancelledError, ExitCode, UsageError } from '../../utils/errors.js';
import { ui } from '../ui/output.js';
import { ask, askSecret, pickOne, yesNo } from '../ui/prompts.js';
import { allFlags } from './flow.js';
import { flagsToLayer } from '../options.js';

async function ctx(cmd: Command): Promise<{ r: ReturnType<typeof resolveConfig>; root: string | undefined }> {
  const f = allFlags(cmd);
  const root = await findRepoRoot(f.cwd ?? process.cwd());
  return { r: resolveConfig({ cli: flagsToLayer(f), repoRoot: root }), root };
}

function show(v: unknown): string {
  if (Array.isArray(v)) return v.length ? v.join(', ') : '[]';
  if (v === undefined || v === '') return '(unset)';
  return String(v);
}

export async function configList(cmd: Command): Promise<void> {
  const f = allFlags(cmd);
  const { r } = await ctx(cmd);
  const rows = SETTING_KEYS.map((k) => ({ key: k, value: r.settings[k], source: r.sources[k] }));
  const keys = Object.entries(r.global.apiKeys ?? {}).map(([p, v]) => ({ provider: p, value: maskSecret(v), source: 'config' }));
  if (f.json) {
    ui.data(JSON.stringify({ settings: Object.fromEntries(rows.map((x) => [x.key, x.value])), sources: r.sources, apiKeys: keys }, null, 2));
    return;
  }
  const t = ui.out;
  const w = Math.max(...SETTING_KEYS.map((k) => k.length));
  const lines = ['', `  ${t.bold('AIC configuration')}`, ''];
  for (const x of rows) lines.push(`  ${x.key.padEnd(w)}  ${show(x.value).padEnd(28)} ${t.mute(x.source)}`);
  if (keys.length) { lines.push('', `  ${t.bold('Stored API keys')}`); for (const k of keys) lines.push(`  ${k.provider.padEnd(w)}  ${k.value}`); }
  lines.push('', `  ${t.mute('global ' + globalConfigPath())}`);
  if (r.projectPath) lines.push(`  ${t.mute('project ' + r.projectPath)}`);
  lines.push('');
  ui.data(lines.join('\n'));
  for (const wmsg of r.warnings) ui.warn(wmsg);
}

export async function configGet(cmd: Command, keyArg: string): Promise<void> {
  const f = allFlags(cmd);
  const { r } = await ctx(cmd);
  if (/^api[-_]?key$/i.test(keyArg)) {
    const k = resolveApiKey(r.settings.provider, r.global, process.env, r.settings.provider);
    ui.data(k.key ? `${maskSecret(k.key)}  [${k.source}]` : '(unset)');
    return;
  }
  const key = canonicalKey(keyArg);
  if (!key) throw unknownKey(keyArg);
  const v = r.settings[key];
  ui.data(Array.isArray(v) ? JSON.stringify(v) : v === undefined ? '' : String(v));
  if (ui.verbose || f.verbose) ui.dim(`source: ${r.sources[key]}`);
}

function unknownKey(k: string): UsageError {
  return new UsageError(`Unknown setting "${k}"`, { details: `Available: ${SETTING_KEYS.join(', ')}, api-key`, try: ['aic config list'] });
}

export interface SetFlags { project?: boolean; provider?: string }

async function setValue(cmd: Command, keyArg: string, raw: string | undefined, o: SetFlags): Promise<void> {
  const f = allFlags(cmd);
  const root = await findRepoRoot(f.cwd ?? process.cwd());

  // ---- API key: hidden prompt, never echoed, never in a project file -------------------------
  if (/^api[-_]?key$/i.test(keyArg)) {
    if (o.project) throw new UsageError('API keys are never written to .aic.json', { try: ['Use an environment variable (see `aic help provider`) or omit --project'] });
    const g = readGlobalConfig();
    const id = o.provider ?? f.provider ?? g.provider ?? 'ollama';
    requireProviderKnown(id, g);
    if (id === 'ollama') throw new UsageError('Ollama does not use an API key');
    let value = raw;
    if (!value) {
      if (!process.stdin.isTTY) throw new UsageError('Pass the key through the environment instead', { details: 'Example: export OPENAI_API_KEY=...  (avoids shell history)' });
      value = (await askSecret(`API key for ${id}:`)).trim();
    }
    if (!value) throw new UsageError('Empty key');
    ui.protect(value);
    updateGlobalConfig((c) => { c.apiKeys = { ...(c.apiKeys ?? {}), [id]: value as string }; });
    ui.ok(`API key for ${id} saved (${maskSecret(value)}) in ${globalConfigPath()}`);
    ui.dim('The file is readable only by you. Environment variables take priority and are the safer choice.');
    return;
  }

  const key = canonicalKey(keyArg);
  if (!key) throw unknownKey(keyArg);
  if (raw === undefined) throw new UsageError(`Missing value for "${key}"`, { try: [`aic config set ${key} <value>`] });
  const value = coerceValue(key, raw);

  if (key === 'autoApprove' && (value as string[]).includes('git_reset')) {
    throw new UsageError('git_reset can never be auto-approved', { details: 'Allowed: git_add, git_commit, git_push' });
  }
  if (key === 'provider') requireProviderKnown(String(value), readGlobalConfig());

  if (o.project) {
    if (!root) throw new UsageError('--project needs a Git repository');
    if (SETTINGS[key].project === 'deny') throw new UsageError(`"${key}" cannot be set in .aic.json`, { details: 'It affects security or your machine, so it is only accepted from the global config or environment.' });
    const path = updateProjectConfig(root, (c) => { c[key] = value; });
    ui.ok(`${key} = ${show(value)}  (saved in ${path})`);
    return;
  }
  if (key === 'provider') switchProvider(String(value));
  else if (key === 'model') rememberModel(readGlobalConfig().provider ?? 'ollama', String(value));
  else setGlobalSetting(key, value);
  ui.ok(`${key} = ${show(value)}`);
  if (key === 'provider') {
    const g = readGlobalConfig();
    ui.dim(`model for ${String(value)}: ${g.model ?? '(provider default)'}`);
    if (!isBuiltinProvider(String(value)) || value !== 'ollama') ui.dim(`Check it with: aic provider test ${String(value)}`);
  }
}

export const configSet = setValue;

export async function configUnset(cmd: Command, keyArg: string, o: { project?: boolean }): Promise<void> {
  const key = canonicalKey(keyArg);
  if (!key) throw unknownKey(keyArg);
  if (o.project) {
    const root = await findRepoRoot(allFlags(cmd).cwd ?? process.cwd());
    if (!root) throw new UsageError('--project needs a Git repository');
    updateProjectConfig(root, (c) => { delete c[key]; });
  } else {
    unsetGlobalSetting(key);
  }
  ui.ok(`${key} reset to ${o.project ? 'the global/default value' : 'its default'}`);
}

export async function configReset(cmd: Command, o: { all?: boolean }): Promise<void> {
  const f = allFlags(cmd);
  if (!f.yes) {
    if (!process.stdin.isTTY) throw new AicError('Reset needs confirmation', ExitCode.CANCELLED, { try: ['aic config reset --yes'] });
    const msg = o.all ? 'Delete the whole global config, including custom providers and stored API keys?' : 'Reset all global settings to defaults? (providers and API keys are kept)';
    if (!(await yesNo(msg, false))) throw new CancelledError();
  }
  resetGlobalConfig(Boolean(o.all));
  ui.ok(o.all ? 'global configuration deleted' : 'settings reset (providers and keys kept)');
}

export async function configEdit(cmd: Command, o: { project?: boolean }): Promise<void> {
  const f = allFlags(cmd);
  let path = globalConfigPath();
  if (o.project) {
    const root = await findRepoRoot(f.cwd ?? process.cwd());
    if (!root) throw new UsageError('--project needs a Git repository');
    path = projectConfigPath(root);
  }
  if (!existsSync(path)) writeJsonFile(path, {}, { secret: !o.project });
  const editor = process.env['VISUAL'] || process.env['EDITOR'] || (process.platform === 'win32' ? 'notepad' : which('nano') ? 'nano' : 'vi');
  if (!process.stdin.isTTY) { ui.data(path); return; }
  ui.dim(`opening ${path} with ${editor}`);
  await new Promise<void>((resolveP, reject) => {
    // editor may contain arguments ("code -w"): let the shell split them, the path is passed separately
    const child = spawn(`${editor} "${path}"`, { stdio: 'inherit', shell: true });
    child.on('error', reject);
    child.on('close', () => resolveP());
  });
  try {
    if (o.project) resolveConfig({ cli: {}, repoRoot: await findRepoRoot(f.cwd ?? process.cwd()) });
    else readGlobalConfig();
    ui.ok('configuration is valid');
  } catch (e) {
    throw new AicError('The edited file is not valid', ExitCode.GENERAL, { details: e instanceof Error ? e.message : String(e), try: ['aic config edit'] });
  }
}

export function configPath(): void {
  ui.data(globalConfigPath());
}

/** Interactive editor: pick a setting, enter a value. */
export async function configInteractive(cmd: Command): Promise<void> {
  const f = allFlags(cmd);
  if (!process.stdin.isTTY) return configList(cmd);
  const root = await findRepoRoot(f.cwd ?? process.cwd());
  while (true) {
    const { r } = await ctx(cmd);
    const choice = await pickOne<string>('AIC settings  (Ctrl+C to leave)', [
      ...SETTING_KEYS.map((k) => ({ name: `${k.padEnd(16)} ${show(r.settings[k]).slice(0, 36).padEnd(36)} ${ui.theme.mute(r.sources[k])}`, value: k as string, description: SETTINGS[k].description })),
      { name: 'api-key          set the API key for the current provider', value: 'api-key' },
    ]);
    let where: 'global' | 'project' = 'global';
    if (choice !== 'api-key' && root && SETTINGS[choice as SettingKey].project !== 'deny') {
      where = await pickOne('Save in', [{ name: 'Global config (all projects)', value: 'global' as const }, { name: '.aic.json (this project)', value: 'project' as const }], 'global');
    }
    if (choice === 'api-key') { await configSet(cmd, 'api-key', undefined, { provider: r.settings.provider }); continue; }
    const key = choice as SettingKey;
    const meta = SETTINGS[key];
    let raw: string;
    if (meta.kind === 'boolean') {
      raw = String(await pickOne(`${key}: ${meta.description}`, [{ name: 'true', value: true }, { name: 'false', value: false }], Boolean(r.settings[key])));
    } else if (key === 'provider') {
      const g = readGlobalConfig();
      raw = await pickOne('Provider', ['ollama', 'openai', 'anthropic', 'gemini', 'openrouter', ...Object.keys(g.providers ?? {})].map((p) => ({ name: p, value: p })), r.settings.provider);
    } else {
      raw = await ask(`${key} (${meta.description}):`, show(r.settings[key]) === '(unset)' ? '' : Array.isArray(r.settings[key]) ? (r.settings[key] as string[]).join(',') : String(r.settings[key]));
    }
    try {
      await configSet(cmd, key, raw, { project: where === 'project' });
    } catch (e) {
      ui.error(e);
    }
  }
}

export type { SettingsLayer };
