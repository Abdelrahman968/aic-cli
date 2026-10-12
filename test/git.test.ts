import { afterEach, describe, expect, it } from 'vitest';
import { openRepo } from '../src/git/exec.js';
import { parsePorcelainZ, changedFiles, hasStagedChanges, summarize } from '../src/git/status.js';
import { parseNumstat, parseAddedLines, shrinkDiff, splitDiffByFile, stagedDiff, stagedStat, pathspecArgs, formatStat, diffFiles } from '../src/git/diff.js';
import { add, checkUndo, commit, planPush, softUndo, unstage } from '../src/git/commit.js';
import { currentBranch, aheadBehind } from '../src/git/branch.js';
import { lastCommit, recentSubjects, hasCommits } from '../src/git/history.js';
import { GitError } from '../src/utils/errors.js';
import { rejection, tempRepo, type TempRepo } from './helpers.js';

describe('parsers', () => {
  it('parses porcelain -z including renames, untracked and partial staging', () => {
    const raw = ['M  a.ts', ' M b.ts', 'MM c.ts', '?? d.ts', 'R  new.ts', 'old.ts', 'A  e.ts', 'D  f.ts'].join('\0') + '\0';
    const f = parsePorcelainZ(raw);
    expect(f.map((x) => [x.path, x.code, x.staged, x.dirty, x.untracked])).toEqual([
      ['a.ts', 'M', true, false, false], ['b.ts', 'M', false, true, false], ['c.ts', 'M', true, true, false],
      ['d.ts', '?', false, false, true], ['new.ts', 'R', true, false, false], ['e.ts', 'A', true, false, false], ['f.ts', 'D', true, false, false],
    ]);
    expect(f[4]?.oldPath).toBe('old.ts');
    expect(summarize(f)).toMatchObject({ total: 7 });
    expect(summarize(f).staged).toHaveLength(5);
  });
  it('parses numstat including binary files', () => {
    expect(parseNumstat('3\t1\tsrc/a.ts\n-\t-\timg.png\n')).toEqual([
      { path: 'src/a.ts', add: 3, del: 1, binary: false }, { path: 'img.png', add: 0, del: 0, binary: true },
    ]);
    expect(formatStat(parseNumstat('3\t1\ta\n-\t-\tb'))).toBe('a (+3 -1)\nb (binary)');
  });
  const DIFF = [
    'diff --git a/src/a.ts b/src/a.ts', 'index 1..2 100644', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,2 +10,3 @@ fn', ' ctx', '+added one', '-removed', '+added two',
    'diff --git a/b.env b/b.env', 'new file mode 100644', '--- /dev/null', '+++ b/b.env', '@@ -0,0 +1 @@', '+KEY=1', '',
  ].join('\n');
  it('maps added lines to file and line numbers', () => {
    expect(parseAddedLines(DIFF)).toEqual([
      { file: 'src/a.ts', line: 11, text: 'added one' }, { file: 'src/a.ts', line: 12, text: 'added two' }, { file: 'b.env', line: 1, text: 'KEY=1' },
    ]);
    expect(diffFiles(DIFF)).toEqual(['src/a.ts', 'b.env']);
    expect(splitDiffByFile(DIFF)).toHaveLength(2);
  });
  it('shrinks fairly: small files stay whole, big ones are cut', () => {
    const small = 'diff --git a/s b/s\n+x\n';
    const big = 'diff --git a/big b/big\n' + '+line\n'.repeat(1000);
    const out = shrinkDiff(small + big, 600);
    expect(out).toContain(small);
    expect(out.length).toBeLessThan(900);
    expect(out).toContain('[... truncated ...]');
    expect(shrinkDiff(small, 600)).toBe(small);
  });
  it('excludes lockfiles by default', () => {
    expect(pathspecArgs(['*.svg']).join(' ')).toContain(':(exclude)*package-lock.json');
    expect(pathspecArgs(['*.svg']).join(' ')).toContain(':(exclude)*.svg');
  });
});

