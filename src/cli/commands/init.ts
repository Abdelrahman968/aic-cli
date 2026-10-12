import { existsSync } from 'node:fs';
import type { Command } from 'commander';
import { openRepo } from '../../git/exec.js';
import { inferScopes } from '../../commit/format.js';
import { writeProjectConfig, projectConfigPath } from '../../config/project.js';
import { globalConfigPath } from '../../config/paths.js';
import { readGlobalConfig, updateGlobalConfig } from '../../config/global.js';
import { resolveConfig } from '../../config/resolve.js';
import { BUILTIN_PROVIDERS, DEFAULT_MODELS } from '../../config/schema.js';
import { pickModel } from '../../agent/session.js';
import { PROVIDER_LABELS } from '../../providers/registry.js';
import { ui } from '../ui/output.js';
import { pickOne, ask } from '../ui/prompts.js';
import { allFlags } from './flow.js';

export async function runInit(cmd: Command, opts: { global?: boolean; force?: boolean }): Promise<void> {
  const f = allFlags(cmd);
  const t = ui.theme;
  if (opts.global) {
    const path = globalConfigPath();
    if (existsSync(path) && !opts.force) {
      ui.warn(`global config already exists: ${path}`);
      ui.dim('Use --force to run the setup again, or `aic config` to edit single settings.');
      return;
    }
    let provider = f.provider ?? 'ollama';
    let model = f.model;
    if (process.stdin.isTTY && !f.provider) {
      provider = await pickOne('Which provider do you want to use?', BUILTIN_PROVIDERS.map((id) => ({ name: PROVIDER_LABELS[id] + (id === 'ollama' ? '  (local, private)' : '  (cloud)'), value: id as string })), 'ollama');
      model = (await ask('Model:', DEFAULT_MODELS[provider as keyof typeof DEFAULT_MODELS] ?? '')).trim() || undefined;
    }
    const existing = readGlobalConfig();
    updateGlobalConfig((g) => {
      g.provider = provider;
      if (model) { g.model = model; g.modelByProvider = { ...(existing.modelByProvider ?? {}), [provider]: model }; }
      g.language ??= 'English';
    });
    ui.write('');
    ui.ok(`created ${path}`);
    if (provider !== 'ollama') ui.dim(`Set your key with an environment variable (preferred) or: aic config set api-key <key> --provider ${provider}`);
    return;
  }

  const git = await openRepo(f.cwd ?? process.cwd());
  const path = projectConfigPath(git.root);
  if (existsSync(path) && !opts.force) {
    ui.warn(`.aic.json already exists: ${path}`);
    ui.dim('Use --force to overwrite it.');
    return;
  }
  const files = (await git.out(['ls-files'], { allowFail: true })).split('\n').filter(Boolean);
  const scopes = inferScopes(files);
  const resolved = resolveConfig({ cli: {}, repoRoot: git.root });
  const starter: Record<string, unknown> = {
    model: pickModel(resolved),
    language: resolved.settings.language,
    bullets: resolved.settings.bullets,
    emoji: false,
    scopes,
    exclude: [],
  };
  writeProjectConfig(git.root, starter);
  ui.write('');
  ui.ok(`created ${path}`);
  ui.dim(scopes.length ? `scopes inferred from your layout: ${scopes.join(', ')}` : 'no scopes inferred - add your own');
  ui.dim(`Commit it so your team shares the same conventions. API keys never belong in this file. ${t.g.mid} see docs/configuration.md`);
}
