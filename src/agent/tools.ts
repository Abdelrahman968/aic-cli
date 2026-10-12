import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { Git } from '../git/exec.js';
import { changedFiles, formatStatusLine, summarize } from '../git/status.js';
import { shrinkDiff, stagedDiff, unstagedDiff } from '../git/diff.js';
import { log } from '../git/history.js';
import { aheadBehind, currentBranch, listBranches } from '../git/branch.js';
import { add, checkUndo, commit, planPush, push, softUndo, unstage } from '../git/commit.js';
import { isSensitivePath, redactContent } from '../security/secret-scanner.js';
import type { Settings } from '../config/schema.js';

/**
 * Risk tiers decide who may approve a tool:
 *  read    - never asks
 *  write   - changes the index/history locally: asks, unless --yes or autoApprove
 *  remote  - talks to the network (push): asks, unless autoApprove, or --yes AND the user explicitly asked for it (--push)
 *  history - rewrites history (soft undo): asks, unless --yes AND the user explicitly asked for it (aic undo --yes)
 */
export type Risk = 'read' | 'write' | 'remote' | 'history';

export interface ToolContext {
  git: Git;
  settings: Settings;
  /** strip secrets from everything returned to the model (non-local providers) */
  redact: boolean;
}

export interface ToolResult {
  ok: boolean;
  output: string;
}

export interface ToolDef {
  name: string;
  description: string;
  /** argument name -> short description */
  args: Record<string, string>;
  risk: (args: Record<string, unknown>) => Risk;
  /** exact command shown to the user before approval */
  describe: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string> | string;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}

const MAX_OUTPUT = 8000;

function clip(text: string, max = MAX_OUTPUT): string {
  return text.length <= max ? text : text.slice(0, max) + `\n[... truncated ${text.length - max} chars ...]`;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length ? v : undefined;
}
function strList(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string' && x.length > 0);
  if (typeof v === 'string' && v) return [v];
  return [];
}
function num(v: unknown, d: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : d;
}

/** Resolve a user/model supplied path and make sure it stays inside the repository. */
export function safeRepoPath(root: string, p: string): { abs: string; rel: string } | { error: string } {
  if (p.includes('\0')) return { error: 'invalid path' };
  const abs = resolve(root, p);
  let real = abs;
  try { if (existsSync(abs)) real = realpathSync(abs); } catch { /* use abs */ }
  let realRoot = root;
  try { realRoot = realpathSync(root); } catch { /* use root */ }
  const rel = relative(realRoot, real);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) return { error: 'path is outside the repository' };
  return { abs: real, rel: rel.split(sep).join('/') };
}

function finish(ctx: ToolContext, text: string): ToolResult {
  const t = clip(text);
  return { ok: true, output: ctx.redact ? redactContent(t).text : t };
}