describe('against a real repository', () => {
  let repo: TempRepo;
  afterEach(() => repo?.cleanup());

  it('rejects directories that are not repositories', async () => {
    const e = await rejection<GitError>(openRepo('/'));
    expect(e).toBeInstanceOf(GitError);
    expect((e as GitError).code).toBe(4);
  });

  it('stats, diffs, stages, commits, and soft-undoes', async () => {
    repo = tempRepo();
    repo.write('src/a.ts', 'one\n'); repo.write('package-lock.json', '{}\n');
    repo.git('add', '-A'); repo.git('commit', '-qm', 'chore: init');
    const git = await openRepo(repo.dir);
    expect(await hasCommits(git)).toBe(true);
    expect(await currentBranch(git)).toMatch(/master|main/);

    repo.write('src/a.ts', 'one\ntwo\n'); repo.write('package-lock.json', '{"x":1}\n'); repo.write('new.txt', 'n\n');
    expect((await changedFiles(git)).map((f) => f.path).sort()).toEqual(['new.txt', 'package-lock.json', 'src/a.ts']);
    expect(await hasStagedChanges(git)).toBe(false);

    await add(git, 'all');
    expect(await hasStagedChanges(git)).toBe(true);
    const stat = await stagedStat(git);
    expect(stat.map((s) => s.path).sort()).toEqual(['new.txt', 'src/a.ts']); // lockfile filtered out
    expect(await stagedDiff(git)).toContain('+two');

    await unstage(git, ['new.txt']);
    expect((await stagedStat(git)).map((s) => s.path)).toEqual(['src/a.ts']);

    const code = await commit(git, { message: 'feat(a): add two\n\n- body line', toStderr: true });
    expect(code).toBe(0);
    expect((await lastCommit(git))?.subject).toBe('feat(a): add two');
    expect(repo.git('log', '-1', '--format=%B').trim()).toBe('feat(a): add two\n\n- body line');
    expect(await recentSubjects(git, 5)).toEqual(['feat(a): add two', 'chore: init']);

    const check = await checkUndo(git);
    expect(check).toEqual({ ok: true, published: false });
    await softUndo(git);
    expect((await lastCommit(git))?.subject).toBe('chore: init');
    expect(await hasStagedChanges(git)).toBe(true); // nothing lost: still staged
  });

  it('commit handles unicode and quotes safely (message goes through a file)', async () => {
    repo = tempRepo();
    repo.write('a.txt', 'a\n'); repo.git('add', '-A');
    const git = await openRepo(repo.dir);
    const msg = 'fix(مصادقة): handle "quotes" & $(echo no) `ticks`\n\n- نقطة';
    expect(await commit(git, { message: msg, toStderr: true })).toBe(0);
    expect(repo.git('log', '-1', '--format=%B').trim()).toBe(msg);
  });

  it('does not allow undoing the very first commit this way', async () => {
    repo = tempRepo();
    repo.write('a', '1'); repo.git('add', '-A'); repo.git('commit', '-qm', 'first');
    const c = await checkUndo(await openRepo(repo.dir));
    expect(c.ok).toBe(false);
    expect(c.reason).toMatch(/first commit/);
  });

  it('refuses to push when there is no remote, and plans an upstream push when there is one', async () => {
    repo = tempRepo();
    repo.write('a', '1'); repo.git('add', '-A'); repo.git('commit', '-qm', 'first');
    const git = await openRepo(repo.dir);
    await expect(planPush(git)).rejects.toThrow(/no remote/);
    repo.git('remote', 'add', 'origin', 'https://example.com/x.git');
    const plan = await planPush(git);
    expect(plan.setUpstream).toBe(true);
    expect(plan.command).toEqual(['git', 'push', '-u', 'origin', 'HEAD']);
    expect(plan.command).not.toContain('--force');
    expect((await aheadBehind(git)).upstream).toBeUndefined();
  });

  it('amend diff compares with the parent commit', async () => {
    repo = tempRepo();
    repo.write('a', '1\n'); repo.git('add', '-A'); repo.git('commit', '-qm', 'first');
    repo.write('a', '1\n2\n'); repo.git('add', '-A'); repo.git('commit', '-qm', 'second');
    const git = await openRepo(repo.dir);
    expect(await stagedDiff(git, { amend: true })).toContain('+2');
    expect(await stagedStat(git)).toEqual([]);
    expect((await stagedStat(git, { amend: true })).length).toBe(1);
  });
});
