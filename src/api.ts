import type { Chapter, Version, Input, InputLink, BiblePage, Review, NovelInfo, ContextPreview, PassName, ProviderId, ModelInfo } from '../shared/types';

export const NOVEL_KEY = 'nw.novel';
export const currentNovel = (): string | null => localStorage.getItem(NOVEL_KEY);
export const setCurrentNovel = (folder: string | null) => { if (folder) localStorage.setItem(NOVEL_KEY, folder); else localStorage.removeItem(NOVEL_KEY); };

const TOKEN_KEY = 'nw.token';
export const accessToken = (): string | null => localStorage.getItem(TOKEN_KEY);

export class ApiError extends Error { constructor(message: string, public status: number) { super(message); } }

async function req<T>(method: string, url: string, body?: unknown, opts: { keepalive?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const novel = currentNovel();
  if (novel) headers['x-novel'] = novel;
  const tok = accessToken(); if (tok) headers['authorization'] = `Bearer ${tok}`;
  const r = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), keepalive: opts.keepalive });
  if (r.status === 401 && (await r.clone().json().catch(() => ({}))).error === 'access token required') {
    const t = prompt('This workbench server needs its access token (printed when the server starts, stored in its config directory):');
    if (t) { localStorage.setItem(TOKEN_KEY, t.trim()); return req<T>(method, url, body, opts); }
  }
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).error ?? msg; } catch { /* keep statusText */ }
    throw new ApiError(msg, r.status);
  }
  return r.json() as Promise<T>;
}
const get = <T,>(u: string) => req<T>('GET', u);
const post = <T,>(u: string, b?: unknown) => req<T>('POST', u, b);
const put = <T,>(u: string, b?: unknown) => req<T>('PUT', u, b);
const patch = <T,>(u: string, b?: unknown) => req<T>('PATCH', u, b);
const del = <T,>(u: string, b?: unknown) => req<T>('DELETE', u, b);

export const api = {
  novels: () => get<{ novels: NovelInfo[]; defaultRoot: string }>('/api/novels'),
  openNovel: (folder: string, create = false, title?: string) => post<{ folder: string; title: string }>('/api/novels', { folder, create, title }),
  forgetNovel: (folder: string) => del('/api/novels', { folder }),
  info: () => get<{ folder: string; title: string; settings: Record<string, string> }>('/api/n/info'),

  chapters: () => get<Chapter[]>('/api/n/chapters'),
  chapter: (id: number) => get<Chapter>(`/api/n/chapters/${id}`),
  createChapter: (title: string, body = '') => post<Chapter>('/api/n/chapters', { title, body }),
  updateChapter: (id: number, p: Partial<Chapter>) => patch<Chapter>(`/api/n/chapters/${id}`, p),
  reorder: (ids: number[]) => post<Chapter[]>('/api/n/chapters/reorder', { ids }),
  saveBody: (id: number, body: string, note?: string, keepalive = false) => req<{ version: Version; chapter: Chapter }>('PUT', `/api/n/chapters/${id}/body`, { body, note }, { keepalive }),
  tag: (id: number, label: string, note?: string) => post<Version>(`/api/n/chapters/${id}/tag`, { label, note }),
  importVersion: (id: number, body: string, label?: string) => post<Version>(`/api/n/chapters/${id}/import`, { body, label }),
  versions: (id: number) => get<Version[]>(`/api/n/chapters/${id}/versions`),
  provenance: (id: number) => get<{ aiParagraphs: number[]; totalParagraphs: number; acceptVersions: number }>(`/api/n/chapters/${id}/provenance`),
  chapterInputs: (id: number) => get<{ placed: Input[]; planned: Input[]; suggested: Input[] }>(`/api/n/chapters/${id}/inputs`),
  markers: (id: number) => get<{ link: InputLink; input: Input; paragraph: number | null }[]>(`/api/n/chapters/${id}/markers`),
  chapterReviews: (id: number) => get<Review[]>(`/api/n/chapters/${id}/reviews`),
  lineCap: (id: number) => get<{ count: number; cap: number; label: string | null; refused: boolean; message?: string }>(`/api/n/chapters/${id}/line-cap`),
  restore: (versionId: number) => post<Version>(`/api/n/versions/${versionId}/restore`),
  tagVersion: (versionId: number, label: string) => post<Version>(`/api/n/versions/${versionId}/tag`, { label }),

  inputs: (q: Record<string, string | number | undefined> = {}) => get<Input[]>('/api/n/inputs?' + new URLSearchParams(Object.fromEntries(Object.entries(q).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)])))),
  createInput: (d: Partial<Input> & { title: string }) => post<Input>('/api/n/inputs', d),
  updateInput: (id: number, p: Partial<Input>) => patch<Input>(`/api/n/inputs/${id}`, p),
  placeInput: (id: number, chapter_id: number, paragraph: number) => post<{ input: Input; link: InputLink }>(`/api/n/inputs/${id}/place`, { chapter_id, paragraph }),
  unplace: (linkId: number) => del<Input>(`/api/n/input-links/${linkId}`),

  bible: () => get<BiblePage[]>('/api/n/bible'),
  createBible: (kind: string, title: string, body = '') => post<BiblePage>('/api/n/bible', { kind, title, body }),
  updateBible: (id: number, p: Partial<BiblePage>) => patch<BiblePage>(`/api/n/bible/${id}`, p),
  addVoiceSample: (text: string) => post<BiblePage>('/api/n/bible/voice/sample', { text }),

  export: () => post<{ dir: string; files: string[]; commit: string | null; gitError?: string }>('/api/n/export'),

  settings: () => get<Record<string, string>>('/api/n/settings'),
  saveSettings: (p: Record<string, string>) => put<Record<string, string>>('/api/n/settings', p),
  keys: () => get<{ mode: 'keychain' | 'file'; anthropic: boolean; gemini: boolean }>('/api/keys'),
  setKey: (provider: ProviderId, key: string) => put<{ ok: boolean; mode: string }>(`/api/keys/${provider}`, { key }),
  providers: () => get<{ id: ProviderId; mode: string; ready: boolean; reason?: string; model: string; hasKey: boolean }[]>('/api/n/providers'),
  models: (id: ProviderId, refresh = false) => get<ModelInfo[]>(`/api/n/providers/${id}/models${refresh ? '?refresh=1' : ''}`),
  testConnection: (id: ProviderId) => post<{ ok: boolean; mode: string; models: number; tokenCount?: number; error?: string }>(`/api/n/providers/${id}/test`),
  routing: () => get<Record<PassName, { provider: ProviderId; model: string }>>('/api/n/routing'),
  usage: () => get<{ provider: string; month: string; input_tokens: number; output_tokens: number; runs: number }[]>('/api/n/usage'),
  prompt: (pass: PassName) => get<{ text: string; version: string }>(`/api/n/prompts/${pass}`),
  savePrompt: (pass: PassName, text: string) => put<{ text: string; version: string }>(`/api/n/prompts/${pass}`, { text }),

  reviews: (chapter?: number) => get<Review[]>(`/api/n/reviews${chapter ? `?chapter=${chapter}` : ''}`),
  review: (id: number) => get<Review>(`/api/n/reviews/${id}`),
  preview: (r: RunRequest) => post<ContextPreview[]>('/api/n/reviews/preview', r),
  accept: (reviewId: number, paragraph: number, alternative: number) => post<{ version: Version; chapter: Chapter }>(`/api/n/reviews/${reviewId}/accept`, { paragraph, alternative }),
};

