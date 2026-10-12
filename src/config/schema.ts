import { z } from 'zod';
import { UsageError } from '../utils/errors.js';

export const COMMIT_TYPES = ['feat', 'fix', 'refactor', 'perf', 'docs', 'style', 'test', 'build', 'ci', 'chore', 'revert'] as const;
export type CommitType = (typeof COMMIT_TYPES)[number];

export type ValueKind = 'string' | 'boolean' | 'number' | 'string[]';
/** What a project-level `.aic.json` may do with a key (a cloned repo must not be able to weaken your security). */
export type ProjectPolicy = 'allow' | 'deny' | 'only-true' | 'only-false';

export interface SettingMeta {
  kind: ValueKind;
  description: string;
  default: string | boolean | number | string[] | undefined;
  min?: number;
  max?: number;
  project: ProjectPolicy;
  /** string[] settings: `union` concatenates across layers, `replace` (default) lets the strongest layer win. */
  merge?: 'union' | 'replace';
  /** secret-ish values are masked in output */
  sensitive?: boolean;
}

export const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
export const DEFAULT_PROVIDER = 'ollama';

/** Single source of truth for every user-facing setting. Used for validation, CLI coercion, docs and the interactive editor. */
export const SETTINGS = {
  provider: { kind: 'string', description: 'Active AI provider id (ollama, openai, anthropic, gemini, openrouter or a custom id)', default: DEFAULT_PROVIDER, project: 'allow' },
  model: { kind: 'string', description: 'Model name for the active provider (empty = provider default)', default: undefined, project: 'allow' },
  language: { kind: 'string', description: 'Language of the subject and bullets (type and scope stay English)', default: 'English', project: 'allow' },
  bullets: { kind: 'number', description: 'Max body bullets, 0 = subject line only', default: 3, min: 0, max: 6, project: 'allow' },
  history: { kind: 'number', description: 'Recent commit subjects used as a style reference, 0 = none', default: 3, min: 0, max: 20, project: 'allow' },
  maxChars: { kind: 'number', description: 'Diff size cap sent to the model (shared fairly between files)', default: 6000, min: 500, max: 400000, project: 'allow' },
  emoji: { kind: 'boolean', description: 'Add a gitmoji after the colon', default: false, project: 'allow' },
  scopes: { kind: 'string[]', description: 'Allowed commit scopes (empty = any)', default: [], project: 'allow' },
  exclude: { kind: 'string[]', description: 'Extra pathspecs hidden from the model, e.g. *.svg', default: [], project: 'allow', merge: 'union' },
  types: { kind: 'string[]', description: 'Allowed commit types (Conventional Commits)', default: [...COMMIT_TYPES], project: 'allow' },
  subjectMax: { kind: 'number', description: 'Max length of the subject line', default: 72, min: 20, max: 200, project: 'allow' },
  instructions: { kind: 'string', description: 'Extra instructions appended to the commit prompt, e.g. "mention the ticket id"', default: '', project: 'allow' },
  retries: { kind: 'number', description: 'Automatic retries when the format check fails', default: 1, min: 0, max: 5, project: 'allow' },
  temperature: { kind: 'number', description: 'Sampling temperature (rises a little on every retry)', default: 0.2, min: 0, max: 2, project: 'allow' },
  numCtx: { kind: 'number', description: 'Minimum context window (auto-raised when the prompt needs more; Ollama and custom providers)', default: 4096, min: 512, max: 1048576, project: 'allow' },
  numPredict: { kind: 'number', description: 'Max tokens in the answer', default: 256, min: 16, max: 32768, project: 'allow' },
  timeoutSec: { kind: 'number', description: 'Whole-request timeout in seconds', default: 180, min: 5, max: 3600, project: 'allow' },
  keepAlive: { kind: 'string', description: 'How long Ollama keeps the model in memory, e.g. 10m', default: '10m', project: 'allow' },
  unloadModel: { kind: 'boolean', description: 'Unload the Ollama model from (V)RAM when AIC exits', default: false, project: 'deny' },
  ollamaUrl: { kind: 'string', description: 'Ollama server URL', default: DEFAULT_OLLAMA_URL, project: 'deny' },
  autoStartOllama: { kind: 'boolean', description: 'Start `ollama serve` automatically when it is not running', default: false, project: 'deny' },
  secretScan: { kind: 'boolean', description: 'Scan staged changes for secrets before committing', default: true, project: 'only-true' },
  sendDiff: { kind: 'boolean', description: 'Send diff content to the provider (false = only file names and line counts)', default: true, project: 'only-false' },
  sendHistory: { kind: 'boolean', description: 'Send recent commit subjects to the provider', default: true, project: 'only-false' },
  sendBranch: { kind: 'boolean', description: 'Send the branch name to the provider', default: true, project: 'only-false' },
  signoff: { kind: 'boolean', description: 'Add Signed-off-by to commits', default: false, project: 'allow' },
  noVerify: { kind: 'boolean', description: 'Skip git hooks when committing', default: false, project: 'deny' },
  autoApprove: { kind: 'string[]', description: 'Agent tools that run without asking: git_add, git_commit, git_push (git_reset is never auto-approved)', default: [], project: 'deny' },
} as const satisfies Record<string, SettingMeta>;

export type SettingKey = keyof typeof SETTINGS;
export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];