export const TOOLS: ToolDef[] = [
  {
    name: 'git_status', description: 'List changed files (staged, unstaged, untracked) and branch info.', args: {},
    risk: () => 'read', describe: () => 'git status',
    async run(_a, ctx) {
      const files = await changedFiles(ctx.git);
      const sum = summarize(files);
      const ab = await aheadBehind(ctx.git);
      const head = `branch: ${await currentBranch(ctx.git)}${ab.upstream ? ` (upstream ${ab.upstream}, ahead ${ab.ahead}, behind ${ab.behind})` : ''}\nstaged: ${sum.staged.length}, unstaged: ${sum.unstaged.length}, untracked: ${sum.untracked.length}`;
      return finish(ctx, files.length ? `${head}\n${files.map(formatStatusLine).join('\n')}` : `${head}\nclean working tree`);
    },
  },
  {
    name: 'git_diff', description: 'Show the unstaged diff.', args: {},
    risk: () => 'read', describe: () => 'git diff',
    async run(_a, ctx) {
      if (!ctx.settings.sendDiff) return { ok: false, output: 'Diff content is not shared with the provider (sendDiff=false).' };
      const d = await unstagedDiff(ctx.git, { exclude: ctx.settings.exclude });
      return finish(ctx, d ? shrinkDiff(d, MAX_OUTPUT) : '(no unstaged changes)');
    },
  },
  {
    name: 'git_diff_cached', description: 'Show the staged diff.', args: {},
    risk: () => 'read', describe: () => 'git diff --staged',
    async run(_a, ctx) {
      if (!ctx.settings.sendDiff) return { ok: false, output: 'Diff content is not shared with the provider (sendDiff=false).' };
      const d = await stagedDiff(ctx.git, { exclude: ctx.settings.exclude });
      return finish(ctx, d ? shrinkDiff(d, MAX_OUTPUT) : '(nothing staged)');
    },
  },
  {
    name: 'git_log', description: 'Recent commits.', args: { count: 'how many commits (default 10, max 50)' },
    risk: () => 'read', describe: (a) => `git log -n ${num(a['count'], 10, 1, 50)}`,
    async run(a, ctx) {
      const commits = await log(ctx.git, num(a['count'], 10, 1, 50));
      return finish(ctx, commits.length ? commits.map((c) => `${c.hash} ${c.date ?? ''} ${c.subject}`).join('\n') : '(no commits yet)');
    },
  },
  {
    name: 'git_branch', description: 'Current branch and local branches.', args: {},
    risk: () => 'read', describe: () => 'git branch',
    async run(_a, ctx) {
      const cur = await currentBranch(ctx.git);
      const all = await listBranches(ctx.git);
      return finish(ctx, `current: ${cur}\n${all.map((b) => (b === cur ? `* ${b}` : `  ${b}`)).join('\n')}`);
    },
  },
  {
    name: 'read_file', description: 'Read a text file inside the repository (secrets files and ignored files are refused).',
    args: { path: 'repo-relative path', startLine: 'optional first line (1-based)', endLine: 'optional last line' },
    risk: () => 'read', describe: (a) => `read ${str(a['path']) ?? '?'}`,
    async run(a, ctx) {
      const p = str(a['path']);
      if (!p) return { ok: false, output: 'path is required' };
      const r = safeRepoPath(ctx.git.root, p);
      if ('error' in r) return { ok: false, output: r.error };
      if (isSensitivePath(r.rel)) return { ok: false, output: `${r.rel} looks like a credentials file and will not be read` };
      if (await ctx.git.ok(['check-ignore', '-q', '--', r.rel])) return { ok: false, output: `${r.rel} is ignored by .gitignore and will not be read` };
      if (ctx.settings.exclude.some((x) => new RegExp('^' + x.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(r.rel))) {
        return { ok: false, output: `${r.rel} is excluded by your configuration` };
      }
      let st;
      try { st = statSync(r.abs); } catch { return { ok: false, output: `${r.rel} does not exist` }; }
      if (!st.isFile()) return { ok: false, output: `${r.rel} is not a file` };
      if (st.size > 1_000_000) return { ok: false, output: `${r.rel} is too large (${st.size} bytes)` };
      const buf = readFileSync(r.abs);
      if (buf.subarray(0, 8000).includes(0)) return { ok: false, output: `${r.rel} looks binary` };
      const lines = buf.toString('utf8').split(/\r?\n/);
      const from = num(a['startLine'], 1, 1, lines.length);
      const to = num(a['endLine'], Math.min(lines.length, from + 399), from, lines.length);
      const body = lines.slice(from - 1, to).map((l, i) => `${from + i}: ${l}`).join('\n');
      return finish(ctx, `${r.rel} (lines ${from}-${to} of ${lines.length})\n${body}`);
    },
  },
  {
    name: 'search_files', description: 'Search tracked and untracked (non-ignored) files for a fixed string.',
    args: { query: 'text to search for', glob: 'optional pathspec, e.g. src/**/*.ts' },
    risk: () => 'read', describe: (a) => `git grep -F ${JSON.stringify(str(a['query']) ?? '')}`,
    async run(a, ctx) {
      const q = str(a['query']);
      if (!q) return { ok: false, output: 'query is required' };
      const spec = str(a['glob']);
      const excludes = ['.env*', '*.pem', '*.key', '*.p12', '*.pfx', 'id_rsa*', 'id_ed25519*', ...ctx.settings.exclude].map((x) => `:(exclude,glob)**/${x}`);
      const res = await ctx.git.raw(['grep', '-n', '-I', '-F', '--no-color', '--untracked', '--max-count=5', '-e', q, '--', spec ?? '.', ...excludes], { allowFail: true });
      if (res.code === 1 || !res.stdout.trim()) return { ok: true, output: '(no matches)' };
      if (res.code !== 0) return { ok: false, output: res.stderr.trim().split('\n')[0] ?? 'search failed' };
      return finish(ctx, res.stdout.split('\n').slice(0, 60).join('\n'));
    },
  },
  {
    name: 'git_add', description: 'Stage files. Use paths=["."] or all=true for everything.', args: { paths: 'list of repo-relative paths', all: 'true to stage everything' },
    risk: () => 'write',
    describe: (a) => (a['all'] === true ? 'git add -A' : `git add -A -- ${strList(a['paths']).join(' ')}`),
    async run(a, ctx) {
      if (a['all'] === true) { await add(ctx.git, 'all'); return { ok: true, output: 'staged everything' }; }
      const paths = strList(a['paths']);
      if (!paths.length) return { ok: false, output: 'paths is required' };
      for (const p of paths) {
        const r = p === '.' ? { rel: '.' } : safeRepoPath(ctx.git.root, p);
        if ('error' in r) return { ok: false, output: `${p}: ${r.error}` };
      }
      await add(ctx.git, paths);
      return { ok: true, output: `staged ${paths.join(', ')}` };
    },
  },
  {
    name: 'git_commit', description: 'Commit the staged changes with the given message.', args: { message: 'full commit message', amend: 'true to amend the last commit' },
    risk: () => 'write',
    describe: (a) => `git commit${a['amend'] === true ? ' --amend' : ''} -m ${JSON.stringify((str(a['message']) ?? '').split('\n')[0])}`,
    async run(a, ctx) {
      const message = str(a['message']);
      if (!message) return { ok: false, output: 'message is required' };
      const code = await commit(ctx.git, {
        message, amend: a['amend'] === true, noVerify: ctx.settings.noVerify, signoff: ctx.settings.signoff, toStderr: true,
      });
      return { ok: code === 0, output: code === 0 ? 'committed' : `git commit failed (exit ${code})` };
    },
  },
  {
    name: 'git_push', description: 'Push the current branch (never forced).', args: {},
    risk: () => 'remote',
    async describe(_a, ctx) {
      try { return (await planPush(ctx.git)).command.join(' '); } catch { return 'git push'; }
    },
    async run(_a, ctx) {
      const plan = await planPush(ctx.git);
      const code = await push(ctx.git, plan, true);
      return { ok: code === 0, output: code === 0 ? `pushed ${plan.branch}` : `git push failed (exit ${code})` };
    },
  },
  {
    name: 'git_reset', description: 'mode="unstage" (needs paths) removes files from the index; mode="soft_undo" undoes the last commit and keeps the changes staged. Hard resets are not available.',
    args: { mode: 'unstage | soft_undo', paths: 'paths for unstage' },
    risk: (a) => (a['mode'] === 'soft_undo' ? 'history' : 'write'),
    describe: (a) => (a['mode'] === 'soft_undo' ? 'git reset --soft HEAD~1' : `git reset -q -- ${strList(a['paths']).join(' ')}`),
    async run(a, ctx) {
      if (a['mode'] === 'soft_undo') {
        const c = await checkUndo(ctx.git);
        if (!c.ok) return { ok: false, output: c.reason ?? 'cannot undo' };
        await softUndo(ctx.git);
        return { ok: true, output: 'last commit undone; changes are staged' };
      }
      if (a['mode'] === 'unstage') {
        const paths = strList(a['paths']);
        if (!paths.length) return { ok: false, output: 'paths is required' };
        await unstage(ctx.git, paths);
        return { ok: true, output: `unstaged ${paths.join(', ')}` };
      }
      return { ok: false, output: 'unsupported mode (only unstage and soft_undo exist)' };
    },
  },
];

export function getTool(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name);
}

