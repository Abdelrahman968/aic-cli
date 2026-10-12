import type { Command } from 'commander';
import { createSession, type Session } from '../../agent/session.js';
import { completeText } from '../../agent/oneshot.js';
import { gatherCommitContext, withholdSensitive } from '../../agent/context.js';
import { generateCommitMessage, type GeneratedMessage, type MessageState } from '../../commit/generate.js';
import { buildSplitMessages, extractJson, heuristicPlan, normalizePlan, pathsFor, type SplitFile, type SplitGroup } from '../../split/plan.js';
import { add, commit } from '../../git/commit.js';
import { changedFiles } from '../../git/status.js';
import { shrinkDiff, workingDiff, workingStat } from '../../git/diff.js';
import { hasCommits, lastCommit } from '../../git/history.js';
import { redactContent, scanStaged } from '../../security/secret-scanner.js';
import { AicError, CancelledError, ExitCode, GitError, SecretError } from '../../utils/errors.js';
import { flagsToLayer } from '../options.js';
import { ui } from '../ui/output.js';
import { Spinner } from '../ui/spinner.js';
import { cancelOnEsc } from '../ui/keys.js';
import { pickOne } from '../ui/prompts.js';
import { ensureReady } from '../interactive/ready.js';
import { renderFindings, renderMessage } from '../interactive/render.js';
import { allFlags } from './flow.js';
import type { Git } from '../../git/exec.js';

export interface SplitOptions {
  max: number;
  hint?: string | undefined;
  dryRun?: boolean | undefined;
  json?: boolean | undefined;
  noScan?: boolean | undefined;
  noVerify?: boolean | undefined;
  signoff?: boolean | undefined;
  skipReady?: boolean | undefined;
  startOllama?: boolean | undefined;
}

export interface SplitResult {
  commits: Array<{ hash: string; subject: string }>;
  skipped: string[][];
  plan: SplitGroup[];
}

/** Empty the index without touching the working tree (also works before the first commit). */
async function clearIndex(git: Git): Promise<void> {
  if (await hasCommits(git)) await git.raw(['reset', '-q'], { allowFail: true });
  else await git.raw(['rm', '-r', '--cached', '-q', '--ignore-unmatch', '.'], { allowFail: true });
}

async function collectFiles(s: Session): Promise<SplitFile[]> {
  const git = s.git as Git;
  const changed = await changedFiles(git);
  const stats = new Map((await workingStat(git, s.settings.exclude)).map((x) => [x.path, x]));
  return changed.map((c) => ({
    path: c.path, ...(c.oldPath ? { oldPath: c.oldPath } : {}), status: c.code,
    add: stats.get(c.path)?.add ?? 0, del: stats.get(c.path)?.del ?? 0,
  }));
}

async function proposePlan(s: Session, files: SplitFile[], o: SplitOptions): Promise<{ plan: SplitGroup[]; usedFallback: boolean }> {
  const git = s.git as Git;
  const names = files.map((f) => f.path);
  let excerpt = '';
  if (s.settings.sendDiff) {
    let d = await workingDiff(git, s.settings.exclude);
    if (s.redact) d = withholdSensitive(d).text;
    excerpt = shrinkDiff(d, Math.max(s.settings.maxChars, 4000));
    if (s.redact) excerpt = redactContent(excerpt).text;
  }
  const sp = new Spinner('planning commits').start();
  sp.update({ cancelHint: true, tokens: 0 });
  const ctl = new AbortController();
  const stop = s.interactive ? cancelOnEsc(ctl) : () => undefined;
  try {
    const text = await completeText(s, buildSplitMessages(files, excerpt, { max: o.max, language: s.settings.language, types: s.settings.types, hint: o.hint }), {
      temperature: 0.1, maxTokens: Math.max(s.settings.numPredict, 1200), signal: ctl.signal, onProgress: (n, t) => sp.update({ tokens: n, tail: t }),
    });
    const plan = normalizePlan(extractJson(text), names, o.max);
    if (plan.length > 0) return { plan, usedFallback: false };
  } finally {
    stop();
    sp.stop();
  }
  return { plan: heuristicPlan(names, o.max), usedFallback: true };
}

