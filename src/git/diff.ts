import type { Git } from './exec.js';
import { EMPTY_TREE } from './exec.js';

export interface FileStat {
  path: string;
  add: number;
  del: number;
  binary: boolean;
}

/** Lockfiles, minified and generated files are noise for the model. */
export const DEFAULT_EXCLUDES = [
  'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'Cargo.lock',
  'composer.lock', 'poetry.lock', 'Gemfile.lock', 'go.sum', '*.min.js', '*.min.css', '*.map',
];

export function pathspecArgs(extraExcludes: string[]): string[] {
  const all = [...DEFAULT_EXCLUDES, ...extraExcludes].filter(Boolean);
  return ['--', '.', ...all.map((p) => `:(exclude)*${p.replace(/^\*+/, '')}`)];
}

export function parseNumstat(text: string): FileStat[] {
  const out: FileStat[] = [];
  for (const line of text.split(/\r?\n/)) {
    const p = line.split('\t');
    if (p.length < 3) continue;
    const binary = p[0] === '-';
    out.push({ path: p.slice(2).join('\t'), add: binary ? 0 : Number(p[0]), del: binary ? 0 : Number(p[1]), binary });
  }
  return out;
}

export function formatStat(files: FileStat[], max = 40): string {
  const lines = files.slice(0, max).map((f) => (f.binary ? `${f.path} (binary)` : `${f.path} (+${f.add} -${f.del})`));
  if (files.length > max) lines.push(`... and ${files.length - max} more files`);
  return lines.join('\n');
}

export interface DiffScope {
  /** compare the index with the PARENT of HEAD (git commit --amend) */
  amend?: boolean;
  exclude?: string[];
}

async function amendBase(git: Git): Promise<string[]> {
  return (await git.ok(['rev-parse', '--verify', '-q', 'HEAD~1'])) ? ['HEAD~1'] : [EMPTY_TREE];
}

export async function stagedStat(git: Git, scope: DiffScope = {}): Promise<FileStat[]> {
  const base = scope.amend ? await amendBase(git) : [];
  const r = await git.raw(['diff', '--staged', '--numstat', '--no-ext-diff', ...base, ...pathspecArgs(scope.exclude ?? [])], { allowFail: true });
  return parseNumstat(r.stdout);
}

export async function stagedDiff(git: Git, scope: DiffScope = {}, context = 1): Promise<string> {
  const base = scope.amend ? await amendBase(git) : [];
  const r = await git.raw(['diff', '--staged', `--unified=${context}`, '--no-color', '--no-ext-diff', ...base, ...pathspecArgs(scope.exclude ?? [])], { allowFail: true });
  return r.stdout.replace(/\r?\n$/, '');
}

export async function unstagedDiff(git: Git, scope: DiffScope = {}, context = 1): Promise<string> {
  const r = await git.raw(['diff', `--unified=${context}`, '--no-color', '--no-ext-diff', ...pathspecArgs(scope.exclude ?? [])], { allowFail: true });
  return r.stdout.replace(/\r?\n$/, '');
}

export async function unstagedStat(git: Git, scope: DiffScope = {}): Promise<FileStat[]> {
  const r = await git.raw(['diff', '--numstat', '--no-ext-diff', ...pathspecArgs(scope.exclude ?? [])], { allowFail: true });
  return parseNumstat(r.stdout);
}

/** Split a unified diff into per-file chunks (each starting with "diff --git"). */
export function splitDiffByFile(diff: string): string[] {
  return diff.split(/^(?=diff --git )/m).filter((c) => c.length > 0);
}

/**
 * Keep the diff inside `budget` characters but give EVERY file a fair share:
 * small files free budget for big ones (same algorithm as the PowerShell version).
 */
export function shrinkDiff(diff: string, budget: number): string {
  if (diff.length <= budget) return diff;
  const chunks = splitDiffByFile(diff);
  if (chunks.length === 0) return diff.slice(0, budget) + '\n[... diff truncated ...]';
  let left = budget;
  let n = chunks.length;
  const keep = new Map<number, string>();
  const order = chunks.map((_, i) => i).sort((a, b) => (chunks[a] as string).length - (chunks[b] as string).length);
  for (const ix of order) {
    const share = Math.floor(left / n);
    n--;
    const chunk = chunks[ix] as string;
    keep.set(ix, chunk.length > share ? chunk.slice(0, share) + '\n[... truncated ...]\n' : chunk);
    left -= Math.min(chunk.length, share);
  }
  return chunks.map((_, i) => keep.get(i) ?? '').join('');
}

export interface AddedLine {
  file: string;
  /** 1-based line number in the new file */
  line: number;
  text: string;
}

/** Added lines of a unified diff with their file and line number (needed by the secret scanner). */
export function parseAddedLines(diff: string): AddedLine[] {
  const out: AddedLine[] = [];
  let file = '';
  let line = 0;
  for (const raw of diff.split(/\r?\n/)) {
    if (raw.startsWith('diff --git ')) {
      const m = /^diff --git a\/.+? b\/(.+)$/.exec(raw);
      file = m?.[1] ?? '';
      line = 0;
      continue;
    }
    if (raw.startsWith('+++ ')) {
      const m = /^\+\+\+ b\/(.+)$/.exec(raw);
      if (m?.[1]) file = m[1];
      continue;
    }
    if (raw.startsWith('--- ')) continue;
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (h) {
      line = Number(h[1]);
      continue;
    }
    if (raw.startsWith('+')) {
      out.push({ file, line, text: raw.slice(1) });
      line++;
    } else if (raw.startsWith(' ')) {
      line++;
    }
  }
  return out;
}

/** Files named in a diff (after exclusions) in order of appearance. */
export function diffFiles(diff: string): string[] {
  const out: string[] = [];
  for (const m of diff.matchAll(/^diff --git a\/.+? b\/(.+)$/gm)) if (m[1]) out.push(m[1]);
  return out;
}

/** Changes on `head` since it forked from `base` (three-dot diff = what a pull request shows). */
export async function rangeStat(git: Git, base: string, head = 'HEAD', exclude: string[] = []): Promise<FileStat[]> {
  const r = await git.raw(['diff', '--numstat', '--no-ext-diff', `${base}...${head}`, ...pathspecArgs(exclude)], { allowFail: true });
  return parseNumstat(r.stdout);
}

export async function rangeDiff(git: Git, base: string, head = 'HEAD', exclude: string[] = [], context = 1): Promise<string> {
  const r = await git.raw(['diff', `--unified=${context}`, '--no-color', '--no-ext-diff', `${base}...${head}`, ...pathspecArgs(exclude)], { allowFail: true });
  return r.stdout.replace(/\r?\n$/, '');
}

/** Diff of every uncommitted change (staged + unstaged) against HEAD. */
export async function workingDiff(git: Git, exclude: string[] = [], context = 1): Promise<string> {
  const r = await git.raw(['diff', 'HEAD', `--unified=${context}`, '--no-color', '--no-ext-diff', ...pathspecArgs(exclude)], { allowFail: true });
  return r.stdout.replace(/\r?\n$/, '');
}

export async function workingStat(git: Git, exclude: string[] = []): Promise<FileStat[]> {
  const r = await git.raw(['diff', 'HEAD', '--numstat', '--no-ext-diff', ...pathspecArgs(exclude)], { allowFail: true });
  return parseNumstat(r.stdout);
}
