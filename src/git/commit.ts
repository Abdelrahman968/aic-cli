import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Git } from './exec.js';
import { GitError } from '../utils/errors.js';
import { aheadBehind, currentBranch, remotes, upstream } from './branch.js';
import { hasCommits, hasParent } from './history.js';

export interface CommitOptions {
  message: string;
  /** open the message in the git editor */
  edit?: boolean;
  amend?: boolean;
  noVerify?: boolean;
  signoff?: boolean;
  /** send git's stdout to stderr so stdout stays clean for --pass-thru */
  toStderr?: boolean;
}

/** Commit through a temp file (UTF-8, no BOM; safe for multi-line and non-Latin text). Returns git's exit code. */
export async function commit(git: Git, o: CommitOptions): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), 'aic-'));
  const file = join(dir, 'COMMIT_MSG');
  try {
    writeFileSync(file, o.message.endsWith('\n') ? o.message : o.message + '\n', { encoding: 'utf8' });
    const args = ['commit', '-F', file];
    if (o.edit) args.push('-e');
    if (o.amend) args.push('--amend');
    if (o.noVerify) args.push('--no-verify');
    if (o.signoff) args.push('--signoff');
    return await git.inherit(args, { toStderr: o.toStderr ?? false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Stage paths, or everything with `all`. */
export async function add(git: Git, paths: string[] | 'all'): Promise<void> {
  if (paths === 'all') await git.raw(['add', '-A']);
  else if (paths.length) await git.raw(['add', '-A', '--', ...paths]);
}

/** Remove paths from the index (the working tree is untouched). */
export async function unstage(git: Git, paths: string[]): Promise<void> {
  if (!paths.length) return;
  if (await hasCommits(git)) await git.raw(['reset', '-q', '--', ...paths]);
  else await git.raw(['rm', '--cached', '-r', '-q', '--', ...paths]);
}

export interface PushPlan {
  branch: string;
  remote: string;
  setUpstream: boolean;
  command: string[];
}

/** Work out what `git push` would do, without doing it (so the user can be shown/confirm the exact command). */
export async function planPush(git: Git): Promise<PushPlan> {
  const branch = await currentBranch(git);
  if (branch === 'detached HEAD') throw new GitError('Cannot push a detached HEAD', { try: ['git switch -c <new-branch>'] });
  const up = await upstream(git);
  if (up) return { branch, remote: up.split('/')[0] ?? 'origin', setUpstream: false, command: ['git', 'push'] };
  const rs = await remotes(git);
  if (rs.length === 0) throw new GitError('This repository has no remote to push to', { try: ['git remote add origin <url>'] });
  const remote = rs.includes('origin') ? 'origin' : (rs[0] as string);
  return { branch, remote, setUpstream: true, command: ['git', 'push', '-u', remote, 'HEAD'] };
}

/** Run a plan from planPush. Never forces. Returns the exit code. */
export async function push(git: Git, plan: PushPlan, toStderr = false): Promise<number> {
  return git.inherit(plan.command.slice(1), { toStderr });
}

export interface UndoCheck {
  ok: boolean;
  reason?: string;
  /** the commit is already on the remote: undoing locally means force-pushing later */
  published: boolean;
}

export async function checkUndo(git: Git): Promise<UndoCheck> {
  if (!(await hasCommits(git))) return { ok: false, reason: 'There is no commit to undo.', published: false };
  if (!(await hasParent(git))) return { ok: false, reason: "The very first commit can't be soft-undone this way.", published: false };
  const ab = await aheadBehind(git);
  const published = ab.upstream !== undefined && ab.ahead === 0;
  return { ok: true, published };
}

/** Soft undo: HEAD moves back one commit, everything stays staged. Nothing is lost. */
export async function softUndo(git: Git): Promise<void> {
  await git.raw(['reset', '--soft', 'HEAD~1']);
}