function renderPlan(plan: SplitGroup[]): void {
  const t = ui.theme;
  ui.write('');
  plan.forEach((g, i) => {
    const head = `${g.type ? t.type(g.type) : t.mute('commit')}${g.scope ? t.scope(`(${g.scope})`) : ''}  ${g.title}`;
    const lines = g.files.slice(0, 8).map((f) => f);
    if (g.files.length > 8) lines.push(t.mute(`… and ${g.files.length - 8} more`));
    ui.card(`${i + 1}/${plan.length}`, [head, ...lines.map((l) => t.mute(l))], { tag: t.mute(`${g.files.length} file${g.files.length === 1 ? '' : 's'}`) });
  });
}

async function messageFor(s: Session, g: SplitGroup, state: MessageState, ctx: Awaited<ReturnType<typeof gatherCommitContext>>): Promise<GeneratedMessage> {
  const sp = new Spinner('writing message').start();
  sp.update({ cancelHint: true, tokens: 0 });
  const ctl = new AbortController();
  const stop = s.interactive ? cancelOnEsc(ctl) : () => undefined;
  try {
    return await generateCommitMessage({
      provider: s.provider, model: s.model, settings: s.settings, context: ctx.prompt, state, signal: ctl.signal,
      onProgress: (p) => sp.update({ tokens: p.tokens, tail: p.text }),
    });
  } finally {
    stop();
    sp.stop();
    void g;
  }
}

