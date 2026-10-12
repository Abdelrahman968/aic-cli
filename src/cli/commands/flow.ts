import type { Command } from 'commander';
import { createSession, type Session } from '../../agent/session.js';
import { OllamaProvider } from '../../providers/ollama.js';
import { CancelledError, UsageError } from '../../utils/errors.js';
import { flagsToLayer, validateType, type CommonFlags } from '../options.js';
import { runCommitFlow, type CommitFlowResult } from '../interactive/commit-flow.js';
import { aheadBehind } from '../../git/branch.js';
import { hasStagedChanges } from '../../git/status.js';
import { ui } from '../ui/output.js';
import { pushWithApproval } from '../interactive/commit-flow.js';
import { ensureReady } from '../interactive/ready.js';

export function allFlags(cmd: Command): CommonFlags {
  return cmd.optsWithGlobals() as CommonFlags;
}

async function finish(s: Session): Promise<void> {
  if (s.provider instanceof OllamaProvider && s.settings.unloadModel) {
    const done = await s.provider.unloadUsedModels();
    if (done.length) ui.dim(`model unloaded ${ui.theme.g.mid} VRAM is free again`);
  }
}

async function run(cmd: Command, mode: 'generate' | 'commit', forcePush = false): Promise<void> {
  const f = allFlags(cmd);
  const s = await createSession({ cli: flagsToLayer(f), yes: f.yes, requireRepo: true, validate: (st) => {
      validateType(f.type, st.types);
      if (f.amend && f.all) throw new UsageError('--amend and --all cannot be combined', { details: 'Stage the files you want first, then amend.' });
    },
  });
  for (const w of s.resolved.warnings) ui.warn(w);
  ui.protect(s.apiKey);
  let result: CommitFlowResult;
  try {
    result = await runCommitFlow(s, {
      mode, all: f.all, pick: f.pick, amend: f.amend, push: forcePush || f.push, dryRun: f.dryRun, copy: f.copy, passThru: f.passThru,
      noScan: f.scan === false, noVerify: f.verify === false, signoff: f.signoff, type: f.type, scope: f.scope, breaking: f.breaking,
      hint: f.hint, ref: f.ref, exclude: [], startOllama: f.startOllama,
    });
  } finally {
    await finish(s);
  }
  if (result.cancelled) throw new CancelledError();
}

export const runGenerate = (cmd: Command): Promise<void> => run(cmd, 'generate');
export const runCommit = (cmd: Command): Promise<void> => run(cmd, 'commit');

/** `aic push`: commit and push; with nothing to commit it pushes what is already committed. */
export async function runPush(cmd: Command): Promise<void> {
  const f = allFlags(cmd);
  if (!f.all && !f.pick && !f.amend) {
    const s = await createSession({ cli: flagsToLayer(f), yes: f.yes, requireRepo: true, lenient: true });
    const git = s.git as NonNullable<Session['git']>;
    const ab = await aheadBehind(git);
    if (!(await hasStagedChanges(git)) && ab.upstream && ab.ahead > 0) {
      ui.info(`Nothing staged; ${ab.ahead} commit${ab.ahead === 1 ? '' : 's'} ahead of ${ab.upstream}.`);
      await pushWithApproval(s, true);
      return;
    }
  }
  await run(cmd, 'commit', true);
}

export { ensureReady };
