import type { Git } from './exec.js';

export interface CommitInfo {
  hash: string;
  subject: string;
  author?: string;
  date?: string;
}

export async function recentSubjects(git: Git, count: number, skip = 0): Promise<string[]> {
  if (count <= 0) return [];
  const r = await git.raw(['log', '-n', String(count), `--skip=${skip}`, '--no-merges', '--pretty=%s'], { allowFail: true });
  return r.stdout.split(/\r?\n/).filter(Boolean);
}

export async function log(git: Git, count = 10): Promise<CommitInfo[]> {
  const r = await git.raw(['log', '-n', String(Math.min(Math.max(count, 1), 100)), '--pretty=%h%x09%s%x09%an%x09%ad', '--date=short'], { allowFail: true });
  return r.stdout.split(/\r?\n/).filter(Boolean).map((l) => {
    const [hash = '', subject = '', author, date] = l.split('\t');
    return { hash, subject, ...(author ? { author } : {}), ...(date ? { date } : {}) };
  });
}

export async function lastCommit(git: Git): Promise<CommitInfo | undefined> {
  const r = await git.raw(['log', '-1', '--format=%h%x09%s'], { allowFail: true });
  if (r.code !== 0 || !r.stdout.trim()) return undefined;
  const [hash = '', subject = ''] = r.stdout.trim().split('\t');
  return { hash, subject };
}

export async function hasCommits(git: Git): Promise<boolean> {
  return git.ok(['rev-parse', '--verify', '-q', 'HEAD']);
}

export async function hasParent(git: Git): Promise<boolean> {
  return git.ok(['rev-parse', '--verify', '-q', 'HEAD~1']);
}

/** "1 file changed, 3 insertions(+)" of the last commit */
export async function lastCommitShortStat(git: Git): Promise<string> {
  const r = await git.raw(['log', '-1', '--shortstat', '--format='], { allowFail: true });
  return r.stdout.trim();
}
