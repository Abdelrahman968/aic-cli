import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { openRepo } from '../../git/exec.js';
import { commitsBetween, latestTag, refExists } from '../../git/history.js';
import { buildModel, hasVersion, prependChangelog, releaseNotesPrompt, renderJson, renderSection, replaceUnreleased, webUrlFromRemote, type ChangelogOptions } from '../../changelog/changelog.js';
import { createSession } from '../../agent/session.js';
import { completeText } from '../../agent/oneshot.js';
import { redactContent } from '../../security/secret-scanner.js';
import { AicError, ExitCode, GitError } from '../../utils/errors.js';
import { flagsToLayer } from '../options.js';
import { ui } from '../ui/output.js';
import { withSpinner } from '../ui/spinner.js';
import { ensureReady } from '../interactive/ready.js';
import { allFlags } from './flow.js';

export interface ChangelogFlags {
  from?: string;
  to?: string;
  release?: string;
  date?: string;
  includeAll?: boolean;
  hashes?: boolean;
  ai?: boolean;
  write?: string | boolean;
  force?: boolean;
  compare?: boolean;
}

export async function runChangelog(cmd: Command, o: ChangelogFlags): Promise<void> {
  const f = allFlags(cmd);
  const git = await openRepo(f.cwd ?? process.cwd());
  const to = o.to ?? 'HEAD';
  if (!(await refExists(git, to))) throw new GitError(`"${to}" is not a commit, tag or branch`);
  let from = o.from;
  if (from && !(await refExists(git, from))) throw new GitError(`"${from}" is not a commit, tag or branch`, { try: ['git tag --list', 'git fetch --tags'] });
  if (!from) from = await latestTag(git, to);
  const commits = await commitsBetween(git, from, to, 2000);

  const opts: ChangelogOptions = { version: o.release, date: o.date ?? (o.release ? new Date().toISOString().slice(0, 10) : undefined), all: o.includeAll, hashes: o.hashes !== false };
  if (o.compare && from && o.release) {
    const remote = (await git.out(['remote', 'get-url', 'origin'], { allowFail: true })).trim();
    const url = remote ? webUrlFromRemote(remote) : undefined;
    if (url) opts.compare = { url, from, to: o.to ?? (/^v\d/.test(from) ? `v${o.release}` : o.release) };
  }
  const model = buildModel(commits, opts);
  ui.dim(`${model.total} commit${model.total === 1 ? '' : 's'} ${from ? `since ${from}` : 'in the whole history'}${to === 'HEAD' ? '' : ` up to ${to}`}`);

  if (f.json) { ui.data(renderJson(model, opts)); return; }
  let section = renderSection(model, opts);

  if (o.ai) {
    const s = await createSession({ cli: flagsToLayer(f), yes: f.yes, requireRepo: true });
    ui.protect(s.apiKey);
    await ensureReady(s, { startOllama: f.startOllama });
    ui.dim(`sending commit subjects (no diffs) to ${s.provider.name}`);
    const body = s.redact ? redactContent(section).text : section;
    const text = await withSpinner('writing release notes', () => completeText(s, releaseNotesPrompt(body, { language: s.settings.language, project: git.name, version: o.release }), { maxTokens: 1200 }));
    const heading = section.split('\n')[0] as string;
    const breaking = /### BREAKING CHANGES[\s\S]*?(?=\n### |\n$)/.exec(section)?.[0];
    section = `${heading}\n\n${text.replace(/^## .*\n+/, '').trim()}\n` + (breaking && !/BREAKING CHANGES/.test(text) ? `\n${breaking.trim()}\n` : '');
  }

  if (o.write === undefined || o.write === false) { ui.data(section); return; }

  const file = join(git.root, typeof o.write === 'string' ? o.write : 'CHANGELOG.md');
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
  if (existing && o.release && hasVersion(existing, o.release) && !o.force) {
    throw new AicError(`${file} already has a section for ${o.release}`, ExitCode.GENERAL, { try: ['aic changelog --write --force', 'Choose another --release label'] });
  }
  let next: string | undefined;
  if (existing && !o.release) next = replaceUnreleased(existing, section);
  next ??= prependChangelog(existing, section);
  writeFileSync(file, next, 'utf8');
  ui.ok(`${existing ? 'updated' : 'created'} ${file}`);
}
