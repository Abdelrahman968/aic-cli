import type { AIProvider, ChatMessage } from '../providers/types.js';
import { executeTool, getTool, toolPromptSection, type ApprovalPolicy, type ToolContext, type ToolResult } from './tools.js';
import { isAbortError, CancelledError } from '../utils/errors.js';

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

const OPEN = '<tool_call>';
const CLOSE = '</tool_call>';

/** Extract the first well-formed tool call from model output. Tolerates ```json fences around the JSON. */
export function parseToolCall(text: string): ToolCall | undefined {
  const start = text.indexOf(OPEN);
  if (start < 0) return undefined;
  const end = text.indexOf(CLOSE, start);
  const body = text.slice(start + OPEN.length, end < 0 ? undefined : end).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const j = JSON.parse(body) as { name?: unknown; args?: unknown; arguments?: unknown };
    if (typeof j.name !== 'string') return undefined;
    const raw = j.args ?? j.arguments;
    const args = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    return { name: j.name, args };
  } catch {
    return undefined;
  }
}

/** Text before the first tool call (what the user should see). */
export function visibleText(text: string): string {
  const i = text.indexOf(OPEN);
  return (i < 0 ? text : text.slice(0, i)).trimEnd();
}

/**
 * Streaming filter: forwards text to the user but hides `<tool_call>...` blocks,
 * holding back a partial `<tool_c...` prefix until it is clear what it is.
 */
export class ToolCallFilter {
  private buf = '';
  private hidden = false;
  /** returns the text that is safe to show now */
  push(chunk: string): string {
    if (this.hidden) return '';
    this.buf += chunk;
    const i = this.buf.indexOf(OPEN);
    if (i >= 0) {
      const out = this.buf.slice(0, i);
      this.buf = '';
      this.hidden = true;
      return out;
    }
    // hold back a trailing partial prefix of the marker
    let hold = 0;
    for (let n = Math.min(OPEN.length - 1, this.buf.length); n > 0; n--) {
      if (OPEN.startsWith(this.buf.slice(this.buf.length - n))) { hold = n; break; }
    }
    const out = this.buf.slice(0, this.buf.length - hold);
    this.buf = this.buf.slice(this.buf.length - hold);
    return out;
  }
  /** flush at the end of the stream */
  end(): string {
    if (this.hidden) return '';
    const out = this.buf;
    this.buf = '';
    return out;
  }
}

export function agentSystemPrompt(contextText: string, language: string): string {
  return [
    'You are AIC, a careful AI coding assistant working inside a Git repository from the terminal.',
    'Answer concisely and concretely. Describe only what is visible in the repository context or tool results; never invent file contents or commits.',
    /^(en|english)$/i.test(language) ? '' : `Reply in ${language}.`,
    '',
    'You can inspect and change the repository with tools. To call a tool, reply with ONLY this block and nothing else:',
    `${OPEN}{"name":"git_log","args":{"count":5}}${CLOSE}`,
    'You will receive the result and can then continue. Call at most one tool per reply. Prefer read-only tools.',
    'Tools that change things (git_add, git_commit, git_push, git_reset) require the user to approve each call, so only use them when the user clearly asked.',
    '',
    'Tools:',
    toolPromptSection(),
    '',
    'Repository context (may be truncated):',
    contextText,
  ].filter((l) => l !== '').join('\n');
}

export interface LoopIO {
  /** visible assistant text, streamed */
  onText?: (chunk: string) => void;
  onToolStart?: (call: ToolCall, command: string) => void;
  onToolEnd?: (call: ToolCall, result: ToolResult) => void;
  onThinking?: () => void;
}

export interface LoopParams {
  provider: AIProvider;
  model: string;
  messages: ChatMessage[];
  tools: ToolContext;
  policy: ApprovalPolicy;
  temperature: number;
  maxTokens: number;
  contextLength: number;
  timeoutMs: number;
  maxSteps?: number;
  signal?: AbortSignal | undefined;
  io?: LoopIO;
}

export interface LoopResult {
  /** final assistant text (visible part) */
  text: string;
  /** messages appended during the loop (assistant + tool results) */
  appended: ChatMessage[];
  toolCalls: number;
}

async function streamOnce(p: LoopParams, messages: ChatMessage[]): Promise<string> {
  const req = {
    model: p.model, messages, temperature: p.temperature, maxTokens: p.maxTokens, contextLength: p.contextLength,
    timeoutMs: p.timeoutMs, ...(p.signal ? { signal: p.signal } : {}),
  };
  const filter = new ToolCallFilter();
  let full = '';
  if (!p.provider.stream) {
    const r = await p.provider.generate(req);
    const shown = filter.push(r.text) + filter.end();
    if (shown) p.io?.onText?.(shown);
    return r.text;
  }
  for await (const c of p.provider.stream(req)) {
    if (c.type === 'text') {
      full += c.text;
      const shown = filter.push(c.text);
      if (shown) p.io?.onText?.(shown);
    } else if (c.type === 'thinking') {
      p.io?.onThinking?.();
    }
  }
  const rest = filter.end();
  if (rest) p.io?.onText?.(rest);
  return full;
}

/** The agent loop: model reply -> (optional) tool call -> approval -> result -> model ... until it answers in plain text. */
export async function runAgentLoop(p: LoopParams): Promise<LoopResult> {
  const messages = [...p.messages];
  const appended: ChatMessage[] = [];
  const maxSteps = p.maxSteps ?? 4;
  let calls = 0;
  let last = '';
  try {
    for (let step = 0; step <= maxSteps; step++) {
      const reply = await streamOnce(p, messages);
      const call = parseToolCall(reply);
      last = visibleText(reply);
      const assistant: ChatMessage = { role: 'assistant', content: reply };
      messages.push(assistant);
      appended.push(assistant);
      if (!call || step === maxSteps) break;

      calls++;
      const tool = getTool(call.name);
      const command = tool ? await tool.describe(call.args, p.tools) : call.name;
      p.io?.onToolStart?.(call, command);
      const result = await executeTool(call.name, call.args, p.tools, p.policy);
      p.io?.onToolEnd?.(call, result);
      const feedback: ChatMessage = {
        role: 'user',
        content: `<tool_result name="${call.name}" ok="${result.ok}">\n${result.output}\n</tool_result>\nContinue. If you have what you need, answer the user now in plain text.`,
      };
      messages.push(feedback);
      appended.push(feedback);
    }
  } catch (e) {
    if (isAbortError(e) || p.signal?.aborted) throw new CancelledError('Cancelled');
    throw e;
  }
  return { text: last, appended, toolCalls: calls };
}
