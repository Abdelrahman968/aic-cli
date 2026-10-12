import { BaseProvider } from './base.js';
import { joinUrl, providerFetch, readSse, timedSignal, tryJson, type RequestContext } from './http.js';
import type { GenerateRequest, ModelInfo, StreamChunk, Usage } from './types.js';
import { ProviderError } from '../utils/errors.js';

export interface OpenAICompatibleOptions {
  id: string;
  name: string;
  baseUrl: string;
  apiKey?: string | undefined;
  /** Extra static headers (e.g. OpenRouter attribution) */
  headers?: Record<string, string> | undefined;
  /** Which JSON field carries the answer length. Official OpenAI wants max_completion_tokens for new models. */
  tokenParam?: 'max_tokens' | 'max_completion_tokens';
  /** Ask for token usage in the final stream chunk (OpenAI, OpenRouter, most compatible servers). */
  streamUsage?: boolean;
  /** false = single JSON response instead of SSE */
  streaming?: boolean;
  /** treat as local (loopback servers such as LM Studio / llama.cpp) */
  local?: boolean;
  /** Default sampling overrides from a custom provider definition */
  temperature?: number | undefined;
  maxTokens?: number | undefined;
  contextLength?: number | undefined;
  authHelp?: string[];
  /** Models that reject a temperature parameter (reasoning models) */
  noTemperature?: RegExp;
}

interface ChatChunk {
  choices?: Array<{ delta?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null }; message?: { content?: string | null }; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string } | string;
}

export class OpenAICompatibleProvider extends BaseProvider {
  readonly id: string;
  readonly name: string;
  readonly local: boolean;
  readonly baseUrl: string;
  private readonly opts: OpenAICompatibleOptions;

  constructor(opts: OpenAICompatibleOptions) {
    super();
    this.opts = opts;
    this.id = opts.id;
    this.name = opts.name;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.local = opts.local ?? false;
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

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json', ...(this.opts.headers ?? {}) };
    if (this.opts.apiKey) h['authorization'] = `Bearer ${this.opts.apiKey}`;
    return h;
  }

  async listModels(): Promise<ModelInfo[]> {
    const sig = timedSignal(15000);
    try {
      const res = await providerFetch(this.ctx(), joinUrl(this.baseUrl, 'models'), { headers: this.headers() }, sig);
      const body = (await res.json()) as { data?: Array<{ id?: string; name?: string; context_length?: number }>; models?: Array<{ id?: string; name?: string }> };
      const rows = body.data ?? body.models ?? [];
      return rows
        .filter((m) => m.id || m.name)
        .map((m): ModelInfo => ({
          id: (m.id ?? m.name) as string,
          ...(m.name && m.id && m.name !== m.id ? { name: m.name } : {}),
          ...('context_length' in m && typeof m.context_length === 'number' ? { contextLength: m.context_length } : {}),
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
    } finally {
      sig.dispose();
    }
  }

  private buildBody(req: GenerateRequest, stream: boolean, tokenParam: string, withTemperature: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = { model: req.model, messages: req.messages, stream };
    const temp = req.temperature ?? this.opts.temperature;
    if (withTemperature && temp !== undefined && !this.opts.noTemperature?.test(req.model)) body['temperature'] = temp;
    const max = req.maxTokens ?? this.opts.maxTokens;
    if (max !== undefined) body[tokenParam] = max;
    if (stream && this.opts.streamUsage !== false) body['stream_options'] = { include_usage: true };
    return body;
  }

  async *stream(req: GenerateRequest): AsyncGenerator<StreamChunk> {
    const streaming = this.opts.streaming !== false;
    let tokenParam: string = this.opts.tokenParam ?? 'max_tokens';
    let withTemp = true;
    const sig = timedSignal(req.timeoutMs, req.signal);
    try {
      let res: Response | undefined;
      // Servers disagree about parameter names; adapt once or twice instead of failing.
      for (let attempt = 0; attempt < 3 && !res; attempt++) {
        try {
          res = await providerFetch(this.ctx(), joinUrl(this.baseUrl, 'chat/completions'), {
            method: 'POST',
            headers: this.headers(),
            body: JSON.stringify(this.buildBody(req, streaming, tokenParam, withTemp)),
          }, sig);
        } catch (e) {
          const text = e instanceof ProviderError ? `${e.message} ${e.extras.details ?? ''}` : '';
          if (e instanceof ProviderError && /HTTP 400/.test(e.message)) {
            if (/max_completion_tokens/.test(text) && tokenParam === 'max_tokens') { tokenParam = 'max_completion_tokens'; continue; }
            if (/max_tokens/.test(text) && tokenParam === 'max_completion_tokens') { tokenParam = 'max_tokens'; continue; }
            if (/temperature/.test(text) && withTemp) { withTemp = false; continue; }
          }
          throw e;
        }
      }
      if (!res) throw new ProviderError(`${this.name} rejected the request parameters`);

      let usage: Usage | undefined;
      if (!streaming) {
        const j = (await res.json()) as ChatChunk;
        const text = j.choices?.[0]?.message?.content ?? '';
        if (text) yield { type: 'text', text };
        usage = this.readUsage(j);
        yield { type: 'done', ...(usage ? { usage } : {}) };
        return;
      }

      for await (const ev of readSse(res, sig.signal)) {
        if (ev.data === '[DONE]') break;
        const j = tryJson(ev.data) as ChatChunk | undefined;
        if (!j) continue;
        if (j.error) throw new ProviderError(`${this.name}: ${typeof j.error === 'string' ? j.error : (j.error.message ?? 'unknown error')}`);
        const d = j.choices?.[0]?.delta;
        if (d?.content) yield { type: 'text', text: d.content };
        else if (d?.reasoning_content || d?.reasoning) yield { type: 'thinking' };
        const u = this.readUsage(j);
        if (u) usage = u;
      }
      yield { type: 'done', ...(usage ? { usage } : {}) };
    } finally {
      sig.dispose();
    }
  }

  private readUsage(j: ChatChunk): Usage | undefined {
    if (!j.usage) return undefined;
    return {
      ...(j.usage.prompt_tokens !== undefined ? { inputTokens: j.usage.prompt_tokens } : {}),
      ...(j.usage.completion_tokens !== undefined ? { outputTokens: j.usage.completion_tokens } : {}),
    };
  }
}
