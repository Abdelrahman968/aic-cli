import type { Session } from '../../agent/session.js';
import { gatherCommitContext } from '../../agent/context.js';
import { authorize, getTool, makePolicy, type ApprovalPolicy, type ToolContext } from '../../agent/tools.js';
import { generateCommitMessage, type GeneratedMessage, type MessageState } from '../../commit/generate.js';
import { getBang, getType, setPrefix, validateMessage } from '../../commit/format.js';
import { add, commit, planPush, push, unstage } from '../../git/commit.js';
import { changedFiles, hasStagedChanges } from '../../git/status.js';
import { stagedDiff } from '../../git/diff.js';
import { currentBranch } from '../../git/branch.js';
import { hasCommits, lastCommit, lastCommitShortStat } from '../../git/history.js';
import { scanStaged, type Finding } from '../../security/secret-scanner.js';
import { copyToClipboard } from '../../utils/clipboard.js';
import { AicError, CancelledError, ExitCode, GitError, SecretError } from '../../utils/errors.js';
import { ui } from '../ui/output.js';
import { Spinner } from '../ui/spinner.js';
import { cancelOnEsc, readKey } from '../ui/keys.js';
import { ask, pickMany, pickOne, yesNo } from '../ui/prompts.js';
import { printDiffColored, renderFindings, renderMessage, renderStat } from './render.js';
import { ensureReady } from './ready.js';

export interface CommitFlowOptions {
  /** generate = show the message only; commit = review and commit */
  mode: 'generate' | 'commit';
  all?: boolean;
  pick?: boolean;
  amend?: boolean;
  push?: boolean;
  dryRun?: boolean;
  copy?: boolean;
  passThru?: boolean;
  noScan?: boolean;
  noVerify?: boolean;
  signoff?: boolean;
  type?: string | undefined;
  scope?: string | undefined;
  breaking?: boolean | undefined;
  hint?: string | undefined;
  ref?: string | undefined;
  exclude?: string[];
  startOllama?: boolean | undefined;
  /** when called from the chat: keep the final summary short and reuse state */
  state?: MessageState;
  /** modifiers from a natural language "make it shorter" */
  skipReady?: boolean;
}

export interface CommitFlowResult {
  message: string | undefined;
  committed: boolean;
  pushed: boolean;
  cancelled: boolean;
  state: MessageState;
}

export function confirmCommandFactory(s: Session): (command: string) => Promise<boolean> {
  return async (command: string) => {
    if (!s.interactive) return false;
    ui.write('');
    ui.write('  ' + ui.theme.bold('AIC wants to run:'));
    ui.write('');
    ui.write('    ' + ui.theme.accent(command));
    ui.write('');
    return yesNo('Continue?', false);
  };
}

export function toolContext(s: Session): ToolContext {
  return { git: s.git as NonNullable<Session['git']>, settings: s.settings, redact: s.redact };
}

export function policyFor(s: Session, explicit: string[]): ApprovalPolicy {
  const confirm = confirmCommandFactory(s);
  return makePolicy({ interactive: s.interactive, yes: s.yes, autoApprove: s.settings.autoApprove, explicit: new Set(explicit), confirm: (cmd) => confirm(cmd) });
}

/** Checklist of changed files: ticked = in this commit. Stages the newly ticked, unstages the unticked. */
export async function selectFiles(s: Session): Promise<void> {
  const git = s.git as NonNullable<Session['git']>;
  const files = await changedFiles(git);
  if (files.length === 0) return;
  const chosen = await pickMany(`Choose what goes into this commit (${files.length} changed)`,
    files.map((f) => ({ name: `${f.code}  ${f.path}`, value: f.path, checked: f.staged })));
  const set = new Set(chosen);
  const toAdd = files.filter((f) => set.has(f.path) && (!f.staged || f.dirty)).map((f) => f.path);
  const toDrop = files.filter((f) => !set.has(f.path) && f.staged).map((f) => f.path);
  if (toAdd.length) await add(git, toAdd);
  if (toDrop.length) await unstage(git, toDrop);
}

async function copyMessage(message: string): Promise<void> {
  if (await copyToClipboard(message)) ui.ok('copied to clipboard');
  else ui.write('  ' + ui.theme.err(`${ui.theme.g.bad} Clipboard is not available here.`));
}

