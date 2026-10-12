import { spawn } from 'node:child_process';
import { delimiter, join } from 'node:path';
import { accessSync, constants } from 'node:fs';

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface RunOptions {
  cwd?: string;
  input?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Run a program without a shell. Never throws on non-zero exit; throws only when it cannot spawn. */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      signal: opts.signal,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs) timer = setTimeout(() => child.kill(), opts.timeoutMs);
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.on('error', (e) => { if (timer) clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), code: code ?? 1 });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(opts.input);
  });
}

/** Run a program with inherited stdio (for git commit -e, push progress, ...). Resolves with exit code. */
export function runInherit(cmd: string, args: string[], opts: { cwd?: string; stdoutToStderr?: boolean } = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      stdio: ['inherit', opts.stdoutToStderr ? process.stderr : 'inherit', 'inherit'],
      windowsHide: false,
    });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

/** Locate an executable on PATH (cross-platform, honours PATHEXT on Windows). */
export function which(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const pathVar = env['PATH'] ?? env['Path'] ?? '';
  const exts = process.platform === 'win32' ? (env['PATHEXT'] ?? '.EXE;.CMD;.BAT;.COM').split(';') : [''];
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = join(dir, name + ext);
      try {
        accessSync(full, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
        return full;
      } catch { /* keep looking */ }
    }
  }
  return undefined;
}
