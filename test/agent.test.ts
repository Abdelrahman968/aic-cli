import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { plan, parseModifiers } from '../src/agent/planner.js';
import { ToolCallFilter, parseToolCall, runAgentLoop, visibleText } from '../src/agent/loop.js';
import { TOOLS, authorize, executeTool, getTool, makePolicy, safeRepoPath, type ApprovalPolicy, type ToolContext } from '../src/agent/tools.js';
import { assemble } from '../src/agent/context.js';
import { openRepo } from '../src/git/exec.js';
import { defaults } from '../src/config/schema.js';
import { FakeProvider, tempRepo, type TempRepo } from './helpers.js';

describe('planner: natural language -> intent', () => {
  const kind = (s: string, pending = false): string => plan(s, { hasPending: pending }).intent.kind;
  it('routes the documented examples', () => {
    expect(kind('generate a commit for my current changes')).toBe('generate');
    expect(kind('commit my current changes')).toBe('commit');
    expect(kind('explain what changed')).toBe('explain');
    expect(kind('create a conventional commit')).toBe('generate');
    expect(kind('show me the diff')).toBe('diff');
    expect(kind('regenerate using another model')).toBe('regenerate');
    expect(kind('analyze my changes')).toBe('explain');
  });
  it('"use a shorter commit message" regenerates only when a message is pending', () => {
    expect(kind('use a shorter commit message', true)).toBe('regenerate');
    expect(plan('use a shorter commit message', { hasPending: true }).intent).toMatchObject({ modifiers: { shorter: true } });
  });
  it('detects commit-and-push and plain push', () => {
    expect(plan('commit and push everything')).toMatchObject({ intent: { kind: 'commit', push: true, all: true } });
    expect(kind('push it')).toBe('push');
  });
  it('does not treat questions about commits as commands', () => {
    expect(kind('what is a conventional commit?')).not.toBe('commit');
    expect(kind('how do I commit only one file?')).toBe('chat');
  });
  it('routes slash commands', () => {
    expect(kind('/status')).toBe('status');
    expect(plan('/diff unstaged').intent).toMatchObject({ kind: 'diff', staged: false });
    expect(plan('/history 5').intent).toMatchObject({ kind: 'history', count: 5 });
    expect(plan('/commit push').intent).toMatchObject({ kind: 'commit', push: true });
    expect(plan('/regenerate fix typo in login').intent).toMatchObject({ kind: 'regenerate', modifiers: { hint: 'fix typo in login' } });
    for (const c of ['/help', '/exit', '/clear', '/undo', '/push', '/model', '/provider', '/config']) expect(plan(c).intent.kind).not.toBe('chat');
    expect(kind('/unknown-thing')).toBe('help');
  });
  it('falls back to the model for anything else', () => {
    expect(kind('why does the login test fail on CI?')).toBe('chat');
  });
  it('extracts modifiers', () => {
    expect(parseModifiers('make it shorter with emoji, type fix, scope auth in French')).toMatchObject({ shorter: true, emoji: true, type: 'fix', scope: 'auth', language: 'French' });
    expect(parseModifiers('without scope')).toMatchObject({ noScope: true });
  });
});

describe('tool-call protocol', () => {
  it('parses calls, including fenced JSON and "arguments"', () => {
    expect(parseToolCall('<tool_call>{"name":"git_log","args":{"count":3}}</tool_call>')).toEqual({ name: 'git_log', args: { count: 3 } });
    expect(parseToolCall('Let me look.\n<tool_call>\n```json\n{"name":"read_file","arguments":{"path":"a.ts"}}\n```\n</tool_call>')).toEqual({ name: 'read_file', args: { path: 'a.ts' } });
    expect(parseToolCall('plain answer')).toBeUndefined();
    expect(parseToolCall('<tool_call>{broken</tool_call>')).toBeUndefined();
    expect(visibleText('Checking...\n<tool_call>{"name":"x"}</tool_call>')).toBe('Checking...');
  });
  it('filter hides tool calls even when split across chunks', () => {
    const f = new ToolCallFilter();
    const shown = ['Hello <to', 'ol_call>{"name"', ':"git_log"}</tool_call>'].map((c) => f.push(c)).join('') + f.end();
    expect(shown).toBe('Hello ');
  });
  it('filter releases a false alarm', () => {
    const f = new ToolCallFilter();
    expect((f.push('a <tool') + f.push('box> b') + f.end())).toBe('a <toolbox> b');
  });
});

