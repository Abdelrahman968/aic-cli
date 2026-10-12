import type { Git } from './exec.js';

export interface ChangedFile {
  path: string;
  /** single letter: M A D R C U ? */
  code: string;
  staged: boolean;
  /** has unstaged changes on top of the staged ones */
  dirty: boolean;
  untracked: boolean;
  oldPath?: string;
}

/** Parse `git status --porcelain=v1 -z`. Renames carry the old name as the following entry. */
export function parsePorcelainZ(raw: string): ChangedFile[] {
  const parts = raw.split('\0').filter(Boolean);
  const items: ChangedFile[] = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i] as string;
    if (e.length < 4) continue;
    const x = e[0] as string;
    const y = e[1] as string;
    let oldPath: string | undefined;
    if (x === 'R' || x === 'C') {
      oldPath = parts[i + 1];
      i++;
    }
    if (x === '!') continue;
    const staged = x !== ' ' && x !== '?';
    const code = x === '?' ? '?' : y !== ' ' ? y : x;
    items.push({ path: e.slice(3), code, staged, dirty: y !== ' ' && x !== '?', untracked: x === '?', ...(oldPath ? { oldPath } : {}) });
  }
  return items;
}

/** Changed files. Falls back to directory-level untracked entries when there are too many (node_modules not ignored). */
export async function changedFiles(git: Git, opts: { maxItems?: number } = {}): Promise<ChangedFile[]> {
  const limit = opts.maxItems ?? 400;
  let items = parsePorcelainZ((await git.raw(['status', '--porcelain=v1', '-z', '-uall'], { allowFail: true })).stdout);
  if (items.length > limit) {
    items = parsePorcelainZ((await git.raw(['status', '--porcelain=v1', '-z', '-unormal'], { allowFail: true })).stdout);
  }
  return items;
}

export interface StatusSummary {
  staged: ChangedFile[];
  unstaged: ChangedFile[];
  untracked: ChangedFile[];
  total: number;
}

export function summarize(files: ChangedFile[]): StatusSummary {
  return {
    staged: files.filter((f) => f.staged),
    unstaged: files.filter((f) => f.dirty),
    untracked: files.filter((f) => f.untracked),
    total: files.length,
  };
}

export async function hasStagedChanges(git: Git): Promise<boolean> {
  return !(await git.ok(['diff', '--staged', '--quiet', '--no-ext-diff']));
}

export function formatStatusLine(f: ChangedFile): string {
  return `${f.code}  ${f.path}${f.oldPath ? `  (from ${f.oldPath})` : ''}`;
}
