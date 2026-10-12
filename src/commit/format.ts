/**
 * Conventional Commit parsing, clean-up and validation.
 * Port of the message logic in aic.ps1 (Normalize-Message, Test-Message, Set-Prefix, ...).
 */

export const RX_PARSE = /^(?<type>[A-Za-z]+)(?:\((?<scope>[^)\r\n]*)\))?(?<bang>!)?:\s*(?<subj>.*)$/;
const RX_HEADER_LINE = /^[A-Za-z]+(\([^)]*\))?!?:\s*\S/;
const TRIM_CHARS = new Set(['`', '"', "'", ' ']);
const RX_EMOJI = /^(?:[\uD83C-\uD83E][\uDC00-\uDFFF]|[\u2300-\u23FF\u2600-\u27BF\u2B00-\u2BFF]\uFE0F?)+\s*/;
const RX_FOOTER = /^(BREAKING[ -]CHANGE|Refs?|Closes|Fixes|Co-authored-by|Signed-off-by)\b/;

/** gitmoji per type; U+FE0F forces emoji presentation of a text-style symbol */
const EMOJI: Record<string, string> = {
  feat: '\u2728', fix: '\u{1F41B}', refactor: '\u267B\uFE0F', perf: '\u26A1', docs: '\u{1F4DD}', style: '\u{1F484}',
  test: '\u2705', build: '\u{1F4E6}', ci: '\u{1F477}', chore: '\u{1F527}', revert: '\u23EA',
};

export function emojiFor(type: string): string {
  return EMOJI[type] ?? '';
}

export function trimQuotes(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && TRIM_CHARS.has(s[a] as string)) a++;
  while (b > a && TRIM_CHARS.has(s[b - 1] as string)) b--;
  return s.slice(a, b);
}

export interface FormatOptions {
  emoji: boolean;
  bullets: number;
  ref?: string | undefined;
}

/** What the user forced (flags or menu). Applied even if a small model ignored the prompt. */
export interface Forced {
  type?: string | undefined;
  scope?: string | undefined;
  noScope?: boolean | undefined;
  breaking?: boolean | undefined;
}

export function joinHeader(type: string, scope: string, bang: boolean, subject: string, emoji: boolean): string {
  const em = emoji ? emojiFor(type) : '';
  const subj = em ? `${em} ${subject.replace(RX_EMOJI, '')}` : subject;
  return `${type}${scope ? `(${scope})` : ''}${bang ? '!' : ''}: ${subj}`;
}

export function firstLine(msg: string): string {
  return msg.split(/\r?\n/, 1)[0] ?? '';
}

export function getType(msg: string): string {
  const m = RX_PARSE.exec(firstLine(msg));
  return m?.groups?.['type']?.toLowerCase() ?? '';
}

export function getScope(msg: string): string {
  const m = RX_PARSE.exec(firstLine(msg));
  return m?.groups?.['scope'] ?? '';
}

export function getBang(msg: string): boolean {
  return Boolean(RX_PARSE.exec(firstLine(msg))?.groups?.['bang']);
}

/** Rewrite type / scope / "!" of the header without touching subject or body. */
export function setPrefix(msg: string, set: { type?: string; scope?: string; bang?: boolean }, emoji: boolean): string {
  const nl = msg.indexOf('\n');
  const first = nl >= 0 ? msg.slice(0, nl) : msg;
  const rest = nl >= 0 ? msg.slice(nl) : '';
  const m = RX_PARSE.exec(first);
  const g = m?.groups;
  const type = set.type ?? (m ? (g?.['type'] ?? '').toLowerCase() : 'chore');
  const scope = set.scope ?? (m && g?.['scope'] !== undefined ? g['scope'] : '');
  const bang = set.bang ?? (m ? Boolean(g?.['bang']) : false);
  const subject = m ? (g?.['subj'] ?? '') : first;
  return joinHeader(type, scope, bang, subject, emoji) + rest;
}