describe('approval policy: --yes is not "ignore all safety"', () => {
  const ctx = {} as ToolContext;
  const confirmYes = vi.fn(async () => true);
  const confirmNo = vi.fn(async () => false);
  const policy = (o: Partial<Parameters<typeof makePolicy>[0]> = {}): ApprovalPolicy => makePolicy({ interactive: true, yes: false, autoApprove: [], explicit: new Set<string>(), confirm: confirmYes, ...o });
  const tool = (n: string) => getTool(n)!;

  it('read tools never ask', async () => {
    const c = vi.fn(async () => false);
    expect((await authorize(tool('git_status'), {}, ctx, policy({ confirm: c }))).allowed).toBe(true);
    expect(c).not.toHaveBeenCalled();
  });
  it('write tools ask by default and are skipped by --yes or autoApprove', async () => {
    confirmYes.mockClear();
    expect((await authorize(tool('git_add'), { all: true }, ctx, policy())).allowed).toBe(true);
    expect(confirmYes).toHaveBeenCalledWith('git add -A', expect.anything());
    expect((await authorize(tool('git_add'), { all: true }, ctx, policy({ confirm: confirmNo }))).allowed).toBe(false);
    expect((await authorize(tool('git_commit'), { message: 'x' }, ctx, policy({ yes: true, confirm: confirmNo }))).allowed).toBe(true);
    expect((await authorize(tool('git_commit'), { message: 'x' }, ctx, policy({ autoApprove: ['git_commit'], confirm: confirmNo }))).allowed).toBe(true);
  });
  it('push is NOT bypassed by --yes alone; needs an explicit --push or autoApprove', async () => {
    expect((await authorize(tool('git_push'), {}, ctx, policy({ yes: true, confirm: confirmNo }))).allowed).toBe(false);
    expect((await authorize(tool('git_push'), {}, ctx, policy({ yes: true, explicit: new Set(['git_push']), confirm: confirmNo }))).allowed).toBe(true);
    expect((await authorize(tool('git_push'), {}, ctx, policy({ autoApprove: ['git_push'], confirm: confirmNo }))).allowed).toBe(true);
  });
  it('soft undo needs --yes AND explicit intent; autoApprove can never cover git_reset', async () => {
    const undo = { mode: 'soft_undo' };
    expect((await authorize(tool('git_reset'), undo, ctx, policy({ yes: true, confirm: confirmNo }))).allowed).toBe(false);
    expect((await authorize(tool('git_reset'), undo, ctx, policy({ autoApprove: ['git_reset'], confirm: confirmNo }))).allowed).toBe(false);
    expect((await authorize(tool('git_reset'), undo, ctx, policy({ yes: true, explicit: new Set(['git_reset']), confirm: confirmNo }))).allowed).toBe(true);
    expect(tool('git_reset').risk({ mode: 'soft_undo' })).toBe('history');
    expect(tool('git_reset').risk({ mode: 'unstage' })).toBe('write');
  });
  it('non-interactive runs refuse anything that would need a question', async () => {
    const r = await authorize(tool('git_push'), {}, ctx, policy({ interactive: false }));
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/needs confirmation/);
  });
  it('exposes no force-push, hard reset, clean or delete tool', () => {
    const names = TOOLS.map((t) => t.name).join(' ');
    expect(names).not.toMatch(/force|hard|clean|delete|rm\b|remove/);
    expect(JSON.stringify(TOOLS.map((t) => t.describe({ mode: 'soft_undo' }, {} as ToolContext)))).not.toMatch(/--force|--hard|clean/);
  });
});

