import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildModel, hasVersion, parseCommit, prependChangelog, renderJson, renderSection, replaceUnreleased, webUrlFromRemote } from '../src/changelog/changelog.js';
import { buildPrMessages, parsePrOutput } from '../src/pr/pr.js';
import { HOOK_MARKER, composeMessageFile, hookScript, hookStatus, installHook, isBlankMessage, shouldSkipSource, uninstallHook } from '../src/hook/hook.js';
import { buildSplitMessages, capGroups, extractJson, heuristicPlan, normalizePlan, pathsFor } from '../src/split/plan.js';
import { openRepo } from '../src/git/exec.js';
import { commitsBetween, defaultBase, latestTag } from '../src/git/history.js';
import { plan } from '../src/agent/planner.js';
import type { GitError } from '../src/utils/errors.js';
import { json, rejection, startServer, tempRepo, type TempRepo } from './helpers.js';

const rc = (subject: string, body = '', hash = 'abcdef1234567890'): { hash: string; subject: string; body: string; author: string; date: string } => ({ hash, subject, body, author: 'A', date: '2026-01-02' });

describe('changelog', () => {
  it('parses conventional commits, breaking markers and footers', () => {
    expect(parseCommit(rc('feat(api)!: drop v1', 'BREAKING CHANGE: v1 endpoints are gone\n\nmore'))).toMatchObject({ type: 'feat', scope: 'api', breaking: true, breakingNote: 'v1 endpoints are gone', conventional: true });
    expect(parseCommit(rc('fix: x', 'BREAKING-CHANGE: y'))).toMatchObject({ breaking: true, breakingNote: 'y' });
    expect(parseCommit(rc('Update readme'))).toMatchObject({ conventional: false, subject: 'Update readme', type: '' });
    expect(parseCommit(rc('wip: stuff')).conventional).toBe(false); // unknown type
  });
  it('groups into sections in a stable order and hides chores by default', () => {
    const cs = [rc('chore: deps', '', 'c1'), rc('fix(ui): button', '', 'f1'), rc('feat(auth): login', '', 'a1'), rc('docs: readme', '', 'd1'), rc('Misc tweak', '', 'm1'), rc('perf: faster', '', 'p1')];
    const m = buildModel(cs);
    expect(m.sections.map((s) => s.def.title)).toEqual(['Features', 'Bug Fixes', 'Performance', 'Documentation']);
    expect(m.other).toHaveLength(1);
    expect(buildModel(cs, { all: true }).sections.map((s) => s.def.title)).toContain('Chores');
  });
  it('renders markdown with scopes, hashes and a breaking section', () => {
    const cs = [rc('feat(auth)!: new login', 'BREAKING CHANGE: sessions are reset', '1111111aaaa'), rc('fix: typo', '', '2222222bbbb')];
    const md = renderSection(buildModel(cs), { version: '1.2.0', date: '2026-02-03' });
    expect(md).toBe([
      '## 1.2.0 - 2026-02-03', '', '### BREAKING CHANGES', '', '- **auth:** sessions are reset (1111111)', '', '### Features', '', '- **auth:** new login (1111111)', '', '### Bug Fixes', '', '- typo (2222222)', '',
    ].join('\n'));
    expect(renderSection(buildModel(cs), {})).toMatch(/^## Unreleased/);
    expect(renderSection(buildModel(cs), { hashes: false })).not.toContain('(1111111)');
    expect(renderSection(buildModel([]), {})).toContain('_No notable changes._');
  });
  it('skips release commits and links compare views', () => {
    expect(buildModel([rc('chore(release): 1.0.0'), rc('Release v1.0.1')]).total).toBe(0);
    const md = renderSection(buildModel([rc('fix: a')]), { version: '1.1.0', compare: { url: 'https://github.com/o/r', from: 'v1.0.0', to: 'v1.1.0' } });
    expect(md.split('\n')[0]).toBe('## [1.1.0](https://github.com/o/r/compare/v1.0.0...v1.1.0)');
  });
  it('json output is structured', () => {
    const j = JSON.parse(renderJson(buildModel([rc('feat(a): x')]), { version: '1.0.0' })) as { version: string; sections: Array<{ title: string; commits: Array<{ scope: string }> }> };
    expect(j.version).toBe('1.0.0');
    expect(j.sections[0]).toMatchObject({ title: 'Features', commits: [{ scope: 'a' }] });
  });
  it('prepends under the title, keeps the intro, replaces Unreleased, detects versions', () => {
    const sec = '## 1.1.0\n\n### Features\n\n- x\n';
    expect(prependChangelog(undefined, sec)).toBe('# Changelog\n\n## 1.1.0\n\n### Features\n\n- x\n');
    const existing = '# Changelog\n\nAll notable changes.\n\n## 1.0.0\n\n- old\n';
    const out = prependChangelog(existing, sec);
    expect(out.indexOf('## 1.1.0')).toBeLessThan(out.indexOf('## 1.0.0'));
    expect(out).toContain('All notable changes.');
    expect(replaceUnreleased('# C\n\n## Unreleased\n\n- a\n\n## 1.0.0\n\n- b\n', '## Unreleased\n\n- new\n')).toBe('# C\n\n## Unreleased\n\n- new\n\n## 1.0.0\n\n- b\n');
    expect(replaceUnreleased('# C\n\n## 1.0.0\n', 'x')).toBeUndefined();
    expect(hasVersion('## [1.0.0](x) - d\n', '1.0.0')).toBe(true);
    expect(hasVersion('## 1.0.0 - d\n', '1.0')).toBe(false);
  });
  it('derives web URLs from remotes', () => {
    expect(webUrlFromRemote('git@github.com:o/r.git')).toBe('https://github.com/o/r');
    expect(webUrlFromRemote('https://user@gitlab.com/g/p.git')).toBe('https://gitlab.com/g/p');
    expect(webUrlFromRemote('/local/path')).toBeUndefined();
  });
});

describe('pull request text', () => {
  const o = { titleMax: 72 };
  it('parses the TITLE/BODY format', () => {
    const r = parsePrOutput('TITLE: Add refresh token rotation.\nBODY:\n## Summary\nRotates tokens.\n\n## Changes\n- a', o);
    expect(r.title).toBe('Add refresh token rotation');
    expect(r.body).toBe('## Summary\nRotates tokens.\n\n## Changes\n- a');
    expect(r.problems).toEqual([]);
  });
  it('tolerates fences, bold markers, quotes and think blocks', () => {
    const r = parsePrOutput('<think>x</think>\n```markdown\n**TITLE:** "Fix login redirect"\n**BODY:**\nBody text\n```', o);
    expect(r).toMatchObject({ title: 'Fix login redirect', body: 'Body text' });
  });
  it('falls back to first line as title when markers are missing', () => {
    const r = parsePrOutput('# Improve caching\n\nWe cache now.', o);
    expect(r).toMatchObject({ title: 'Improve caching', body: 'We cache now.' });
  });
  it('reports long titles and empty parts', () => {
    expect(parsePrOutput('TITLE: ' + 'x'.repeat(90) + '\nBODY:\nb', o).problems[0]).toMatch(/max 72/);
    expect(parsePrOutput('TITLE: ok\nBODY:\n', o).problems).toContain('the description is empty');
    expect(parsePrOutput('', o).problems).toContain('the model did not produce a title');
  });
  it('builds prompts with template, conventional title, language and hint', () => {
    const ctx = { branch: 'feature/x', base: 'main', commits: ['feat: a', 'fix: b'], stat: 'a.ts (+1 -0)', diff: '+x' };
    const [sys, usr] = buildPrMessages(ctx, { language: 'Arabic', hint: 'perf work', template: '## What\n- [ ] tests', conventional: true, types: ['feat', 'fix'], titleMax: 72 });
    expect(sys?.content).toContain('--- TEMPLATE ---');
    expect(sys?.content).toContain('## What');
    expect(sys?.content).toContain('type(scope): subject');
    expect(sys?.content).toContain('Write the body in Arabic');
    expect(sys?.content).toContain('Never invent test results');
    expect(usr?.content).toContain('feature/x (into main)');
    expect(usr?.content).toContain('perf work');
    expect(usr?.content).toContain('- feat: a');
    const plain = buildPrMessages(ctx, { language: 'English', types: [], titleMax: 60 })[0]?.content ?? '';
    expect(plain).toContain('## Summary');
    expect(plain).toContain('max 60 characters');
  });
});

describe('split planning', () => {
  const files = ['src/auth/token.ts', 'src/auth/refresh.ts', 'src/api/routes.ts', 'README.md'];
  it('extracts JSON from messy model output', () => {
    expect(extractJson('```json\n{"commits":[{"files":["a"]}]}\n```')).toEqual({ commits: [{ files: ['a'] }] });
    expect(extractJson('Sure! Here is the plan: {"commits":[]} hope that helps')).toEqual({ commits: [] });
    expect(extractJson('[{"files":["a"]}]')).toEqual([{ files: ['a'] }]);
    expect(extractJson('<think>{"x":1}</think>{"commits":[1]}')).toEqual({ commits: [1] });
    expect(extractJson('no json here')).toBeUndefined();
    expect(extractJson('{broken')).toBeUndefined();
  });
  it('keeps every file exactly once and drops unknown ones', () => {
    const p = normalizePlan({ commits: [
      { title: 'auth', type: 'FEAT', scope: 'auth', files: ['./src/auth/token.ts', 'src/auth/refresh.ts', 'ghost.ts', 'src/auth/token.ts'] },
      { title: 'routes', files: ['src/api/routes.ts', 'src/auth/token.ts'] },
      { title: 'nothing', files: ['ghost2.ts'] },
    ] }, files, 6);
    expect(p.map((g) => g.files)).toEqual([['src/auth/token.ts', 'src/auth/refresh.ts'], ['src/api/routes.ts'], ['README.md']]);
    expect(p[0]).toMatchObject({ title: 'auth', type: 'feat', scope: 'auth' });
    expect(p[2]?.title).toBe('other changes');
    expect(p.flatMap((g) => g.files).sort()).toEqual([...files].sort());
  });
  it('returns [] for unusable plans and caps the group count', () => {
    expect(normalizePlan('garbage', files, 6)).toEqual([]);
    expect(normalizePlan({ commits: [{ files: ['nope'] }] }, files, 6)).toEqual([]);
    expect(normalizePlan(undefined, files, 6)).toEqual([]);
    const many = normalizePlan(files.map((f) => ({ title: f, files: [f] })), files, 2);
    expect(many).toHaveLength(2);
    expect(many[1]?.files).toHaveLength(3);
    expect(capGroups([{ title: 'a', files: ['a'] }], 5)).toHaveLength(1);
  });
  it('heuristic plan separates docs, tests, config and areas', () => {
    const p = heuristicPlan(['README.md', 'src/api/a.ts', 'src/api/b.ts', 'src/web/c.ts', 'test/a.test.ts', 'package.json', 'yarn.lock'], 10);
    const by = Object.fromEntries(p.map((g) => [g.type ?? g.scope ?? 'x', g.files]));
    expect(by['docs']).toEqual(['README.md']);
    expect(by['test']).toEqual(['test/a.test.ts']);
    expect(by['chore']).toEqual(['package.json', 'yarn.lock']);
    expect(by['api']).toEqual(['src/api/a.ts', 'src/api/b.ts']);
    expect(by['web']).toEqual(['src/web/c.ts']);
    expect(heuristicPlan(['a/x', 'b/y', 'c/z'], 2)).toHaveLength(2);
  });
  it('prompt lists files, limits and the JSON contract', () => {
    const [sys, usr] = buildSplitMessages([{ path: 'a.ts', add: 3, del: 1, status: 'M' }, { path: 'new.ts', oldPath: 'old.ts', add: 0, del: 0, status: 'R' }], '+x', { max: 4, language: 'French', types: ['feat', 'fix'], hint: 'auth work' });
    expect(sys?.content).toContain('between 1 and 4 commits');
    expect(sys?.content).toContain('Write titles in French');
    expect(sys?.content).toContain('JSON only');
    expect(usr?.content).toContain('M a.ts (+3 -1)');
    expect(usr?.content).toContain('renamed from old.ts');
    expect(usr?.content).toContain('auth work');
  });
  it('stages both sides of a rename', () => {
    const f = [{ path: 'new.ts', oldPath: 'old.ts', add: 0, del: 0, status: 'R' }, { path: 'b.ts', add: 1, del: 0, status: 'M' }];
    expect(pathsFor({ title: 't', files: ['new.ts'] }, f)).toEqual(['new.ts', 'old.ts']);
  });
  it('agent understands "split my changes"', () => {
    expect(plan('split my changes into commits').intent.kind).toBe('split');
    expect(plan('/split').intent.kind).toBe('split');
    expect(plan('what does split do?').intent.kind).not.toBe('split');
  });
});

describe('hook (unit)', () => {
  let repo: TempRepo;
  afterEach(() => repo?.cleanup());

  it('script never fails a commit and is easy to disable', () => {
    const s = hookScript();
    expect(s.startsWith('#!/bin/sh')).toBe(true);
    expect(s).toContain(HOOK_MARKER);
    expect(s).toContain('AIC_HOOK_DISABLE');
    expect(s).toContain('command -v aic');
    expect(s.trimEnd().endsWith('exit 0')).toBe(true);
    expect(s).toContain('|| true');
  });
  it('knows when not to touch a message', () => {
    for (const src of ['message', 'merge', 'squash', 'commit']) expect(shouldSkipSource(src)).toBe(true);
    expect(shouldSkipSource(undefined)).toBe(false);
    expect(shouldSkipSource('template')).toBe(false);
    expect(isBlankMessage('\n# Please enter the commit message\n#\n')).toBe(true);
    expect(isBlankMessage('wip\n# comment')).toBe(false);
    expect(composeMessageFile('feat: x\n', '\n# comment\n')).toBe('feat: x\n\n# comment\n');
    expect(composeMessageFile('feat: x', '')).toBe('feat: x\n');
  });
  it('installs, refreshes, refuses foreign hooks, backs up with --force and restores on uninstall', async () => {
    repo = tempRepo();
    const git = await openRepo(repo.dir);
    expect((await hookStatus(git)).state).toBe('not-installed');
    const r = await installHook(git);
    expect(r.alreadyInstalled).toBe(false);
    expect(readFileSync(r.path, 'utf8')).toContain(HOOK_MARKER);
    if (process.platform !== 'win32') expect(statSync(r.path).mode & 0o111).not.toBe(0);
    expect((await installHook(git)).alreadyInstalled).toBe(true);
    expect((await uninstallHook(git)).removed).toBe(true);
    expect(existsSync(r.path)).toBe(false);
    expect((await uninstallHook(git)).removed).toBe(false);

    writeFileSync(r.path, '#!/bin/sh\necho mine\n'); chmodSync(r.path, 0o755);
    expect((await hookStatus(git)).state).toBe('foreign');
    const err = await rejection<GitError>(installHook(git));
    expect(err.message).toMatch(/was not created by AIC/);
    expect(readFileSync(r.path, 'utf8')).toContain('echo mine');
    await expect(uninstallHook(git)).rejects.toThrow(/left alone/);
    const forced = await installHook(git, { force: true });
    expect(forced.backup).toBeDefined();
    expect(readFileSync(forced.backup as string, 'utf8')).toContain('echo mine');
    expect((await uninstallHook(git)).restored).toBeDefined();
    expect(readFileSync(r.path, 'utf8')).toContain('echo mine');
  });
  it('follows core.hooksPath', async () => {
    repo = tempRepo();
    repo.git('config', 'core.hooksPath', '.githooks');
    const git = await openRepo(repo.dir);
    const st = await hookStatus(git);
    expect(st.customPath).toBe(true);
    expect(st.path).toBe(join(repo.dir, '.githooks', 'prepare-commit-msg'));
    await installHook(git);
    expect(existsSync(st.path)).toBe(true);
  });
});

describe('git range helpers', () => {
  let repo: TempRepo;
  afterEach(() => repo?.cleanup());
  it('lists commits with bodies since a tag, finds the base branch', async () => {
    repo = tempRepo();
    repo.git('checkout', '-q', '-b', 'main');
    repo.write('a', '1'); repo.git('add', '-A'); repo.git('commit', '-qm', 'feat: one');
    repo.git('tag', 'v1.0.0');
    repo.write('a', '2'); repo.git('add', '-A'); repo.git('commit', '-qm', 'fix(x): two', '-m', 'BREAKING CHANGE: details');
    repo.git('checkout', '-q', '-b', 'feature/y');
    repo.write('b', '1'); repo.git('add', '-A'); repo.git('commit', '-qm', 'feat: three');
    const git = await openRepo(repo.dir);
    expect(await latestTag(git)).toBe('v1.0.0');
    const cs = await commitsBetween(git, 'v1.0.0');
    expect(cs.map((c) => c.subject)).toEqual(['feat: three', 'fix(x): two']);
    expect(cs[1]?.body).toContain('BREAKING CHANGE: details');
    expect((await commitsBetween(git, undefined)).length).toBe(3);
    expect(await defaultBase(git, 'feature/y')).toBe('main');
    expect(await commitsBetween(git, 'nope-ref')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// end to end
// ---------------------------------------------------------------------------------------------

const execFileAsync = promisify(execFile);
const ROOT = resolve(import.meta.dirname, '..');
const TSX = join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');

interface Run { code: number; stdout: string; stderr: string }
function aic(args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }): Promise<Run> {
  return new Promise((res) => {
    const base = { ...process.env };
    for (const k of Object.keys(base)) if (k.startsWith('AIC_') || k === 'OLLAMA_HOST') delete base[k];
    const env = { ...base, NO_COLOR: '1', CI: '1', TERM: 'dumb', ...opts.env };
    const c = spawn(TSX, [join(ROOT, 'src/index.ts'), ...args], { cwd: opts.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    c.stdout.on('data', (d) => (stdout += d)); c.stderr.on('data', (d) => (stderr += d));
    c.on('close', (code) => res({ code: code ?? -1, stdout, stderr }));
  });
}

describe('end to end: changelog, hook, pr, split', () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let cfg: string;
  let bin: string;
  const calls: Record<string, number> = { message: 0, plan: 0, pr: 0, notes: 0 };
  const seen: string[] = [];
  let planAnswer = '';
  const prAnswer = 'TITLE: Add refresh token rotation.\nBODY:\n## Summary\nRotates tokens on every use.\n\n## Changes\n- rotate\n- revoke';
  const COMMIT = 'Feat(auth): Add refresh token rotation.\n\n* rotate tokens on use\n';
  let repo: TempRepo;

  beforeAll(async () => {
    server = await startServer((r, res) => {
      if (r.url === '/api/tags') return json(res, { models: [{ name: 'qwen2.5-coder:7b', size: 1 }] });
      if (r.url === '/api/show') return json(res, { capabilities: ['completion'] });
      if (r.url === '/api/chat') {
        const sys = (JSON.parse(r.body) as { messages: Array<{ content: string }> }).messages[0]?.content ?? '';
        seen.push(r.body);
        let answer = COMMIT; let kind = 'message';
        if (sys.includes('split a developer')) { answer = planAnswer; kind = 'plan'; }
        else if (sys.includes('pull request titles')) { answer = prAnswer; kind = 'pr'; }
        else if (sys.includes('release notes')) { answer = '## Whatever\n\nThis release improves login.\n\n### Highlights\n- Faster login'; kind = 'notes'; }
        calls[kind] = (calls[kind] ?? 0) + 1;
        res.setHeader('content-type', 'application/x-ndjson');
        res.write(JSON.stringify({ message: { content: answer } }) + '\n');
        return res.end(JSON.stringify({ done: true }) + '\n');
      }
      res.statusCode = 404; res.end('{}');
    });
    cfg = mkdtempSync(join(tmpdir(), 'aic-feat-cfg-'));
    bin = mkdtempSync(join(tmpdir(), 'aic-feat-bin-'));
    writeFileSync(join(bin, 'aic'), `#!/bin/sh\nexec "${TSX}" "${join(ROOT, 'src/index.ts')}" "$@"\n`);
    chmodSync(join(bin, 'aic'), 0o755);
  });
  afterAll(async () => { await server.close(); rmSync(cfg, { recursive: true, force: true }); rmSync(bin, { recursive: true, force: true }); });
  afterEach(() => repo?.cleanup());

  const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ AIC_CONFIG_DIR: cfg, AIC_OLLAMA_URL: server.url, ...extra });
  const reset = (): void => { for (const k of Object.keys(calls)) calls[k] = 0; seen.length = 0; };

  // ---- changelog -------------------------------------------------------------------------
  const historyRepo = (): TempRepo => {
    const r = tempRepo();
    r.git('checkout', '-q', '-b', 'main');
    r.write('a', '0'); r.git('add', '-A'); r.git('commit', '-qm', 'feat: initial');
    r.git('tag', 'v1.0.0');
    for (const [i, m] of ['feat(auth): add refresh tokens', 'fix(api): handle expired sessions', 'chore: bump deps', 'docs: update readme', 'Random manual commit'].entries()) {
      r.write('a', String(i + 1)); r.git('add', '-A'); r.git('commit', '-qm', m);
    }
    r.write('a', 'x'); r.git('add', '-A'); r.git('commit', '-qm', 'refactor(db)!: new schema', '-m', 'BREAKING CHANGE: run the migration');
    return r;
  };

  it('changelog: groups commits since the latest tag, offline, no model contacted', async () => {
    repo = historyRepo(); reset();
    const r = await aic(['changelog'], { cwd: repo.dir, env: { AIC_CONFIG_DIR: cfg } });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('## Unreleased');
    expect(r.stdout).toContain('### BREAKING CHANGES');
    expect(r.stdout).toContain('run the migration');
    expect(r.stdout).toMatch(/### Features\n\n- \*\*auth:\*\* add refresh tokens \([0-9a-f]{7}\)/);
    expect(r.stdout).toMatch(/### Bug Fixes\n\n- \*\*api:\*\* handle expired sessions/);
    expect(r.stdout).toContain('### Other changes');
    expect(r.stdout).not.toContain('bump deps');
    expect(r.stdout).not.toContain('initial');
    expect(r.stderr).toContain('since v1.0.0');
    expect(Object.values(calls).reduce((a, b) => a + b, 0)).toBe(0);
    expect((await aic(['changelog', '--include-all', '--no-hashes'], { cwd: repo.dir, env: { AIC_CONFIG_DIR: cfg } })).stdout).toContain('### Chores');
    const j = JSON.parse((await aic(['changelog', '--json', '--release', '2.0.0'], { cwd: repo.dir, env: { AIC_CONFIG_DIR: cfg } })).stdout) as { version: string };
    expect(j.version).toBe('2.0.0');
  });

  it('changelog --write creates, prepends and refuses to duplicate a version', async () => {
    repo = historyRepo();
    const e = { AIC_CONFIG_DIR: cfg };
    expect((await aic(['changelog', '--release', '1.1.0', '--date', '2026-03-04', '--write'], { cwd: repo.dir, env: e })).code).toBe(0);
    const file = join(repo.dir, 'CHANGELOG.md');
    expect(readFileSync(file, 'utf8').startsWith('# Changelog\n\n## 1.1.0 - 2026-03-04')).toBe(true);
    const dup = await aic(['changelog', '--release', '1.1.0', '--write'], { cwd: repo.dir, env: e });
    expect(dup.code).toBe(1);
    expect(dup.stderr).toContain('already has a section for 1.1.0');
    expect((await aic(['changelog', '--release', '1.1.0', '--write', '--force'], { cwd: repo.dir, env: e })).code).toBe(0);
    repo.git('tag', 'v1.1.0'); repo.write('b', '1'); repo.git('add', '-A'); repo.git('commit', '-qm', 'fix: later');
    expect((await aic(['changelog', '--release', '1.1.1', '--write'], { cwd: repo.dir, env: e })).code).toBe(0);
    const text = readFileSync(file, 'utf8');
    expect(text.indexOf('## 1.1.1')).toBeLessThan(text.indexOf('## 1.1.0'));
    expect((await aic(['changelog', '--from', 'no-such-ref'], { cwd: repo.dir, env: e })).code).toBe(4);
  });

  it('changelog --ai rewrites with the model and keeps the heading and breaking section', async () => {
    repo = historyRepo(); reset();
    const r = await aic(['changelog', '--ai', '--release', '1.2.0', '--ollama-url', server.url], { cwd: repo.dir, env: { AIC_CONFIG_DIR: cfg } });
    expect(r.code).toBe(0);
    expect(calls['notes']).toBe(1);
    expect(r.stdout.startsWith('## 1.2.0')).toBe(true);
    expect(r.stdout).toContain('This release improves login.');
    expect(r.stdout).toContain('### BREAKING CHANGES');
    expect(r.stdout).not.toContain('## Whatever');
    expect(seen.join('')).not.toContain('diff --git'); // subjects only, never diffs
  });

  // ---- hook ------------------------------------------------------------------------------
  it('hook: install/status/uninstall through the CLI', async () => {
    repo = tempRepo();
    expect((await aic(['hook', 'status'], { cwd: repo.dir, env: env() })).stdout).toContain('not installed');
    expect((await aic(['hook', 'install'], { cwd: repo.dir, env: env() })).code).toBe(0);
    expect((await aic(['hook', 'status'], { cwd: repo.dir, env: env() })).stdout).toContain('installed');
    writeFileSync(join(repo.dir, '.git/hooks/prepare-commit-msg'), '#!/bin/sh\n');
    expect((await aic(['hook', 'install'], { cwd: repo.dir, env: env() })).code).toBe(4);
    expect((await aic(['hook', 'uninstall'], { cwd: repo.dir, env: env() })).code).toBe(4);
  });

  const commitViaGit = async (r: TempRepo, extraArgs: string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<{ out: string; subject: string }> => {
    const outFile = join(r.dir, '.git', 'EDITOR_SAW');
    const editor = join(bin, 'editor.sh');
    writeFileSync(editor, `#!/bin/sh\ncp "$1" "${outFile}"\n`); chmodSync(editor, 0o755);
    const base: NodeJS.ProcessEnv = { ...process.env, ...env(), PATH: `${bin}:${process.env['PATH']}`, GIT_EDITOR: editor, NO_COLOR: '1', ...extraEnv };
    for (const k of Object.keys(base)) if (k.startsWith('GIT_CONFIG')) delete base[k];
    await execFileAsync('git', ['commit', ...extraArgs], { cwd: r.dir, env: base }); // async: the mock server lives in this process
    return { out: existsSync(outFile) ? readFileSync(outFile, 'utf8') : '', subject: r.git('log', '-1', '--format=%s').trim() };
  };

  it('hook: a plain `git commit` opens the editor with a generated message', async () => {
    repo = tempRepo(); reset();
    repo.write('src/auth/token.ts', 'v1\n'); repo.git('add', '-A'); repo.git('commit', '-qm', 'chore: init');
    await aic(['hook', 'install'], { cwd: repo.dir, env: env() });
    repo.write('src/auth/token.ts', 'v2\n'); repo.git('add', '-A');
    const { out, subject } = await commitViaGit(repo, []);
    expect(out.startsWith('feat(auth): add refresh token rotation\n\n- rotate tokens on use')).toBe(true);
    expect(out).toContain('# Please enter the commit message'); // git's own comments are preserved
    expect(subject).toBe('feat(auth): add refresh token rotation');
    expect(calls['message']).toBe(1);
  });

  it('hook: leaves -m messages, amends and disabled runs alone, and never blocks a commit', async () => {
    repo = tempRepo(); reset();
    repo.write('a.txt', '1\n'); repo.git('add', '-A'); repo.git('commit', '-qm', 'chore: init');
    await aic(['hook', 'install'], { cwd: repo.dir, env: env() });
    repo.write('a.txt', '2\n'); repo.git('add', '-A');
    expect((await commitViaGit(repo, ['-m', 'my own message'])).subject).toBe('my own message');
    expect(calls['message']).toBe(0);
    repo.write('a.txt', '3\n'); repo.git('add', '-A');
    expect((await commitViaGit(repo, ['--amend'])).subject).toBe('my own message');
    expect(calls['message']).toBe(0);
    repo.write('a.txt', '4\n'); repo.git('add', '-A');
    await commitViaGit(repo, [], { AIC_HOOK_DISABLE: '1', GIT_EDITOR: 'true' }).catch(() => undefined);
    expect(calls['message']).toBe(0);
  });

  it('hook: skips (and still commits) when Ollama is down or secrets are staged', async () => {
    repo = tempRepo(); reset();
    repo.write('a.txt', '1\n'); repo.git('add', '-A'); repo.git('commit', '-qm', 'chore: init');
    await aic(['hook', 'install'], { cwd: repo.dir, env: env() });
    repo.write('a.txt', '2\n'); repo.git('add', '-A');
    const writeEditor = join(bin, 'writer.sh');
    writeFileSync(writeEditor, '#!/bin/sh\nprintf "manual: written by me\\n" > "$1"\n'); chmodSync(writeEditor, 0o755);
    const down = await commitViaGit(repo, [], { AIC_OLLAMA_URL: 'http://127.0.0.1:1', GIT_EDITOR: writeEditor });
    expect(down.subject).toBe('manual: written by me');
    repo.write('k.ts', `const k = "${'AK' + 'IAABCDEFGHIJKLMNOP'}";\n`); repo.git('add', '-A');
    const secret = await commitViaGit(repo, [], { GIT_EDITOR: writeEditor });
    expect(secret.subject).toBe('manual: written by me');
    expect(calls['message']).toBe(0);
  });

  // ---- pr --------------------------------------------------------------------------------
  const prRepo = (): TempRepo => {
    const r = tempRepo();
    r.git('checkout', '-q', '-b', 'main');
    r.write('src/auth/token.ts', 'v1\n'); r.git('add', '-A'); r.git('commit', '-qm', 'chore: init');
    r.git('checkout', '-q', '-b', 'feature/auth');
    r.write('src/auth/token.ts', 'v2\n'); r.git('add', '-A'); r.git('commit', '-qm', 'feat(auth): rotate refresh tokens');
    r.write('src/auth/revoke.ts', 'x\n'); r.git('add', '-A'); r.git('commit', '-qm', 'feat(auth): revoke sessions');
    return r;
  };

  it('pr: title and description from the branch, as stdout / json', async () => {
    repo = prRepo(); reset();
    const r = await aic(['pr', '--pass-thru'], { cwd: repo.dir, env: env() });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('Add refresh token rotation\n\n## Summary\nRotates tokens on every use.\n\n## Changes\n- rotate\n- revoke\n');
    expect(r.stderr).toContain('feature/auth');
    const prompt = seen[0] ?? '';
    expect(prompt).toContain('feat(auth): rotate refresh tokens');
    expect(prompt).toContain('feat(auth): revoke sessions');
    expect(prompt).not.toContain('chore: init'); // only commits that are not in main
    expect(prompt).toContain('into main');
    const j = JSON.parse((await aic(['pr', '--json', '--base', 'main'], { cwd: repo.dir, env: env() })).stdout) as { title: string; commits: number; base: string };
    expect(j).toMatchObject({ title: 'Add refresh token rotation', commits: 2, base: 'main' });
  });

  it('pr: fills the repository template and supports conventional titles', async () => {
    repo = prRepo(); reset();
    repo.write('.github/pull_request_template.md', '## What changed\n\n## How to test\n- [ ] unit tests'); // untracked: must not appear in the diff
    await aic(['pr', '--pass-thru', '--conventional'], { cwd: repo.dir, env: env() });
    expect(seen[0]).toContain('How to test');
    expect(seen[0]).toContain('type(scope): subject');
    reset();
    await aic(['pr', '--pass-thru', '--no-template'], { cwd: repo.dir, env: env() });
    expect(seen[0]).not.toContain('How to test');
    expect((await aic(['pr', '--template', 'missing.md'], { cwd: repo.dir, env: env() })).code).toBe(2);
  });

  it('pr: clear errors when there is nothing to describe', async () => {
    repo = prRepo();
    repo.git('checkout', '-q', 'main');
    const none = await aic(['pr', '--base', 'main'], { cwd: repo.dir, env: env() });
    expect(none.code).toBe(1);
    expect(none.stderr).toContain('No commits');
    expect((await aic(['pr', '--base', 'nope'], { cwd: repo.dir, env: env() })).code).toBe(4);
  });

  it('pr: redacts secrets and withholds .env diffs before they reach a cloud model', async () => {
    repo = prRepo(); reset();
    // simulate a cloud endpoint: a custom provider on the mock, not loopback-exempt via name
    const key = 'AK' + 'IAABCDEFGHIJKLMNOP';
    repo.write('src/leak.ts', `const k = "${key}";\n`); repo.write('.env', 'DB_PASSWORD=hunter2hunter2\n'); repo.git('add', '-A'); repo.git('commit', '-qm', 'feat: oops');
    // Ollama on a non-loopback hostname counts as cloud: 127.0.0.2 still reaches the mock on Linux
    const url = server.url.replace('127.0.0.1', '127.0.0.2');
    const r = await aic(['pr', '--pass-thru', '--yes'], { cwd: repo.dir, env: env({ AIC_OLLAMA_URL: url }) });
    if (r.code === 0) {
      expect(seen.join('')).not.toContain(key);
      expect(seen.join('')).not.toContain('hunter2hunter2');
      expect(seen.join('')).toContain('[REDACTED]');
    } else {
      // platforms where 127.0.0.2 is not routable: the protection is still covered by the unit tests
      expect(r.stderr).toContain('Unable to connect');
    }
  });

  // ---- split -----------------------------------------------------------------------------
  const splitRepo = (): TempRepo => {
    const r = tempRepo();
    r.write('src/auth/token.ts', 'v1\n'); r.write('src/api/routes.ts', 'v1\n'); r.write('README.md', 'v1\n');
    r.git('add', '-A'); r.git('commit', '-qm', 'chore: init');
    r.write('src/auth/token.ts', 'v2\n'); r.write('src/auth/refresh.ts', 'new\n'); r.write('src/api/routes.ts', 'v2\n'); r.write('README.md', 'v2\n');
    return r;
  };
  const PLAN = JSON.stringify({ commits: [
    { title: 'rotate refresh tokens', type: 'feat', scope: 'auth', files: ['src/auth/token.ts', 'src/auth/refresh.ts'] },
    { title: 'fix route handling', type: 'fix', files: ['src/api/routes.ts'] },
    { title: 'document it', type: 'docs', files: ['README.md'] },
  ] });

  it('split --dry-run and --json show the plan and change nothing', async () => {
    repo = splitRepo(); reset(); planAnswer = '```json\n' + PLAN + '\n```';
    const r = await aic(['split', '--dry-run'], { cwd: repo.dir, env: env() });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('rotate refresh tokens');
    expect(r.stderr).toContain('1/3');
    expect(r.stderr).toContain('nothing was staged or committed');
    expect(repo.git('log', '--oneline').trim().split('\n')).toHaveLength(1);
    expect(repo.git('diff', '--cached', '--name-only').trim()).toBe('');
    expect(calls['message']).toBe(0);
    const j = JSON.parse((await aic(['split', '--json'], { cwd: repo.dir, env: env() })).stdout) as { commits: Array<{ files: string[] }> };
    expect(j.commits.map((c) => c.files.length)).toEqual([2, 1, 1]);
  });

  it('split --yes creates one commit per group, with every file committed exactly once', async () => {
    repo = splitRepo(); reset(); planAnswer = PLAN;
    const r = await aic(['split', '--yes'], { cwd: repo.dir, env: env() });
    expect(r.code).toBe(0);
    expect(calls['plan']).toBe(1);
    expect(calls['message']).toBe(3);
    const log = repo.git('log', '--format=%s').trim().split('\n');
    expect(log).toHaveLength(4);
    expect(log[0]).toMatch(/^docs/);
    expect(log[1]).toMatch(/^fix/);
    expect(log[2]).toMatch(/^feat\(auth\)/);
    expect(repo.git('status', '--porcelain').trim()).toBe('');
    const perCommit = repo.git('log', '--name-only', '--format=%x00', '-3').split('\0').map((s) => s.trim().split('\n').filter(Boolean)).filter((a) => a.length);
    expect(perCommit.flat().sort()).toEqual(['README.md', 'src/api/routes.ts', 'src/auth/refresh.ts', 'src/auth/token.ts']);
    expect(r.stderr).toContain('3 commits created');
  });

  it('split falls back to grouping by area when the model returns garbage', async () => {
    repo = splitRepo(); reset(); planAnswer = 'I am not able to produce JSON, sorry.';
    const r = await aic(['split', '--yes'], { cwd: repo.dir, env: env() });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('grouped by area instead');
    expect(repo.git('status', '--porcelain').trim()).toBe('');
    expect(repo.git('log', '--oneline').trim().split('\n').length).toBeGreaterThan(2);
  });

  it('split stops at a group with secrets (exit 5), keeps earlier commits, never sends that group to the model', async () => {
    repo = splitRepo(); reset(); planAnswer = PLAN;
    repo.write('src/api/routes.ts', `export const key = "${'AK' + 'IAABCDEFGHIJKLMNOP'}";\n`);
    const r = await aic(['split', '--yes'], { cwd: repo.dir, env: env() });
    expect(r.code).toBe(5);
    expect(r.stderr).toContain('Possible secrets in group 2/3');
    expect(r.stderr).not.toContain('AKIA');
    expect(calls['message']).toBe(1);
    expect(repo.git('log', '--oneline').trim().split('\n')).toHaveLength(2);
    expect(repo.git('diff', '--cached', '--name-only').trim()).toBe('src/api/routes.ts');
    expect(repo.git('status', '--porcelain')).toContain('README.md');
  });

  it('split input checks: one file, no terminal without --yes, bad --max-commits', async () => {
    repo = tempRepo();
    repo.write('a', '1'); repo.git('add', '-A'); repo.git('commit', '-qm', 'init'); repo.write('a', '2');
    expect((await aic(['split', '--yes'], { cwd: repo.dir, env: env() })).code).toBe(1);
    repo.cleanup(); repo = splitRepo(); planAnswer = PLAN;
    const noTty = await aic(['split'], { cwd: repo.dir, env: env() });
    expect(noTty.code).toBe(2);
    expect(noTty.stderr).toContain('needs a terminal or --yes');
    expect(repo.git('diff', '--cached', '--name-only').trim()).toBe('');
    expect((await aic(['split', '--max-commits', '1'], { cwd: repo.dir, env: env() })).code).toBe(2);
  });

  it('help lists the new commands', async () => {
    repo = tempRepo();
    const h = await aic(['--help'], { cwd: repo.dir });
    for (const w of ['split', 'pr', 'changelog', 'hook']) expect(h.stdout).toContain(w);
    expect((await aic(['hook', '--help'], { cwd: repo.dir })).stdout).toMatch(/install[\s\S]*uninstall[\s\S]*status/);
    expect((await aic(['hook', '--help'], { cwd: repo.dir })).stdout).not.toContain('run <file>');
    mkdirSync(join(repo.dir, 'x'), { recursive: true });
  });
});
