import { BaseProvider } from './base.js';
import { joinUrl, providerFetch, readSse, timedSignal, tryJson, type RequestContext } from './http.js';
import type { ChatMessage, GenerateRequest, ModelInfo, StreamChunk, Usage } from './types.js';
import { ProviderError } from '../utils/errors.js';

export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

export interface GeminiOptions {
  apiKey?: string | undefined;
  baseUrl?: string;
  authHelp?: string[];
}

export function toGeminiContents(messages: ChatMessage[]): { system: string; contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> } {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    const role = m.role === 'assistant' ? 'model' : 'user';
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push({ text: m.content });
    else contents.push({ role, parts: [{ text: m.content }] });
  }
  return { system, contents };
}

interface GeminiChunk {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> }; finishReason?: string }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  promptFeedback?: { blockReason?: string };
  error?: { message?: string };
}

export class GeminiProvider extends BaseProvider {
  readonly id = 'gemini';
  readonly name = 'Google Gemini';
  readonly local = false;
  readonly baseUrl: string;
  private readonly opts: GeminiOptions;

  constructor(opts: GeminiOptions = {}) {
    super();
    this.opts = opts;
    this.baseUrl = (opts.baseUrl ?? GEMINI_BASE_URL).replace(/\/+$/, '');
  }

  get endpoint(): string { return this.baseUrl; }

  private ctx(): RequestContext {
    return {
      name: this.name,
      baseUrl: this.baseUrl,
      secrets: this.opts.apiKey ? [this.opts.apiKey] : [],
      ...(this.opts.authHelp ? { authHelp: this.opts.authHelp } : {}),
    };
  }

  /** The key travels in a header, never in the URL, so it cannot leak into logs or proxies. */
  private headers(): Record<string, string> {
    return { 'content-type': 'application/json', ...(this.opts.apiKey ? { 'x-goog-api-key': this.opts.apiKey } : {}) };
  }

  async listModels(): Promise<ModelInfo[]> {
    const sig = timedSignal(15000);
    try {
      const res = await providerFetch(this.ctx(), joinUrl(this.baseUrl, 'models?pageSize=1000'), { headers: this.headers() }, sig);
      const body = (await res.json()) as { models?: Array<{ name: string; displayName?: string; inputTokenLimit?: number; supportedGenerationMethods?: string[] }> };
      return (body.models ?? [])
        .filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
        .map((m): ModelInfo => ({
          id: m.name.replace(/^models\//, ''),
          ...(m.displayName ? { name: m.displayName } : {}),
          ...(m.inputTokenLimit ? { contextLength: m.inputTokenLimit } : {}),
        }));
    } finally {
      sig.dispose();
    }
  }

  async *stream(req: GenerateRequest): AsyncGenerator<StreamChunk> {
    const { system, contents } = toGeminiContents(req.messages);
    const thinkingModel = /gemini-(2\.5|3)/.test(req.model);
    const generationConfig: Record<string, unknown> = {};
    if (req.temperature !== undefined) generationConfig['temperature'] = req.temperature;
    if (req.maxTokens !== undefined) {
      // On 2.5/3 models "thinking" tokens count against the output limit; leave room so the answer is not cut to nothing.
      generationConfig['maxOutputTokens'] = thinkingModel && !/flash/.test(req.model) ? req.maxTokens + 1024 : req.maxTokens;
    }
    if (/gemini-2\.5-flash/.test(req.model)) generationConfig['thinkingConfig'] = { thinkingBudget: 0 };
    const body: Record<string, unknown> = { contents, generationConfig };
    if (system) body['systemInstruction'] = { parts: [{ text: system }] };

    const model = encodeURIComponent(req.model.replace(/^models\//, ''));
    const sig = timedSignal(req.timeoutMs, req.signal);
    try {
      const res = await providerFetch(this.ctx(), joinUrl(this.baseUrl, `models/${model}:streamGenerateContent?alt=sse`), {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
      }, sig);
      let usage: Usage | undefined;
      for await (const ev of readSse(res, sig.signal)) {
        const j = tryJson(ev.data) as GeminiChunk | undefined;
        if (!j) continue;
        if (j.error) throw new ProviderError(`${this.name}: ${j.error.message ?? 'unknown error'}`);
        if (j.promptFeedback?.blockReason) {
          throw new ProviderError(`${this.name} blocked the prompt (${j.promptFeedback.blockReason})`, { try: ['Try a different model or provider'] });
        }
        for (const part of j.candidates?.[0]?.content?.parts ?? []) {
          if (part.thought) yield { type: 'thinking' };
          else if (part.text) yield { type: 'text', text: part.text };
        }
        if (j.usageMetadata) {
          usage = {
            ...(j.usageMetadata.promptTokenCount !== undefined ? { inputTokens: j.usageMetadata.promptTokenCount } : {}),
            ...(j.usageMetadata.candidatesTokenCount !== undefined ? { outputTokens: j.usageMetadata.candidatesTokenCount } : {}),
          };
        }
      }
      yield { type: 'done', ...(usage ? { usage } : {}) };
    } finally {
      sig.dispose();
    }
  }
}
