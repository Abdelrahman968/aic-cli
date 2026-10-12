import type { ChatMessage } from '../providers/types.js';

export interface PrContext {
  branch: string | undefined;
  base: string;
  commits: string[];
  stat: string;
  diff: string;
}

export interface PrPromptOptions {
  language: string;
  hint?: string | undefined;
  /** repository's pull request template, if any */
  template?: string | undefined;
  /** title as "type(scope): subject" */
  conventional?: boolean | undefined;
  types: string[];
  titleMax: number;
}

export function buildPrMessages(ctx: PrContext, o: PrPromptOptions): ChatMessage[] {
  const sys: string[] = [
    'You write pull request titles and descriptions for reviewers.',
    o.conventional
      ? `Title: Conventional Commit style "type(scope): subject" (type is one of ${o.types.join(', ')}), lowercase subject, imperative, max ${o.titleMax} characters, no trailing period.`
      : `Title: one imperative sentence, max ${o.titleMax} characters, no trailing period, no prefix like "PR:".`,
  ];
  if (o.template?.trim()) {
    sys.push('Fill in the repository pull request template below. Keep its headings and order. Leave checkboxes unchecked unless the change clearly satisfies them. Remove HTML comments.');
    sys.push('--- TEMPLATE ---', o.template.trim(), '--- END TEMPLATE ---');
  } else {
    sys.push('Body in Markdown with these sections: "## Summary" (1-3 sentences: what and why), "## Changes" (grouped bullets of what changed), and "## Notes" ONLY if there are breaking changes, migrations or follow-ups.');
  }
  sys.push('Describe only what is visible in the commits and diff. Never invent test results, issue numbers, benchmarks or reasons.');
  if (!/^(en|english)$/i.test(o.language)) sys.push(`Write the body in ${o.language}${o.conventional ? '; keep the title type and scope in English' : ''}.`);
  sys.push('Output EXACTLY this format and nothing else:', 'TITLE: <the title>', 'BODY:', '<the markdown body>');

  const usr: string[] = [];
  if (ctx.branch) usr.push(`Branch: ${ctx.branch} (into ${ctx.base})`); else usr.push(`Base: ${ctx.base}`);
  if (o.hint) usr.push(`Note from the author (context only): ${o.hint}`);
  usr.push(`Commits (${ctx.commits.length}):\n${ctx.commits.map((c) => `- ${c}`).join('\n') || '(none)'}`);
  usr.push(`Files changed:\n${ctx.stat}`);
  usr.push(`Diff:\n${ctx.diff}`);
  return [{ role: 'system', content: sys.join('\n') }, { role: 'user', content: usr.join('\n\n') }];
}

export interface PrText {
  title: string;
  body: string;
  problems: string[];
}

function clean(s: string): string {
  return s.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/<think>[\s\S]*$/, '').trim();
}

/** Parse the model's TITLE:/BODY: answer; tolerant of fences, quotes, and answers without the markers. */
export function parsePrOutput(raw: string, o: { titleMax: number }): PrText {
  let text = clean(raw);
  text = text.replace(/^```[A-Za-z]*\s*\n/, '').replace(/\n```\s*$/, '');
  const t = /^[\s*#_]*TITLE[\s*_]*:[\s*_]*(.+)$/im.exec(text);
  let title: string;
  let body: string;
  if (t) {
    title = t[1] as string;
    const after = text.slice((t.index ?? 0) + t[0].length);
    const b = /^[\s*#_]*BODY[\s*_]*:[\s*_]*\n?([\s\S]*)$/im.exec(after);
    body = b ? (b[1] as string) : after;
  } else {
    const lines = text.split('\n');
    const i = lines.findIndex((l) => l.trim().length > 0);
    title = i >= 0 ? (lines[i] as string).replace(/^#+\s*/, '') : '';
    body = lines.slice(i + 1).join('\n');
  }
  title = title.trim().replace(/^["'`]+|["'`]+$/g, '').replace(/\*\*/g, '').replace(/[.\s]+$/, '');
  body = body.trim().replace(/\n```\s*$/, '').trim();
  const problems: string[] = [];
  if (!title) problems.push('the model did not produce a title');
  else if ([...title].length > o.titleMax) problems.push(`title is ${[...title].length} chars (max ${o.titleMax})`);
  if (!body) problems.push('the description is empty');
  return { title, body, problems };
}

export function formatPr(p: { title: string; body: string }): string {
  return `${p.title}\n\n${p.body}\n`;
}