export interface RunRequest { pass: PassName; chapterId?: number; versionId?: number; marked?: number[]; question?: string; provider?: ProviderId; model?: string }
export type RunEvent =
  | { type: 'context'; provider: ProviderId; preview: ContextPreview }
  | { type: 'status'; provider: ProviderId; text: string }
  | { type: 'reset'; provider: ProviderId }
  | { type: 'delta'; provider: ProviderId; text: string }
  | { type: 'discarded'; provider: ProviderId; reason: string }
  | { type: 'error'; provider: ProviderId; message: string; refused?: boolean }
  | { type: 'done'; provider: ProviderId; review: Review }
  | { type: 'agreement'; pairs: { a: number; b: number; score: number }[] }
  | { type: 'finished' };

/** POST + server-sent events over fetch, so the review streams into the sidebar as it arrives. */
export async function runPass(r: RunRequest, onEvent: (e: RunEvent) => void, signal?: AbortSignal): Promise<void> {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-novel': currentNovel() ?? '' };
  const tok = accessToken(); if (tok) headers['authorization'] = `Bearer ${tok}`;
  const res = await fetch('/api/n/reviews/run', { method: 'POST', headers, body: JSON.stringify(r), signal });
  if (!res.ok || !res.body) { let msg = res.statusText; try { msg = (await res.json()).error ?? msg; } catch { /* */ } throw new ApiError(msg, res.status); }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
      const data = chunk.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
      if (data) { try { onEvent(JSON.parse(data)); } catch { /* ignore partial */ } }
    }
  }
}

export const markedKey = (chapterId: number) => `nw.marked.${chapterId}`;
export function getMarked(chapterId: number): number[] { try { return JSON.parse(localStorage.getItem(markedKey(chapterId)) ?? '[]'); } catch { return []; } }
export function setMarked(chapterId: number, m: number[]) { localStorage.setItem(markedKey(chapterId), JSON.stringify([...new Set(m)].sort((a, b) => a - b))); }

export const fmtDate = (s: string | null | undefined) => s ? new Date(s).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—';
export const ago = (s: string | null | undefined) => {
  if (!s) return 'never';
  const d = (Date.now() - Date.parse(s)) / 1000;
  if (d < 60) return 'just now'; if (d < 3600) return `${Math.floor(d / 60)} min ago`; if (d < 86400) return `${Math.floor(d / 3600)} h ago`; return `${Math.floor(d / 86400)} d ago`;
};
