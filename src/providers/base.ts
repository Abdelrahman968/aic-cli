import type { AIProvider, GenerateRequest, GenerateResponse, ModelInfo, ProviderStatus, StreamChunk, Usage } from './types.js';

/** Shared behaviour: `generate()` is `stream()` collected into one response, so every provider streams. */
export abstract class BaseProvider implements AIProvider {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly local: boolean;
  abstract readonly endpoint: string;

  abstract listModels(): Promise<ModelInfo[]>;
  abstract stream(request: GenerateRequest): AsyncIterable<StreamChunk>;

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    const started = Date.now();
    let text = '';
    let thinking = 0;
    let usage: Usage | undefined;
    for await (const chunk of this.stream(request)) {
      if (chunk.type === 'text') text += chunk.text;
      else if (chunk.type === 'thinking') thinking++;
      else if (chunk.usage) usage = chunk.usage;
    }
    return { text, model: request.model, durationMs: Date.now() - started, thinkingChunks: thinking, ...(usage ? { usage } : {}) };
  }

  async check(): Promise<ProviderStatus> {
    const models = await this.listModels();
    return { ok: true, message: `${this.name} reachable (${models.length} model${models.length === 1 ? '' : 's'})` };
  }
}
