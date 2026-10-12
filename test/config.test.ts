import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyProjectPolicy, envLayer, resolveApiKey, resolveConfig } from '../src/config/resolve.js';
import { SETTINGS, canonicalKey, coerceValue, defaults, toEnvName } from '../src/config/schema.js';
import { readProjectConfig } from '../src/config/project.js';
import { readGlobalConfig, rememberModel, resetGlobalConfig, setGlobalSetting, switchProvider, updateGlobalConfig, writeGlobalConfig } from '../src/config/global.js';
import { configDir } from '../src/config/paths.js';
import { pickModel } from '../src/agent/session.js';
import { UsageError } from '../src/utils/errors.js';

describe('config precedence: CLI > env > project > global > defaults', () => {
  it('uses defaults when nothing is set', () => {
    const r = resolveConfig({ global: {}, project: { layer: {}, path: '', exists: false, warnings: [] }, env: {} });
    expect(r.settings.provider).toBe('ollama');
    expect(r.settings.bullets).toBe(3);
    expect(r.sources.bullets).toBe('default');
  });

  it('layers override each other in the documented order', () => {
    const base = { global: { bullets: 1, language: 'French', maxChars: 1000 }, project: { layer: { bullets: 2, language: 'German' }, path: 'x', exists: true, warnings: [] } };
    expect(resolveConfig({ ...base, env: {} }).settings).toMatchObject({ bullets: 2, language: 'German', maxChars: 1000 });
    const withEnv = resolveConfig({ ...base, env: { AIC_BULLETS: '4', AIC_MAX_CHARS: '2500' } });
    expect(withEnv.settings).toMatchObject({ bullets: 4, maxChars: 2500, language: 'German' });
    expect(withEnv.sources).toMatchObject({ bullets: 'env', maxChars: 'env', language: 'project' });
    const withCli = resolveConfig({ ...base, env: { AIC_BULLETS: '4' }, cli: { bullets: 6 } });
    expect(withCli.settings.bullets).toBe(6);
    expect(withCli.sources.bullets).toBe('cli');
  });

  it('exclude is additive across layers', () => {
    const r = resolveConfig({ global: { exclude: ['*.svg'] }, project: { layer: { exclude: ['docs/**'] }, path: 'x', exists: true, warnings: [] }, cli: { exclude: ['*.snap'] }, env: {} });
    expect(r.settings.exclude).toEqual(['*.svg', 'docs/**', '*.snap']);
  });

  it('ignores invalid environment values with a warning instead of crashing', () => {
    const r = resolveConfig({ global: {}, project: { layer: {}, path: '', exists: false, warnings: [] }, env: { AIC_BULLETS: 'lots', AIC_SECRET_SCAN: 'maybe' } });
    expect(r.settings.bullets).toBe(3);
    expect(r.warnings.join('\n')).toMatch(/AIC_BULLETS/);
    expect(r.warnings.join('\n')).toMatch(/AIC_SECRET_SCAN/);
  });

  it('maps documented env names', () => {
    expect(toEnvName('maxChars')).toBe('AIC_MAX_CHARS');
    expect(toEnvName('autoStartOllama')).toBe('AIC_AUTO_START_OLLAMA');
    const { layer } = envLayer({ AIC_PROVIDER: 'openai', AIC_MODEL: 'gpt-4o', AIC_OLLAMA_URL: 'http://h:1', AIC_LANGUAGE: 'en', AIC_SECRET_SCAN: 'false' });
    expect(layer).toMatchObject({ provider: 'openai', model: 'gpt-4o', ollamaUrl: 'http://h:1', language: 'en', secretScan: false });
  });

  it('honours OLLAMA_HOST as a weak fallback only', () => {
    expect(envLayer({ OLLAMA_HOST: '10.0.0.5:11434' }).layer.ollamaUrl).toBe('10.0.0.5:11434');
    expect(envLayer({ OLLAMA_HOST: 'a', AIC_OLLAMA_URL: 'http://b' }).layer.ollamaUrl).toBe('http://b');
  });
});

