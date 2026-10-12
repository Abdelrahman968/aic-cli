import { afterEach, describe, expect, it } from 'vitest';
import { OpenAICompatibleProvider } from '../src/providers/openai-compatible.js';
import { AnthropicProvider, toAnthropicMessages } from '../src/providers/anthropic.js';
import { GeminiProvider, toGeminiContents } from '../src/providers/gemini.js';
import { OllamaProvider, normalizeOllamaUrl, isLoopbackUrl } from '../src/providers/ollama.js';
import { createCustomProvider, createProvider, listProviderEntries } from '../src/providers/registry.js';
import { readLines, readSse, timedSignal } from '../src/providers/http.js';
import { ProviderError } from '../src/utils/errors.js';
import { defaults } from '../src/config/schema.js';
import { json, rejection, sse, startServer } from './helpers.js';
import type { GenerateRequest } from '../src/providers/types.js';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { while (closers.length) await (closers.pop() as () => Promise<void>)(); });
async function server(h: Parameters<typeof startServer>[0]): Promise<Awaited<ReturnType<typeof startServer>>> {
  const s = await startServer(h);
  closers.push(s.close);
  return s;
}

const req = (over: Partial<GenerateRequest> = {}): GenerateRequest => ({ model: 'm', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }], temperature: 0.2, maxTokens: 50, ...over });
const chunks = (words: string[]): Array<{ data: unknown }> => words.map((w) => ({ data: { choices: [{ delta: { content: w } }] } }));

describe('streaming parsers', () => {
  it('parses SSE with multi-line data and comments', async () => {
    const res = new Response(': keep-alive\nevent: a\ndata: one\ndata: two\n\ndata: [DONE]\n\n');
    const got: Array<{ event?: string; data: string }> = [];
    for await (const e of readSse(res)) got.push({ ...(e.event ? { event: e.event } : {}), data: e.data });
    expect(got).toEqual([{ event: 'a', data: 'one\ntwo' }, { data: '[DONE]' }]);
  });
  it('splits lines across chunk boundaries', async () => {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode('{"a":')); c.enqueue(enc.encode('1}\n{"b":2}\r\n')); c.close(); } });
    const lines: string[] = [];
    for await (const l of readLines(new Response(body))) lines.push(l);
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });
  it('timedSignal aborts on timeout and reports it', async () => {
    const t = timedSignal(20);
    await new Promise((r) => setTimeout(r, 60));
    expect(t.signal.aborted).toBe(true);
    expect(t.timedOut()).toBe(true);
    t.dispose();
  });
});

