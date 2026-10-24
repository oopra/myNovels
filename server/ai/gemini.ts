import { GoogleGenAI } from '@google/genai';
import type { ModelInfo } from '../../shared/types';
import type { Provider, CompleteRequest, StreamChunk } from './provider';
import { ProviderError } from './provider';

/** Gemini via the official SDK with an AI Studio key. The only supported mode. */
export class GeminiProvider implements Provider {
  id = 'gemini' as const;
  mode = 'API key via @google/genai';
  private ai: GoogleGenAI;
  constructor(apiKey: string) { this.ai = new GoogleGenAI({ apiKey }); }

  async listModels(): Promise<ModelInfo[]> {
    const out: ModelInfo[] = [];
    try {
      const pager = await this.ai.models.list({ config: { pageSize: 100 } });
      for await (const m of pager) {
        const id = (m.name ?? '').replace(/^models\//, '');
        if (!id || !(m.supportedActions ?? []).includes('generateContent')) continue;
        out.push({ id, name: m.displayName ?? id });
      }
    } catch (e) { throw wrap(e); }
    return out;
  }

  async *complete(req: CompleteRequest): AsyncIterable<StreamChunk> {
    try {
      const stream = await this.ai.models.generateContentStream({
        model: req.model,
        contents: req.messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
        config: {
          systemInstruction: req.system,
          maxOutputTokens: req.maxTokens,
          tools: req.tools === 'search' ? [{ googleSearch: {} }] : undefined,
        },
      });
      let usage = { input_tokens: 0, output_tokens: 0 };
      const sources = new Map<string, string>();
      for await (const chunk of stream) {
        const t = chunk.text;
        if (t) yield { delta: t };
        if (chunk.usageMetadata) usage = { input_tokens: chunk.usageMetadata.promptTokenCount ?? usage.input_tokens, output_tokens: chunk.usageMetadata.candidatesTokenCount ?? usage.output_tokens };
        const gm = chunk.candidates?.[0]?.groundingMetadata;
        for (const g of gm?.groundingChunks ?? []) if (g.web?.uri) sources.set(g.web.uri, g.web.title ?? g.web.uri);
      }
      if (sources.size) yield { sources: [...sources].map(([url, title]) => ({ title, url })) };
      yield { usage, done: true };
    } catch (e) { throw wrap(e); }
  }

  async countTokens(text: string, model: string): Promise<number> {
    try {
      const r = await this.ai.models.countTokens({ model, contents: [{ role: 'user', parts: [{ text }] }] });
      return r.totalTokens ?? Math.ceil(text.length / 4);
    } catch (e) { throw wrap(e); }
  }
}

function wrap(e: unknown): Error {
  if (e instanceof ProviderError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  const status = Number(/\b(4\d\d|5\d\d)\b/.exec(msg)?.[1] ?? 0) || undefined;
  if (status === 401 || status === 403 || /API key not valid/i.test(msg)) return new ProviderError('Gemini API key rejected', false, status ?? 401);
  if (status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(msg)) return new ProviderError(`Gemini rate limit: ${msg}`, true, 429);
  if ((status && status >= 500) || /UNAVAILABLE|DEADLINE|timeout|fetch failed/i.test(msg)) return new ProviderError(`Gemini unavailable: ${msg}`, true, status);
  return new ProviderError(`Gemini error: ${msg}`, false, status);
}
