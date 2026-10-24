import Anthropic from '@anthropic-ai/sdk';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ModelInfo } from '../../shared/types';
import { estimateTokens } from '../../shared/text';
import type { Provider, CompleteRequest, StreamChunk } from './provider';
import { ProviderError } from './provider';

export const ANTHROPIC_DEFAULT_MODEL = 'claude-sonnet-5-5';
export const ANTHROPIC_HEAVY_MODEL = 'claude-opus-5-5';
export const ANTHROPIC_CHEAP_MODEL = 'claude-haiku-5-5';

/** Fallback: the official SDK with an API key. The bible context is the system prompt and is cached. */
export class AnthropicSdkProvider implements Provider {
  id = 'anthropic' as const;
  mode = 'API key via @anthropic-ai/sdk';
  private client: Anthropic;
  constructor(apiKey: string) { this.client = new Anthropic({ apiKey, maxRetries: 0 }); }

  async listModels(): Promise<ModelInfo[]> {
    const out: ModelInfo[] = [];
    try {
      for await (const m of this.client.models.list()) out.push({ id: m.id, name: m.display_name });
    } catch (e) { throw wrap(e); }
    return out;
  }

  async *complete(req: CompleteRequest): AsyncIterable<StreamChunk> {
    let stream;
    try {
      stream = this.client.messages.stream({
        model: req.model,
        max_tokens: req.maxTokens,
        system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
        messages: req.messages.map(m => ({ role: m.role, content: m.content })),
      });
      for await (const ev of stream) {
        if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') yield { delta: ev.delta.text };
      }
      const final = await stream.finalMessage();
      if (final.stop_reason === 'refusal') throw new ProviderError(`Model declined the request${final.stop_details?.explanation ? `: ${final.stop_details.explanation}` : ''}`, false);
      yield { usage: { input_tokens: final.usage.input_tokens + (final.usage.cache_read_input_tokens ?? 0) + (final.usage.cache_creation_input_tokens ?? 0), output_tokens: final.usage.output_tokens }, done: true };
    } catch (e) { throw wrap(e); }
  }

  async countTokens(text: string, model: string): Promise<number> {
    try {
      const r = await this.client.messages.countTokens({ model, messages: [{ role: 'user', content: text }] });
      return r.input_tokens;
    } catch (e) { throw wrap(e); }
  }
}

function wrap(e: unknown): Error {
  if (e instanceof ProviderError) return e;
  if (e instanceof Anthropic.RateLimitError) return new ProviderError(`Rate limited: ${e.message}`, true, 429);
  if (e instanceof Anthropic.AuthenticationError) return new ProviderError('Anthropic API key rejected', false, 401);
  if (e instanceof Anthropic.APIConnectionTimeoutError) return new ProviderError('Anthropic request timed out', true);
  if (e instanceof Anthropic.APIConnectionError) return new ProviderError(`Could not reach Anthropic: ${e.message}`, true);
  if (e instanceof Anthropic.InternalServerError) return new ProviderError(`Anthropic server error: ${e.message}`, true, e.status);
  if (e instanceof Anthropic.APIError) return new ProviderError(`Anthropic error ${e.status}: ${e.message}`, false, e.status);
  return e instanceof Error ? e : new Error(String(e));
}

const run = promisify(execFile);

/** Default: ride the author's own Claude Code login by spawning `claude -p` with stream-json output.
 *  Tools are disabled; the passes only read. */
export class AnthropicCliProvider implements Provider {
  id = 'anthropic' as const;
  mode = 'Max login via claude CLI';
  constructor(private bin = process.env.NOVEL_WORKBENCH_CLAUDE_BIN ?? 'claude') {}

