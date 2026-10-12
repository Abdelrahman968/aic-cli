import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { Git } from '../git/exec.js';
import { GitError } from '../utils/errors.js';

export const HOOK_NAME = 'prepare-commit-msg';
export const HOOK_MARKER = '# aic-managed-hook v1';

/**
 * The hook must never block a commit: it exits 0 whatever happens, only runs when `aic` is installed,
 * and can be switched off per command with AIC_HOOK_DISABLE=1.
 */
export function hookScript(): string {
  return [
    '#!/bin/sh',
    HOOK_MARKER,
    '# Writes an AI-generated commit message into the editor. Remove with: aic hook uninstall',
    '[ -n "$AIC_HOOK_DISABLE" ] && exit 0',
    'command -v aic >/dev/null 2>&1 || exit 0',
    'aic hook run "$@" </dev/null || true',
    'exit 0',
    '',
  ].join('\n');
}

/** git commit sources that already carry a message the user chose. */
const SKIP_SOURCES = new Set(['message', 'merge', 'squash', 'commit']);

export function shouldSkipSource(source: string | undefined): boolean {
  return source !== undefined && SKIP_SOURCES.has(source);
}

/** The message file only holds git's comment template (or nothing) when there is nothing of the user's to protect. */
export function isBlankMessage(content: string): boolean {
  return content.split(/\r?\n/).every((l) => l.trim() === '' || l.startsWith('#'));
}

/** Put the generated message first and keep git's comment block below it. */
export function composeMessageFile(generated: string, existing: string): string {
  const comments = existing.replace(/\r\n/g, '\n').replace(/^\n+/, '');
  return generated.trimEnd() + '\n' + (comments ? '\n' + comments : '');
}

export async function hooksDir(git: Git): Promise<string> {
  const p = (await git.out(['rev-parse', '--git-path', 'hooks'])).trim();
  return isAbsolute(p) ? p : resolve(git.root, p);
}

export type HookState = 'not-installed' | 'installed' | 'foreign';

export interface HookStatus {
  state: HookState;
  path: string;
  dir: string;
  /** a custom core.hooksPath is configured */
  customPath: boolean;
}

export async function hookStatus(git: Git): Promise<HookStatus> {
  const dir = await hooksDir(git);
  const path = join(dir, HOOK_NAME);
  const customPath = (await git.out(['config', '--get', 'core.hooksPath'], { allowFail: true })).trim().length > 0;
  if (!existsSync(path)) return { state: 'not-installed', path, dir, customPath };
  const content = readFileSync(path, 'utf8');
  return { state: content.includes(HOOK_MARKER) ? 'installed' : 'foreign', path, dir, customPath };
}

export interface InstallResult {
  path: string;
  /** an existing foreign hook was moved here */
  backup?: string;
  alreadyInstalled: boolean;
}

export async function installHook(git: Git, opts: { force?: boolean } = {}): Promise<InstallResult> {
  const st = await hookStatus(git);
  if (st.state === 'installed') {
    writeFileSync(st.path, hookScript(), { mode: 0o755 });
    try { chmodSync(st.path, 0o755); } catch { /* Windows */ }
    return { path: st.path, alreadyInstalled: true };
  }
  let backup: string | undefined;
  if (st.state === 'foreign') {
    if (!opts.force) {
      throw new GitError(`A ${HOOK_NAME} hook already exists and was not created by AIC`, {
        details: st.path,
        try: ['aic hook install --force   (the old hook is kept as .aic-backup)', 'Call `aic hook run "$@"` from your existing hook yourself'],
      });
    }
    backup = `${st.path}.aic-backup`;
    if (existsSync(backup)) throw new GitError(`${backup} already exists`, { try: ['Move or delete it, then retry'] });
    renameSync(st.path, backup);
  }
  mkdirSync(dirname(st.path), { recursive: true });
  writeFileSync(st.path, hookScript(), { mode: 0o755 });
  try { chmodSync(st.path, 0o755); } catch { /* Windows */ }
  return { path: st.path, alreadyInstalled: false, ...(backup ? { backup } : {}) };
}

export interface UninstallResult {
  removed: boolean;
  restored?: string;
}

export async function uninstallHook(git: Git): Promise<UninstallResult> {
  const st = await hookStatus(git);
  if (st.state === 'not-installed') return { removed: false };
  if (st.state === 'foreign') throw new GitError(`The ${HOOK_NAME} hook was not created by AIC, so it was left alone`, { details: st.path });
  unlinkSync(st.path);
  const backup = `${st.path}.aic-backup`;
  if (existsSync(backup)) {
    renameSync(backup, st.path);
    return { removed: true, restored: st.path };
  }
  return { removed: true };
}