async function showDone(s: Session, amend: boolean): Promise<void> {
  const git = s.git as NonNullable<Session['git']>;
  const t = ui.theme;
  const last = await lastCommit(git);
  const stat = await lastCommitShortStat(git);
  const branch = await currentBranch(git);
  ui.write('');
  ui.write('  ' + t.ok(t.bold(`${t.g.ok} ${amend ? 'amended' : 'committed'}`)) + ' ' + t.accent(last?.hash ?? '') + ' on ' + t.scope(branch) + (stat ? '  ' + t.dim(stat) : ''));
}

/** Run `git push` through the approval policy (never forced). */
export async function pushWithApproval(s: Session, explicit: boolean): Promise<boolean> {
  const git = s.git as NonNullable<Session['git']>;
  const tool = getTool('git_push');
  if (!tool) return false;
  const ctx = toolContext(s);
  const policy = policyFor(s, explicit ? ['git_push'] : []);
  const auth = await authorize(tool, {}, ctx, policy);
  if (!auth.allowed) {
    ui.warn(`not pushed: ${auth.reason ?? 'declined'}`);
    return false;
  }
  const plan = await planPush(git);
  ui.dim(`pushing ${ui.theme.g.mid} ${plan.branch} ...`);
  const code = await push(git, plan, true);
  if (code === 0) { ui.ok('pushed'); return true; }
  throw new GitError('git push failed', { details: 'See the git output above.', try: ['git status', 'git pull --rebase'] });
}

async function generateWithSpinner(s: Session, o: CommitFlowOptions, ctx: Awaited<ReturnType<typeof gatherCommitContext>>, state: MessageState, settingsOverride?: Partial<Session['settings']>): Promise<GeneratedMessage> {
  const sp = new Spinner('reading diff').start();
  sp.update({ cancelHint: true, tokens: 0 });
  const ctl = new AbortController();
  const stopWatch = s.interactive ? cancelOnEsc(ctl) : () => undefined;
  try {
    return await generateCommitMessage({
      provider: s.provider, model: s.model, settings: { ...s.settings, ...settingsOverride }, context: ctx.prompt, state, ref: o.ref, signal: ctl.signal,
      onProgress: (p) => sp.update({ label: p.phase === 'writing' ? 'writing' : p.phase === 'thinking' ? 'thinking' : 'reading diff', tokens: p.tokens, tail: p.text }),
      onRetry: (problem, n, max) => { sp.stop(); ui.warn(`${problem} - retrying (${n}/${max})`); sp.start(); },
    });
  } finally {
    stopWatch();
    sp.stop();
  }
}

/**
 * generate -> (review) -> commit [-> push]. Shared by `aic commit`, `aic generate`, `aic push` and the chat.
 */
