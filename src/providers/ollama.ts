import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BaseProvider } from './base.js';
import { connectionError, joinUrl, providerFetch, readLines, timedSignal, tryJson, type RequestContext } from './http.js';
import type { GenerateRequest, ModelInfo, ProviderStatus, StreamChunk, Usage } from './types.js';
import { ProviderError } from '../utils/errors.js';
import { DEFAULT_OLLAMA_URL } from '../config/schema.js';
import { sleep } from '../utils/text.js';
import { which } from '../utils/process.js';

/** "11434", ":11434", "localhost:11434", "0.0.0.0:11434" -> a usable http URL (0.0.0.0 is a bind address, not a destination). */
export function normalizeOllamaUrl(raw: string | undefined): string {
  let u = (raw ?? '').trim() || DEFAULT_OLLAMA_URL;
  if (/^\d+$/.test(u)) u = `localhost:${u}`;
  else if (/^:\d+$/.test(u)) u = `localhost${u}`;
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`;
  u = u.replace('//0.0.0.0', '//127.0.0.1').replace(/\/+$/, '');
  try {
    new URL(u);
  } catch {
    throw new ProviderError(`Invalid Ollama URL: ${raw}`, { try: ['aic config set ollamaUrl http://localhost:11434'] });
  }
  return u;
}

export function isLoopbackUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.localhost');
  } catch {
    return false;
  }
}

export interface OllamaOptions {
  url?: string | undefined;
  keepAlive?: string | undefined;
}

interface TagsResponse {
  models?: Array<{ name?: string; model?: string; size?: number; details?: { family?: string; parameter_size?: string } }>;
}

export class OllamaProvider extends BaseProvider {
  readonly id = 'ollama';
  readonly name = 'Ollama';
  readonly baseUrl: string;
  private readonly keepAlive: string;
  private readonly caps = new Map<string, string[]>();
  private readonly used = new Set<string>();

  constructor(opts: OllamaOptions = {}) {
    super();
    this.baseUrl = normalizeOllamaUrl(opts.url);
    this.keepAlive = opts.keepAlive ?? '10m';
  }

  get local(): boolean { return isLoopbackUrl(this.baseUrl); }
  get endpoint(): string { return this.baseUrl; }

  private ctx(): RequestContext {
    return {
      name: 'Ollama',
      baseUrl: this.baseUrl,
      secrets: [],
      connectionHelp: {
        causes: ['Ollama is not running', 'The configured URL is incorrect', 'Firewall/network issue'],
        try: ['aic doctor', 'aic config get ollamaUrl', 'ollama serve'],
      },
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    const sig = timedSignal(5000);
    try {
      const res = await providerFetch(this.ctx(), joinUrl(this.baseUrl, 'api/tags'), {}, sig);
      const body = (await res.json()) as TagsResponse;
      return (body.models ?? [])
        .map((m): ModelInfo | undefined => {
          const id = m.name ?? m.model;
          if (!id) return undefined;
          return {
            id,
            ...(m.size !== undefined ? { sizeBytes: m.size } : {}),
            ...(m.details?.family ? { family: m.details.family } : {}),
            ...(m.details?.parameter_size ? { parameterSize: m.details.parameter_size } : {}),
          };
        })
        .filter((m): m is ModelInfo => m !== undefined)
        .sort((a, b) => a.id.localeCompare(b.id));
    } finally {
      sig.dispose();
    }
  }

  /** Is the server reachable? (never throws) */
  async isUp(timeoutMs = 3000): Promise<boolean> {
    const sig = timedSignal(timeoutMs);
    try {
      const res = await fetch(joinUrl(this.baseUrl, 'api/tags'), { signal: sig.signal });
      return res.ok;
    } catch {
      return false;
    } finally {
      sig.dispose();
    }
  }

  /** "name" resolves to "name:latest" on the server. */
  static canonicalName(model: string): string {
    return model.includes(':') ? model : `${model}:latest`;
  }

  async capabilities(model: string): Promise<string[]> {
    const cached = this.caps.get(model);
    if (cached) return cached;
    let caps: string[] = [];
    const sig = timedSignal(5000);
    try {
      const res = await fetch(joinUrl(this.baseUrl, 'api/show'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, name: model }),
        signal: sig.signal,
      });
      if (res.ok) {
        const j = (await res.json()) as { capabilities?: string[] };
        caps = j.capabilities ?? [];
      }
    } catch { /* older servers: no capabilities endpoint */ } finally {
      sig.dispose();
    }
    this.caps.set(model, caps);
    return caps;
  }

  async *stream(req: GenerateRequest): AsyncGenerator<StreamChunk> {
    this.used.add(req.model);
    const chars = req.messages.reduce((n, m) => n + m.content.length, 0);
    const predict = req.maxTokens ?? 256;
    // context window big enough for prompt + answer (code is roughly 2.8 chars per token)
    const ctxSize = Math.max(req.contextLength ?? 4096, Math.ceil((chars / 2.8 + predict + 64) / 1024) * 1024);
    const payload: Record<string, unknown> = {
      model: req.model,
      stream: true,
      keep_alive: this.keepAlive,
      messages: req.messages,
      options: { temperature: req.temperature ?? 0.2, num_ctx: ctxSize, num_predict: predict },
    };
    // thinking models would burn the whole token budget on reasoning: switch it off
    if ((await this.capabilities(req.model)).includes('thinking')) payload['think'] = false;

    const sig = timedSignal(req.timeoutMs, req.signal);
    try {
      const res = await providerFetch(this.ctx(), joinUrl(this.baseUrl, 'api/chat'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }, sig).catch((e: unknown) => { throw this.explainModelError(e, req.model); });

      let usage: Usage | undefined;
      for await (const line of readLines(res, sig.signal)) {
        if (!line.trim()) continue;
        const o = tryJson(line);
        if (!o) continue;
        if (typeof o['error'] === 'string') throw this.explainModelError(new ProviderError(`Ollama: ${o['error']}`), req.model);
        const msg = o['message'] as { content?: string; thinking?: string } | undefined;
        if (msg?.content) yield { type: 'text', text: msg.content };
        else if (msg?.thinking) yield { type: 'thinking' };
        if (o['done'] === true) {
          const evalCount = Number(o['eval_count'] ?? 0);
          const evalNs = Number(o['eval_duration'] ?? 0);
          usage = {
            ...(o['prompt_eval_count'] !== undefined ? { inputTokens: Number(o['prompt_eval_count']) } : {}),
            ...(evalCount ? { outputTokens: evalCount } : {}),
            ...(evalCount && evalNs ? { tokensPerSecond: evalCount / (evalNs / 1e9) } : {}),
          };
        }
      }
      yield { type: 'done', ...(usage ? { usage } : {}) };
    } finally {
      sig.dispose();
    }
  }

  private explainModelError(e: unknown, model: string): unknown {
    if (e instanceof ProviderError && /not found|404/i.test(e.message + (e.extras.details ?? ''))) {
      return new ProviderError(`Model "${model}" is not installed on ${this.baseUrl}`, {
        causes: ['The model has not been pulled yet', 'The model name has a typo'],
        try: [`ollama pull ${model}`, 'aic model list'],
      });
    }
    return e;
  }

  override async generate(req: GenerateRequest): ReturnType<BaseProvider['generate']> {
    const res = await super.generate(req);
    if (!res.text.trim() && res.thinkingChunks > 0) {
      throw new ProviderError('The model spent its whole token budget thinking', {
        causes: ['A reasoning model was selected'],
        try: ['aic config set numPredict 1024', 'aic model use <non-reasoning-model>'],
      });
    }
    return res;
  }

  override async check(): Promise<ProviderStatus> {
    try {
      const models = await this.listModels();
      return { ok: true, message: `Ollama reachable at ${this.baseUrl} (${models.length} model${models.length === 1 ? '' : 's'} installed)` };
    } catch (e) {
      if (e instanceof ProviderError) return { ok: false, message: e.message, details: e.extras.causes ?? [] };
      throw e;
    }
  }

  /** Give the (V)RAM back: keep_alive 0 unloads a model. Best effort. */
  async unloadUsedModels(): Promise<string[]> {
    const done: string[] = [];
    for (const m of this.used) {
      const sig = timedSignal(5000);
      try {
        await fetch(joinUrl(this.baseUrl, 'api/generate'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: m, keep_alive: 0 }),
          signal: sig.signal,
        });
        done.push(m);
      } catch { /* ignore */ } finally {
        sig.dispose();
      }
    }
    return done;
  }

  /** Start `ollama serve` in the background and wait until it answers. */
  async startServer(onTick?: (secs: number) => void, maxSeconds = 25): Promise<boolean> {
    const exe = which('ollama');
    if (!exe || !this.local) return false;
    try {
      const out = openSync(join(tmpdir(), 'aic-ollama.out.log'), 'a');
      const err = openSync(join(tmpdir(), 'aic-ollama.err.log'), 'a');
      const child = spawn(exe, ['serve'], { detached: true, stdio: ['ignore', out, err], windowsHide: true });
      child.on('error', () => undefined);
      child.unref();
    } catch {
      return false;
    }
    const t0 = Date.now();
    while ((Date.now() - t0) / 1000 < maxSeconds) {
      if (await this.isUp(1000)) return true;
      onTick?.((Date.now() - t0) / 1000);
      await sleep(300);
    }
    return false;
  }

  unreachableError(): ProviderError {
    return connectionError(this.ctx(), new Error('no response from the server'));
  }
}