  static async available(bin = process.env.NOVEL_WORKBENCH_CLAUDE_BIN ?? 'claude'): Promise<{ ok: boolean; reason?: string; version?: string }> {
    try {
      const { stdout } = await run(bin, ['--version'], { timeout: 10_000 });
      return { ok: true, version: stdout.trim() };
    } catch (e) {
      return { ok: false, reason: `The claude CLI was not found (${(e as Error).message.split('\n')[0]}). Install Claude Code, run \`claude\` once and sign in.` };
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    // The CLI exposes no model listing; these are the aliases and ids it accepts.
    return [
      { id: ANTHROPIC_DEFAULT_MODEL, name: 'Claude Sonnet 5.5' },
      { id: ANTHROPIC_HEAVY_MODEL, name: 'Claude Opus 5.5' },
      { id: ANTHROPIC_CHEAP_MODEL, name: 'Claude Haiku 5.5' },
    ];
  }

  async *complete(req: CompleteRequest): AsyncIterable<StreamChunk> {
    const prompt = req.messages.map(m => (m.role === 'assistant' ? `[assistant]\n${m.content}` : m.content)).join('\n\n');
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--tools', '', '--no-session-persistence', '--disable-slash-commands', '--setting-sources', '',
      '--model', req.model, '--system-prompt', req.system];
    const child = spawn(this.bin, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(req.maxTokens) } });
    child.stdin.end(prompt);
    let stderr = '';
    child.stderr.on('data', d => { stderr += d.toString(); });
    let buf = '';
    let sawDelta = false;
    let finalText = '';
    let usage = { input_tokens: 0, output_tokens: 0 };
    let resultError: string | null = null;
    const queue: StreamChunk[] = [];
    let resolveWait: (() => void) | null = null;
    let closed = false; let exitCode: number | null = null;
    const push = (c: StreamChunk) => { queue.push(c); resolveWait?.(); };
    const handleLine = (line: string) => {
      if (!line.trim()) return;
      let ev: any;
      try { ev = JSON.parse(line); } catch { return; }
      if (ev.type === 'stream_event') {
        const e = ev.event;
        if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta') { sawDelta = true; push({ delta: e.delta.text }); }
        if (e?.type === 'message_delta' && e.usage) usage.output_tokens = e.usage.output_tokens ?? usage.output_tokens;
        if (e?.type === 'message_start' && e.message?.usage) usage.input_tokens = (e.message.usage.input_tokens ?? 0) + (e.message.usage.cache_read_input_tokens ?? 0) + (e.message.usage.cache_creation_input_tokens ?? 0);
      } else if (ev.type === 'assistant' && ev.message?.content) {
        for (const b of ev.message.content) if (b.type === 'text') finalText += b.text;
        if (ev.message.usage) usage = {
          input_tokens: (ev.message.usage.input_tokens ?? 0) + (ev.message.usage.cache_read_input_tokens ?? 0) + (ev.message.usage.cache_creation_input_tokens ?? 0),
          output_tokens: ev.message.usage.output_tokens ?? usage.output_tokens };
      } else if (ev.type === 'result') {
        if (ev.is_error) resultError = typeof ev.result === 'string' ? ev.result : (ev.error ?? 'claude CLI reported an error');
        if (ev.usage) usage = {
          input_tokens: (ev.usage.input_tokens ?? 0) + (ev.usage.cache_read_input_tokens ?? 0) + (ev.usage.cache_creation_input_tokens ?? 0),
          output_tokens: ev.usage.output_tokens ?? usage.output_tokens };
        if (!sawDelta && !finalText && typeof ev.result === 'string') finalText = ev.result;
      }
    };
    child.stdout.on('data', d => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { handleLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    child.on('error', e => { resultError = `Could not start claude CLI: ${e.message}`; closed = true; resolveWait?.(); });
    child.on('close', code => { if (buf) handleLine(buf); exitCode = code; closed = true; resolveWait?.(); });

    while (true) {
      while (queue.length) yield queue.shift()!;
      if (closed) break;
      await new Promise<void>(r => { resolveWait = r; });
      resolveWait = null;
    }
    while (queue.length) yield queue.shift()!;
    if (resultError) {
      const retryable = /rate limit|overloaded|timed? ?out|529|503/i.test(resultError);
      throw new ProviderError(resultError, retryable);
    }
    if (exitCode !== 0) {
      const msg = stderr.trim() || `claude CLI exited with code ${exitCode}`;
      if (/not logged in|login|authenticate|sign in/i.test(msg)) throw new ProviderError('No Claude Code login found. Run `claude` once in a terminal and sign in, or add an API key in Settings.', false, 401);
      throw new ProviderError(msg, /rate limit|overloaded|timeout/i.test(msg));
    }
    if (!sawDelta && finalText) yield { delta: finalText };
    yield { usage, done: true };
  }

  async countTokens(text: string): Promise<number> {
    // The CLI has no counting endpoint; the estimate is marked as such in the UI.
    return estimateTokens(text);
  }
}
