import { scopeCandidate } from '../commit/format.js';
import type { ChatMessage } from '../providers/types.js';

export interface SplitGroup {
  /** short description of the commit's purpose (used as a hint for the message) */
  title: string;
  files: string[];
  type?: string | undefined;
  scope?: string | undefined;
}

export interface SplitFile {
  path: string;
  /** previous name for renames, staged together with the new one */
  oldPath?: string | undefined;
  add: number;
  del: number;
  status: string;
}

/** Pull a JSON value out of a model answer (fences, preambles, trailing chatter). */
export function extractJson(text: string): unknown {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(cleaned);
  const candidates = [fenced?.[1], cleaned];
  for (const c of candidates) {
    if (!c) continue;
    const start = c.search(/[[{]/);
    if (start < 0) continue;
    for (let end = c.length; end > start; end = c.lastIndexOf(c[start] === '{' ? '}' : ']', end - 1) + 1) {
      if (end <= start) break;
      try { return JSON.parse(c.slice(start, end)); } catch { /* try a shorter slice */ }
    }
  }
  return undefined;
}

function norm(p: string): string {
  return p.trim().replace(/^\.\//, '').replace(/\\/g, '/');
}

/**
 * Make an untrusted model plan safe: every changed file ends up in exactly one group, unknown files are dropped,
 * and there are at most `max` groups. Returns [] when nothing usable remains (caller falls back to the heuristic).
 */
export function normalizePlan(raw: unknown, allFiles: string[], max: number): SplitGroup[] {
  const known = new Map(allFiles.map((f) => [norm(f), f]));
  const arr: unknown[] = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { commits?: unknown }).commits) ? ((raw as { commits: unknown[] }).commits) : [];
  const seen = new Set<string>();
  const groups: SplitGroup[] = [];
  for (const g of arr) {
    if (!g || typeof g !== 'object') continue;
    const o = g as Record<string, unknown>;
    const files: string[] = [];
    for (const f of Array.isArray(o['files']) ? o['files'] : []) {
      const real = typeof f === 'string' ? known.get(norm(f)) : undefined;
      if (real !== undefined && !seen.has(real)) { seen.add(real); files.push(real); } // each file once, across and within groups
    }
    if (files.length === 0) continue;
    groups.push({
      title: typeof o['title'] === 'string' && o['title'].trim() ? o['title'].trim().slice(0, 120) : 'related changes',
      files,
      ...(typeof o['type'] === 'string' && o['type'] ? { type: o['type'].toLowerCase() } : {}),
      ...(typeof o['scope'] === 'string' && o['scope'] ? { scope: o['scope'] } : {}),
    });
  }
  if (groups.length === 0) return [];
  const leftover = allFiles.filter((f) => !seen.has(f));
  if (leftover.length) groups.push({ title: 'other changes', files: leftover });
  return capGroups(groups, max);
}

/** Merge the smallest tail groups so at most `max` remain. */
export function capGroups(groups: SplitGroup[], max: number): SplitGroup[] {
  const limit = Math.max(1, max);
  if (groups.length <= limit) return groups;
  const head = groups.slice(0, limit - 1);
  const tail = groups.slice(limit - 1);
  return [...head, { title: 'other changes', files: tail.flatMap((g) => g.files) }];
}

const DOC = /\.(md|mdx|rst|txt)$/i;
const LOCK = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|go\.sum|poetry\.lock|Gemfile\.lock|composer\.lock)$/;
const CONFIG = /(^|\/)(\.[^/]+rc(\.[a-z]+)?|[^/]+\.config\.[a-z]+|tsconfig[^/]*\.json|package\.json|Dockerfile|\.github\/.+|\.gitignore)$/;
const TEST = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[a-z]+$/;

/** Deterministic fallback: docs, tests, config/lockfiles and one group per top-level area. */
export function heuristicPlan(files: string[], max: number): SplitGroup[] {
  const buckets = new Map<string, SplitGroup>();
  const put = (key: string, title: string, f: string, type?: string, scope?: string): void => {
    const g = buckets.get(key) ?? { title, files: [], ...(type ? { type } : {}), ...(scope ? { scope } : {}) };
    g.files.push(f);
    buckets.set(key, g);
  };
  for (const f of files) {
    if (DOC.test(f)) put('docs', 'documentation', f, 'docs');
    else if (TEST.test(f)) put('tests', 'tests', f, 'test');
    else if (LOCK.test(f) || CONFIG.test(f)) put('config', 'project configuration and dependencies', f, 'chore');
    else {
      const sc = scopeCandidate(f);
      put(`src:${sc}`, sc ? `changes in ${sc}` : 'changes in the project root', f, undefined, sc || undefined);
    }
  }
  return capGroups([...buckets.values()], max);
}

export interface SplitPromptOptions {
  max: number;
  language: string;
  types: string[];
  hint?: string | undefined;
}

export function buildSplitMessages(files: SplitFile[], diffExcerpt: string, o: SplitPromptOptions): ChatMessage[] {
  const sys = [
    'You split a developer\'s uncommitted changes into a small number of logical, reviewable commits.',
    `Create between 1 and ${o.max} commits. Each file belongs to exactly one commit. Group files that serve one purpose (a feature with its tests, a refactor, a dependency bump, documentation).`,
    'Keep unrelated changes apart. Do not create a commit for a single trivial file unless it is truly unrelated.',
    `For each commit give: "title" (what and why, max 12 words), "type" (one of ${o.types.join(', ')}), optional "scope", and "files" (exact paths from the list).`,
    /^(en|english)$/i.test(o.language) ? '' : `Write titles in ${o.language}.`,
    'Order commits so that earlier ones do not depend on later ones (foundations first, tests and docs last).',
    'Answer with JSON only, no prose: {"commits":[{"title":"...","type":"feat","scope":"auth","files":["a.ts","b.ts"]}]}',
  ].filter(Boolean).join('\n');
  const list = files.map((f) => `${f.status} ${f.path}${f.oldPath ? ` (renamed from ${f.oldPath})` : ''} (+${f.add} -${f.del})`).join('\n');
  const usr = [
    ...(o.hint ? [`Note from the author: ${o.hint}`] : []),
    `Changed files (${files.length}):\n${list}`,
    ...(diffExcerpt ? [`Diff excerpt:\n${diffExcerpt}`] : []),
  ].join('\n\n');
  return [{ role: 'system', content: sys }, { role: 'user', content: usr }];
}

/** Paths to stage for a group (renames need both sides so git sees a rename). */
export function pathsFor(group: SplitGroup, files: SplitFile[]): string[] {
  const out = new Set<string>();
  for (const p of group.files) {
    out.add(p);
    const f = files.find((x) => x.path === p);
    if (f?.oldPath) out.add(f.oldPath);
  }
  return [...out];
}
