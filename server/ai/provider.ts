import type { ModelInfo, ProviderId, Usage } from '../../shared/types';

export interface CompleteRequest {
  model: string;
  system: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  maxTokens: number;
  tools?: 'search';
}
export interface StreamChunk { delta?: string; usage?: Usage; done?: boolean; sources?: { title: string; url: string }[] }

export interface Provider {
  id: ProviderId;
  /** Human-readable description of the auth mode in use, e.g. "Max login via claude CLI". */
  mode: string;
  listModels(): Promise<ModelInfo[]>;
  complete(req: CompleteRequest): AsyncIterable<StreamChunk>;
  countTokens(text: string, model: string): Promise<number>;
}

export class ProviderError extends Error {
  constructor(message: string, public retryable: boolean, public status?: number) { super(message); }
}

/** Collect a whole stream into text + usage. Used by the rewrite detector's second call and tests. */
export async function collect(stream: AsyncIterable<StreamChunk>): Promise<{ text: string; usage: Usage }> {
  let text = ''; let usage: Usage = { input_tokens: 0, output_tokens: 0 };
  for await (const c of stream) { if (c.delta) text += c.delta; if (c.usage) usage = c.usage; }
  return { text, usage };
}
