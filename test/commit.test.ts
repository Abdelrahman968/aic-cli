import { describe, expect, it } from 'vitest';
import { emojiFor, getBang, getScope, getType, inferScopes, normalizeMessage, scopeCandidate, scopeHint, setPrefix, strictRegex, validateMessage } from '../src/commit/format.js';
import { buildCommitMessages } from '../src/commit/prompt.js';
import { generateCommitMessage, type MessageState } from '../src/commit/generate.js';
import { COMMIT_TYPES, defaults } from '../src/config/schema.js';
import { CancelledError } from '../src/utils/errors.js';
import { FakeProvider } from './helpers.js';

const fmt = { emoji: false, bullets: 3 };
const vopts = { types: [...COMMIT_TYPES], scopes: [] as string[], subjectMax: 72 };

describe('normalizeMessage', () => {
  it('lowercases the subject, drops the trailing dot, converts bullets', () => {
    expect(normalizeMessage('Feat(auth): Add refresh token rotation.\n\n* rotate\n• revoke', fmt)).toBe('feat(auth): add refresh token rotation\n\n- rotate\n- revoke');
  });
  it('strips <think> blocks, fences, quotes and preambles', () => {
    const raw = '<think>planning...</think>\nHere is your commit:\n```text\n"fix(api): handle expired sessions"\n```';
    expect(normalizeMessage(raw, fmt)).toBe('fix(api): handle expired sessions');
    expect(normalizeMessage('<think>never closed', fmt)).toBe('');
  });
  it('limits bullets and supports subject-only', () => {
    const raw = 'feat: x\n\n- a\n- b\n- c\n- d';
    expect(normalizeMessage(raw, { emoji: false, bullets: 2 })).toBe('feat: x\n\n- a\n- b');
    expect(normalizeMessage(raw, { emoji: false, bullets: 0 })).toBe('feat: x');
  });
  it('keeps footers and adds a reference', () => {
    expect(normalizeMessage('fix: y\n\n- a\n\nBREAKING CHANGE: api', fmt)).toBe('fix: y\n\n- a\n\nBREAKING CHANGE: api');
    expect(normalizeMessage('fix: y', { ...fmt, ref: '#42' })).toBe('fix: y\n\nRefs: #42');
    expect(normalizeMessage('fix: y\n\nRefs: #42', { ...fmt, ref: '#42' })).toBe('fix: y\n\nRefs: #42');
  });
  it('enforces forced type, scope, and breaking even if the model ignored them', () => {
    expect(normalizeMessage('feat(ui): add x', fmt, { type: 'fix', scope: 'auth', breaking: true })).toBe('fix(auth)!: add x');
    expect(normalizeMessage('feat(ui): add x', fmt, { noScope: true })).toBe('feat: add x');
  });
  it('adds a gitmoji exactly once', () => {
    const out = normalizeMessage('feat(auth): add x', { emoji: true, bullets: 3 });
    expect(out).toBe(`feat(auth): ${emojiFor('feat')} add x`);
    expect(normalizeMessage(out, { emoji: true, bullets: 3 })).toBe(out);
  });
  it('returns empty for empty input', () => {
    expect(normalizeMessage('   ', fmt)).toBe('');
  });
});

describe('header helpers', () => {
  it('reads and rewrites type, scope, bang', () => {
    const m = 'feat(auth): add x\n\n- body';
    expect([getType(m), getScope(m), getBang(m)]).toEqual(['feat', 'auth', false]);
    expect(setPrefix(m, { type: 'fix' }, false)).toBe('fix(auth): add x\n\n- body');
    expect(setPrefix(m, { scope: '' }, false)).toBe('feat: add x\n\n- body');
    expect(setPrefix(m, { bang: true }, false)).toBe('feat(auth)!: add x\n\n- body');
    expect(setPrefix('just text', { type: 'chore' }, false)).toBe('chore: just text');
  });
});

describe('validateMessage', () => {
  it('accepts valid headers, including breaking and custom types', () => {
    expect(validateMessage('feat(auth)!: add x', vopts)).toEqual([]);
    expect(validateMessage('deps: bump x', { ...vopts, types: [...vopts.types, 'deps'] })).toEqual([]);
  });
  it('flags format, length and scope problems', () => {
    expect(validateMessage('Added things', vopts)[0]).toMatch(/not 'type\(scope\): subject'/);
    expect(validateMessage('feat: ' + 'x'.repeat(80), vopts)[0]).toMatch(/max 72/);
    expect(validateMessage('feat(zzz): ok', { ...vopts, scopes: ['api', 'web'] })[0]).toMatch(/scope 'zzz'/);
    expect(strictRegex(['feat']).test('fix: x')).toBe(false);
  });
});

describe('scope inference', () => {
  it('skips generic folders', () => {
    expect(scopeCandidate('src/app/dashboard/page.tsx')).toBe('dashboard');
    expect(scopeCandidate('README.md')).toBe('');
    expect(scopeHint(['src/auth/a.ts', 'src/auth/b.ts'])).toBe('auth');
    expect(scopeHint(['src/auth/a.ts', 'src/api/b.ts'])).toBe('');
  });
  it('ranks scopes for aic init', () => {
    expect(inferScopes(['src/api/a', 'src/api/b', 'src/web/c', 'README.md'])).toEqual(['api', 'web']);
  });
});