export interface Settings {
  provider: string;
  model: string | undefined;
  language: string;
  bullets: number;
  history: number;
  maxChars: number;
  emoji: boolean;
  scopes: string[];
  exclude: string[];
  types: string[];
  subjectMax: number;
  instructions: string;
  retries: number;
  temperature: number;
  numCtx: number;
  numPredict: number;
  timeoutSec: number;
  keepAlive: string;
  unloadModel: boolean;
  ollamaUrl: string;
  autoStartOllama: boolean;
  secretScan: boolean;
  sendDiff: boolean;
  sendHistory: boolean;
  sendBranch: boolean;
  signoff: boolean;
  noVerify: boolean;
  autoApprove: string[];
}

export type SettingsLayer = Partial<Settings>;

export function isSettingKey(k: string): k is SettingKey {
  return Object.prototype.hasOwnProperty.call(SETTINGS, k);
}

/** `api-key` -> `apiKey`, `auto_start_ollama` -> `autoStartOllama` */
export function toCamel(key: string): string {
  return key.replace(/[-_]+([a-zA-Z0-9])/g, (_m, c: string) => c.toUpperCase());
}
export function toKebab(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}
export function toEnvName(key: string): string {
  return 'AIC_' + key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}

/** Accepts camelCase or kebab-case and returns the canonical key, or undefined. */
export function canonicalKey(input: string): SettingKey | undefined {
  const c = toCamel(input.trim());
  if (isSettingKey(c)) return c;
  const lower = SETTING_KEYS.find((k) => k.toLowerCase() === c.toLowerCase());
  return lower;
}

/** Coerce a raw string (CLI / env) to the setting's type. Throws UsageError with a helpful message. */
export function coerceValue(key: SettingKey, raw: string): string | number | boolean | string[] {
  const meta: SettingMeta = SETTINGS[key];
  const v = raw.trim();
  switch (meta.kind) {
    case 'boolean': {
      if (/^(1|true|yes|on|y)$/i.test(v)) return true;
      if (/^(0|false|no|off|n)$/i.test(v)) return false;
      throw new UsageError(`"${key}" expects true or false, got "${raw}".`);
    }
    case 'number': {
      const n = Number(v);
      if (v === '' || !Number.isFinite(n)) throw new UsageError(`"${key}" expects a number, got "${raw}".`);
      if (meta.min !== undefined && n < meta.min) throw new UsageError(`"${key}" must be at least ${meta.min}.`);
      if (meta.max !== undefined && n > meta.max) throw new UsageError(`"${key}" must be at most ${meta.max}.`);
      return n;
    }
    case 'string[]': {
      if (v.startsWith('[')) {
        try {
          const arr: unknown = JSON.parse(v);
          if (Array.isArray(arr)) return arr.map(String).filter(Boolean);
        } catch { /* fall through to comma split */ }
      }
      return v.split(',').map((s) => s.trim()).filter(Boolean);
    }
    default:
      return v;
  }
}

function zodFor(meta: SettingMeta): z.ZodType {
  switch (meta.kind) {
    case 'boolean': return z.boolean();
    case 'number': {
      let n = z.number();
      if (meta.min !== undefined) n = n.min(meta.min);
      if (meta.max !== undefined) n = n.max(meta.max);
      return n;
    }
    case 'string[]': return z.array(z.string());
    default: return z.string();
  }
}

const settingsShape: Record<string, z.ZodType> = {};
for (const k of SETTING_KEYS) settingsShape[k] = zodFor(SETTINGS[k]).optional();

export const ProviderDefSchema = z.object({
  name: z.string().min(1).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, 'use letters, digits, ".", "_" or "-"'),
  protocol: z.enum(['openai-compatible', 'anthropic', 'ollama']).default('openai-compatible'),
  baseUrl: z.string().url(),
  apiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
  model: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  timeoutSec: z.number().positive().optional(),
  stream: z.boolean().optional(),
  contextLength: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
});
export type ProviderDef = z.infer<typeof ProviderDefSchema>;

/** Shape of ~/.config/aic/config.json */
export const GlobalFileSchema = z.object({
  ...settingsShape,
  providers: z.record(z.string(), ProviderDefSchema).optional(),
  apiKeys: z.record(z.string(), z.string()).optional(),
  modelByProvider: z.record(z.string(), z.string()).optional(),
  acknowledgedProviders: z.array(z.string()).optional(),
});
export type GlobalFile = SettingsLayer & {
  providers?: Record<string, ProviderDef>;
  apiKeys?: Record<string, string>;
  modelByProvider?: Record<string, string>;
  acknowledgedProviders?: string[];
};

/** Shape of .aic.json (settings only; no secrets, no provider definitions) */
export const ProjectFileSchema = z.object({ ...settingsShape });

export function defaults(): Settings {
  const out: Record<string, unknown> = {};
  for (const k of SETTING_KEYS) {
    const d = SETTINGS[k].default;
    out[k] = Array.isArray(d) ? [...d] : d;
  }
  return out as unknown as Settings;
}

/** Built-in provider ids */
export const BUILTIN_PROVIDERS = ['ollama', 'openai', 'anthropic', 'gemini', 'openrouter'] as const;
export type BuiltinProviderId = (typeof BUILTIN_PROVIDERS)[number];

export const DEFAULT_MODELS: Record<BuiltinProviderId, string> = {
  ollama: 'qwen2.5-coder:7b',
  openai: 'gpt-4o-mini',
  anthropic: 'claude-haiku-5-5',
  gemini: 'gemini-2.5-flash',
  openrouter: 'openai/gpt-4o-mini',
};

export const API_KEY_ENV: Record<Exclude<BuiltinProviderId, 'ollama'>, string[]> = {
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
};
