import type { Command } from 'commander';
import { createSession, pickModel } from '../../agent/session.js';
import { readGlobalConfig, switchProvider, updateGlobalConfig } from '../../config/global.js';
import { resolveConfig, isBuiltinProvider } from '../../config/resolve.js';
import { BUILTIN_PROVIDERS, ProviderDefSchema, type ProviderDef } from '../../config/schema.js';
import { defaultModelFor, listProviderEntries } from '../../providers/registry.js';
import { findRepoRoot } from '../../git/exec.js';
import { AicError, CancelledError, ExitCode, ProviderError, UsageError } from '../../utils/errors.js';
import { ui } from '../ui/output.js';
import { ask, pickOne, yesNo } from '../ui/prompts.js';
import { withSpinner } from '../ui/spinner.js';
import { allFlags } from './flow.js';
import { flagsToLayer } from '../options.js';

async function load(cmd: Command): Promise<ReturnType<typeof resolveConfig>> {
  const f = allFlags(cmd);
  return resolveConfig({ cli: flagsToLayer(f), repoRoot: await findRepoRoot(f.cwd ?? process.cwd()) });
}

export async function providerList(cmd: Command): Promise<void> {
  const f = allFlags(cmd);
  const r = await load(cmd);
  const entries = listProviderEntries({ settings: r.settings, global: r.global }, pickModel(r));
  if (f.json) { ui.data(JSON.stringify(entries, null, 2)); return; }
  const t = ui.out;
  const lines = ['', '  ' + t.bold('AIC Providers'), ''];
  for (const e of entries) {
    const mark = e.ready ? t.ok(t.g.ok) : t.mute(t.g.hollow);
    const tags = [e.kind === 'custom' ? 'custom' : '', e.local ? 'local' : 'cloud', e.ready ? '' : 'needs API key'].filter(Boolean).join(', ');
    lines.push(`  ${mark} ${e.name}${e.active ? t.accent('  (current)') : ''}  ${t.mute(tags)}`);
  }
  const cur = entries.find((e) => e.active);
  lines.push('', `  Current:`, `  ${cur?.name ?? r.settings.provider} ${t.g.arrow} ${cur?.model ?? '(no model)'}`, '');
  ui.data(lines.join('\n'));
}

function parseHeaders(list: string[] | undefined): Record<string, string> | undefined {
  if (!list?.length) return undefined;
  const h: Record<string, string> = {};
  for (const item of list) {
    const i = item.indexOf('=');
    if (i <= 0) throw new UsageError(`Invalid header "${item}"`, { details: 'Use NAME=value. Put secrets in an env var, not in a header value.' });
    h[item.slice(0, i).trim()] = item.slice(i + 1).trim();
  }
  return h;
}

export interface AddFlags {
  baseUrl?: string;
  protocol?: string;
  apiKeyEnv?: string;
  model?: string;
  header?: string[];
  timeout?: string;
  stream?: boolean;
  contextLength?: string;
  temperature?: string;
  maxTokens?: string;
  force?: boolean;
}

export async function providerAdd(cmd: Command, nameArg: string | undefined, o: AddFlags): Promise<void> {
  const interactive = Boolean(process.stdin.isTTY && process.stderr.isTTY);
  let name = nameArg;
  if (!name) {
    if (!interactive) throw new UsageError('Provider name is required', { try: ['aic provider add my-provider --base-url https://example.com/v1 --api-key-env MY_API_KEY --model my-model'] });
    name = (await ask('Provider name (e.g. my-provider):')).trim();
  }
  if (isBuiltinProvider(name)) throw new UsageError(`"${name}" is a built-in provider and cannot be redefined`, { try: [`aic provider add ${name}-custom ...`] });
  const existing = readGlobalConfig().providers?.[name];
  if (existing && !o.force) throw new UsageError(`Provider "${name}" already exists`, { try: [`aic provider add ${name} --force ...`, `aic provider remove ${name}`] });

  let baseUrl = o.baseUrl;
  let protocol = o.protocol;
  let apiKeyEnv = o.apiKeyEnv;
  let model = o.model ?? allFlags(cmd).model; // `--model` is also a root option, so commander may have assigned it there
  if (interactive && !baseUrl) {
    protocol = protocol ?? (await pickOne('API protocol', [
      { name: 'OpenAI-compatible (chat/completions)', value: 'openai-compatible' },
      { name: 'Anthropic messages', value: 'anthropic' },
      { name: 'Ollama', value: 'ollama' },
    ], 'openai-compatible'));
    baseUrl = (await ask('Base URL (e.g. https://example.com/v1):')).trim();
    apiKeyEnv = apiKeyEnv ?? ((await ask('Environment variable that holds the API key (blank = none):')).trim() || undefined);
    model = model ?? ((await ask('Default model (blank = choose later):')).trim() || undefined);
  }
  if (!baseUrl) throw new UsageError('--base-url is required', { try: [`aic provider add ${name} --base-url https://example.com/v1`] });

  const parsed = ProviderDefSchema.safeParse({
    name, protocol: protocol ?? 'openai-compatible', baseUrl, apiKeyEnv, model,
    headers: parseHeaders(o.header),
    timeoutSec: o.timeout ? Number(o.timeout) : undefined,
    stream: o.stream === false ? false : undefined,
    contextLength: o.contextLength ? Number(o.contextLength) : undefined,
    temperature: o.temperature ? Number(o.temperature) : undefined,
    maxTokens: o.maxTokens ? Number(o.maxTokens) : undefined,
  });
  if (!parsed.success) {
    throw new UsageError('Invalid provider definition', { details: parsed.error.issues.map((i) => `${i.path.join('.') || 'value'}: ${i.message}`).join('\n') });
  }
  const def: ProviderDef = parsed.data;
  updateGlobalConfig((g) => { g.providers = { ...(g.providers ?? {}), [name as string]: def }; });
  ui.ok(`provider "${name}" saved`);
  if (def.apiKeyEnv) ui.dim(`Set ${def.apiKeyEnv} in your environment. AIC never stores or prints it.`);
  ui.dim(`Use it:  aic provider use ${name}      Test it:  aic provider test ${name}`);
}

