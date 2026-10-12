import type { Command } from 'commander';
import { run } from '../../utils/process.js';
import { findRepoRoot } from '../../git/exec.js';
import { resolveConfig } from '../../config/resolve.js';
import { createProvider } from '../../providers/registry.js';
import { OllamaProvider } from '../../providers/ollama.js';
import { pickModel } from '../../agent/session.js';
import { scanDiff } from '../../security/secret-scanner.js';
import { globalConfigPath } from '../../config/paths.js';
import { ExitCode, ProviderError, toMessage } from '../../utils/errors.js';
import { ui } from '../ui/output.js';
import { allFlags } from './flow.js';
import { flagsToLayer } from '../options.js';
import { withSpinner } from '../ui/spinner.js';
import type { ProviderStatus } from '../../providers/types.js';

type Status = 'ok' | 'warn' | 'fail';
interface Check {
  status: Status;
  label: string;
  detail?: string;
  hint?: string[];
  code?: number;
}

export async function runDoctor(cmd: Command): Promise<number> {
  const f = allFlags(cmd);
  const checks: Check[] = [];
  const t = ui.theme;

  // Node
  const major = Number(process.versions.node.split('.')[0]);
  const minor = Number(process.versions.node.split('.')[1]);
  const nodeOk = major > 18 || (major === 18 && minor >= 17);
  checks.push({ status: nodeOk ? 'ok' : 'fail', label: `Node.js ${process.versions.node}`, ...(nodeOk ? {} : { detail: 'AIC needs Node.js 18.17 or newer', hint: ['https://nodejs.org'] }) });

  // Git
  let gitOk = false;
  try {
    const r = await run('git', ['--version']);
    gitOk = r.code === 0;
    checks.push({ status: gitOk ? 'ok' : 'fail', label: r.stdout.trim().replace(/^git version /, 'Git ') });
  } catch {
    checks.push({ status: 'fail', label: 'Git not found', detail: 'git is not installed or not on PATH', hint: ['https://git-scm.com/downloads'], code: ExitCode.GIT });
  }
  const root = gitOk ? await findRepoRoot(f.cwd ?? process.cwd()) : undefined;
  checks.push(root ? { status: 'ok', label: 'Repository detected', detail: root } : { status: 'warn', label: 'Not inside a Git repository', detail: 'Commit features need one; config and provider commands do not.' });

  // Configuration
  let resolved;
  try {
    resolved = resolveConfig({ cli: flagsToLayer(f), repoRoot: root });
    checks.push(resolved.warnings.length
      ? { status: 'warn', label: 'Configuration loaded with warnings', detail: resolved.warnings.join('\n') }
      : { status: 'ok', label: 'Configuration valid', detail: `global: ${globalConfigPath()}${resolved.projectPath ? `\nproject: ${resolved.projectPath}` : ''}` });
  } catch (e) {
    checks.push({ status: 'fail', label: 'Configuration invalid', detail: toMessage(e), hint: ['aic config edit', 'aic config reset'] });
  }

  if (resolved) {
    const s = resolved.settings;
    const model = pickModel(resolved);
    // Provider + credentials
    let provider;
    try {
      provider = createProvider(s.provider, { settings: s, global: resolved.global });
      checks.push({ status: 'ok', label: `Provider ${provider.name}`, detail: provider.local ? 'local only: nothing leaves your machine' : `cloud: context is sent to ${provider.endpoint}` });
      if (provider.id !== 'ollama') checks.push({ status: 'ok', label: 'API configuration', detail: 'credentials found (value not shown)' });
    } catch (e) {
      const pe = e instanceof ProviderError ? e : undefined;
      checks.push({ status: 'fail', label: pe?.message ?? `Provider "${s.provider}" is not usable`, detail: pe?.extras.details ?? toMessage(e), ...(pe?.extras.try ? { hint: pe.extras.try } : { hint: ['aic provider list'] }), code: ExitCode.PROVIDER });
    }
    if (provider) {
      const status: ProviderStatus = await withSpinner('checking provider', () => provider.check().catch((e: unknown): ProviderStatus => ({ ok: false, message: e instanceof ProviderError ? e.message : toMessage(e), details: e instanceof ProviderError ? [...(e.extras.causes ?? [])] : [] })));
      if (status.ok) {
        checks.push({ status: 'ok', label: provider instanceof OllamaProvider ? 'Ollama reachable' : `${provider.name} reachable`, detail: provider instanceof OllamaProvider ? provider.baseUrl : undefined });
        if (provider instanceof OllamaProvider) {
          const want = OllamaProvider.canonicalName(model);
          const installed = (await provider.listModels().catch(() => [])).map((m) => m.id);
          checks.push(installed.includes(want)
            ? { status: 'ok', label: `${model} available` }
            : { status: 'fail', label: `${model} is not installed`, detail: installed.length ? `Installed: ${installed.join(', ')}` : 'No models installed', hint: [`ollama pull ${model}`, 'aic model list'], code: ExitCode.PROVIDER });
        } else {
          checks.push({ status: 'ok', label: `Model ${model}` });
        }
      } else {
        checks.push({
          status: 'fail', label: status.message,
          ...(status.details?.length ? { detail: 'Possible causes:\n' + status.details.map((d) => `  ${t.g.bullet} ${d}`).join('\n') } : {}),
          hint: provider instanceof OllamaProvider ? ['aic config get ollamaUrl', 'ollama serve'] : ['aic provider test', 'aic config get provider'], code: ExitCode.PROVIDER,
        });
      }
    }
  }

  // Secret scanner self-test (the fake key is assembled at runtime so this file never trips scanners itself)
  const fake = 'AK' + 'IA' + 'ABCDEFGHIJKLMNOP';
  const hit = scanDiff(`diff --git a/x.env.ts b/x.env.ts\n--- a/x.env.ts\n+++ b/x.env.ts\n@@ -0,0 +1 @@\n+const k = "${fake}";\n`);
  checks.push(hit.length ? { status: 'ok', label: 'Secret scanner working' } : { status: 'fail', label: 'Secret scanner self-test failed' });

  // print
  ui.write('');
  ui.write('  ' + t.bold('AIC Doctor'));
  ui.write('');
  for (const c of checks) {
    const icon = c.status === 'ok' ? t.ok(t.g.ok) : c.status === 'warn' ? t.warn(t.g.warn) : t.err(t.g.bad);
    ui.write(`  ${icon} ${c.label}`);
    if (c.detail && (c.status !== 'ok' || ui.verbose)) for (const l of c.detail.split('\n')) ui.write('      ' + t.mute(l));
    if (c.hint?.length) { ui.write('      ' + t.bold('Try:')); for (const h of c.hint) ui.write('        ' + t.accent(h)); }
  }
  ui.write('');
  const failed = checks.filter((c) => c.status === 'fail');
  if (failed.length === 0) {
    ui.write('  ' + t.ok(t.bold('AIC is ready.')));
    return 0;
  }
  ui.write('  ' + t.err(`${failed.length} problem${failed.length === 1 ? '' : 's'} found.`));
  return failed[0]?.code ?? ExitCode.GENERAL;
}