describe('tools against a repository', () => {
  let repo: TempRepo;
  afterEach(() => repo?.cleanup());
  const make = async (): Promise<ToolContext> => {
    repo = tempRepo();
    repo.write('src/a.ts', 'line1\nline2\nneedle here\n'); repo.write('.env', 'SECRET=1\n'); repo.write('.gitignore', 'ignored.txt\n'); repo.write('ignored.txt', 'x\n');
    repo.git('add', '-A'); repo.git('commit', '-qm', 'init');
    return { git: await openRepo(repo.dir), settings: defaults(), redact: false };
  };
  const never = makePolicy({ interactive: false, yes: false, autoApprove: [], explicit: new Set<string>(), confirm: async () => false });

  it('reads files with line numbers, refuses secrets, ignored files and escapes', async () => {
    const ctx = await make();
    const ok = await executeTool('read_file', { path: 'src/a.ts', startLine: 2 }, ctx, never);
    expect(ok.ok).toBe(true);
    expect(ok.output).toContain('2: line2');
    expect((await executeTool('read_file', { path: '.env' }, ctx, never)).output).toMatch(/credentials/);
    expect((await executeTool('read_file', { path: 'ignored.txt' }, ctx, never)).output).toMatch(/gitignore/);
    expect((await executeTool('read_file', { path: '../../etc/passwd' }, ctx, never)).output).toMatch(/outside the repository/);
    expect((await executeTool('read_file', { path: '/etc/passwd' }, ctx, never)).output).toMatch(/outside the repository/);
  });
  it('does not follow symlinks out of the repository', async () => {
    const ctx = await make();
    symlinkSync('/etc/hostname', join(repo.dir, 'link.txt'));
    expect((await executeTool('read_file', { path: 'link.txt' }, ctx, never)).output).toMatch(/outside the repository/);
    expect(safeRepoPath(repo.dir, 'src/a.ts')).toMatchObject({ rel: 'src/a.ts' });
  });
  it('searches without touching ignored or secret files', async () => {
    const ctx = await make();
    repo.write('.env.local', 'needle=1\n'); repo.write('ignored.txt', 'needle\n');
    const r = await executeTool('search_files', { query: 'needle' }, ctx, never);
    expect(r.output).toContain('src/a.ts');
    expect(r.output).not.toContain('.env');
    expect(r.output).not.toContain('ignored.txt');
    expect((await executeTool('search_files', { query: 'zzzzqqq' }, ctx, never)).output).toBe('(no matches)');
  });
  it('honours sendDiff=false and redacts for cloud providers', async () => {
    const ctx = await make();
    repo.write('src/a.ts', 'x = 1\n'); repo.git('add', '-A');
    expect((await executeTool('git_diff_cached', {}, { ...ctx, settings: { ...ctx.settings, sendDiff: false } }, never)).ok).toBe(false);
    repo.write('src/b.ts', 'k = "' + 'AK' + 'IAABCDEFGHIJKLMNOP' + '"\n'); repo.git('add', '-A');
    const out = await executeTool('git_diff_cached', {}, { ...ctx, redact: true }, never);
    expect(out.output).toContain('[REDACTED]');
  });
  it('write tools are refused without confirmation in non-interactive mode and nothing changes', async () => {
    const ctx = await make();
    repo.write('new.txt', 'n\n');
    const r = await executeTool('git_add', { all: true }, ctx, never);
    expect(r.ok).toBe(false);
    expect(repo.git('diff', '--cached', '--name-only')).toBe('');
    const ok = await executeTool('git_add', { paths: ['new.txt'] }, ctx, makePolicy({ interactive: false, yes: true, autoApprove: [], explicit: new Set<string>(), confirm: async () => false }));
    expect(ok.ok).toBe(true);
    expect(repo.git('diff', '--cached', '--name-only').trim()).toBe('new.txt');
    expect((await executeTool('git_add', { paths: ['../x'] }, ctx, makePolicy({ interactive: false, yes: true, autoApprove: [], explicit: new Set<string>(), confirm: async () => false }))).output).toMatch(/outside/);
  });
  it('rejects unknown tools', async () => {
    const ctx = await make();
    expect((await executeTool('rm_rf', {}, ctx, never)).output).toMatch(/unknown tool/);
  });

  it('agent loop: model asks for a tool, gets the result, then answers', async () => {
    const ctx = await make();
    const provider = new FakeProvider(['<tool_call>{"name":"git_log","args":{"count":1}}</tool_call>', 'The last commit is "init".']);
    const events: string[] = [];
    let streamed = '';
    const res = await runAgentLoop({
      provider, model: 'm', messages: [{ role: 'user', content: 'what was the last commit?' }], tools: ctx, policy: never,
      temperature: 0.2, maxTokens: 100, contextLength: 4096, timeoutMs: 5000,
      io: { onText: (t) => { streamed += t; }, onToolStart: (c) => events.push(`start:${c.name}`), onToolEnd: (c, r) => events.push(`end:${c.name}:${r.ok}`) },
    });
    expect(events).toEqual(['start:git_log', 'end:git_log:true']);
    expect(res.text).toBe('The last commit is "init".');
    expect(streamed).toBe('The last commit is "init".'); // the raw tool call is never shown
    const fed = provider.calls[1]!.messages.find((m) => m.content.includes('<tool_result'))!;
    expect(fed.content).toContain('<tool_result name="git_log"');
    expect(fed.content).toContain('init');
  });
  it('agent loop stops after the step limit', async () => {
    const ctx = await make();
    const provider = new FakeProvider(['<tool_call>{"name":"git_status","args":{}}</tool_call>']);
    const res = await runAgentLoop({ provider, model: 'm', messages: [{ role: 'user', content: 'x' }], tools: ctx, policy: never, temperature: 0, maxTokens: 10, contextLength: 1024, timeoutMs: 1000, maxSteps: 2 });
    expect(res.toolCalls).toBe(2);
  });
  it('agent loop: a dangerous call from the model is blocked, and the model is told', async () => {
    const ctx = await make();
    const provider = new FakeProvider(['<tool_call>{"name":"git_push","args":{}}</tool_call>', 'I could not push.']);
    const res = await runAgentLoop({ provider, model: 'm', messages: [{ role: 'user', content: 'push' }], tools: ctx, policy: never, temperature: 0, maxTokens: 10, contextLength: 1024, timeoutMs: 1000 });
    expect(provider.calls[1]!.messages.find((m) => m.content.includes('<tool_result'))!.content).toContain('not executed');
    expect(res.text).toBe('I could not push.');
  });
});

describe('context assembly under a budget', () => {
  const shrink = (t: string, n: number): string => t.slice(0, n);
  const sections = [
    { id: 'repo', title: 'Repository', priority: 100, text: 'name: x' },
    { id: 'diff', title: 'Diff', priority: 70, text: 'd'.repeat(5000), shrink, minChars: 300 },
    { id: 'history', title: 'History', priority: 40, text: 'h'.repeat(2000), shrink, minChars: 100 },
  ];
  it('returns everything when it fits', () => {
    const a = assemble(sections, 100000);
    expect(a.truncated).toEqual([]);
    expect(a.text).toContain('## History');
  });
  it('shrinks low-priority sections first, then drops them, and never drops the repo header', () => {
    const a = assemble(sections, 5500);
    expect(a.truncated).toContain('history');
    expect(a.used).toBeLessThanOrEqual(5600);
    const tiny = assemble(sections, 400);
    expect(tiny.dropped).toContain('history');
    expect(tiny.text).toContain('name: x');
  });
});
