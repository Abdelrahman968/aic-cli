import type { Git } from './exec.js';

export async function currentBranch(git: Git): Promise<string> {
  const r = await git.raw(['symbolic-ref', '--short', '-q', 'HEAD'], { allowFail: true });
  const b = r.stdout.trim();
  return b || 'detached HEAD';
}

export async function upstream(git: Git): Promise<string | undefined> {
  const r = await git.raw(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { allowFail: true });
  return r.code === 0 ? r.stdout.trim() : undefined;
}

export interface AheadBehind {
  upstream: string | undefined;
  ahead: number;
  behind: number;
}

export async function aheadBehind(git: Git): Promise<AheadBehind> {
  const up = await upstream(git);
  if (!up) return { upstream: undefined, ahead: 0, behind: 0 };
  const r = await git.raw(['rev-list', '--left-right', '--count', 'HEAD...@{u}'], { allowFail: true });
  const [a = '0', b = '0'] = r.stdout.trim().split(/\s+/);
  return { upstream: up, ahead: Number(a) || 0, behind: Number(b) || 0 };
}

export async function listBranches(git: Git): Promise<string[]> {
  const r = await git.raw(['branch', '--format=%(refname:short)'], { allowFail: true });
  return r.stdout.split(/\r?\n/).filter(Boolean);
}

export async function remotes(git: Git): Promise<string[]> {
  const r = await git.raw(['remote'], { allowFail: true });
  return r.stdout.split(/\r?\n/).filter(Boolean);
}