export async function runCommitFlow(s: Session, o: CommitFlowOptions): Promise<CommitFlowResult> {
  const git = s.git;
  if (!git) throw new GitError('Not inside a Git repository', { try: ['cd into your project', 'git init'] });
  const t = ui.theme;
  const state: MessageState = o.state ?? { type: o.type, scope: o.scope, breaking: o.breaking, hint: o.hint, regen: 0 };
  if (!o.state) { state.type = o.type; state.scope = o.scope; state.breaking = o.breaking; state.hint = o.hint; }
  const result: CommitFlowResult = { message: undefined, committed: false, pushed: false, cancelled: false, state };
  const commitMode = o.mode === 'commit' && !o.dryRun && !o.copy;

  if (!o.skipReady) await ensureReady(s, { startOllama: o.startOllama });

  // ---- which files? -------------------------------------------------------------------------
  if (o.all) {
    await add(git, 'all');
  } else if (!o.amend && s.interactive && !s.yes) {
    const pickNow = o.pick || !(await hasStagedChanges(git));
    if (pickNow) await selectFiles(s);
  }
  if (o.amend && !(await hasCommits(git))) throw new GitError('Nothing to amend: this repository has no commits yet.');

  let ctx = await gatherCommitContext(git, s.settings, { amend: o.amend ?? false, exclude: o.exclude ?? [], redact: s.redact });
  if (ctx.files.length === 0) {
    throw new AicError('Nothing staged (or only lockfiles)', ExitCode.GENERAL, {
      try: ['git add <files>', 'aic commit --all', 'aic commit --pick  (interactive file checklist)'],
    });
  }

  // ---- secret scan (local only) -------------------------------------------------------------
  let findings: Finding[] = [];
  if (!o.noScan && s.settings.secretScan) findings = scanStaged(ctx.files.map((f) => f.path), ctx.rawDiff);
  if (findings.length) renderFindings(findings);
  let ack = false;
  // Unattended mode never commits with findings, so do not even ask the model (nothing leaves the machine).
  if (s.yes && findings.length && commitMode) {
    throw new SecretError('Possible secrets are staged, so --yes will not commit', {
      details: `${findings.length} finding${findings.length === 1 ? '' : 's'} listed above. Nothing was sent to the provider.`,
      try: ['Remove the secrets and stage again', 'aic commit --no-scan   (only if they are false alarms)'],
    });
  }

  ui.blank();
  renderStat(ctx.files);
  if (ctx.redactions > 0) ui.dim(`${ctx.redactions} secret-like value${ctx.redactions === 1 ? '' : 's'} redacted before sending to ${s.provider.name}`);
  if (!s.provider.local) ui.dim(`sending to ${s.provider.name}: ${ctx.sent.chars} of ${ctx.sent.total} diff chars`);
  ui.write('  ' + t.ok(t.g.dot) + ' ' + t.mute(`${s.provider.name} ${t.g.mid} ${s.model}${s.provider.local ? '' : ` ${t.g.mid} cloud`}`));

  let message: GeneratedMessage | undefined;
  let need = true;

  while (true) {
    if (need) {
      need = false;
      try {
        message = await generateWithSpinner(s, o, ctx, state);
        result.message = message.message;
        renderMessage(message);
      } catch (e) {
        if (e instanceof CancelledError) {
          if (!message) { result.cancelled = true; return result; }
          ui.dim('cancelled; keeping the previous message');
        } else {
          throw e;
        }
      }
    }
    const msg = message as GeneratedMessage;

    if (o.dryRun || o.mode === 'generate') {
      ui.blank();
      ui.dim(`${o.dryRun ? 'dry run' : 'generate only'} ${t.g.mid} nothing was committed`);
      if (o.copy) await copyMessage(msg.message);
      if (o.passThru) ui.data(msg.message);
      return result;
    }
    if (o.copy) {
      await copyMessage(msg.message);
      if (o.passThru) ui.data(msg.message);
      return result;
    }

    // ---- non-interactive: --yes ----------------------------------------------------------------
    if (s.yes) {
      if (findings.length) {
        throw new SecretError('Possible secrets are staged, so --yes will not commit', {
          details: `${findings.length} finding${findings.length === 1 ? '' : 's'} listed above.`,
          try: ['Remove the secrets and stage again', 'aic commit --no-scan   (only if they are false alarms)'],
        });
      }
      if (msg.problems.length === 0 || !s.interactive) {
        if (msg.problems.length) throw new AicError('The message still fails the format check, so --yes will not commit it', ExitCode.GENERAL, { details: msg.problems[0] ?? '' });
        const code = await commit(git, { message: msg.message, amend: o.amend ?? false, noVerify: o.noVerify || s.settings.noVerify, signoff: o.signoff || s.settings.signoff, toStderr: true });
        if (code !== 0) throw new GitError('git commit did not complete', { details: 'A hook failed or git rejected the commit.' });
        result.committed = true;
        await showDone(s, o.amend ?? false);
        if (o.push) result.pushed = await pushWithApproval(s, true);
        if (o.passThru) ui.data(msg.message);
        return result;
      }
    }

    // ---- interactive review ---------------------------------------------------------------------
    if (!s.interactive) {
      throw new AicError('Cannot review interactively without a terminal', ExitCode.USAGE, { try: ['aic commit --yes', 'aic generate --pass-thru'] });
    }
    renderActions(o.amend ?? false, findings.length > 0);
    const k = await readKey();
    const key = k.name === 'enter' ? 'y' : k.name === 'escape' || k.name === 'ctrl-c' ? 'q' : k.name;
    ui.raw('\r\u001b[2K');

    switch (key) {
      case 'y': case 'e': case 'p': {
        if (findings.length && !ack) {
          if (!(await yesNo('Possible secrets are staged. Commit anyway?', false))) break;
          ack = true;
        }
        const code = await commit(git, { message: msg.message, edit: key === 'e', amend: o.amend ?? false, noVerify: o.noVerify || s.settings.noVerify, signoff: o.signoff || s.settings.signoff, toStderr: true });
        if (code !== 0) {
          ui.write('  ' + t.err(`${t.g.bad} git commit did not complete`));
          ui.dim('A hook failed or the editor was closed empty. Your message is still here: fix it, then press Enter again.');
          break;
        }
        result.committed = true;
        await showDone(s, o.amend ?? false);
        if (o.push || key === 'p') result.pushed = await pushWithApproval(s, Boolean(o.push) && s.yes);
        if (o.passThru) ui.data(msg.message);
        return result;
      }
      case 'r': state.regen++; need = true; break;
      case 'h': {
        const h = (await ask('hint for the model:')).trim();
        if (h) { state.hint = h; state.regen++; need = true; }
        break;
      }
      case 'm': await changeModel(s); state.regen = 0; need = true; break;
      case 't': {
        const types = s.settings.types;
        const cur = getType(msg.message);
        const chosen = await pickOne('Pick a type', types.map((x) => ({ name: x, value: x })), types.includes(cur) ? cur : undefined);
        state.type = chosen;
        message = rewrite(msg, setPrefix(msg.message, { type: chosen }, s.settings.emoji), s);
        result.message = message.message;
        renderMessage(message);
        break;
      }
      case 's': {
        let sc: string;
        if (s.settings.scopes.length) {
          const none = '\0none';
          const v = await pickOne('Pick a scope', [...s.settings.scopes.map((x) => ({ name: x, value: x })), { name: '(no scope)', value: none }]);
          sc = v === none ? '' : v;
        } else {
          sc = (await ask('scope (blank = none):')).trim();
        }
        state.scope = sc;
        state.noScope = !sc;
        message = rewrite(msg, setPrefix(msg.message, { scope: sc }, s.settings.emoji), s);
        result.message = message.message;
        renderMessage(message);
        break;
      }
      case 'b': {
        state.breaking = !getBang(msg.message);
        message = rewrite(msg, setPrefix(msg.message, { bang: state.breaking }, s.settings.emoji), s);
        result.message = message.message;
        renderMessage(message);
        break;
      }
      case 'c': await copyMessage(msg.message); break;
      case 'd': printDiffColored(await stagedDiff(git, { amend: o.amend ?? false, exclude: [...s.settings.exclude, ...(o.exclude ?? [])] }, 3)); break;
      case 'q': result.cancelled = true; return result;
      default: break;
    }
    // refresh context after a model change or when the index changed under us
    if (need) ctx = await gatherCommitContext(git, s.settings, { amend: o.amend ?? false, exclude: o.exclude ?? [], redact: s.redact });
  }
}