/** Split the uncommitted changes into several commits (file level). Reusable from the chat. */
export async function runSplit(s: Session, o: SplitOptions): Promise<SplitResult> {
  const git = s.git;
  if (!git) throw new GitError('Not inside a Git repository', { try: ['cd into your project', 'git init'] });
  const t = ui.theme;
  if (!o.skipReady) await ensureReady(s, { startOllama: o.startOllama });

  let files = await collectFiles(s);
  if (files.length < 2) {
    throw new AicError(files.length === 0 ? 'Nothing to commit' : 'Only one file changed, so there is nothing to split', ExitCode.GENERAL, { try: ['aic commit'] });
  }
  const result: SplitResult = { commits: [], skipped: [], plan: [] };

  let plan!: SplitGroup[];
  while (true) {
    const p = await proposePlan(s, files, o);
    plan = p.plan;
    if (p.usedFallback) ui.warn('The model did not return a usable plan; grouped by area instead.');
    if (!s.provider.local) ui.dim(`sent to ${s.provider.name}: file names, line counts${s.settings.sendDiff ? ' and a shortened diff' : ''}`);
    renderPlan(plan);
    if (o.json) { ui.data(JSON.stringify({ commits: plan }, null, 2)); result.plan = plan; return result; }
    if (o.dryRun) { ui.blank(); ui.dim('dry run: nothing was staged or committed'); result.plan = plan; return result; }
    if (s.yes) break;
    if (!s.interactive) throw new AicError('Splitting needs a terminal or --yes', ExitCode.USAGE, { try: ['aic split --yes', 'aic split --dry-run'] });
    ui.write('');
    ui.dim('AIC will stage each group in turn (your current staging is replaced; no file contents change).');
    const choice = await pickOne(`Create ${plan.length} commit${plan.length === 1 ? '' : 's'}?`, [
      { name: `Yes, create ${plan.length}`, value: 'go' },
      { name: 'Plan again', value: 'again' },
      { name: 'Cancel', value: 'cancel' },
    ]);
    if (choice === 'cancel') throw new CancelledError();
    if (choice === 'go') break;
  }
  result.plan = plan;

  let i = 0;
  try {
    for (const g of plan) {
      i++;
      files = await collectFiles(s);
      const live = new Set(files.map((f) => f.path));
      const group: SplitGroup = { ...g, files: g.files.filter((f) => live.has(f)) };
      if (group.files.length === 0) continue;
      ui.write('');
      ui.write('  ' + t.bold(`${i}/${plan.length}`) + '  ' + group.title);

      await clearIndex(git);
      await add(git, pathsFor(group, files));
      const ctx = await gatherCommitContext(git, s.settings, { redact: s.redact });
      const staged = (await git.out(['diff', '--staged', '--name-only'], { allowFail: true })).split('\n').filter(Boolean);
      if (staged.length === 0) { ui.dim('nothing to stage for this group'); continue; }

      if (!o.noScan && s.settings.secretScan) {
        const findings = scanStaged(staged, ctx.rawDiff);
        if (findings.length) {
          renderFindings(findings);
          throw new SecretError(`Possible secrets in group ${i}/${plan.length}, so splitting stopped`, {
            details: `${result.commits.length} commit${result.commits.length === 1 ? '' : 's'} already created. This group is staged so you can inspect it; nothing was sent to the model for it.`,
            try: ['Remove the secrets, then run `aic split` again', 'aic commit --no-scan   (only if they are false alarms)'],
          });
        }
      }

      const state: MessageState = {
        regen: 0,
        type: group.type && s.settings.types.includes(group.type) ? group.type : undefined,
        scope: group.scope && (s.settings.scopes.length === 0 || s.settings.scopes.includes(group.scope)) ? group.scope : undefined,
        hint: [group.title, o.hint].filter(Boolean).join('. '),
      };
      let message: GeneratedMessage;
      if (ctx.files.length === 0) {
        // only lockfiles / generated files: nothing the model could describe
        message = { message: 'chore: update lockfiles and generated files', problems: [], meta: { tokens: 0, seconds: 0, model: s.model, attempt: 1 } };
      } else {
        message = await messageFor(s, group, state, ctx);
      }

      let edit = false;
      let decided = s.yes;
      while (!decided) {
        renderMessage(message);
        const choice = await pickOne('Commit this group?', [
          { name: 'Commit', value: 'commit' }, { name: 'Edit in editor, then commit', value: 'edit' }, { name: 'Regenerate', value: 'regen' },
          { name: 'Skip this group (leave its changes uncommitted)', value: 'skip' }, { name: 'Stop here', value: 'stop' },
        ]);
        if (choice === 'regen') { state.regen++; message = await messageFor(s, group, state, ctx); continue; }
        if (choice === 'skip') { result.skipped.push(group.files); await clearIndex(git); decided = true; edit = false; message = { ...message, message: '' }; break; }
        if (choice === 'stop') { await clearIndex(git); throw new CancelledError('Stopped'); }
        edit = choice === 'edit';
        decided = true;
      }
      if (!message.message) continue;
      if (s.yes) renderMessage(message);

      const code = await commit(git, { message: message.message, edit, noVerify: o.noVerify || s.settings.noVerify, signoff: o.signoff || s.settings.signoff, toStderr: true });
      if (code !== 0) throw new GitError(`git commit failed for group ${i}/${plan.length}`, { details: 'A hook failed or the editor was closed empty. The group is still staged.', try: ['Fix the problem, then run `aic split` again'] });
      const last = await lastCommit(git);
      result.commits.push({ hash: last?.hash ?? '', subject: last?.subject ?? message.message.split('\n')[0] ?? '' });
      ui.ok(`${t.accent(last?.hash ?? '')}  ${last?.subject ?? ''}`);
    }
  } finally {
    if (result.commits.length || result.skipped.length) {
      const left = await changedFiles(git);
      ui.write('');
      ui.write('  ' + t.bold(`${result.commits.length} commit${result.commits.length === 1 ? '' : 's'} created`) + (left.length ? t.mute(`  ${left.length} file${left.length === 1 ? '' : 's'} still uncommitted`) : ''));
    }
  }
  return result;
}

export interface SplitFlags { maxCommits?: string; json?: boolean }

export async function runSplitCommand(cmd: Command, o: SplitFlags): Promise<void> {
  const f = allFlags(cmd);
  const max = o.maxCommits ? Number(o.maxCommits) : 6;
  if (!Number.isInteger(max) || max < 2 || max > 12) throw new AicError('--max-commits must be between 2 and 12', ExitCode.USAGE);
  const s = await createSession({ cli: flagsToLayer(f), yes: f.yes, requireRepo: true });
  for (const w of s.resolved.warnings) ui.warn(w);
  ui.protect(s.apiKey);
  await runSplit(s, { max, hint: f.hint, dryRun: f.dryRun, json: o.json ?? f.json, noScan: f.scan === false, noVerify: f.verify === false, signoff: f.signoff, startOllama: f.startOllama });
}