describe('OpenAI-compatible provider', () => {
  it('streams text, sends auth + OpenAI-shaped body, reports usage', async () => {
    const s = await server((r, res) => {
      if (r.url === '/v1/chat/completions') sse(res, [...chunks(['feat', ': x']), { data: { choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } } }], true);
    });
    const p = new OpenAICompatibleProvider({ id: 'x', name: 'X', baseUrl: `${s.url}/v1`, apiKey: 'key-abc-123' });
    const res = await p.generate(req());
    expect(res.text).toBe('feat: x');
    expect(res.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
    const sent = s.requests[0]!;
    expect(sent.headers['authorization']).toBe('Bearer key-abc-123');
    expect(JSON.parse(sent.body)).toMatchObject({ model: 'm', stream: true, max_tokens: 50, temperature: 0.2 });
  });

  it('lists models', async () => {
    const s = await server((_r, res) => json(res, { data: [{ id: 'b' }, { id: 'a' }] }));
    const p = new OpenAICompatibleProvider({ id: 'x', name: 'X', baseUrl: `${s.url}/v1` });
    expect((await p.listModels()).map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('adapts when the server wants max_completion_tokens or no temperature', async () => {
    const s = await server((r, res) => {
      const b = JSON.parse(r.body) as Record<string, unknown>;
      if ('max_tokens' in b) return json(res, { error: { message: "Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens' instead." } }, 400);
      if ('temperature' in b) return json(res, { error: { message: "Unsupported value: 'temperature' does not support 0.2" } }, 400);
      sse(res, chunks(['ok']), true);
    });
    const p = new OpenAICompatibleProvider({ id: 'x', name: 'X', baseUrl: `${s.url}/v1` });
    expect((await p.generate(req())).text).toBe('ok');
    expect(s.requests).toHaveLength(3);
  });

  it('supports non-streaming endpoints', async () => {
    const s = await server((_r, res) => json(res, { choices: [{ message: { content: 'plain' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    const p = new OpenAICompatibleProvider({ id: 'x', name: 'X', baseUrl: `${s.url}/v1`, streaming: false });
    expect((await p.generate(req())).text).toBe('plain');
    expect(JSON.parse(s.requests[0]!.body).stream).toBe(false);
  });

  it('counts reasoning chunks but never mixes them into the text', async () => {
    const s = await server((_r, res) => sse(res, [{ data: { choices: [{ delta: { reasoning_content: 'hmm' } }] } }, ...chunks(['done'])], true));
    const p = new OpenAICompatibleProvider({ id: 'x', name: 'X', baseUrl: `${s.url}/v1` });
    const r = await p.generate(req());
    expect(r.text).toBe('done');
    expect(r.thinkingChunks).toBe(1);
  });

  it('maps 401 to a credentials error without leaking the key', async () => {
    const s = await server((_r, res) => json(res, { error: { message: 'Invalid key: key-abc-123' } }, 401));
    const p = new OpenAICompatibleProvider({ id: 'x', name: 'X', baseUrl: `${s.url}/v1`, apiKey: 'key-abc-123', authHelp: ['export X_KEY=...'] });
    const e = await rejection<ProviderError>(p.generate(req()));
    expect(e).toBeInstanceOf(ProviderError);
    const text = JSON.stringify({ m: e.message, x: e.extras });
    expect(text).not.toContain('key-abc-123');
    expect(e.message).toMatch(/rejected the credentials/);
    expect(e.extras.try).toContain('export X_KEY=...');
    expect(e.code).toBe(3);
  });

  it('maps 429, 404 and 500', async () => {
    for (const [status, re] of [[429, /rate limit/], [404, /404/], [503, /server error/]] as const) {
      const s = await server((_r, res) => json(res, { error: 'x' }, status));
      const p = new OpenAICompatibleProvider({ id: 'x', name: 'X', baseUrl: `${s.url}/v1` });
      await expect(p.generate(req())).rejects.toThrow(re);
    }
  });

  it('turns a refused connection into an actionable error', async () => {
    const p = new OpenAICompatibleProvider({ id: 'x', name: 'X', baseUrl: 'http://127.0.0.1:1/v1' });
    const e = await rejection<ProviderError>(p.generate(req()));
    expect(e.message).toBe('Unable to connect to X');
    expect(e.extras.causes?.length).toBeGreaterThan(0);
  });

  it('can be cancelled', async () => {
    const s = await server((_r, res) => { res.setHeader('content-type', 'text/event-stream'); res.write('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'); });
    const p = new OpenAICompatibleProvider({ id: 'x', name: 'X', baseUrl: `${s.url}/v1` });
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 50);
    await expect(p.generate(req({ signal: ctl.signal }))).rejects.toThrow();
  });

  it('times out slow servers with a helpful error', async () => {
    const s = await server(() => undefined);
    const p = new OpenAICompatibleProvider({ id: 'x', name: 'X', baseUrl: `${s.url}/v1` });
    await expect(p.generate(req({ timeoutMs: 80 }))).rejects.toThrow(/did not answer in time/);
  });
});

describe('Anthropic provider', () => {
  it('splits the system prompt and merges roles', () => {
    const r = toAnthropicMessages([{ role: 'system', content: 'a' }, { role: 'user', content: 'b' }, { role: 'user', content: 'c' }]);
    expect(r).toEqual({ system: 'a', messages: [{ role: 'user', content: 'b\n\nc' }] });
  });
  it('streams text_delta events and reads usage', async () => {
    const s = await server((_r, res) => sse(res, [
      { event: 'message_start', data: { type: 'message_start', message: { usage: { input_tokens: 11 } } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'fix' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', delta: { type: 'text_delta', text: ': y' } } },
      { event: 'message_delta', data: { type: 'message_delta', usage: { output_tokens: 4 } } },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]));
    const p = new AnthropicProvider({ baseUrl: s.url, apiKey: 'ant-key-123456' });
    const r = await p.generate(req());
    expect(r.text).toBe('fix: y');
    expect(r.usage).toEqual({ inputTokens: 11, outputTokens: 4 });
    const sent = s.requests[0]!;
    expect(sent.url).toBe('/v1/messages');
    expect(sent.headers['x-api-key']).toBe('ant-key-123456');
    expect(sent.headers['anthropic-version']).toBeTruthy();
    expect(JSON.parse(sent.body)).toMatchObject({ system: 'sys', max_tokens: 50, stream: true });
  });
  it('surfaces stream errors', async () => {
    const s = await server((_r, res) => sse(res, [{ event: 'error', data: { type: 'error', error: { message: 'overloaded' } } }]));
    await expect(new AnthropicProvider({ baseUrl: s.url }).generate(req())).rejects.toThrow(/overloaded/);
  });
  it('lists models', async () => {
    const s = await server((_r, res) => json(res, { data: [{ id: 'claude-x', display_name: 'Claude X' }] }));
    expect(await new AnthropicProvider({ baseUrl: s.url }).listModels()).toEqual([{ id: 'claude-x', name: 'Claude X' }]);
  });
});

describe('Gemini provider', () => {
  it('maps roles and puts the key in a header, never in the URL', async () => {
    expect(toGeminiContents([{ role: 'system', content: 's' }, { role: 'user', content: 'u' }, { role: 'assistant', content: 'a' }])).toEqual({
      system: 's', contents: [{ role: 'user', parts: [{ text: 'u' }] }, { role: 'model', parts: [{ text: 'a' }] }],
    });
    const s = await server((_r, res) => sse(res, [
      { data: { candidates: [{ content: { parts: [{ text: 'feat' }] } }] } },
      { data: { candidates: [{ content: { parts: [{ text: ': z' }] } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 } } },
    ]));
    const p = new GeminiProvider({ baseUrl: s.url, apiKey: 'AIza-secret-key-000' });
    const r = await p.generate(req({ model: 'gemini-2.5-flash' }));
    expect(r.text).toBe('feat: z');
    expect(r.usage).toEqual({ inputTokens: 5, outputTokens: 2 });
    const sent = s.requests[0]!;
    expect(sent.url).toContain('/models/gemini-2.5-flash:streamGenerateContent?alt=sse');
    expect(sent.url).not.toContain('AIza');
    expect(sent.headers['x-goog-api-key']).toBe('AIza-secret-key-000');
    expect(JSON.parse(sent.body).generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
  });
  it('reports blocked prompts', async () => {
    const s = await server((_r, res) => sse(res, [{ data: { promptFeedback: { blockReason: 'SAFETY' } } }]));
    await expect(new GeminiProvider({ baseUrl: s.url }).generate(req())).rejects.toThrow(/blocked/);
  });
  it('lists only generateContent models', async () => {
    const s = await server((_r, res) => json(res, { models: [{ name: 'models/g1', supportedGenerationMethods: ['generateContent'] }, { name: 'models/emb', supportedGenerationMethods: ['embedContent'] }] }));
    expect((await new GeminiProvider({ baseUrl: s.url }).listModels()).map((m) => m.id)).toEqual(['g1']);
  });
});

describe('Ollama provider', () => {
  it('normalizes URLs like the PowerShell version', () => {
    expect(normalizeOllamaUrl(undefined)).toBe('http://localhost:11434');
    expect(normalizeOllamaUrl(':11434')).toBe('http://localhost:11434');
    expect(normalizeOllamaUrl('11500')).toBe('http://localhost:11500');
    expect(normalizeOllamaUrl('0.0.0.0:11434')).toBe('http://127.0.0.1:11434');
    expect(normalizeOllamaUrl('https://gpu-box:11434/')).toBe('https://gpu-box:11434');
    expect(isLoopbackUrl('http://localhost:1')).toBe(true);
    expect(isLoopbackUrl('http://gpu-box:1')).toBe(false);
    expect(OllamaProvider.canonicalName('qwen')).toBe('qwen:latest');
  });
  it('streams NDJSON, disables thinking and sizes the context window', async () => {
    const s = await server((r, res) => {
      if (r.url === '/api/show') return json(res, { capabilities: ['completion', 'thinking'] });
      res.setHeader('content-type', 'application/x-ndjson');
      res.write(JSON.stringify({ message: { content: 'fix(a): ' } }) + '\n');
      res.write(JSON.stringify({ message: { content: 'b' } }) + '\n');
      res.end(JSON.stringify({ done: true, eval_count: 10, eval_duration: 2e9, prompt_eval_count: 30 }) + '\n');
    });
    const p = new OllamaProvider({ url: s.url });
    const r = await p.generate(req({ contextLength: 4096 }));
    expect(r.text).toBe('fix(a): b');
    expect(r.usage).toMatchObject({ inputTokens: 30, outputTokens: 10, tokensPerSecond: 5 });
    const chat = JSON.parse(s.requests.find((x) => x.url === '/api/chat')!.body);
    expect(chat.think).toBe(false);
    expect(chat.options.num_ctx).toBeGreaterThanOrEqual(4096);
    expect(chat.options.num_predict).toBe(50);
    expect(p.local).toBe(true);
  });
  it('lists installed models with sizes', async () => {
    const s = await server((_r, res) => json(res, { models: [{ name: 'b:1', size: 100 }, { name: 'a:2', size: 5, details: { family: 'qwen', parameter_size: '7B' } }] }));
    const m = await new OllamaProvider({ url: s.url }).listModels();
    expect(m.map((x) => x.id)).toEqual(['a:2', 'b:1']);
    expect(m[0]).toMatchObject({ parameterSize: '7B', sizeBytes: 5 });
  });
  it('explains a missing model with the pull command', async () => {
    const s = await server((r, res) => (r.url === '/api/show' ? json(res, {}) : json(res, { error: "model 'zzz' not found" }, 404)));
    const e = await rejection<ProviderError>(new OllamaProvider({ url: s.url }).generate(req({ model: 'zzz' })));
    expect(e.message).toMatch(/not installed/);
    expect(e.extras.try).toContain('ollama pull zzz');
  });
  it('gives the full "unable to connect" help when Ollama is down', async () => {
    const p = new OllamaProvider({ url: 'http://127.0.0.1:1' });
    expect(await p.isUp(500)).toBe(false);
    const e = await rejection<ProviderError>(p.listModels());
    expect(e.message).toBe('Unable to connect to Ollama');
    expect(e.extras.details).toContain('http://127.0.0.1:1');
    expect(e.extras.try).toEqual(expect.arrayContaining(['aic doctor', 'ollama serve']));
  });
  it('fails clearly when a reasoning model returns only thoughts', async () => {
    const s = await server((r, res) => {
      if (r.url === '/api/show') return json(res, {});
      res.end(JSON.stringify({ message: { thinking: 'hmm' } }) + '\n' + JSON.stringify({ done: true }) + '\n');
    });
    await expect(new OllamaProvider({ url: s.url }).generate(req())).rejects.toThrow(/thinking/);
  });
});

describe('provider registry and custom providers', () => {
  const settings = { ...defaults(), provider: 'ollama' };
  const custom = { name: 'my-provider', protocol: 'openai-compatible' as const, baseUrl: 'https://example.com/v1', apiKeyEnv: 'MY_API_KEY', model: 'my-model' };

  it('creates all built-in providers', () => {
    const g = {};
    const env = { OPENAI_API_KEY: 'a', ANTHROPIC_API_KEY: 'b', GEMINI_API_KEY: 'c', OPENROUTER_API_KEY: 'd' };
    for (const id of ['ollama', 'openai', 'anthropic', 'gemini', 'openrouter']) {
      const p = createProvider(id, { settings, global: g, env });
      expect(p.id).toBe(id);
      expect(typeof p.listModels).toBe('function');
      expect(typeof p.stream).toBe('function');
    }
  });
  it('marks Ollama local and clouds as not local', () => {
    expect(createProvider('ollama', { settings, global: {}, env: {} }).local).toBe(true);
    expect(createProvider('openai', { settings, global: {}, env: { OPENAI_API_KEY: 'k' } }).local).toBe(false);
  });
  it('refuses to build a cloud provider without a key, naming the env var', () => {
    let e: ProviderError | undefined;
    try { createProvider('openai', { settings, global: {}, env: {} }); } catch (x) { e = x as ProviderError; }
    expect(e).toBeInstanceOf(ProviderError);
    expect(e?.message).toBe('No API key for OpenAI');
    expect(e?.extras.try?.join('\n')).toContain('OPENAI_API_KEY');
  });
  it('rejects unknown providers', () => {
    expect(() => createProvider('nope', { settings, global: {}, env: {} })).toThrow(/Unknown provider/);
  });
  it('builds a user-defined provider from config only (no source edits)', () => {
    const g = { providers: { 'my-provider': custom } };
    expect(() => createProvider('my-provider', { settings: { ...settings, provider: 'my-provider' }, global: g, env: {} })).toThrow(/No API key/);
    const p = createProvider('my-provider', { settings: { ...settings, provider: 'my-provider' }, global: g, env: { MY_API_KEY: 'k1234567' } });
    expect(p.id).toBe('my-provider');
    expect(p.endpoint).toBe('https://example.com/v1');
    expect(p.local).toBe(false);
  });
  it('does not require a key when the definition names no apiKeyEnv (e.g. LM Studio)', () => {
    const def = { name: 'lm', protocol: 'openai-compatible' as const, baseUrl: 'http://127.0.0.1:1234/v1' };
    const p = createProvider('lm', { settings: { ...settings, provider: 'lm' }, global: { providers: { lm: def } }, env: {} });
    expect(p.local).toBe(true);
  });
  it('talks to a custom provider with custom headers, temperature and token defaults', async () => {
    const s = await server((_r, res) => sse(res, chunks(['hello']), true));
    const p = createCustomProvider({ ...custom, baseUrl: `${s.url}/v1`, headers: { 'x-team': 'core' }, temperature: 0.7, maxTokens: 99, stream: true }, 'tok-123456');
    expect((await p.generate({ model: 'my-model', messages: [{ role: 'user', content: 'x' }] })).text).toBe('hello');
    const sent = s.requests[0]!;
    expect(sent.headers['x-team']).toBe('core');
    expect(JSON.parse(sent.body)).toMatchObject({ temperature: 0.7, max_tokens: 99 });
  });
  it('supports the anthropic and ollama protocols for custom providers', () => {
    expect(createCustomProvider({ ...custom, protocol: 'anthropic' }, 'k').id).toBe('my-provider');
    expect(createCustomProvider({ ...custom, protocol: 'ollama', baseUrl: 'http://box:11434' }, undefined).id).toBe('ollama');
  });
  it('lists providers with readiness and the active one', () => {
    const e = listProviderEntries({ settings: { ...settings, provider: 'ollama' }, global: { providers: { 'my-provider': custom } }, env: { OPENAI_API_KEY: 'k' } }, 'qwen2.5-coder:7b');
    const byId = Object.fromEntries(e.map((x) => [x.id, x]));
    expect(byId['ollama']).toMatchObject({ active: true, ready: true, local: true, model: 'qwen2.5-coder:7b' });
    expect(byId['openai']?.ready).toBe(true);
    expect(byId['anthropic']?.ready).toBe(false);
    expect(byId['my-provider']).toMatchObject({ kind: 'custom', ready: false });
  });
});
