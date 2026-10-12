import { basename } from 'node:path';
import { run, runInherit, type RunResult } from '../utils/process.js';
import { GitError } from '../utils/errors.js';

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export interface GitRunOptions {
  input?: string;
  /** Do not throw on a non-zero exit code. */
  allowFail?: boolean;
}

/** Thin, injection-safe wrapper around the git binary (no shell, args are an array). */
export class Git {
  constructor(readonly root: string) {}

  get name(): string { return basename(this.root); }

  private base(): string[] {
    return ['-C', this.root, '-c', 'core.quotepath=false', '-c', 'color.ui=false'];
  }

  async raw(args: string[], opts: GitRunOptions = {}): Promise<RunResult> {
    try {
      const res = await run('git', [...this.base(), ...args], { ...(opts.input !== undefined ? { input: opts.input } : {}), env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C.UTF-8' } });
      if (res.code !== 0 && !opts.allowFail) {
        const first = args[0] ?? 'command';
        throw new GitError(`git ${first} failed`, { details: (res.stderr || res.stdout).trim().split('\n').slice(0, 6).join('\n') });
      }
      return res;
    } catch (e) {
      if (e instanceof GitError) throw e;
      throw gitMissing(e);
    }
  }

  /** stdout of a git command, trailing newline removed. */
  async out(args: string[], opts: GitRunOptions = {}): Promise<string> {
    const r = await this.raw(args, opts);
    return r.stdout.replace(/\r?\n$/, '');
  }

  /** true when the command exits 0 */
  async ok(args: string[]): Promise<boolean> {
    const r = await this.raw(args, { allowFail: true });
    return r.code === 0;
  }

  /** Run with the terminal attached (commit -e, push progress, hooks). */
  async inherit(args: string[], opts: { toStderr?: boolean } = {}): Promise<number> {
    try {
      return await runInherit('git', [...this.base(), ...args], { stdoutToStderr: opts.toStderr ?? false });
    } catch (e) {
      throw gitMissing(e);
    }
  }
}

export function gitMissing(e: unknown): GitError {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') {
    return new GitError('git was not found in PATH', { causes: ['Git is not installed', 'Git is installed but not on PATH'], try: ['https://git-scm.com/downloads'] });
  }
  return new GitError(e instanceof Error ? e.message : String(e), { cause: e });
}

/** Resolve the repository root for `cwd`. */
export async function openRepo(cwd: string = process.cwd()): Promise<Git> {
  let res: RunResult;
  try {
    res = await run('git', ['rev-parse', '--show-toplevel'], { cwd });
  } catch (e) {
    throw gitMissing(e);
  }
  const root = res.stdout.trim();
  if (res.code !== 0 || !root) {
    throw new GitError('Not inside a Git repository', { details: cwd, try: ['cd into your project', 'git init'] });
  }
  return new Git(root);
}

export async function findRepoRoot(cwd: string = process.cwd()): Promise<string | undefined> {
  try {
    return (await openRepo(cwd)).root;
  } catch {
    return undefined;
  }
}
