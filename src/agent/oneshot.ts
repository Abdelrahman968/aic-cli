import type { AIProvider, ChatMessage } from '../providers/types.js';
import type { Settings } from '../config/schema.js';
import { CancelledError, ProviderError, isAbortError } from '../utils/errors.js';

export interface OneShotOptions {
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal | undefined;
  onProgress?: (tokens: number, text: string) => void;
}

/** One non-conversational completion: stream, collect, never return an empty answer. */
export async function completeText(
  s: { provider: AIProvider; model: string; settings: Settings },
  messages: ChatMessage[],
  o: OneShotOptions = {},
): Promise<string> {
  const req = {
    model: s.model, messages, temperature: o.temperature ?? s.settings.temperature,
    maxTokens: o.maxTokens ?? Math.max(s.settings.numPredict, 800),
    contextLength: Math.max(s.settings.numCtx, 8192), timeoutMs: s.settings.timeoutSec * 1000,
    ...(o.signal ? { signal: o.signal } : {}),
  };
  let text = '';
  let thinking = 0;
  let n = 0;
  try {
    if (s.provider.stream) {
      for await (const c of s.provider.stream(req)) {
        if (c.type === 'text') { text += c.text; n++; o.onProgress?.(n, text); }
        else if (c.type === 'thinking') thinking++;
      }
    } else {
      text = (await s.provider.generate(req)).text;
    }
  } catch (e) {
    if (isAbortError(e) || o.signal?.aborted) throw new CancelledError('Cancelled');
    throw e;
  }
  text = text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/<think>[\s\S]*$/, '').trim();
  if (!text) {
    throw new ProviderError(thinking ? 'The model spent its whole token budget thinking' : 'The model returned an empty answer', {
      try: thinking ? ['aic config set numPredict 2048', 'aic model use <non-reasoning-model>'] : ['Try again', 'aic model list'],
    });
  }
  return text;
}
