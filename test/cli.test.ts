import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { normalizeLegacyArgv } from '../src/cli/legacy.js';
import { collect, flagsToLayer, validateType } from '../src/cli/options.js';
import { buildProgram } from '../src/cli/program.js';
import { Ui } from '../src/cli/ui/output.js';
import { AicError, ExitCode, GitError, ProviderError, SecretError, UsageError } from '../src/utils/errors.js';
import { maskSecret, redactSecrets } from '../src/utils/redact.js';
import { json, startServer, tempRepo, type TempRepo } from './helpers.js';

const ROOT = resolve(import.meta.dirname, '..');
const TSX = join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');

interface Run { code: number; stdout: string; stderr: string }
function aic(args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }): Promise<Run> {
  return new Promise((res) => {
    const base = { ...process.env };
    for (const k of Object.keys(base)) if (k.startsWith('AIC_') || k === 'OLLAMA_HOST') delete base[k]; // isolate from the developer's own setup
    const env = { ...base, NO_COLOR: '1', CI: '1', TERM: 'dumb', ...opts.env };
    const c = spawn(TSX, [join(ROOT, 'src/index.ts'), ...args], { cwd: opts.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    c.stdout.on('data', (d) => (stdout += d)); c.stderr.on('data', (d) => (stderr += d));
    c.on('close', (code) => res({ code: code ?? -1, stdout, stderr }));
  });
}

describe('legacy PowerShell flags', () => {
  it('maps switches and values onto the new CLI and routes to commit', () => {
    expect(normalizeLegacyArgv(['-All', '-Push', '-DryRun', '-Type', 'fix', '-Scope', 'auth'])).toEqual({
      argv: ['commit', '--all', '--push', '--dry-run', '--type', 'fix', '--scope', 'auth'], translated: true,
    });
  });
  it('is case-insensitive like PowerShell', () => {
    expect(normalizeLegacyArgv(['-yes', '-NOSCAN']).argv).toEqual(['commit', '--yes', '--no-scan']);
  });
  it('routes -Undo and -Init to their commands', () => {
    expect(normalizeLegacyArgv(['-Undo', '-Yes']).argv).toEqual(['undo', '--yes']);
    expect(normalizeLegacyArgv(['-Init']).argv).toEqual(['init']);
  });
  it('maps the value options', () => {
    expect(normalizeLegacyArgv(['-Model', 'x', '-OllamaUrl', 'http://h', '-MaxChars', '3000', '-TimeoutSec', '30', '-Bullets', '0', '-Language', 'Arabic', '-Hint', 'login']).argv)
      .toEqual(['commit', '--model', 'x', '--ollama-url', 'http://h', '--max-chars', '3000', '--timeout', '30', '--bullets', '0', '--language', 'Arabic', '--hint', 'login']);
  });
  it('does not touch modern syntax', () => {
    const a = ['commit', '--all', '-m', 'x', '-p', 'openai', '-v'];
    expect(normalizeLegacyArgv(a)).toEqual({ argv: a, translated: false });
    expect(normalizeLegacyArgv(['config', 'set', 'model', 'x']).translated).toBe(false);
  });
  it('maps -Scopes (allowed scope list) separately from -Scope', () => {
    expect(normalizeLegacyArgv(['-Scopes', 'api,web', '-Scope', 'api']).argv).toEqual(['commit', '--scopes', 'api,web', '--scope', 'api']);
    expect(flagsToLayer({ scopes: ['api', 'web'] })).toEqual({ scopes: ['api', 'web'] });
  });
  it('keeps an explicit subcommand', () => {
    expect(normalizeLegacyArgv(['generate', '-Copy']).argv).toEqual(['generate', '--copy']);
  });
});

describe('option plumbing', () => {
  it('turns flags into the CLI config layer with validation', () => {
    expect(flagsToLayer({ model: 'm', bullets: '2', maxChars: '9000', emoji: true, scan: false, startOllama: true, exclude: ['*.svg'], timeout: '60', verify: false })).toEqual({
      model: 'm', bullets: 2, maxChars: 9000, emoji: true, secretScan: false, autoStartOllama: true, exclude: ['*.svg'], timeoutSec: 60, noVerify: true,
    });
    expect(flagsToLayer({})).toEqual({});
    expect(() => flagsToLayer({ bullets: '99' })).toThrow(UsageError);
    expect(() => flagsToLayer({ temperature: 'hot' })).toThrow(/number/);
  });
  it('validates commit types against configuration', () => {
    expect(() => validateType('feat', ['feat'])).not.toThrow();
    expect(() => validateType('nope', ['feat'])).toThrow(/Invalid commit type/);
    expect(() => validateType(undefined, ['feat'])).not.toThrow();
  });
  it('collects repeatable and comma separated values', () => {
    expect(collect('a,b', ['x'])).toEqual(['x', 'a', 'b']);
  });
});

describe('program definition', () => {
  it('registers every documented command and subcommand', () => {
    const { program } = buildProgram();
    const names = program.commands.map((c) => c.name());
    expect(names).toEqual(expect.arrayContaining(['chat', 'generate', 'commit', 'push', 'undo', 'status', 'init', 'doctor', 'provider', 'model', 'config']));
    const sub = (n: string): string[] => program.commands.find((c) => c.name() === n)!.commands.map((c) => c.name());
    expect(sub('provider')).toEqual(expect.arrayContaining(['list', 'add', 'remove', 'use', 'test']));
    expect(sub('model')).toEqual(expect.arrayContaining(['list', 'use', 'current', 'test']));
    expect(sub('config')).toEqual(expect.arrayContaining(['list', 'get', 'set', 'unset', 'reset', 'edit', 'path']));
  });
  it('covers every option of the PowerShell script', () => {
    const { program } = buildProgram();
    const commit = program.commands.find((c) => c.name() === 'commit')!;
    const longs = new Set([...program.options, ...commit.options].map((o) => o.long));
    for (const l of ['--all', '--pick', '--amend', '--dry-run', '--yes', '--push', '--copy', '--pass-thru', '--no-scan', '--start-ollama', '--ollama-url', '--model', '--hint', '--type', '--scope', '--breaking', '--scopes', '--language', '--bullets', '--history', '--max-chars', '--exclude', '--emoji', '--ref', '--signoff', '--no-verify', '--unload', '--keep-alive', '--num-ctx', '--num-predict', '--temperature', '--retries', '--timeout']) {
      expect(longs, l).toContain(l);
    }
  });
});

describe('error rendering', () => {
  const capture = (fn: (u: Ui) => void): string => {
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((s: string) => { chunks.push(String(s)); return true; }) as never);
    try { const u = new Ui({ plain: true }); fn(u); } finally { spy.mockRestore(); }
    return chunks.join('');
  };
  it('shows what happened, why, and what to try', () => {
    const out = capture((u) => u.error(new ProviderError('Unable to connect to Ollama', { details: 'URL: http://localhost:11434', causes: ['Ollama is not running', 'The configured URL is incorrect'], try: ['aic doctor', 'ollama serve'] })));
    expect(out).toContain('Unable to connect to Ollama');
    expect(out).toContain('URL: http://localhost:11434');
    expect(out).toContain('Possible causes:');
    expect(out).toContain('Ollama is not running');
    expect(out).toContain('Try:');
    expect(out).toContain('aic doctor');
    expect(out).not.toContain('fetch failed');
  });
  it('never prints registered secrets', () => {
    const out = capture((u) => { u.protect('super-secret-key-9999'); u.error(new AicError('bad token super-secret-key-9999')); u.write('also super-secret-key-9999'); });
    expect(out).not.toContain('super-secret-key-9999');
    expect(out).toContain('***');
  });
  it('maps error classes to the documented exit codes', () => {
    const u = new Ui({ plain: true });
    expect([new UsageError('x'), new ProviderError('x'), new GitError('x'), new SecretError('x'), new AicError('x'), new Error('x')].map((e) => u.codeFor(e))).toEqual([2, 3, 4, 5, 1, 1]);
    expect(ExitCode).toEqual({ OK: 0, GENERAL: 1, USAGE: 2, PROVIDER: 3, GIT: 4, SECRET: 5, CANCELLED: 6 });
  });
  it('masks and redacts keys', () => {
    expect(maskSecret('sk-abcdefghijklmnop')).not.toContain('abcdefghij');
    expect(maskSecret('short')).toBe('*****');
    expect(redactSecrets('GET /x?key=AIzaSECRET123&a=1 Authorization: Bearer tok-123456789', ['tok-123456789'])).not.toMatch(/AIzaSECRET123|tok-123456789/);
  });
});

describe('end to end (real CLI process, mock model server, temp repository)', () => {
  let repo: TempRepo;
  let cfg: string;
  let server: Awaited<ReturnType<typeof startServer>>;
  const MSG = 'Feat(auth): Add refresh token rotation.\n\n* rotate tokens on use\n* revoke old sessions\n';
  let chatCalls = 0;

  beforeAll(async () => {
    server = await startServer((r, res) => {
      if (r.url === '/api/tags') return json(res, { models: [{ name: 'qwen2.5-coder:7b', size: 4_700_000_000, details: { family: 'qwen2', parameter_size: '7B' } }] });
      if (r.url === '/api/show') return json(res, { capabilities: ['completion'] });
      if (r.url === '/api/chat') {
        chatCalls++;
        res.setHeader('content-type', 'application/x-ndjson');
        res.write(JSON.stringify({ message: { content: MSG } }) + '\n');
        return res.end(JSON.stringify({ done: true, eval_count: 20, eval_duration: 1e9 }) + '\n');
      }
      if (r.url === '/v1/models') return json(res, { data: [{ id: 'my-model' }] });
      if (r.url === '/v1/chat/completions') {
        if (r.headers['authorization'] !== 'Bearer sekret-key-123') return json(res, { error: { message: 'bad key' } }, 401);
        res.setHeader('content-type', 'text/event-stream');
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'fix(api): handle expired sessions' } }] })}\n\ndata: [DONE]\n\n`);
        return res.end();
      }
      res.statusCode = 404; res.end('{}');
    });
  });
  afterAll(async () => { await server.close(); });

  const fresh = (): void => {
    repo?.cleanup(); if (cfg) rmSync(cfg, { recursive: true, force: true });
    repo = tempRepo(); cfg = mkdtempSync(join(tmpdir(), 'aic-e2e-cfg-'));
    repo.write('src/auth/token.ts', 'export const a = 1;\n'); repo.git('add', '-A'); repo.git('commit', '-qm', 'chore: init');
    repo.write('src/auth/token.ts', 'export const a = 2;\n'); repo.git('add', '-A');
    chatCalls = 0;
  };
  afterEach(() => { repo?.cleanup(); if (cfg) rmSync(cfg, { recursive: true, force: true }); });
  const run = (args: string[], env: NodeJS.ProcessEnv = {}): Promise<Run> =>
    aic(['--ollama-url', server.url, ...args], { cwd: repo.dir, env: { AIC_CONFIG_DIR: cfg, ...env } });

  it('--version and --help', async () => {
    fresh();
    const v = await aic(['--version'], { cwd: repo.dir });
    expect(v.code).toBe(0);
    expect(v.stdout.trim()).toBe((JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version);
    const h = await aic(['--help'], { cwd: repo.dir });
    expect(h.code).toBe(0);
    for (const w of ['chat', 'generate', 'commit', 'push', 'provider', 'model', 'config', 'init', 'undo', 'status', 'doctor', '--dry-run', '--yes', '--no-scan', '--verbose']) expect(h.stdout).toContain(w);
    const hp = await aic(['help', 'provider'], { cwd: repo.dir });
    expect(hp.stdout).toMatch(/list[\s\S]*add[\s\S]*remove[\s\S]*use[\s\S]*test/);
    expect((await aic(['provider', '--help'], { cwd: repo.dir })).code).toBe(0);
  });

  it('generate --pass-thru prints only the message on stdout', async () => {
    fresh();
    const r = await run(['generate', '--pass-thru']);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('feat(auth): add refresh token rotation\n\n- rotate tokens on use\n- revoke old sessions\n');
    expect(r.stderr).toContain('nothing was committed');
    expect(repo.git('log', '--oneline').trim().split('\n')).toHaveLength(1);
  });

  it('commit --dry-run and --copy never commit', async () => {
    fresh();
    expect((await run(['commit', '--dry-run'])).code).toBe(0);
    expect(repo.git('log', '--oneline').trim().split('\n')).toHaveLength(1);
  });

  it('commit --yes commits the normalized message', async () => {
    fresh();
    const r = await run(['commit', '--yes']);
    expect(r.code).toBe(0);
    expect(repo.git('log', '-1', '--format=%B').trim()).toBe('feat(auth): add refresh token rotation\n\n- rotate tokens on use\n- revoke old sessions');
  });

  it('honours --type, --scope, --breaking, --emoji and --bullets 0', async () => {
    fresh();
    const r = await run(['generate', '--pass-thru', '--type', 'fix', '--scope', 'api', '--breaking', '--bullets', '0']);
    expect(r.stdout.trim()).toBe('fix(api)!: add refresh token rotation');
  });

  it('accepts the old PowerShell syntax', async () => {
    fresh();
    const r = await run(['-DryRun', '-Type', 'fix', '-PassThru']);
    expect(r.code).toBe(0);
    expect(r.stdout.startsWith('fix(auth): add refresh token rotation')).toBe(true);
    expect(r.stderr).toContain('PowerShell-style flags');
  });

  it('blocks --yes when secrets are staged (exit 5) and sends NOTHING to the model', async () => {
    fresh();
    repo.write('.env', 'TOKEN=abc\n'); repo.write('src/k.ts', `const k = "${'AK' + 'IAABCDEFGHIJKLMNOP'}";\n`); repo.git('add', '-A');
    const r = await run(['commit', '--yes']);
    expect(r.code).toBe(5);
    expect(r.stderr).toContain('Potential secrets detected');
    expect(r.stderr).toMatch(/File: \.env/);
    expect(r.stderr).toMatch(/Line: 1/);
    expect(r.stderr).not.toContain('AKIA');
    expect(r.stderr).toContain('--no-scan');
    expect(chatCalls).toBe(0);
    expect(repo.git('log', '--oneline').trim().split('\n')).toHaveLength(1);
  });

  it('--no-scan lets a deliberate commit through', async () => {
    fresh();
    repo.write('.env', 'TOKEN=abc\n'); repo.git('add', '-A');
    expect((await run(['commit', '--yes', '--no-scan'])).code).toBe(0);
  });

  it('exits 1 with guidance when nothing is staged', async () => {
    fresh(); repo.git('reset', '-q');
    const r = await run(['commit', '--yes']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Nothing staged');
  });

  it('commit --push --yes without a remote exits 4 after committing', async () => {
    fresh();
    const r = await run(['commit', '--yes', '--push']);
    expect(r.code).toBe(4);
    expect(r.stderr).toContain('no remote');
    expect(repo.git('log', '--oneline').trim().split('\n')).toHaveLength(2);
  });

  it('push is refused without a terminal when --yes is not given (nothing pushed, nothing forced)', async () => {
    fresh(); repo.git('remote', 'add', 'origin', 'https://example.invalid/x.git');
    const r = await run(['push']);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/cannot review|needs confirmation|terminal/i);
  });

  it('undo --yes soft-undoes; without --yes and without a terminal it refuses', async () => {
    fresh(); await run(['commit', '--yes']);
    const refuse = await run(['undo']);
    expect(refuse.code).toBe(6);
    expect(repo.git('log', '--oneline').trim().split('\n')).toHaveLength(2);
    const ok = await run(['undo', '--yes']);
    expect(ok.code).toBe(0);
    expect(repo.git('log', '--oneline').trim().split('\n')).toHaveLength(1);
    expect(repo.git('diff', '--cached', '--name-only').trim()).toBe('src/auth/token.ts');
  });

  it('status --json', async () => {
    fresh();
    const r = await run(['status', '--json']);
    const j = JSON.parse(r.stdout) as { files: Array<{ path: string }>; branch: string };
    expect(j.files.map((f) => f.path)).toEqual(['src/auth/token.ts']);
  });

  it('usage errors exit 2 and win over provider errors', async () => {
    fresh();
    expect((await run(['bogus'])).code).toBe(2);
    expect((await run(['commit', '--type', 'nope'])).code).toBe(2);
    expect((await run(['commit', '--bullets', '99'])).code).toBe(2);
    expect((await run(['commit', '--amend', '--all'])).code).toBe(2);
    expect((await run(['commit', '--wat'])).code).toBe(2);
    expect((await run(['-p', 'openai', 'commit', '--type', 'nope'])).code).toBe(2);
  });

  it('outside a repository exits 4', async () => {
    fresh();
    const r = await aic(['status'], { cwd: tmpdir(), env: { AIC_CONFIG_DIR: cfg } });
    expect(r.code).toBe(4);
    expect(r.stderr).toContain('Not inside a Git repository');
  });

  it('unreachable Ollama gives the actionable error and exit 3', async () => {
    fresh();
    const r = await aic(['generate', '--ollama-url', 'http://127.0.0.1:1'], { cwd: repo.dir, env: { AIC_CONFIG_DIR: cfg } });
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('Unable to connect to Ollama');
    expect(r.stderr).toContain('http://127.0.0.1:1');
    expect(r.stderr).toContain('Possible causes');
    expect(r.stderr).toContain('ollama serve');
  });

  it('config: set/get/list, precedence and masking', async () => {
    fresh();
    expect((await run(['config', 'set', 'language', 'French'])).code).toBe(0);
    expect((await run(['config', 'get', 'language'])).stdout.trim()).toBe('French');
    repo.write('.aic.json', JSON.stringify({ language: 'German', bullets: 1, ollamaUrl: 'http://evil.invalid', secretScan: false }));
    expect((await run(['config', 'get', 'language'])).stdout.trim()).toBe('German');
    expect((await run(['config', 'get', 'language'], { AIC_LANGUAGE: 'Spanish' })).stdout.trim()).toBe('Spanish');
    const list = await run(['config', 'list']);
    expect(list.stdout).toMatch(/language\s+German\s+project/);
    expect(list.stdout).toMatch(/bullets\s+1\s+project/);
    expect(list.stderr).toContain('"ollamaUrl" can only be set');
    expect(list.stderr).toContain('"secretScan" cannot be switched off');
    expect((await run(['config', 'get', 'secretScan'])).stdout.trim()).toBe('true');
    expect((await run(['config', 'set', 'bullets', '99'])).code).toBe(2);
    expect((await run(['config', 'set', 'nope', '1'])).code).toBe(2);
    expect((await run(['config', 'set', 'provider', 'nope'])).code).toBe(2);
    expect((await run(['config', 'set', 'autoApprove', 'git_reset'])).code).toBe(2);
    expect((await run(['config', 'set', 'ollamaUrl', 'http://x', '--project'])).code).toBe(2);
    expect((await run(['config', 'set', 'api-key', 'sk-should-not-be-in-project', '--project'])).code).toBe(2);
    expect((await run(['config', 'list', '--json'])).code).toBe(0);
  });

  it('API keys are stored privately, masked everywhere and never printed', async () => {
    fresh();
    const key = 'sk-test-abcdefghijklmnopqrstuvwxyz';
    const set = await run(['config', 'set', 'api-key', key, '--provider', 'openai']);
    expect(set.code).toBe(0);
    expect(set.stdout + set.stderr).not.toContain(key);
    const file = readFileSync(join(cfg, 'config.json'), 'utf8');
    expect(file).toContain(key);
    if (process.platform !== 'win32') expect((await import('node:fs')).statSync(join(cfg, 'config.json')).mode & 0o077).toBe(0);
    const list = await run(['config', 'list']);
    expect(list.stdout + list.stderr).not.toContain(key);
    const dr = await run(['-p', 'openai', 'doctor']);
    expect(dr.stdout + dr.stderr).not.toContain(key);
    expect((await run(['config', 'set', 'api-key', 'x', '--provider', 'ollama'])).code).toBe(2);
  });

  it('custom provider: add, list, use, test, generate, remove', async () => {
    fresh();
    const add = await run(['provider', 'add', 'my-provider', '--base-url', `${server.url}/v1`, '--api-key-env', 'MY_API_KEY', '--model', 'my-model', '--header', 'x-team=core']);
    expect(add.code).toBe(0);
    const stored = JSON.parse(readFileSync(join(cfg, 'config.json'), 'utf8')) as { providers: Record<string, { model: string; apiKeyEnv: string; headers: Record<string, string> }> };
    expect(stored.providers['my-provider']).toMatchObject({ model: 'my-model', apiKeyEnv: 'MY_API_KEY', headers: { 'x-team': 'core' } });

    const list = await run(['provider', 'list']);
    expect(list.stdout).toContain('AIC Providers');
    expect(list.stdout).toMatch(/my-provider\s+custom/);
    expect(list.stdout).toMatch(/Ollama\s+\(current\)/);
    const listJson = JSON.parse((await run(['provider', 'list', '--json'])).stdout) as Array<{ id: string; active: boolean }>;
    expect(listJson.find((p) => p.active)?.id).toBe('ollama');

    expect((await run(['provider', 'use', 'my-provider'])).code).toBe(0);
    expect((await run(['model', 'current'])).stdout.trim()).toBe('my-provider/my-model');

    const noKey = await run(['generate', '--pass-thru']);
    expect(noKey.code).toBe(3);
    expect(noKey.stderr).toContain('No API key for my-provider');
    expect(noKey.stderr).toContain('MY_API_KEY');

    const bad = await run(['generate', '--pass-thru'], { MY_API_KEY: 'wrong-key-123456' });
    expect(bad.code).toBe(3);
    expect(bad.stderr).toContain('rejected the credentials');
    expect(bad.stderr + bad.stdout).not.toContain('wrong-key-123456');

    const good = await run(['generate', '--pass-thru'], { MY_API_KEY: 'sekret-key-123' });
    expect(good.code).toBe(0);
    expect(good.stdout.trim()).toBe('fix(api): handle expired sessions');
    expect(server.requests.some((q) => q.headers['x-team'] === 'core')).toBe(true);

    const t = await run(['provider', 'test'], { MY_API_KEY: 'sekret-key-123' });
    expect(t.code).toBe(0);
    expect(t.stderr).toContain('reachable');

    expect((await run(['provider', 'remove', 'my-provider'])).code).toBe(6);       // needs confirmation, no terminal
    expect((await run(['provider', 'remove', 'my-provider', '--yes'])).code).toBe(0);
    expect((await run(['config', 'get', 'provider'])).stdout.trim()).toBe('ollama');
    expect((await run(['provider', 'add', 'openai', '--base-url', 'http://x/v1'])).code).toBe(2);
    expect((await run(['provider', 'add', 'bad name!', '--base-url', 'http://x/v1'])).code).toBe(2);
    expect((await run(['provider', 'add', 'p', '--base-url', 'not a url'])).code).toBe(2);
  });

  it('model list/current/use for Ollama', async () => {
    fresh();
    const l = await run(['model', 'list']);
    expect(l.code).toBe(0);
    expect(l.stdout).toContain('qwen2.5-coder:7b');
    expect(l.stdout).toContain('7B');
    expect((await run(['model', 'use', 'other:1b'])).code).toBe(0);
    expect((await run(['model', 'current'])).stdout.trim()).toBe('ollama/other:1b');
    expect((await run(['model', 'current'], { AIC_MODEL: 'env-model' })).stdout.trim()).toBe('ollama/env-model');
    expect((await run(['-m', 'cli-model', 'model', 'current'], { AIC_MODEL: 'env-model' })).stdout.trim()).toBe('ollama/cli-model');
  });

  it('init creates .aic.json with inferred scopes; refuses to overwrite', async () => {
    fresh();
    repo.write('src/api/a.ts', 'a'); repo.write('src/web/b.ts', 'b'); repo.git('add', '-A'); repo.git('commit', '-qm', 'more');
    const r = await run(['init']);
    expect(r.code).toBe(0);
    const cfgFile = JSON.parse(readFileSync(join(repo.dir, '.aic.json'), 'utf8')) as { scopes: string[]; model: string };
    expect(cfgFile.scopes).toEqual(expect.arrayContaining(['api', 'web', 'auth']));
    expect(cfgFile.model).toBe('qwen2.5-coder:7b');
    expect((await run(['init'])).stderr).toContain('already exists');
    expect((await run(['init', '--force'])).code).toBe(0);
    const g = await run(['init', '--global', '--provider', 'ollama', '--model', 'qwen2.5-coder:3b']);
    expect(g.code).toBe(0);
    expect(existsSync(join(cfg, 'config.json'))).toBe(true);
  });

  it('doctor: ready when everything works, exit 3 with fixes when the provider is down', async () => {
    fresh();
    const ok = await run(['doctor']);
    expect(ok.code).toBe(0);
    expect(ok.stderr).toContain('AIC Doctor');
    expect(ok.stderr).toContain('AIC is ready.');
    expect(ok.stderr).toContain('qwen2.5-coder:7b available');
    const bad = await aic(['doctor', '--ollama-url', 'http://127.0.0.1:1'], { cwd: repo.dir, env: { AIC_CONFIG_DIR: cfg } });
    expect(bad.code).toBe(3);
    expect(bad.stderr).toContain('Unable to connect to Ollama');
    expect(bad.stderr).toContain('problem');
  });
});
