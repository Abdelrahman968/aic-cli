import type { ChatMessage } from '../providers/types.js';
import { buildChatContext } from './context.js';
import { agentSystemPrompt, runAgentLoop, type LoopIO } from './loop.js';
import { makePolicy, type ApprovalPolicy, type ToolDef } from './tools.js';
import type { Session } from './session.js';
import { AicError, ExitCode } from '../utils/errors.js';

const MAX_HISTORY_MESSAGES = 14;
const MAX_HISTORY_CHARS = 12000;

export interface AgentOptions {
  session: Session;
  /** tools the user explicitly asked for with flags (e.g. --push) */
  explicit?: string[];
  confirm: (command: string, tool: ToolDef) => Promise<boolean>;
}

/** Conversational agent: repository context + conversation memory + the tool loop. Headless (no terminal code). */
export class Agent {
  private history: ChatMessage[] = [];
  private readonly policy: ApprovalPolicy;

  constructor(private readonly opts: AgentOptions) {
    const s = opts.session;
    this.policy = makePolicy({
      interactive: s.interactive,
      yes: s.yes,
      autoApprove: s.settings.autoApprove,
      explicit: new Set(opts.explicit ?? []),
      confirm: opts.confirm,
    });
  }

  clear(): void { this.history = []; }

  private trimmedHistory(): ChatMessage[] {
    let h = this.history.slice(-MAX_HISTORY_MESSAGES);
    let chars = h.reduce((n, m) => n + m.content.length, 0);
    while (h.length > 2 && chars > MAX_HISTORY_CHARS) {
      chars -= (h[0] as ChatMessage).content.length;
      h = h.slice(1);
    }
    // never start with an assistant turn
    while (h[0] && h[0].role !== 'user') h = h.slice(1);
    return h;
  }

  /** One conversational turn. Streams visible text through io.onText. */
  async ask(userText: string, io: LoopIO, signal?: AbortSignal, onContext?: (info: { truncated: string[]; dropped: string[]; redactions: number }) => void): Promise<{ text: string; toolCalls: number; truncated: string[] }> {
    const s = this.opts.session;
    if (!s.git) throw new AicError('This needs a Git repository', ExitCode.GIT);
    const ctx = await buildChatContext(s.git, s.settings, { redact: s.redact });
    onContext?.({ truncated: ctx.truncated, dropped: ctx.dropped, redactions: ctx.redactions });
    const messages: ChatMessage[] = [
      { role: 'system', content: agentSystemPrompt(ctx.text, s.settings.language) },
      ...this.trimmedHistory(),
      { role: 'user', content: userText },
    ];
    const res = await runAgentLoop({
      provider: s.provider, model: s.model, messages,
      tools: { git: s.git, settings: s.settings, redact: s.redact },
      policy: this.policy,
      temperature: Math.max(0.2, s.settings.temperature),
      maxTokens: Math.max(s.settings.numPredict, 700),
      contextLength: Math.max(s.settings.numCtx, 8192),
      timeoutMs: s.settings.timeoutSec * 1000,
      signal, io,
    });
    this.history.push({ role: 'user', content: userText }, ...res.appended.filter((m) => m.role === 'assistant' || m.content.startsWith('<tool_result')));
    return { text: res.text, toolCalls: res.toolCalls, truncated: ctx.truncated };
  }
}