export async function providerRemove(cmd: Command, name: string): Promise<void> {
  const f = allFlags(cmd);
  if (isBuiltinProvider(name)) throw new UsageError(`"${name}" is built in and cannot be removed`);
  const g = readGlobalConfig();
  if (!g.providers?.[name]) throw new UsageError(`No custom provider named "${name}"`, { try: ['aic provider list'] });
  if (!f.yes) {
    if (!process.stdin.isTTY) throw new AicError('Removing a provider needs confirmation', ExitCode.CANCELLED, { try: [`aic provider remove ${name} --yes`] });
    if (!(await yesNo(`Remove provider "${name}"?`, false))) throw new CancelledError();
  }
  updateGlobalConfig((cfg) => {
    const { [name]: _gone, ...rest } = cfg.providers ?? {};
    void _gone;
    cfg.providers = rest;
    if (cfg.apiKeys) delete cfg.apiKeys[name];
    if (cfg.modelByProvider) delete cfg.modelByProvider[name];
    if (cfg.provider === name) { cfg.provider = 'ollama'; delete cfg.model; }
  });
  ui.ok(`provider "${name}" removed`);
}

export async function providerUse(cmd: Command, name: string | undefined, o: { model?: string }): Promise<void> {
  const r = await load(cmd);
  let id = name;
  if (!id) {
    if (!process.stdin.isTTY) throw new UsageError('Provider id is required', { try: ['aic provider use ollama'] });
    const entries = listProviderEntries({ settings: r.settings, global: r.global });
    id = await pickOne('Pick a provider', entries.map((e) => ({ name: `${e.ready ? ui.theme.g.ok : ui.theme.g.hollow} ${e.name}${e.active ? '  (current)' : ''}`, value: e.id })), r.settings.provider);
  }
  if (!isBuiltinProvider(id) && !r.global.providers?.[id]) {
    throw new UsageError(`Unknown provider "${id}"`, { details: `Available: ${[...BUILTIN_PROVIDERS, ...Object.keys(r.global.providers ?? {})].join(', ')}`, try: ['aic provider list'] });
  }
  switchProvider(id, o.model ?? allFlags(cmd).model);
  const g = readGlobalConfig();
  ui.ok(`provider → ${id}${g.model ? ` ${ui.theme.g.mid} ${g.model}` : ` ${ui.theme.g.mid} ${defaultModelFor(id, g) ?? '(choose with aic model use)'} (default)`}`);
}

export async function providerTest(cmd: Command, name: string | undefined, o: { generate?: boolean }): Promise<void> {
  const f = allFlags(cmd);
  const layer = { ...flagsToLayer(f), ...(name ? { provider: name } : {}) };
  const s = await createSession({ cli: layer, yes: f.yes, requireRepo: false });
  ui.protect(s.apiKey);
  const t = ui.theme;
  ui.write('');
  ui.write('  ' + t.bold(`Testing ${s.provider.name}`) + t.mute(`  ${s.provider.endpoint}`));
  ui.write('');
  let listed = false;
  try {
    const models = await withSpinner('listing models', () => s.provider.listModels());
    listed = true;
    ui.ok(`reachable, ${models.length} model${models.length === 1 ? '' : 's'} listed`);
  } catch (e) {
    // some OpenAI-compatible servers have no /models route: judge by a real request below
    if (e instanceof ProviderError && /404|405|not found/i.test(e.message) && o.generate !== false) ui.warn('model listing is not supported by this endpoint, trying a request instead');
    else throw e;
  }
  if (o.generate === false) return;
  const t0 = Date.now();
  const res = await withSpinner(`asking ${s.model}`, () => s.provider.generate({ model: s.model, messages: [{ role: 'user', content: 'Reply with the single word: ok' }], maxTokens: 32, temperature: 0, timeoutMs: s.settings.timeoutSec * 1000 }));
  ui.ok(`${s.model} answered in ${((Date.now() - t0) / 1000).toFixed(1)}s${res.usage?.outputTokens ? ` (${res.usage.outputTokens} tokens)` : ''}`);
  if (!res.text.trim()) ui.warn('the answer was empty (reasoning models may need a larger numPredict)');
  if (!listed) ui.dim('the endpoint works for chat completions');
  ui.write('');
  if (!s.provider.local) ui.dim(`Note: ${s.provider.name} is a cloud provider. A test request leaves your machine; repository data was not included.`);
}
