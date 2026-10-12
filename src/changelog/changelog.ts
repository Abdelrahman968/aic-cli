import { RX_PARSE } from '../commit/format.js';
import type { RangeCommit } from '../git/history.js';

export interface ParsedCommit {
  hash: string;
  type: string;
  scope: string;
  breaking: boolean;
  /** text of the BREAKING CHANGE footer, when present */
  breakingNote: string;
  subject: string;
  /** false for commits that do not follow Conventional Commits */
  conventional: boolean;
  author: string;
  date: string;
}

const KNOWN = new Set(['feat', 'fix', 'perf', 'refactor', 'docs', 'style', 'test', 'build', 'ci', 'chore', 'revert']);

export function parseCommit(c: RangeCommit): ParsedCommit {
  const m = RX_PARSE.exec(c.subject);
  const footer = /^BREAKING[ -]CHANGE:\s*([\s\S]*?)(?:\n\n|$)/m.exec(c.body);
  const type = m?.groups?.['type']?.toLowerCase() ?? '';
  const conventional = Boolean(m) && KNOWN.has(type);
  const bang = Boolean(m?.groups?.['bang']);
  return {
    hash: c.hash,
    type: conventional ? type : '',
    scope: conventional ? (m?.groups?.['scope'] ?? '').trim() : '',
    breaking: conventional && (bang || Boolean(footer)),
    breakingNote: footer?.[1]?.trim().replace(/\s*\n\s*/g, ' ') ?? '',
    subject: conventional ? (m?.groups?.['subj'] ?? '').trim() : c.subject.trim(),
    conventional,
    author: c.author,
    date: c.date,
  };
}

export interface SectionDef {
  id: string;
  title: string;
  types: string[];
  /** hidden unless `all` is set (chores are noise in release notes) */
  hidden?: boolean;
}

export const SECTIONS: SectionDef[] = [
  { id: 'feat', title: 'Features', types: ['feat'] },
  { id: 'fix', title: 'Bug Fixes', types: ['fix'] },
  { id: 'perf', title: 'Performance', types: ['perf'] },
  { id: 'refactor', title: 'Refactoring', types: ['refactor'] },
  { id: 'docs', title: 'Documentation', types: ['docs'] },
  { id: 'test', title: 'Tests', types: ['test'] },
  { id: 'build', title: 'Build & CI', types: ['build', 'ci'] },
  { id: 'revert', title: 'Reverts', types: ['revert'] },
  { id: 'chore', title: 'Chores', types: ['chore', 'style'], hidden: true },
];

export interface ChangelogOptions {
  /** heading label, e.g. "1.2.0"; omitted = "Unreleased" */
  version?: string | undefined;
  date?: string | undefined;
  /** include chores/style and non-conventional commits' hidden types */
  all?: boolean | undefined;
  /** show short commit hashes */
  hashes?: boolean | undefined;
  /** compare link base, e.g. https://github.com/o/r (no trailing slash) */
  compare?: { url: string; from: string; to: string } | undefined;
}

export interface ChangelogModel {
  breaking: ParsedCommit[];
  sections: Array<{ def: SectionDef; commits: ParsedCommit[] }>;
  other: ParsedCommit[];
  total: number;
}

/** Release commits and fixups are not interesting to readers. */
export function isNoise(c: ParsedCommit): boolean {
  return /^(release|bump version|version bump)\b/i.test(c.subject) || (c.type === 'chore' && /^release\b/i.test(c.scope + ' ' + c.subject));
}

export function buildModel(commits: RangeCommit[], o: ChangelogOptions = {}): ChangelogModel {
  const parsed = commits.map(parseCommit).filter((c) => !isNoise(c));
  const breaking = parsed.filter((c) => c.breaking);
  const sections = SECTIONS.filter((d) => !d.hidden || o.all).map((def) => ({ def, commits: parsed.filter((c) => c.conventional && def.types.includes(c.type)) })).filter((s) => s.commits.length > 0);
  const other = parsed.filter((c) => !c.conventional);
  return { breaking, sections, other, total: parsed.length };
}

function line(c: ParsedCommit, o: ChangelogOptions): string {
  const scope = c.scope ? `**${c.scope}:** ` : '';
  const hash = o.hashes !== false && c.hash ? ` (${c.hash.slice(0, 7)})` : '';
  return `- ${scope}${c.subject}${hash}`;
}