describe('prompt builder', () => {
  const ctx = { branch: 'feature/auth', recent: ['fix: a'], scopeHint: 'auth', stat: 'a.ts (+1 -0)', diff: '+x' };
  const base = { types: [...COMMIT_TYPES], scopes: [] as string[], bullets: 3, language: 'English', subjectMax: 72, instructions: '', model: 'm' };
  it('includes context, rules and examples', () => {
    const [sys, usr] = buildCommitMessages(ctx, base);
    expect(sys?.content).toContain('Conventional Commits');
    expect(sys?.content).toContain('max 72 characters');
    expect(usr?.content).toContain('Branch: feature/auth');
    expect(usr?.content).toContain('Likely scope (use it only if it fits): auth');
    expect(usr?.content).toContain('a.ts (+1 -0)');
  });
  it('applies language, forced type/scope, hint, custom instructions and subject-only mode', () => {
    const [sys, usr] = buildCommitMessages(ctx, { ...base, language: 'Arabic', type: 'fix', scope: 'api', hint: 'login bug', instructions: 'mention JIRA ids', bullets: 0 });
    expect(sys?.content).toContain('Write the subject and bullets in Arabic');
    expect(sys?.content).toContain('The type MUST be: fix');
    expect(sys?.content).toContain('The scope MUST be: api');
    expect(sys?.content).toContain('mention JIRA ids');
    expect(sys?.content).toContain('subject line only');
    expect(usr?.content).toContain('login bug');
    expect(usr?.content).not.toContain('Likely scope');
  });
  it('restricts scopes and adds the Qwen3 switch', () => {
    const [sys, usr] = buildCommitMessages(ctx, { ...base, scopes: ['api', 'web'], model: 'qwen3:8b' });
    expect(sys?.content).toContain('Allowed scopes: api, web');
    expect(usr?.content).not.toContain('Likely scope'); // hint "auth" is not an allowed scope
    expect(usr?.content).toContain('/no_think');
  });
});

describe('generateCommitMessage', () => {
  const context = { branch: 'main', recent: [], scopeHint: '', stat: 'a (+1 -0)', diff: '+x' };
  const settings = { ...defaults(), retries: 2 };
  const run = (p: FakeProvider, state: MessageState = { regen: 0 }, s = settings): ReturnType<typeof generateCommitMessage> =>
    generateCommitMessage({ provider: p, model: 'fake-model', settings: s, context, state });

  it('returns a normalized valid message with metadata', async () => {
    const p = new FakeProvider(['Fix(api): Handle expired sessions.']);
    const r = await run(p);
    expect(r.message).toBe('fix(api): handle expired sessions');
    expect(r.problems).toEqual([]);
    expect(r.meta).toMatchObject({ model: 'fake-model', attempt: 1 });
    expect(p.calls[0]?.maxTokens).toBe(settings.numPredict);
  });
  it('retries with feedback and a higher temperature when the format is wrong', async () => {
    const p = new FakeProvider(['I changed some things', 'feat: add things']);
    const retries: string[] = [];
    const r = await generateCommitMessage({ provider: p, model: 'm', settings, context, state: { regen: 0 }, onRetry: (x) => retries.push(x) });
    expect(r.message).toBe('feat: add things');
    expect(r.meta.attempt).toBe(2);
    expect(retries).toHaveLength(1);
    expect(p.calls[1]!.temperature).toBeGreaterThan(p.calls[0]!.temperature!);
    expect(p.calls[1]!.messages[1]!.content).toContain('previous answer was rejected');
  });
  it('returns the best attempt with problems when retries run out', async () => {
    const r = await run(new FakeProvider(['nonsense']), { regen: 0 }, { ...settings, retries: 1 });
    expect(r.problems.length).toBeGreaterThan(0);
  });
  it('regenerate raises the temperature', async () => {
    const p = new FakeProvider(['feat: a']);
    await run(p, { regen: 2 });
    expect(p.calls[0]!.temperature).toBeCloseTo(0.2 + 0.4);
  });
  it('honours forced type/scope in the result', async () => {
    const r = await run(new FakeProvider(['feat(ui): add x']), { regen: 0, type: 'fix', scope: 'auth' });
    expect(r.message).toBe('fix(auth): add x');
  });
  it('errors on empty output and supports cancellation', async () => {
    await expect(run(new FakeProvider(['<think>x</think>']), { regen: 0 }, { ...settings, retries: 0 })).rejects.toThrow(/empty message/);
    const ctl = new AbortController(); ctl.abort(new CancelledError());
    const p = new FakeProvider(['feat: x']);
    p.stream = (): never => { throw new DOMException('Aborted', 'AbortError'); };
    await expect(generateCommitMessage({ provider: p, model: 'm', settings, context, state: { regen: 0 }, signal: ctl.signal })).rejects.toBeInstanceOf(CancelledError);
  });
});