function rewrite(old: GeneratedMessage, message: string, s: Session): GeneratedMessage {
  return { ...old, message, problems: validateMessage(message, { types: s.settings.types, scopes: s.settings.scopes, subjectMax: s.settings.subjectMax }) };
}

function renderActions(amend: boolean, risky: boolean): void {
  const t = ui.theme;
  const cap = (k: string, label: string): string => `${t.cap(k)} ${label}`;
  ui.write('');
  ui.write('  ' + [cap('Enter', amend ? 'amend' : risky ? 'commit…' : 'commit'), cap('e', 'edit'), cap('r', 'regenerate'), cap('h', 'hint'), cap('p', 'commit & push')].join('  '));
  ui.write('  ' + [cap('t', 'type'), cap('s', 'scope'), cap('b', 'breaking'), cap('m', 'model'), cap('c', 'copy'), cap('d', 'diff'), cap('q', 'quit')].join('  '));
}

export async function changeModel(s: Session): Promise<void> {
  const models = (await s.provider.listModels()).filter((m) => !/embed/i.test(m.id));
  if (models.length === 0) { ui.warn('No models available.'); return; }
  const picked = await pickOne('Pick a model', models.map((m) => ({ name: m.id + (m.sizeBytes ? `  (${(m.sizeBytes / 1024 ** 3).toFixed(1)} GB)` : '') + (m.id === s.model ? '   <- current' : ''), value: m.id })), s.model);
  s.model = picked;
}