export function renderSection(model: ChangelogModel, o: ChangelogOptions = {}): string {
  const date = o.date ?? '';
  const label = o.version ? `${o.compare ? `[${o.version}](${o.compare.url}/compare/${o.compare.from}...${o.compare.to})` : o.version}${date ? ` - ${date}` : ''}` : 'Unreleased';
  const out: string[] = [`## ${label}`, ''];
  if (model.breaking.length) {
    out.push('### BREAKING CHANGES', '');
    for (const c of model.breaking) out.push(`- ${c.scope ? `**${c.scope}:** ` : ''}${c.breakingNote || c.subject}${o.hashes !== false && c.hash ? ` (${c.hash.slice(0, 7)})` : ''}`);
    out.push('');
  }
  for (const s of model.sections) {
    out.push(`### ${s.def.title}`, '');
    for (const c of s.commits) out.push(line(c, o));
    out.push('');
  }
  if (model.other.length) {
    out.push('### Other changes', '');
    for (const c of model.other) out.push(line(c, o));
    out.push('');
  }
  if (model.total === 0 || (!model.breaking.length && !model.sections.length && !model.other.length)) out.push('_No notable changes._', '');
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

export function renderJson(model: ChangelogModel, o: ChangelogOptions = {}): string {
  const strip = (c: ParsedCommit): Record<string, unknown> => ({ hash: c.hash, type: c.type, scope: c.scope, subject: c.subject, breaking: c.breaking, author: c.author, date: c.date });
  return JSON.stringify({
    version: o.version ?? null,
    date: o.date ?? null,
    breaking: model.breaking.map(strip),
    sections: model.sections.map((s) => ({ title: s.def.title, commits: s.commits.map(strip) })),
    other: model.other.map(strip),
  }, null, 2);
}

/** Insert a new release section under the title (and intro) of an existing CHANGELOG, newest first. */
export function prependChangelog(existing: string | undefined, section: string): string {
  const body = section.trimEnd() + '\n';
  if (!existing || !existing.trim()) return `# Changelog\n\n${body}`;
  const lines = existing.replace(/\r\n/g, '\n').split('\n');
  const firstRelease = lines.findIndex((l) => /^## /.test(l));
  if (firstRelease < 0) return existing.trimEnd() + '\n\n' + body;
  return [...lines.slice(0, firstRelease), ...body.split('\n'), ...lines.slice(firstRelease)].join('\n').replace(/\n{3,}/g, '\n\n');
}

/** Does the file already contain a section for this version? */
export function hasVersion(existing: string, version: string): boolean {
  const v = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^## \\[?${v}\\]?(\\s|\\(|$)`, 'm').test(existing);
}

/** Turn git remote URLs into a web URL usable for compare links. */
export function webUrlFromRemote(remote: string): string | undefined {
  const t = remote.trim();
  const ssh = /^git@([^:]+):(.+?)(?:\.git)?$/.exec(t);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  const http = /^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(t);
  if (http) return `https://${http[1]}/${http[2]}`;
  return undefined;
}

export function releaseNotesPrompt(sectionMarkdown: string, o: { language: string; project: string; version?: string | undefined }): Array<{ role: 'system' | 'user'; content: string }> {
  const lang = /^(en|english)$/i.test(o.language) ? '' : `Write in ${o.language}. `;
  return [
    { role: 'system', content: [
      'You write release notes for end users from a list of commits.',
      lang + 'Output Markdown only, no preamble.',
      'Start with one or two sentences summarizing the release, then a "Highlights" list of the 3-6 most important user-visible changes in plain language, then keep any "BREAKING CHANGES" section verbatim.',
      'Use only the information in the list. Never invent features, numbers or dates.',
    ].join('\n') },
    { role: 'user', content: `Project: ${o.project}${o.version ? `\nVersion: ${o.version}` : ''}\n\nCommits:\n${sectionMarkdown}` },
  ];
}

/** Replace an existing "## Unreleased" section (up to the next "## ") with a fresh one. Returns undefined when there is none. */
export function replaceUnreleased(existing: string, section: string): string | undefined {
  const lines = existing.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => /^## Unreleased\b/i.test(l));
  if (start < 0) return undefined;
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end < 0) end = lines.length;
  return [...lines.slice(0, start), ...section.trimEnd().split('\n'), '', ...lines.slice(end)].join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}