/** Models love fences, <think> blocks, preambles, capitals and trailing dots: tidy all of it. */
export function normalizeMessage(raw: string, fmt: FormatOptions, forced: Forced = {}): string {
  let m = raw.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/<think>[\s\S]*$/, '');
  m = m.trim().replace(/^```[A-Za-z]*\s*/, '').replace(/\s*```\s*$/, '').trim();
  if (!m) return '';
  const lines = m.split(/\r?\n/);
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    if (RX_HEADER_LINE.test(trimQuotes(lines[i] as string))) { start = i; break; }
  }
  let hdr = trimQuotes(lines[start] as string);
  const pm = RX_PARSE.exec(hdr);
  if (pm?.groups) {
    let subj = trimQuotes(pm.groups['subj'] ?? '').replace(/[. ]+$/, '');
    if (/^[A-Z][a-z]+(\s|$)/.test(subj)) subj = subj.charAt(0).toLowerCase() + subj.slice(1); // "Add x" -> "add x"
    const scope = pm.groups['scope'] !== undefined ? pm.groups['scope'].trim() : '';
    hdr = joinHeader((pm.groups['type'] ?? '').toLowerCase(), scope, Boolean(pm.groups['bang']), subj, fmt.emoji);
  }
  const bullets: string[] = [];
  const footers: string[] = [];
  for (const l of lines.slice(start + 1)) {
    let t = l.trim();
    if (!t) continue;
    if (RX_FOOTER.test(t)) { footers.push(t); continue; }
    t = t.replace(/^[*\u2022]\s+/, '- ');
    if (!/^-\s/.test(t)) t = `- ${t}`;
    bullets.push(t);
  }
  const kept = fmt.bullets === 0 ? [] : bullets.slice(0, fmt.bullets);
  if (fmt.ref && !footers.some((f) => f.includes(fmt.ref as string))) footers.push(`Refs: ${fmt.ref}`);
  let out = hdr;
  if (kept.length) out += '\n\n' + kept.join('\n');
  if (footers.length) out += '\n\n' + footers.join('\n');

  const set: { type?: string; scope?: string; bang?: boolean } = {};
  if (forced.type) set.type = forced.type;
  if (forced.noScope) set.scope = '';
  else if (forced.scope) set.scope = forced.scope;
  if (forced.breaking) set.bang = true;
  if (Object.keys(set).length || fmt.emoji) out = setPrefix(out, set, fmt.emoji);
  return out;
}

export function strictRegex(types: string[]): RegExp {
  const alt = types.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(`^(${alt})(\\([^)\\r\\n]+\\))?!?: \\S.*$`);
}

export interface ValidateOptions {
  types: string[];
  scopes: string[];
  subjectMax: number;
}

/** Returns a list of problems (empty = valid). */
export function validateMessage(msg: string, o: ValidateOptions): string[] {
  const problems: string[] = [];
  const first = firstLine(msg);
  if (!strictRegex(o.types).test(first)) problems.push("header is not 'type(scope): subject'");
  else if ([...first].length > o.subjectMax) problems.push(`subject line is ${[...first].length} chars (max ${o.subjectMax})`);
  const scope = RX_PARSE.exec(first)?.groups?.['scope'];
  if (o.scopes.length && scope && !o.scopes.includes(scope)) problems.push(`scope '${scope}' is not one of: ${o.scopes.join(', ')}`);
  return problems;
}

// ---------------------------------------------------------------------------------------------
// scope hints
// ---------------------------------------------------------------------------------------------

const GENERIC_DIRS = new Set(['src', 'source', 'app', 'apps', 'lib', 'libs', 'packages', 'pkg', 'internal', 'cmd']);

/** "src/app/dashboard/page.tsx" -> "dashboard" ('' for files at the top level) */
export function scopeCandidate(path: string): string {
  const seg = path.split('/');
  let i = 0;
  while (i < seg.length - 1 && GENERIC_DIRS.has((seg[i] as string).toLowerCase())) i++;
  return i < seg.length - 1 ? (seg[i] as string).replace(/[^A-Za-z0-9._-]/g, '').toLowerCase() : '';
}

export function scopeHint(paths: string[]): string {
  const uniq = [...new Set(paths.map(scopeCandidate))];
  return uniq.length === 1 && uniq[0] ? uniq[0] : '';
}

/** Most common scope candidates in a file list (for `aic init`). */
export function inferScopes(paths: string[], limit = 12): string[] {
  const counts = new Map<string, number>();
  for (const p of paths) {
    const c = scopeCandidate(p);
    if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([k]) => k);
}
