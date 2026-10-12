export type Role = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: Role;
  content: string;
}

export interface ModelInfo {
  id: string;
  name?: string;
  sizeBytes?: number;
  contextLength?: number;
  family?: string;
  parameterSize?: string;
  capabilities?: string[];
}

export interface GenerateRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  /** Max tokens in the answer. */
  maxTokens?: number;
  /** Minimum context window to request (providers that support it). */
  contextLength?: number;
  /** Abort the request (Esc / Ctrl+C). */
  signal?: AbortSignal;
  /** Whole-request timeout. */
  timeoutMs?: number;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  /** generation speed when the server reports it */
  tokensPerSecond?: number;
}

export interface GenerateResponse {
  text: string;
  model: string;
  usage?: Usage;
  durationMs: number;
  /** number of reasoning chunks received (they are never included in `text`) */
  thinkingChunks: number;
}

export type StreamChunk =
  | { type: 'text'; text: string }
  | { type: 'thinking' }
  | { type: 'done'; usage?: Usage };

export interface ProviderStatus {
  ok: boolean;
  message: string;
  details?: string[];
}

export interface AIProvider {
  readonly id: string;
  readonly name: string;
  /** true when prompts never leave the machine (Ollama on loopback) */
  readonly local: boolean;
  /** where requests are sent, for privacy notices (never contains credentials) */
  readonly endpoint: string;
  listModels(): Promise<ModelInfo[]>;
  generate(request: GenerateRequest): Promise<GenerateResponse>;
  stream?(request: GenerateRequest): AsyncIterable<StreamChunk>;
  /** Cheap connectivity/credential check. */
  check(): Promise<ProviderStatus>;
}
