import { buildCommitMessages, type CommitPromptContext } from './prompt.js';
import { normalizeMessage, validateMessage, type Forced } from './format.js';
import type { AIProvider, StreamChunk } from '../providers/types.js';
import type { Settings } from '../config/schema.js';
import { AicError, CancelledError, ExitCode, ProviderError, isAbortError } from '../utils/errors.js';

export interface MessageState extends Forced {
  hint?: string | undefined;
  /** how often the user pressed "regenerate" (raises the temperature a little each time) */
  regen: number;
}

export interface GenerateMeta {
  tokens: number;
  seconds: number;
  tokensPerSecond?: number;
  model: string;
  attempt: number;
}

export interface GeneratedMessage {
  message: string;
  problems: string[];
  meta: GenerateMeta;
}

export interface GenerateProgress {
  phase: 'reading' | 'writing' | 'thinking';
  tokens: number;
  text: string;
  seconds: number;
}

export interface GenerateParams {
  provider: AIProvider;
  model: string;
  settings: Settings;
  context: CommitPromptContext;
  state: MessageState;
  /** extra settings overrides (e.g. ref) */
  ref?: string | undefined;
  signal?: AbortSignal | undefined;
  onProgress?: ((p: GenerateProgress) => void) | undefined;
  onRetry?: ((problem: string, attempt: number, max: number) => void) | undefined;
}

async function collect(provider: AIProvider, req: Parameters<AIProvider['generate']>[0], onChunk: (c: StreamChunk) => void): Promise<{ text: string; usage?: { outputTokens?: number; tokensPerSecond?: number }; thinking: number }> {
  if (!provider.stream) {
    const r = await provider.generate(req);
    return { text: r.text, ...(r.usage ? { usage: r.usage } : {}), thinking: r.thinkingChunks };
  }
  let text = '';
  let thinking = 0;
  let usage: { outputTokens?: number; tokensPerSecond?: number } | undefined;
  for await (const c of provider.stream(req)) {
    onChunk(c);
    if (c.type === 'text') text += c.text;
    else if (c.type === 'thinking') thinking++;
    else if (c.usage) usage = c.usage;
  }
  return { text, ...(usage ? { usage } : {}), thinking };
}

/** Generate -> normalize -> validate, with automatic retries when the format check fails. */
export async function generateCommitMessage(p: GenerateParams): Promise<GeneratedMessage> {
  const s = p.settings;
  let note: string | undefined;
  let best: GeneratedMessage | undefined;

  for (let attempt = 0; attempt <= s.retries; attempt++) {
    const temperature = Math.min(0.9, s.temperature + 0.2 * (p.state.regen + attempt)); // a bit more creative on every retry
    const messages = buildCommitMessages(p.context, {
      types: s.types, scopes: s.scopes, bullets: s.bullets, language: s.language, subjectMax: s.subjectMax,
      instructions: s.instructions, type: p.state.type, scope: p.state.scope, noScope: p.state.noScope,
      hint: p.state.hint, model: p.model, note,
    });
    const t0 = Date.now();
    let tokens = 0;
    let text = '';
    let thinking = 0;
    try {
      const res = await collect(p.provider, {
        model: p.model, messages, temperature, maxTokens: s.numPredict, contextLength: s.numCtx,
        timeoutMs: s.timeoutSec * 1000, ...(p.signal ? { signal: p.signal } : {}),
      }, (c) => {
        if (c.type === 'text') { tokens++; text += c.text; }
        else if (c.type === 'thinking') { thinking++; }
        p.onProgress?.({ phase: c.type === 'text' ? 'writing' : c.type === 'thinking' ? 'thinking' : 'reading', tokens: tokens + thinking, text, seconds: (Date.now() - t0) / 1000 });
      });
      text = res.text;
      thinking = res.thinking;
      const seconds = (Date.now() - t0) / 1000;
      if (!text.trim() && thinking > 0) {
        throw new ProviderError('The model spent its whole token budget thinking', {
          causes: ['A reasoning model was selected'], try: ['aic config set numPredict 1024', 'aic model use <non-reasoning-model>'],
        });
      }
      const message = normalizeMessage(text, { emoji: s.emoji, bullets: s.bullets, ref: p.ref }, p.state);
      if (!message && best) return best; // a later attempt came back empty: keep the earlier (imperfect) one
      if (!message) throw new AicError('The model returned an empty message', ExitCode.PROVIDER, { try: ['Regenerate (r)', 'Try another model: aic model list'] });
      const problems = validateMessage(message, { types: s.types, scopes: s.scopes, subjectMax: s.subjectMax });
      const outTokens = res.usage?.outputTokens ?? tokens;
      best = {
        message, problems,
        meta: { tokens: outTokens, seconds, ...(res.usage?.tokensPerSecond ? { tokensPerSecond: res.usage.tokensPerSecond } : {}), model: p.model, attempt: attempt + 1 },
      };
      if (problems.length === 0) return best;
      if (attempt < s.retries) {
        p.onRetry?.(problems[0] as string, attempt + 1, s.retries);
        note = `Your previous answer was rejected: ${problems.join('; ')}. Follow the format exactly.`;
      }
    } catch (e) {
      if (isAbortError(e) || p.signal?.aborted) throw new CancelledError('Generation cancelled');
      throw e;
    }
  }
  return best as GeneratedMessage;
}
