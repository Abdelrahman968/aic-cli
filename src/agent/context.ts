import type { Git } from '../git/exec.js';
import { formatStat, shrinkDiff, stagedDiff, stagedStat, unstagedDiff, unstagedStat, type FileStat } from '../git/diff.js';
import { recentSubjects, log } from '../git/history.js';
import { aheadBehind, currentBranch } from '../git/branch.js';
import { changedFiles, formatStatusLine, summarize } from '../git/status.js';
import { scopeHint } from '../commit/format.js';
import type { CommitPromptContext } from '../commit/prompt.js';
import { isSensitivePath, redactContent } from '../security/secret-scanner.js';
import { splitDiffByFile, diffFiles } from '../git/diff.js';
import type { Settings } from '../config/schema.js';

export interface Section {
  id: string;
  title: string;
  text: string;
  /** higher = kept first when the budget is tight */
  priority: number;
  /** can this section be cut down? */
  shrink?: (text: string, budget: number) => string;
  /** never go below this many chars when shrinking */
  minChars?: number;
}

export interface Assembled {
  text: string;
  used: number;
  truncated: string[];
  dropped: string[];
}

/**
 * Fit sections into `budget` characters. Lowest-priority sections are shrunk first (to their floor),
 * then dropped, so the most useful context survives on large repositories.
 */
export function assemble(sections: Section[], budget: number): Assembled {
  const secs = sections.map((s) => ({ ...s }));
  const render = (): string => secs.filter((s) => s.text).map((s) => `## ${s.title}\n${s.text}`).join('\n\n');
  const len = (): number => secs.reduce((n, s) => n + (s.text ? s.text.length + s.title.length + 6 : 0), 0);
  const truncated: string[] = [];
  const dropped: string[] = [];
  const byPriority = [...secs].sort((a, b) => a.priority - b.priority);

  for (const s of byPriority) {
    const over = len() - budget;
    if (over <= 0) break;
    if (s.shrink && s.text) {
      const target = Math.max(s.minChars ?? 200, s.text.length - over);
      if (target < s.text.length) {
        s.text = s.shrink(s.text, target);
        truncated.push(s.id);
      }
    }
  }
  for (const s of byPriority) {
    if (len() <= budget) break;
    if (s.text && s.priority < 100) {
      s.text = '';
      dropped.push(s.id);
    }
  }
  return { text: render(), used: len(), truncated, dropped };
}

export interface CommitContextOptions {
  amend?: boolean;
  exclude?: string[];
  /** strip secrets from what is sent (on for any non-local provider) */
  redact: boolean;
}

export interface CommitContext {
  files: FileStat[];
  statText: string;
  /** full staged diff, kept locally (secret scan, `d` key) */
  rawDiff: string;
  prompt: CommitPromptContext;
  redactions: number;
  /** characters of diff actually sent / total */
  sent: { chars: number; total: number };
}

/** Replace the diff of credential-like files (.env, keys) by a placeholder before it leaves the machine. */
export function withholdSensitive(diff: string): { text: string; files: string[] } {
  const files: string[] = [];
  const text = splitDiffByFile(diff).map((chunk) => {
    const f = diffFiles(chunk)[0];
    if (f && isSensitivePath(f)) { files.push(f); return `diff --git a/${f} b/${f}\n[content of ${f} withheld: credentials file]\n`; }
    return chunk;
  }).join('');
  return { text, files };
}

const WITHHELD = '(diff content is not sent: privacy settings allow file names and line counts only)';

