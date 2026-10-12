import { BaseProvider } from './base.js';
import { joinUrl, providerFetch, readSse, timedSignal, tryJson, type RequestContext } from './http.js';
import type { ChatMessage, GenerateRequest, ModelInfo, StreamChunk, Usage } from './types.js';
import { ProviderError } from '../utils/errors.js';

export interface AnthropicOptions {
  id?: string;
  name?: string;
  baseUrl?: string;
  apiKey?: string | undefined;
  headers?: Record<string, string> | undefined;
  version?: string;
  temperature?: number | undefined;
  maxTokens?: number | undefined;
  streaming?: boolean;
  authHelp?: string[];
}

export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

/** Anthropic wants `system` on its own and strictly alternating roles. */
export function toAnthropicMessages(messages: ChatMessage[]): { system: string; messages: Array<{ role: 'user' | 'assistant'; content: string }> } {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const out: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += '\n\n' + m.content;
    else out.push({ role: m.role, content: m.content });
  }
  if (out.length === 0 || out[0]?.role !== 'user') out.unshift({ role: 'user', content: '(continue)' });
  return { system, messages: out };
}

export class AnthropicProvider extends BaseProvider {
  readonly id: string;
  readonly name: string;
  readonly local = false;
  readonly baseUrl: string;
  private readonly opts: AnthropicOptions;

  constructor(opts: AnthropicOptions = {}) {
    super();
    this.opts = opts;
    this.id = opts.id ?? 'anthropic';
    this.name = opts.name ?? 'Anthropic';
    this.baseUrl = (opts.baseUrl ?? ANTHROPIC_BASE_URL).replace(/\/+$/, '');
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
    return {
      'content-type': 'application/json',
      'anthropic-version': this.opts.version ?? '2023-06-01',
      ...(this.opts.apiKey ? { 'x-api-key': this.opts.apiKey } : {}),
      ...(this.opts.headers ?? {}),
    };
  }

  private url(path: string): string {
    // accept both https://api.anthropic.com and https://host/v1
    return /\/v1$/.test(this.baseUrl) ? joinUrl(this.baseUrl, path) : joinUrl(this.baseUrl, 'v1/' + path);
  }

  async listModels(): Promise<ModelInfo[]> {
    const sig = timedSignal(15000);
    try {
      const res = await providerFetch(this.ctx(), this.url('models?limit=1000'), { headers: this.headers() }, sig);
      const body = (await res.json()) as { data?: Array<{ id: string; display_name?: string }> };
      return (body.data ?? []).map((m): ModelInfo => ({ id: m.id, ...(m.display_name ? { name: m.display_name } : {}) }));
    } finally {
      sig.dispose();
    }
  }

  async *stream(req: GenerateRequest): AsyncGenerator<StreamChunk> {
    const { system, messages } = toAnthropicMessages(req.messages);
    const streaming = this.opts.streaming !== false;
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens ?? this.opts.maxTokens ?? 1024,
      messages,
      stream: streaming,
    };
    if (system) body['system'] = system;
    const temp = req.temperature ?? this.opts.temperature;
    if (temp !== undefined) body['temperature'] = Math.min(1, temp);

    const sig = timedSignal(req.timeoutMs, req.signal);
    try {
      const res = await providerFetch(this.ctx(), this.url('messages'), { method: 'POST', headers: this.headers(), body: JSON.stringify(body) }, sig);
      let inputTokens: number | undefined;
      let outputTokens: number | undefined;

      if (!streaming) {
        const j = (await res.json()) as { content?: Array<{ type: string; text?: string }>; usage?: { input_tokens?: number; output_tokens?: number } };
        const text = (j.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
        if (text) yield { type: 'text', text };
        yield { type: 'done', usage: { ...(j.usage?.input_tokens !== undefined ? { inputTokens: j.usage.input_tokens } : {}), ...(j.usage?.output_tokens !== undefined ? { outputTokens: j.usage.output_tokens } : {}) } };
        return;
      }

      for await (const ev of readSse(res, sig.signal)) {
        const j = tryJson(ev.data);
        if (!j) continue;
        const type = (ev.event ?? j['type']) as string | undefined;
        if (type === 'error') {
          const e = j['error'] as { message?: string } | undefined;
          throw new ProviderError(`${this.name}: ${e?.message ?? 'stream error'}`);
        }
        if (type === 'message_start') {
          const u = (j['message'] as { usage?: { input_tokens?: number } } | undefined)?.usage;
          if (u?.input_tokens !== undefined) inputTokens = u.input_tokens;
        } else if (type === 'content_block_delta') {
          const d = j['delta'] as { type?: string; text?: string } | undefined;
          if (d?.type === 'text_delta' && d.text) yield { type: 'text', text: d.text };
          else if (d?.type === 'thinking_delta') yield { type: 'thinking' };
        } else if (type === 'message_delta') {
          const u = j['usage'] as { output_tokens?: number } | undefined;
          if (u?.output_tokens !== undefined) outputTokens = u.output_tokens;
        } else if (type === 'message_stop') {
          break;
        }
      }
      const usage: Usage = { ...(inputTokens !== undefined ? { inputTokens } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}) };
      yield { type: 'done', usage };
    } finally {
      sig.dispose();
    }
  }
}
