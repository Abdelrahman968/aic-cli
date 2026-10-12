import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { createSession } from '../../agent/session.js';
import { completeText } from '../../agent/oneshot.js';
import { withholdSensitive } from '../../agent/context.js';
import { currentBranch } from '../../git/branch.js';
import { commitsBetween, defaultBase, refExists } from '../../git/history.js';
import { formatStat, rangeDiff, rangeStat, shrinkDiff } from '../../git/diff.js';
import { buildPrMessages, formatPr, parsePrOutput, type PrText } from '../../pr/pr.js';
import { redactContent } from '../../security/secret-scanner.js';
import { copyToClipboard } from '../../utils/clipboard.js';
import { AicError, CancelledError, ExitCode, GitError } from '../../utils/errors.js';
import { flagsToLayer } from '../options.js';
import { ui } from '../ui/output.js';
import { Spinner } from '../ui/spinner.js';
import { cancelOnEsc } from '../ui/keys.js';
import { ask, pickOne } from '../ui/prompts.js';
import { ensureReady } from '../interactive/ready.js';
import { colorizeHeader } from '../interactive/render.js';
import { allFlags } from './flow.js';

export interface PrFlags {
  base?: string;
  template?: string;
  noTemplate?: boolean;
  conventional?: boolean;
  titleMax?: string;
}

const TEMPLATE_PATHS = ['.github/pull_request_template.md', '.github/PULL_REQUEST_TEMPLATE.md', 'docs/pull_request_template.md', 'pull_request_template.md', 'PULL_REQUEST_TEMPLATE.md'];

function findTemplate(root: string, explicit: string | undefined): string | undefined {
  const paths = explicit ? [explicit] : TEMPLATE_PATHS;
  for (const p of paths) {
    const full = explicit ? p : join(root, p);
    if (existsSync(full)) return readFileSync(full, 'utf8').slice(0, 4000);
  }
  if (explicit) throw new AicError(`Template not found: ${explicit}`, ExitCode.USAGE);
  return undefined;
}

export async function runPr(cmd: Command, o: PrFlags): Promise<void> {
  const f = allFlags(cmd);
  const s = await createSession({ cli: flagsToLayer(f), yes: f.yes, requireRepo: true });
  for (const w of s.resolved.warnings) ui.warn(w);
  ui.protect(s.apiKey);
  const git = s.git as NonNullable<typeof s.git>;
  await ensureReady(s, { startOllama: f.startOllama });

  const branch = await currentBranch(git);
  const base = o.base ?? (await defaultBase(git, branch));
  if (!base) throw new GitError('Cannot tell which branch to compare with', { try: ['aic pr --base main', 'git remote add origin <url>'] });
  if (!(await refExists(git, base))) throw new GitError(`Base "${base}" does not exist`, { try: ['git fetch', 'aic pr --base <branch>'] });
  const commits = await commitsBetween(git, base, 'HEAD', 100);
  if (commits.length === 0) throw new AicError(`No commits on ${branch} that are not already in ${base}`, ExitCode.GENERAL, { try: ['git log --oneline ' + base + '..HEAD', 'aic pr --base <other-branch>'] });

  const titleMax = o.titleMax ? Number(o.titleMax) : 72;
  const files = await rangeStat(git, base, 'HEAD', s.settings.exclude);
  const rawDiff = s.settings.sendDiff ? await rangeDiff(git, base, 'HEAD', s.settings.exclude) : '';
  let diff = s.settings.sendDiff ? shrinkDiff(s.redact ? withholdSensitive(rawDiff).text : rawDiff, s.settings.maxChars * 2) : '(diff content is not sent: privacy settings)';
  let redactions = 0;
  if (s.redact && s.settings.sendDiff) { const r = redactContent(diff); diff = r.text; redactions = r.count; }
  const stat = formatStat(files, 60);
  const template = o.noTemplate ? undefined : findTemplate(git.root, o.template);

  ui.blank();
  ui.kv([['branch', ui.theme.scope(branch)], ['base', base], ['commits', String(commits.length)], ['files', String(files.length)], ['template', template ? 'repository PR template' : 'default structure']]);
  if (redactions) ui.dim(`${redactions} secret-like value(s) redacted before sending`);
  if (!s.provider.local) ui.dim(`sending to ${s.provider.name}: commit subjects and ${s.settings.sendDiff ? 'the diff' : 'file names only'}`);

  const state = { hint: f.hint, regen: 0 };
  const generate = async (): Promise<PrText> => {
    const sp = new Spinner('writing pull request').start();
    sp.update({ cancelHint: true, tokens: 0 });
    const ctl = new AbortController();
    const stop = s.interactive ? cancelOnEsc(ctl) : () => undefined;
    try {
      const messages = buildPrMessages({ branch: s.settings.sendBranch ? branch : undefined, base, commits: s.settings.sendHistory ? commits.map((c) => c.subject) : [], stat, diff }, {
        language: s.settings.language, hint: state.hint, template, conventional: o.conventional, types: s.settings.types, titleMax,
      });
      let last: PrText | undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        const text = await completeText(s, messages, { maxTokens: Math.max(s.settings.numPredict, 900), temperature: Math.min(0.9, s.settings.temperature + 0.2 * (state.regen + attempt)), signal: ctl.signal, onProgress: (n, t) => sp.update({ tokens: n, tail: t }) });
        last = parsePrOutput(text, { titleMax });
        if (!last.problems.some((p) => /no title|empty/.test(p))) break;
      }
      return last as PrText;
    } finally {
      stop();
      sp.stop();
    }
  };

  let pr = await generate();
  while (true) {
    ui.write('');
    ui.card('Pull request', [colorizeHeader(pr.title) === pr.title ? ui.theme.bold(pr.title) : colorizeHeader(pr.title), '', ...pr.body.split('\n')]);
    for (const p of pr.problems) ui.warn(p);

    if (f.json) { ui.data(JSON.stringify({ title: pr.title, body: pr.body, base, branch, commits: commits.length }, null, 2)); return; }
    if (f.passThru) { ui.data(formatPr(pr)); return; }
    if (f.copy) {
      ui.write(await copyToClipboard(formatPr(pr)) ? '  ' + ui.theme.ok(`${ui.theme.g.ok} copied title and description`) : '  ' + ui.theme.err('Clipboard is not available here.'));
      return;
    }
    if (!s.interactive) { ui.data(formatPr(pr)); return; }

    const action = await pickOne('What next?', [
      { name: 'Copy title and description', value: 'both' },
      { name: 'Copy description only', value: 'body' },
      { name: 'Copy title only', value: 'title' },
      { name: 'Regenerate', value: 'regen' },
      { name: 'Add a hint and regenerate', value: 'hint' },
      { name: 'Done', value: 'done' },
    ]);
    if (action === 'done') return;
    if (action === 'regen' || action === 'hint') {
      if (action === 'hint') { const h = (await ask('hint for the model:')).trim(); if (h) state.hint = h; }
      state.regen++;
      try { pr = await generate(); } catch (e) { if (e instanceof CancelledError) { ui.dim('cancelled'); continue; } throw e; }
      continue;
    }
    const text = action === 'both' ? formatPr(pr) : action === 'body' ? pr.body : pr.title;
    ui.write(await copyToClipboard(text) ? '  ' + ui.theme.ok(`${ui.theme.g.ok} copied`) : '  ' + ui.theme.err('Clipboard is not available here.'));
  }
}
