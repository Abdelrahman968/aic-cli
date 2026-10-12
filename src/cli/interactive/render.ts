import { ui } from '../ui/output.js';
import type { FileStat } from '../../git/diff.js';
import type { ChangedFile } from '../../git/status.js';
import type { Finding } from '../../security/secret-scanner.js';
import type { GeneratedMessage } from '../../commit/generate.js';
import { getBang, getScope, getType, firstLine } from '../../commit/format.js';

export function renderStat(files: FileStat[]): void {
  const t = ui.theme;
  const add = files.reduce((n, f) => n + f.add, 0);
  const del = files.reduce((n, f) => n + f.del, 0);
  const shown = files.slice(0, 12);
  const lines = shown.map((f) => (f.binary ? `${t.mute('bin')}  ${f.path}` : `${t.ok('+' + f.add)} ${t.err('-' + f.del)}  ${f.path}`));
  if (files.length > shown.length) lines.push(t.mute(`… and ${files.length - shown.length} more files`));
  ui.card('Staged changes', lines, { tag: t.mute(`${files.length} file${files.length === 1 ? '' : 's'}  `) + t.ok('+' + add) + ' ' + t.err('-' + del) });
}

export function renderFindings(findings: Finding[]): void {
  const t = ui.theme;
  ui.write('');
  ui.write('  ' + t.warn(`${t.g.warn} Potential secret${findings.length === 1 ? '' : 's'} detected`));
  for (const f of findings.slice(0, 12)) {
    ui.write('');
    ui.write('    ' + t.mute('File:') + ' ' + f.file);
    if (f.line !== undefined) ui.write('    ' + t.mute('Line:') + ' ' + f.line);
    ui.write('    ' + t.mute('Type:') + ' ' + f.type);
  }
  if (findings.length > 12) ui.write('\n    ' + t.mute(`… and ${findings.length - 12} more`));
  ui.write('');
  ui.write('    ' + t.mute('The values are never printed or sent anywhere. Remove them, or use --no-scan only if you understand the risk.'));
}

export function colorizeHeader(line: string): string {
  const t = ui.theme;
  const m = /^(\w+)(\([^)]*\))?(!)?:\s?(.*)$/.exec(line);
  if (!m) return line;
  return t.type(m[1] as string) + (m[2] ? t.scope(m[2]) : '') + (m[3] ? t.errBold('!') : '') + ': ' + t.bold(m[4] ?? '');
}

export function renderMessage(g: GeneratedMessage): void {
  const t = ui.theme;
  const lines = g.message.split('\n').map((l, i) => (i === 0 ? colorizeHeader(l) : l.startsWith('- ') ? t.mute('- ') + l.slice(2) : l));
  const m = g.meta;
  const meta = `${m.tokens} tok ${t.g.mid} ${m.seconds.toFixed(1)}s${m.tokensPerSecond ? ` ${t.g.mid} ${m.tokensPerSecond.toFixed(1)} tok/s` : ''} ${t.g.mid} ${m.model}${m.attempt > 1 ? ` ${t.g.mid} attempt ${m.attempt}` : ''}`;
  ui.write('');
  ui.card('Suggested commit', lines, { footer: t.mute(meta) });
  for (const p of g.problems) ui.warn(p);
  if (g.problems.length) ui.dim('Edit it with e, or regenerate with r.');
}

export function renderStatus(files: ChangedFile[], branch: string, extra?: string): void {
  const t = ui.theme;
  ui.write('');
  ui.kv([['branch', t.scope(branch) + (extra ? '  ' + t.mute(extra) : '')]]);
  ui.write('');
  if (files.length === 0) { ui.info(t.ok(`${t.g.ok} working tree clean`)); return; }
  const staged = files.filter((f) => f.staged);
  const unstaged = files.filter((f) => !f.staged && !f.untracked);
  const untracked = files.filter((f) => f.untracked);
  const group = (title: string, list: ChangedFile[]): void => {
    if (!list.length) return;
    ui.write('  ' + t.bold(`${title} (${list.length})`));
    for (const f of list.slice(0, 30)) ui.write(`    ${t.mute(f.code)}  ${f.path}${f.dirty && f.staged ? t.mute('  (+ unstaged edits)') : ''}`);
    if (list.length > 30) ui.write('    ' + t.mute(`… ${list.length - 30} more`));
    ui.write('');
  };
  group('Staged', staged);
  group('Modified', unstaged);
  group('Untracked', untracked);
}

export function summaryOf(message: string): string {
  const h = firstLine(message);
  return `${getType(message)}${getScope(message) ? `(${getScope(message)})` : ''}${getBang(message) ? '!' : ''} ${h}`.trim();
}

export function printDiffColored(diff: string): void {
  const t = ui.theme;
  for (const l of diff.split('\n')) {
    if (l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff --git')) process.stderr.write(t.bold(l) + '\n');
    else if (l.startsWith('@@')) process.stderr.write(t.accent(l) + '\n');
    else if (l.startsWith('+')) process.stderr.write(t.ok(l) + '\n');
    else if (l.startsWith('-')) process.stderr.write(t.err(l) + '\n');
    else process.stderr.write(l + '\n');
  }
}
