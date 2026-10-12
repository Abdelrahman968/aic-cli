import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { AicError, ExitCode } from '../utils/errors.js';

export function readJsonFile(path: string): unknown | undefined {
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new AicError(`Invalid JSON in ${path}`, ExitCode.GENERAL, {
      details: e instanceof Error ? e.message : String(e),
      try: [`aic config edit`, `aic config reset`],
    });
  }
}

/** Write JSON atomically (temp file + rename). `secret` files get mode 0600 where the OS supports it. */
export function writeJsonFile(path: string, data: unknown, opts: { secret?: boolean } = {}): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode: opts.secret ? 0o600 : 0o644 });
  renameSync(tmp, path);
  if (opts.secret) {
    try { chmodSync(path, 0o600); } catch { /* Windows: ACLs are per-user by default */ }
  }
}
