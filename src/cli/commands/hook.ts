import { readFileSync, writeFileSync } from 'node:fs';
import type { Command } from 'commander';
import { openRepo } from '../../git/exec.js';
import { composeMessageFile, hookStatus, installHook, isBlankMessage, shouldSkipSource, uninstallHook, HOOK_NAME } from '../../hook/hook.js';
import { createSession } from '../../agent/session.js';
import { gatherCommitContext } from '../../agent/context.js';
import { generateCommitMessage } from '../../commit/generate.js';
import { scanStaged } from '../../security/secret-scanner.js';
import { OllamaProvider } from '../../providers/ollama.js';
import { flagsToLayer } from '../options.js';
import { ui } from '../ui/output.js';
import { allFlags } from './flow.js';
import { toMessage } from '../../utils/errors.js';

export async function hookInstall(cmd: Command, o: { force?: boolean }): Promise<void> {
  const git = await openRepo(allFlags(cmd).cwd ?? process.cwd());
  const r = await installHook(git, o);
  ui.ok(r.alreadyInstalled ? `hook refreshed: ${r.path}` : `hook installed: ${r.path}`);
  if (r.backup) ui.dim(`your previous hook was kept as ${r.backup}`);
  ui.dim('`git commit` (without -m) now opens the editor with a generated message. Skip once with AIC_HOOK_DISABLE=1.');
  ui.dim('The hook never blocks a commit, and sends nothing to a cloud provider until you have accepted it once (run `aic commit`).');
}

export async function hookUninstall(cmd: Command): Promise<void> {
  const git = await openRepo(allFlags(cmd).cwd ?? process.cwd());
  const r = await uninstallHook(git);
  if (!r.removed) ui.info('The AIC hook is not installed.');
  else ui.ok(r.restored ? 'hook removed; your previous hook was restored' : 'hook removed');
}

export async function hookShow(cmd: Command): Promise<void> {
  const git = await openRepo(allFlags(cmd).cwd ?? process.cwd());
  const st = await hookStatus(git);
  const label = st.state === 'installed' ? ui.out.ok('installed') : st.state === 'foreign' ? ui.out.warn('another hook is installed (not AIC)') : 'not installed';
  ui.data(`${HOOK_NAME}: ${label}\n${st.path}${st.customPath ? '\n(core.hooksPath is set)' : ''}`);
}

/**
 * Called by git as `aic hook run <message-file> [source] [sha]`. Must never fail a commit:
 * every problem becomes a one-line note on stderr and exit code 0.
 */
export async function hookRun(cmd: Command, file: string, source: string | undefined): Promise<void> {
  const note = (m: string): void => { process.stderr.write(`aic: ${m}\n`); };
  try {
    if (process.env['AIC_HOOK_DISABLE']) return;
    if (shouldSkipSource(source)) return;
    const original = readFileSync(file, 'utf8');
    if (!isBlankMessage(original)) return; // the user already wrote something

    const f = allFlags(cmd);
    const s = await createSession({ cli: flagsToLayer(f), requireRepo: true, interactive: false, cwd: f.cwd });
    ui.protect(s.apiKey);
    const git = s.git as NonNullable<typeof s.git>;
    if (!s.provider.local && !(s.resolved.global.acknowledgedProviders ?? []).includes(s.provider.id)) {
      note(`skipped: ${s.provider.name} is a cloud provider you have not approved yet (run \`aic commit\` once)`);
      return;
    }
    if (s.provider instanceof OllamaProvider && !(await s.provider.isUp(1500))) {
      note('skipped: Ollama is not running');
      return;
    }
    const ctx = await gatherCommitContext(git, s.settings, { redact: s.redact });
    if (ctx.files.length === 0) return;
    if (s.settings.secretScan && scanStaged(ctx.files.map((x) => x.path), ctx.rawDiff).length > 0) {
      note('skipped: possible secrets are staged (run `aic commit` to see them)');
      return;
    }
    note(`writing a commit message with ${s.provider.name} (${s.model}) ...`);
    const settings = { ...s.settings, timeoutSec: Math.min(s.settings.timeoutSec, 90), retries: Math.min(s.settings.retries, 1) };
    const g = await generateCommitMessage({ provider: s.provider, model: s.model, settings, context: ctx.prompt, state: { regen: 0 } });
    const header = g.problems.length ? `# aic: the generated message did not pass the format check (${g.problems[0]}); please review it.\n` : '';
    writeFileSync(file, composeMessageFile(header + g.message, original), 'utf8');
  } catch (e) {
    note(`skipped: ${toMessage(e).split('\n')[0]}`);
  }
}
