import { AnthropicProvider } from './anthropic.js';
import { GeminiProvider } from './gemini.js';
import { OllamaProvider } from './ollama.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import type { AIProvider } from './types.js';
import {
  BUILTIN_PROVIDERS,
  DEFAULT_MODELS,
  type BuiltinProviderId,
  type GlobalFile,
  type ProviderDef,
  type Settings,
} from '../config/schema.js';
import { isBuiltinProvider, requireProviderKnown, resolveApiKey } from '../config/resolve.js';
import { ProviderError } from '../utils/errors.js';

export const OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export interface ProviderEnv {
  settings: Pick<Settings, 'provider' | 'ollamaUrl' | 'keepAlive'>;
  global: GlobalFile;
  env?: NodeJS.ProcessEnv;
}

export const PROVIDER_LABELS: Record<BuiltinProviderId, string> = {
  ollama: 'Ollama',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  gemini: 'Google Gemini',
  openrouter: 'OpenRouter',
};

function keyHelp(providerId: string, envNames: string[]): string[] {
  const first = envNames[0];
  return [
    ...(first ? [`export ${first}=...   (PowerShell: $env:${first}="...")`] : []),
    `aic config set api-key <key> --provider ${providerId}`,
    `aic provider test ${providerId}`,
  ];
}

function envNamesFor(id: string, def?: ProviderDef): string[] {
  switch (id) {
    case 'openai': return ['OPENAI_API_KEY'];
    case 'anthropic': return ['ANTHROPIC_API_KEY'];
    case 'gemini': return ['GEMINI_API_KEY', 'GOOGLE_API_KEY'];
    case 'openrouter': return ['OPENROUTER_API_KEY'];
    default: return def?.apiKeyEnv ? [def.apiKeyEnv] : [];
  }
}

function isLoopbackHost(url: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return h === 'localhost' || h === '127.0.0.1' || h === '::1';
  } catch {
    return false;
  }
}

export function createCustomProvider(def: ProviderDef, apiKey: string | undefined): AIProvider {
  const authHelp = keyHelp(def.name, def.apiKeyEnv ? [def.apiKeyEnv] : []);
  switch (def.protocol) {
    case 'anthropic':
      return new AnthropicProvider({
        id: def.name, name: def.name, baseUrl: def.baseUrl, apiKey, headers: def.headers,
        temperature: def.temperature, maxTokens: def.maxTokens, streaming: def.stream !== false, authHelp,
      });
    case 'ollama':
      return new OllamaProvider({ url: def.baseUrl });
    default:
      return new OpenAICompatibleProvider({
        id: def.name, name: def.name, baseUrl: def.baseUrl, apiKey, headers: def.headers,
        streaming: def.stream !== false, local: isLoopbackHost(def.baseUrl),
        temperature: def.temperature, maxTokens: def.maxTokens, contextLength: def.contextLength, authHelp,
      });
  }
}

/** Build the provider object for `id`. Throws a helpful ProviderError when credentials are missing. */
export function createProvider(id: string, pe: ProviderEnv, opts: { requireKey?: boolean } = {}): AIProvider {
  const env = pe.env ?? process.env;
  requireProviderKnown(id, pe.global);
  const requireKey = opts.requireKey ?? true;

  if (id === 'ollama') return new OllamaProvider({ url: pe.settings.ollamaUrl, keepAlive: pe.settings.keepAlive });

  const def = pe.global.providers?.[id];
  const lookup = resolveApiKey(id, pe.global, env, pe.settings.provider);
  const names = envNamesFor(id, def);
  // built-ins always need a key; a custom provider needs one exactly when it names an apiKeyEnv
  const needsKey = def ? Boolean(def.apiKeyEnv) && def.protocol !== 'ollama' : true;

  if (requireKey && needsKey && !lookup.key) {
    const label = isBuiltinProvider(id) ? PROVIDER_LABELS[id] : id;
    throw new ProviderError(`No API key for ${label}`, {
      details: `Checked: ${lookup.checked.join(', ')}${pe.global.apiKeys ? ', stored config' : ''}`,
      causes: ['The environment variable is not set in this terminal', 'No key was saved with `aic config set api-key`'],
      try: keyHelp(id, names),
    });
  }
  const apiKey = lookup.key;
  const authHelp = keyHelp(id, names);

  switch (id) {
    case 'openai':
      return new OpenAICompatibleProvider({
        id, name: PROVIDER_LABELS.openai, baseUrl: OPENAI_BASE_URL, apiKey, tokenParam: 'max_completion_tokens',
        noTemperature: /^(o\d|gpt-5)/, authHelp,
      });
    case 'openrouter':
      return new OpenAICompatibleProvider({
        id, name: PROVIDER_LABELS.openrouter, baseUrl: OPENROUTER_BASE_URL, apiKey, authHelp,
        headers: { 'x-title': 'aic', 'http-referer': 'https://github.com/aic-cli/aic' },
      });
    case 'anthropic':
      return new AnthropicProvider({ apiKey, authHelp });
    case 'gemini':
      return new GeminiProvider({ apiKey, authHelp });
    default:
      if (!def) throw new ProviderError(`Unknown provider "${id}"`);
      return createCustomProvider(def, apiKey);
  }
}

export function defaultModelFor(id: string, global: GlobalFile): string | undefined {
  if (isBuiltinProvider(id)) return DEFAULT_MODELS[id];
  return global.providers?.[id]?.model;
}

export interface ProviderEntry {
  id: string;
  name: string;
  kind: 'builtin' | 'custom';
  /** usable now: no key needed, or a key is available */
  ready: boolean;
  local: boolean;
  active: boolean;
  model: string | undefined;
  keySource: string | undefined;
  endpoint: string;
}

export function listProviderEntries(pe: ProviderEnv, activeModel?: string): ProviderEntry[] {
  const env = pe.env ?? process.env;
  const entries: ProviderEntry[] = [];
  for (const id of BUILTIN_PROVIDERS) {
    const lookup = id === 'ollama' ? undefined : resolveApiKey(id, pe.global, env, pe.settings.provider);
    const endpoint = id === 'ollama' ? pe.settings.ollamaUrl : id === 'openai' ? OPENAI_BASE_URL : id === 'openrouter' ? OPENROUTER_BASE_URL : id === 'anthropic' ? 'https://api.anthropic.com' : 'https://generativelanguage.googleapis.com';
    entries.push({
      id, name: PROVIDER_LABELS[id], kind: 'builtin',
      ready: id === 'ollama' ? true : Boolean(lookup?.key),
      local: id === 'ollama' && isLoopbackHost(pe.settings.ollamaUrl.includes('://') ? pe.settings.ollamaUrl : `http://${pe.settings.ollamaUrl}`),
      active: pe.settings.provider === id,
      model: pe.settings.provider === id ? activeModel ?? DEFAULT_MODELS[id] : pe.global.modelByProvider?.[id] ?? DEFAULT_MODELS[id],
      keySource: lookup?.source, endpoint,
    });
  }
  for (const [id, def] of Object.entries(pe.global.providers ?? {})) {
    const lookup = resolveApiKey(id, pe.global, env, pe.settings.provider);
    entries.push({
      id, name: def.name, kind: 'custom',
      ready: Boolean(lookup.key) || !def.apiKeyEnv,
      local: isLoopbackHost(def.baseUrl),
      active: pe.settings.provider === id,
      model: pe.settings.provider === id ? activeModel ?? def.model : pe.global.modelByProvider?.[id] ?? def.model,
      keySource: lookup.source, endpoint: def.baseUrl,
    });
  }
  return entries;
}