export function toolPromptSection(): string {
  return TOOLS.map((t) => {
    const args = Object.entries(t.args).map(([k, v]) => `${k}: ${v}`).join('; ');
    return `- ${t.name}${args ? `(${args})` : '()'}: ${t.description}`;
  }).join('\n');
}

// ---------------------------------------------------------------------------------------------
// approval
// ---------------------------------------------------------------------------------------------

export interface ApprovalPolicy {
  interactive: boolean;
  /** --yes */
  yes: boolean;
  /** tools approved without asking (settings.autoApprove; git_reset is filtered out) */
  autoApprove: ReadonlySet<string>;
  /** tools the user explicitly asked for with a flag (--push, undo command ...) */
  explicit: ReadonlySet<string>;
  confirm: (command: string, tool: ToolDef) => Promise<boolean>;
}

export function makePolicy(p: Omit<ApprovalPolicy, 'autoApprove'> & { autoApprove: string[] }): ApprovalPolicy {
  return { ...p, autoApprove: new Set(p.autoApprove.filter((n) => n !== 'git_reset')) };
}

export interface Authorization {
  allowed: boolean;
  reason?: string;
}

/**
 * Decide whether a tool may run. `--yes` is NOT "ignore all safety": it only bypasses the confirmations
 * that are designed to be bypassed (see Risk).
 */
export async function authorize(tool: ToolDef, args: Record<string, unknown>, ctx: ToolContext, policy: ApprovalPolicy): Promise<Authorization> {
  const risk = tool.risk(args);
  if (risk === 'read') return { allowed: true };
  const auto = policy.autoApprove.has(tool.name);
  const bypass =
    risk === 'write' ? policy.yes || auto
    : risk === 'remote' ? auto || (policy.yes && policy.explicit.has(tool.name))
    : policy.yes && policy.explicit.has(tool.name);
  if (bypass) return { allowed: true };
  if (!policy.interactive) {
    return { allowed: false, reason: `${tool.name} needs confirmation. Run interactively${risk === 'write' ? ' or pass --yes' : ''}.` };
  }
  const cmd = await tool.describe(args, ctx);
  return (await policy.confirm(cmd, tool)) ? { allowed: true } : { allowed: false, reason: 'declined by user' };
}

export async function executeTool(name: string, args: Record<string, unknown>, ctx: ToolContext, policy: ApprovalPolicy): Promise<ToolResult> {
  const tool = getTool(name);
  if (!tool) return { ok: false, output: `unknown tool "${name}"` };
  const auth = await authorize(tool, args, ctx, policy);
  if (!auth.allowed) return { ok: false, output: `not executed: ${auth.reason ?? 'denied'}` };
  try {
    return await tool.run(args, ctx);
  } catch (e) {
    return { ok: false, output: e instanceof Error ? e.message : String(e) };
  }
}