export async function gatherCommitContext(git: Git, s: Settings, o: CommitContextOptions): Promise<CommitContext> {
  const scope = { amend: o.amend ?? false, exclude: [...s.exclude, ...(o.exclude ?? [])] };
  const files = await stagedStat(git, scope);
  const rawDiff = await stagedDiff(git, scope);
  const statText = formatStat(files);
  let diff = s.sendDiff ? shrinkDiff(o.redact ? withholdSensitive(rawDiff).text : rawDiff, s.maxChars) : WITHHELD;
  let redactions = 0;
  if (o.redact && s.sendDiff) {
    const r = redactContent(diff);
    diff = r.text;
    redactions = r.count;
  }
  const recent = s.sendHistory ? await recentSubjects(git, s.history, o.amend ? 1 : 0) : [];
  const branch = s.sendBranch ? await currentBranch(git) : undefined;
  return {
    files, statText, rawDiff, redactions,
    sent: { chars: s.sendDiff ? Math.min(diff.length, rawDiff.length) : 0, total: rawDiff.length },
    prompt: { branch, recent, scopeHint: scopeHint(files.map((f) => f.path)), stat: statText, diff },
  };
}

function shrinkByLines(text: string, budget: number): string {
  if (text.length <= budget) return text;
  return text.slice(0, Math.max(0, budget - 20)) + '\n[... truncated ...]';
}

export interface ChatContext {
  text: string;
  truncated: string[];
  dropped: string[];
  redactions: number;
}

/** Repository snapshot for conversational questions ("explain what changed"). Respects privacy settings and the char budget. */
export async function buildChatContext(git: Git, s: Settings, o: { redact: boolean; budget?: number }): Promise<ChatContext> {
  const budget = o.budget ?? Math.max(4000, s.maxChars + 2500);
  const files = await changedFiles(git);
  const sum = summarize(files);
  const branch = s.sendBranch ? await currentBranch(git) : '(hidden by privacy settings)';
  const ab = s.sendBranch ? await aheadBehind(git) : undefined;
  const ex = s.exclude;

  const sections: Section[] = [];
  sections.push({ id: 'repo', title: 'Repository', priority: 100, text: `name: ${git.name}\nbranch: ${branch}${ab?.upstream ? `\nupstream: ${ab.upstream} (ahead ${ab.ahead}, behind ${ab.behind})` : ''}` });
  sections.push({
    id: 'status', title: 'Status', priority: 90,
    text: files.length
      ? `staged: ${sum.staged.length}, unstaged: ${sum.unstaged.length}, untracked: ${sum.untracked.length}\n` + files.slice(0, 60).map(formatStatusLine).join('\n') + (files.length > 60 ? `\n... ${files.length - 60} more` : '')
      : 'clean working tree',
    shrink: shrinkByLines, minChars: 300,
  });
  if (s.sendDiff) {
    const [sStat, uStat] = await Promise.all([stagedStat(git, { exclude: ex }), unstagedStat(git, { exclude: ex })]);
    const [sDiff, uDiff] = await Promise.all([stagedDiff(git, { exclude: ex }), unstagedDiff(git, { exclude: ex })]);
    if (sStat.length) sections.push({ id: 'staged-stat', title: 'Staged files', priority: 80, text: formatStat(sStat), shrink: shrinkByLines, minChars: 200 });
    if (sDiff) sections.push({ id: 'staged-diff', title: 'Staged diff', priority: 70, text: sDiff, shrink: shrinkDiff, minChars: 600 });
    if (uStat.length) sections.push({ id: 'unstaged-stat', title: 'Unstaged files', priority: 60, text: formatStat(uStat), shrink: shrinkByLines, minChars: 200 });
    if (uDiff) sections.push({ id: 'unstaged-diff', title: 'Unstaged diff', priority: 50, text: uDiff, shrink: shrinkDiff, minChars: 600 });
  } else {
    sections.push({ id: 'privacy', title: 'Privacy', priority: 95, text: 'Diff content is not shared (sendDiff=false). Only file names are available.' });
  }
  if (s.sendHistory) {
    const commits = await log(git, 10);
    if (commits.length) sections.push({ id: 'history', title: 'Recent commits', priority: 40, text: commits.map((c) => `${c.hash} ${c.subject}`).join('\n'), shrink: shrinkByLines, minChars: 150 });
  }

  const a = assemble(sections, budget);
  let text = a.text;
  let redactions = 0;
  if (o.redact) {
    const r = redactContent(text);
    text = r.text;
    redactions = r.count;
  }
  return { text, truncated: a.truncated, dropped: a.dropped, redactions };
}
