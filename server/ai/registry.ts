import type { Store } from '../store';
import type { ModelInfo, ProviderId, PassName } from '../../shared/types';
import { PASS_DEFAULT_PROVIDER } from '../../shared/types';
import type { Provider } from './provider';
import { ProviderError } from './provider';
import { AnthropicCliProvider, AnthropicSdkProvider, ANTHROPIC_DEFAULT_MODEL } from './anthropic';
import { GeminiProvider } from './gemini';
import { getKey } from './keys';

const DAY = 24 * 3600 * 1000;

export interface ProviderStatus { id: ProviderId; mode: string; ready: boolean; reason?: string; model: string; hasKey: boolean }

/** Test hook: lets tests swap in fake providers without touching the vendor SDKs. */
export let providerFactory: ((id: ProviderId, store: Store) => Promise<Provider>) | null = null;
export function setProviderFactory(f: typeof providerFactory): void { providerFactory = f; }

export async function anthropicMode(store: Store): Promise<'cli' | 'api'> {
  const pref = store.getSetting('anthropic.mode');
  if (pref === 'api') return 'api';
  if (pref === 'cli') return 'cli';
  const cli = await AnthropicCliProvider.available();
  if (cli.ok) return 'cli';
  return (await getKey('anthropic')) ? 'api' : 'cli';
}

export async function getProvider(id: ProviderId, store: Store): Promise<Provider> {
  if (providerFactory) return providerFactory(id, store);
  if (id === 'anthropic') {
    const mode = await anthropicMode(store);
    if (mode === 'api') {
      const key = await getKey('anthropic');
      if (!key) throw new ProviderError('No Anthropic API key in Settings and the claude CLI is not available.', false, 401);
      return new AnthropicSdkProvider(key);
    }
    const cli = await AnthropicCliProvider.available();
    if (!cli.ok) throw new ProviderError(cli.reason!, false, 401);
    return new AnthropicCliProvider();
  }
  const key = await getKey('gemini');
  if (!key) throw new ProviderError('No Gemini API key. Add one from Google AI Studio in Settings.', false, 401);
  return new GeminiProvider(key);
}

export async function providerStatus(store: Store): Promise<ProviderStatus[]> {
  const out: ProviderStatus[] = [];
  const aKey = !!(await getKey('anthropic'));
  const mode = await anthropicMode(store);
  if (mode === 'cli') {
    const cli = await AnthropicCliProvider.available();
    out.push({ id: 'anthropic', mode: `Max login via claude CLI${cli.version ? ` (${cli.version})` : ''}`, ready: cli.ok, reason: cli.reason, model: modelFor(store, 'anthropic'), hasKey: aKey });
  } else {
    out.push({ id: 'anthropic', mode: 'API key via @anthropic-ai/sdk', ready: aKey, reason: aKey ? undefined : 'No API key saved.', model: modelFor(store, 'anthropic'), hasKey: aKey });
  }
  const gKey = !!(await getKey('gemini'));
  out.push({ id: 'gemini', mode: 'API key via @google/genai', ready: gKey, reason: gKey ? undefined : 'No API key saved. Get one from Google AI Studio.', model: modelFor(store, 'gemini'), hasKey: gKey });
  return out;
}

export function modelFor(store: Store, id: ProviderId, pass?: PassName): string {
  if (pass) { const p = store.getSetting(`pass.${pass}.model.${id}`); if (p) return p; }
  const m = store.getSetting(`${id}.model`);
  if (m) return m;
  if (id === 'anthropic') return ANTHROPIC_DEFAULT_MODEL;
  // Gemini: never hard-code an id; fall back to the first cached Pro model, else an empty string that Settings flags.
  const cached = cachedModels(store, 'gemini');
  const pro = cached?.find(m => /pro/i.test(m.id) && !/preview|exp|tts|image|live|audio/i.test(m.id)) ?? cached?.[0];
  return pro?.id ?? '';
}

export function providerFor(store: Store, pass: PassName): ProviderId {
  const o = store.getSetting(`pass.${pass}.provider`) as ProviderId | undefined;
  return o === 'anthropic' || o === 'gemini' ? o : PASS_DEFAULT_PROVIDER[pass];
}

export function cachedModels(store: Store, id: ProviderId): ModelInfo[] | null {
  const raw = store.getSetting(`models.${id}`);
  if (!raw) return null;
  try { const { at, models } = JSON.parse(raw); return Date.now() - at < DAY ? models : models; } catch { return null; }
}

export async function listModels(store: Store, id: ProviderId, force = false): Promise<ModelInfo[]> {
  const raw = store.getSetting(`models.${id}`);
  if (raw && !force) {
    try { const { at, models } = JSON.parse(raw); if (Date.now() - at < DAY) return models; } catch { /* refetch */ }
  }
  const p = await getProvider(id, store);
  const models = await p.listModels();
  store.setSetting(`models.${id}`, JSON.stringify({ at: Date.now(), models }));
  return models;
}

export async function testConnection(store: Store, id: ProviderId): Promise<{ ok: boolean; mode: string; models: number; tokenCount?: number; error?: string }> {
  try {
    const p = await getProvider(id, store);
    const models = await listModels(store, id, true);
    const model = modelFor(store, id) || models[0]?.id;
    let tokenCount: number | undefined;
    if (model) tokenCount = await p.countTokens('The quick brown fox jumps over the lazy dog.', model);
    return { ok: true, mode: p.mode, models: models.length, tokenCount };
  } catch (e) {
    return { ok: false, mode: '', models: 0, error: (e as Error).message };
  }
}
