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

export interface RangeCommit {
  hash: string;
  subject: string;
  author: string;
  date: string;
  body: string;
}

/** Commits in `from..to` (or everything up to `to`), newest first, merges excluded. Bodies are included (BREAKING CHANGE footers live there). */
export async function commitsBetween(git: Git, from: string | undefined, to = 'HEAD', max = 500): Promise<RangeCommit[]> {
  const range = from ? `${from}..${to}` : to;
  const r = await git.raw(['log', range, '--no-merges', `--max-count=${max}`, '--date=short', '--pretty=format:%H%x1f%s%x1f%an%x1f%ad%x1f%b%x1e'], { allowFail: true });
  if (r.code !== 0) return [];
  return r.stdout.split('\x1e').map((rec) => rec.replace(/^\n+/, '')).filter(Boolean).map((rec) => {
    const [hash = '', subject = '', author = '', date = '', ...body] = rec.split('\x1f');
    return { hash, subject, author, date, body: body.join('\x1f').trim() };
  });
}

/** Most recent tag reachable from `to`, if any. */
export async function latestTag(git: Git, to = 'HEAD'): Promise<string | undefined> {
  const r = await git.raw(['describe', '--tags', '--abbrev=0', to], { allowFail: true });
  return r.code === 0 ? r.stdout.trim() || undefined : undefined;
}

export async function refExists(git: Git, ref: string): Promise<boolean> {
  return git.ok(['rev-parse', '--verify', '-q', `${ref}^{commit}`]);
}

/** Where a pull request would be opened against: origin/HEAD, else main/master (remote first). */
export async function defaultBase(git: Git, currentBranch?: string): Promise<string | undefined> {
  const head = await git.raw(['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD'], { allowFail: true });
  const fromOrigin = head.stdout.trim();
  if (head.code === 0 && fromOrigin && fromOrigin !== `origin/${currentBranch}`) return fromOrigin;
  for (const ref of ['origin/main', 'origin/master', 'main', 'master', 'develop']) {
    if (ref === currentBranch || ref === `origin/${currentBranch}`) continue;
    if (await refExists(git, ref)) return ref;
  }
  return undefined;
}
