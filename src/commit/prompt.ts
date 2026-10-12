import type { ChatMessage } from '../providers/types.js';

export interface CommitPromptContext {
  branch: string | undefined;
  recent: string[];
  scopeHint: string;
  stat: string;
  diff: string;
}

export interface CommitPromptOptions {
  types: string[];
  scopes: string[];
  bullets: number;
  language: string;
  subjectMax: number;
  instructions: string;
  /** forced by flags / menu */
  type?: string | undefined;
  scope?: string | undefined;
  noScope?: boolean | undefined;
  hint?: string | undefined;
  model: string;
  /** feedback from a failed format check, appended on retries */
  note?: string | undefined;
}

export function buildCommitMessages(ctx: CommitPromptContext, o: CommitPromptOptions): ChatMessage[] {
  const sys: string[] = [];
  sys.push('You are an expert developer who writes git commit messages.');
  sys.push('Use Conventional Commits: type(scope): subject');
  sys.push(`type is one of: ${o.types.join(', ')}.`);
  sys.push(`Subject: imperative mood, lowercase, no trailing period, max ${o.subjectMax} characters.`);
  if (o.bullets > 0) sys.push(`For non-trivial changes add a blank line, then up to ${o.bullets} bullets ("- ") explaining what changed and why.`);
  else sys.push('Output the subject line only: no body, no bullets.');
  sys.push('Describe only what is visible in the diff. Never invent details.');
  if (!/^(en|english)$/i.test(o.language)) sys.push(`Write the subject and bullets in ${o.language}. Keep the type and scope in English.`);
  if (o.type) sys.push(`The type MUST be: ${o.type}`);
  if (o.noScope) sys.push('Do not use a scope.');
  else if (o.scope) sys.push(`The scope MUST be: ${o.scope}`);
  else if (o.scopes.length) sys.push(`Allowed scopes: ${o.scopes.join(', ')}. Use exactly one of them, or omit the scope if none fits.`);
  if (o.instructions.trim()) sys.push(`Additional project instructions: ${o.instructions.trim()}`);
  sys.push('Output ONLY the commit message: no markdown fences, no quotes, no preamble.');
  sys.push('');
  sys.push('Example:');
  sys.push('fix(api): return 404 when the user does not exist');
  if (o.bullets > 0) {
    sys.push('');
    sys.push('- throw NotFoundError instead of returning null');
    sys.push('- add a test for the missing-user case');
  }

  const usr: string[] = [];
  if (ctx.branch) usr.push(`Branch: ${ctx.branch}`);
  if (ctx.recent.length) usr.push(`Recent commits (style reference only, never copy them):\n${ctx.recent.map((s) => `- ${s}`).join('\n')}`);
  if (ctx.scopeHint && !o.scope && !o.noScope && (!o.scopes.length || o.scopes.includes(ctx.scopeHint))) {
    usr.push(`Likely scope (use it only if it fits): ${ctx.scopeHint}`);
  }
  if (o.hint) usr.push(`Note from the author (context only, do not quote): ${o.hint}`);
  if (o.note) usr.push(o.note);
  usr.push(`Files changed:\n${ctx.stat}`);
  usr.push(`Diff:\n${ctx.diff}`);
  if (/qwen3/i.test(o.model)) usr.push('/no_think'); // Qwen3 soft switch for Ollama versions that predate the `think` option

  return [
    { role: 'system', content: sys.join('\n') },
    { role: 'user', content: usr.join('\n\n') },
  ];
}