describe('project config cannot weaken security', () => {
  it('drops deny-listed keys', () => {
    const w: string[] = [];
    const out = applyProjectPolicy({ ollamaUrl: 'http://evil', autoApprove: ['git_push'], autoStartOllama: true, language: 'French' }, w);
    expect(out).toEqual({ language: 'French' });
    expect(w).toHaveLength(3);
  });
  it('cannot turn the secret scan off, but can turn it on', () => {
    const w: string[] = [];
    expect(applyProjectPolicy({ secretScan: false }, w)).toEqual({});
    expect(applyProjectPolicy({ secretScan: true }, w)).toEqual({ secretScan: true });
  });
  it('can restrict what is sent but not widen it', () => {
    const w: string[] = [];
    expect(applyProjectPolicy({ sendDiff: false }, w)).toEqual({ sendDiff: false });
    expect(applyProjectPolicy({ sendDiff: true }, w)).toEqual({});
  });
  it('a global sendDiff=false survives a project that says true', () => {
    const r = resolveConfig({ global: { sendDiff: false }, project: { layer: { sendDiff: true }, path: 'x', exists: true, warnings: [] }, env: {} });
    expect(r.settings.sendDiff).toBe(false);
  });
});

describe('coercion and validation', () => {
  it('coerces by type', () => {
    expect(coerceValue('emoji', 'yes')).toBe(true);
    expect(coerceValue('emoji', 'off')).toBe(false);
    expect(coerceValue('bullets', '4')).toBe(4);
    expect(coerceValue('scopes', 'a, b ,c')).toEqual(['a', 'b', 'c']);
    expect(coerceValue('scopes', '["x","y"]')).toEqual(['x', 'y']);
  });
  it('rejects out-of-range and non-numeric numbers', () => {
    expect(() => coerceValue('bullets', '99')).toThrow(UsageError);
    expect(() => coerceValue('bullets', 'abc')).toThrow(/number/);
    expect(() => coerceValue('secretScan', 'perhaps')).toThrow(/true or false/);
  });
  it('accepts camelCase, kebab-case and any casing for keys', () => {
    expect(canonicalKey('auto-start-ollama')).toBe('autoStartOllama');
    expect(canonicalKey('MAXCHARS')).toBe('maxChars');
    expect(canonicalKey('nope')).toBeUndefined();
  });
  it('defaults() returns fresh arrays', () => {
    const a = defaults(); a.scopes.push('x');
    expect(defaults().scopes).toEqual([]);
    expect(SETTINGS.secretScan.default).toBe(true);
  });
});

describe('.aic.json (project file)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'aic-proj-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads the legacy fields from the PowerShell version', () => {
    writeFileSync(join(dir, '.aic.json'), JSON.stringify({ model: 'qwen2.5-coder:3b', language: 'English', bullets: 2, emoji: true, scopes: ['api', 'web'], exclude: ['*.svg'] }));
    const p = readProjectConfig(dir);
    expect(p.layer).toMatchObject({ model: 'qwen2.5-coder:3b', bullets: 2, emoji: true, scopes: ['api', 'web'] });
    expect(p.warnings).toEqual([]);
  });
  it('ignores unknown keys, bad values and broken JSON with warnings', () => {
    writeFileSync(join(dir, '.aic.json'), JSON.stringify({ bogus: 1, bullets: 'x', language: 'Arabic' }));
    const p = readProjectConfig(dir);
    expect(p.layer).toEqual({ language: 'Arabic' });
    expect(p.warnings).toHaveLength(2);
    writeFileSync(join(dir, '.aic.json'), '{ not json');
    const broken = readProjectConfig(dir);
    expect(broken.layer).toEqual({});
    expect(broken.warnings[0]).toMatch(/could not be read/);
  });
  it('tolerates a UTF-8 BOM (PowerShell writes one)', () => {
    writeFileSync(join(dir, '.aic.json'), '\uFEFF{"bullets":1}');
    expect(readProjectConfig(dir).layer).toEqual({ bullets: 1 });
  });
});

