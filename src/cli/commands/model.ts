import type { Command } from 'commander';
import { createSession } from '../../agent/session.js';
import { rememberModel } from '../../config/global.js';
import { updateProjectConfig } from '../../config/project.js';
import { findRepoRoot } from '../../git/exec.js';
import { formatBytes } from '../../utils/text.js';
import { UsageError } from '../../utils/errors.js';
import { ui } from '../ui/output.js';
import { pickOne } from '../ui/prompts.js';
import { withSpinner } from '../ui/spinner.js';
import { allFlags } from './flow.js';
import { flagsToLayer } from '../options.js';
import { ensureReady } from '../interactive/ready.js';
import { OllamaProvider } from '../../providers/ollama.js';

async function sess(cmd: Command, needsReady = true): Promise<Awaited<ReturnType<typeof createSession>>> {
  const f = allFlags(cmd);
  const s = await createSession({ cli: flagsToLayer(f), yes: f.yes, requireRepo: false });
  ui.protect(s.apiKey);
  if (needsReady) await ensureReady(s, { startOllama: f.startOllama, skipModelCheck: true });
  return s;
}

export async function modelList(cmd: Command): Promise<void> {
  const f = allFlags(cmd);
  const s = await sess(cmd);
  const models = await withSpinner(`listing ${s.provider.name} models`, () => s.provider.listModels());
  if (f.json) { ui.data(JSON.stringify(models, null, 2)); return; }
  const t = ui.out;
  const want = s.provider instanceof OllamaProvider ? OllamaProvider.canonicalName(s.model) : s.model;
  const lines = ['', `  ${t.bold(s.provider.name + ' models')}  ${t.mute(`(${models.length})`)}`, ''];
  for (const m of models) {
    const cur = m.id === want || m.id === s.model;
    const meta = [m.parameterSize, m.sizeBytes ? formatBytes(m.sizeBytes) : '', m.contextLength ? `${Math.round(m.contextLength / 1000)}k ctx` : ''].filter(Boolean).join('  ');
    lines.push(`  ${cur ? t.accent(t.g.dot) : ' '} ${m.id}${meta ? '  ' + t.mute(meta) : ''}${cur ? t.accent('  (current)') : ''}`);
  }
  if (!models.length) lines.push(s.provider.id === 'ollama' ? `  ${t.mute('No models installed. Try: ollama pull qwen2.5-coder:7b')}` : `  ${t.mute('The provider returned no models.')}`);
  lines.push('');
  ui.data(lines.join('\n'));
}

export async function modelCurrent(cmd: Command): Promise<void> {
  const f = allFlags(cmd);
  const s = await createSession({ cli: flagsToLayer(f), requireRepo: false, lenient: true });
  const src = s.resolved.sources.model;
  if (f.json) { ui.data(JSON.stringify({ provider: s.provider.id, model: s.model, source: src })); return; }
  ui.data(`${s.provider.id}/${s.model}`);
  ui.dim(`provider ${s.provider.name}${s.provider.local ? ' (local)' : ' (cloud)'} ${ui.theme.g.mid} model from ${src === 'default' ? 'provider default' : src}`);
}

export async function modelUse(cmd: Command, name: string | undefined, o: { project?: boolean }): Promise<void> {
  const f = allFlags(cmd);
  const s = await sess(cmd);
  let model = name;
  if (!model) {
    if (!s.interactive) throw new UsageError('Model name is required', { try: ['aic model use qwen2.5-coder:7b'] });
    const models = (await s.provider.listModels()).filter((m) => !/embed/i.test(m.id));
    if (!models.length) throw new UsageError('No models available to choose from');
    model = await pickOne('Pick a model', models.map((m) => ({ name: m.id + (m.sizeBytes ? `  (${formatBytes(m.sizeBytes)})` : ''), value: m.id })), s.model);
  }
  if (o.project) {
    const root = await findRepoRoot(f.cwd ?? process.cwd());
    if (!root) throw new UsageError('--project needs a Git repository');
    const path = updateProjectConfig(root, (c) => { c['model'] = model; });
    ui.ok(`model → ${model}  (saved in ${path})`);
    return;
  }
  rememberModel(s.provider.id, model);
  ui.ok(`model → ${model}  (${s.provider.name})`);
}

export async function modelTest(cmd: Command, name: string | undefined): Promise<void> {
  const s = await sess(cmd);
  const model = name ?? s.model;
  const t0 = Date.now();
  const res = await withSpinner(`asking ${model}`, () => s.provider.generate({ model, messages: [{ role: 'user', content: 'Reply with the single word: ok' }], maxTokens: 32, temperature: 0, timeoutMs: s.settings.timeoutSec * 1000 }));
  ui.ok(`${model} answered in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (!res.text.trim()) ui.warn('the answer was empty (reasoning models may need a larger numPredict)');
}