describe('global config store', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'aic-cfg-')); env = { AIC_CONFIG_DIR: dir }; });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('honours AIC_CONFIG_DIR and platform defaults', () => {
    expect(configDir({ AIC_CONFIG_DIR: '/x' })).toBe('/x');
    expect(configDir({ APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, 'win32')).toMatch(/aic$/);
    expect(configDir({ XDG_CONFIG_HOME: '/xdg' }, 'linux')).toBe('/xdg/aic');
  });
  it('writes owner-only files', () => {
    setGlobalSetting('language', 'French', env);
    expect(readGlobalConfig(env).language).toBe('French');
    if (process.platform !== 'win32') expect((statSync(join(dir, 'config.json')).mode & 0o777).toString(8)).toBe('600');
  });
  it('rejects invalid files with a helpful error', () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ bullets: 'many' }));
    expect(() => readGlobalConfig(env)).toThrow(/Invalid global configuration/);
    writeFileSync(join(dir, 'config.json'), '{oops');
    expect(() => readGlobalConfig(env)).toThrow(/Invalid JSON/);
  });
  it('remembers one model per provider when switching', () => {
    rememberModel('ollama', 'qwen2.5-coder:7b', env);
    switchProvider('openai', 'gpt-4o', env);
    expect(readGlobalConfig(env)).toMatchObject({ provider: 'openai', model: 'gpt-4o' });
    switchProvider('ollama', undefined, env);
    expect(readGlobalConfig(env).model).toBe('qwen2.5-coder:7b');
    switchProvider('anthropic', undefined, env);
    expect(readGlobalConfig(env).model).toBeUndefined();
  });
  it('reset keeps providers and keys unless asked', () => {
    updateGlobalConfig((g) => { g.language = 'French'; g.apiKeys = { openai: 'sk-test-123456' }; g.providers = { p: { name: 'p', protocol: 'openai-compatible', baseUrl: 'http://x/v1' } }; }, env);
    resetGlobalConfig(false, env);
    const g = readGlobalConfig(env);
    expect(g.language).toBeUndefined();
    expect(g.apiKeys?.['openai']).toBe('sk-test-123456');
    expect(g.providers?.['p']).toBeDefined();
    resetGlobalConfig(true, env);
    expect(readGlobalConfig(env)).toEqual({});
    writeGlobalConfig({}, env);
  });
});

describe('API keys and model selection', () => {
  it('prefers AIC_API_KEY, then provider env, then stored key', () => {
    const g = { apiKeys: { openai: 'stored-key-1' } };
    expect(resolveApiKey('openai', g, { AIC_API_KEY: 'a', OPENAI_API_KEY: 'b' }, 'openai')).toMatchObject({ key: 'a', source: 'env:AIC_API_KEY' });
    expect(resolveApiKey('openai', g, { OPENAI_API_KEY: 'b' }, 'openai')).toMatchObject({ key: 'b', source: 'env:OPENAI_API_KEY' });
    expect(resolveApiKey('openai', g, {}, 'openai')).toMatchObject({ key: 'stored-key-1', source: 'config' });
    expect(resolveApiKey('openai', {}, {}, 'openai').key).toBeUndefined();
  });
  it('AIC_API_KEY only applies to the active provider', () => {
    expect(resolveApiKey('anthropic', {}, { AIC_API_KEY: 'a' }, 'openai').key).toBeUndefined();
  });
  it('supports both Gemini env names and custom apiKeyEnv', () => {
    expect(resolveApiKey('gemini', {}, { GOOGLE_API_KEY: 'g' }, 'gemini').key).toBe('g');
    const g = { providers: { mine: { name: 'mine', protocol: 'openai-compatible' as const, baseUrl: 'http://x', apiKeyEnv: 'MY_KEY' } } };
    expect(resolveApiKey('mine', g, { MY_KEY: 'k' }, 'mine').key).toBe('k');
  });
  it('does not send a global Ollama model name to another provider', () => {
    const r = resolveConfig({ global: { provider: 'ollama', model: 'qwen2.5-coder:7b' }, project: { layer: {}, path: '', exists: false, warnings: [] }, env: {}, cli: { provider: 'openai' } });
    expect(pickModel(r)).toBe('gpt-4o-mini');
    const explicit = resolveConfig({ global: { provider: 'ollama', model: 'qwen2.5-coder:7b' }, project: { layer: {}, path: '', exists: false, warnings: [] }, env: {}, cli: { provider: 'openai', model: 'gpt-4o' } });
    expect(pickModel(explicit)).toBe('gpt-4o');
  });
});
