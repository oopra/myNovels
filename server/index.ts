import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { streamSSE } from 'hono/streaming';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openNovel, closeNovel, knownNovels, type Novel } from './novel';
import { defaultNovelsRoot } from './paths';
import { NotFound, BadRequest, Refused } from './store';
import { exportNovel } from './lib/export';
import type { PassName, ProviderId, InputStatus } from '../shared/types';
import { PASS_LABELS } from '../shared/types';
import { getKey, setKey, keyStoreMode } from './ai/keys';
import { providerStatus, listModels, testConnection, providerFor, modelFor } from './ai/registry';
import { readPrompt, writePrompt } from './ai/context';
import { runPass, preview, acceptAlternative, lineCapState } from './ai/run';
import { getProvider } from './ai/registry';
import { splitParagraphs, voiceStats } from '../shared/text';

type Env = { Variables: { novel: Novel } };
export const app = new Hono<Env>();
const PORT = Number(process.env.PORT ?? 4801);

app.onError((err, c) => {
  const status = (err as { status?: number }).status;
  if (err instanceof NotFound || err instanceof BadRequest || err instanceof Refused || (status && status >= 400 && status < 500)) {
    return c.json({ error: err.message }, (status ?? 400) as 400);
  }
  console.error(err);
  return c.json({ error: err.message }, 500);
});

// ---------- novels ----------
app.get('/api/novels', c => c.json({ novels: knownNovels(), defaultRoot: defaultNovelsRoot() }));
app.post('/api/novels', async c => {
  const { folder, title, create } = await c.req.json<{ folder: string; title?: string; create?: boolean }>();
  if (!folder) throw new BadRequest('folder required');
  const n = openNovel(folder, !!create, title);
  return c.json({ folder: n.folder, title: n.title });
});
app.delete('/api/novels', async c => {
  const { folder } = await c.req.json<{ folder: string }>();
  closeNovel(folder, true);
  return c.json({ ok: true });
});

// Every route below needs an open novel, named by the X-Novel header (its folder).
app.use('/api/n/*', async (c, next) => {
  const folder = c.req.header('x-novel');
  if (!folder) return c.json({ error: 'no novel selected' }, 400);
  try { c.set('novel', openNovel(folder)); } catch (e) { return c.json({ error: (e as Error).message }, 404); }
  await next();
});
const S = (c: { get(k: 'novel'): Novel }) => c.get('novel').store;
const num = (v: string) => { const n = Number(v); if (!Number.isInteger(n)) throw new BadRequest('bad id'); return n; };

app.get('/api/n/info', c => { const n = c.get('novel'); return c.json({ folder: n.folder, title: n.title, settings: n.store.allSettings() }); });

// ---------- chapters ----------
app.get('/api/n/chapters', c => c.json(S(c).listChapters()));
app.post('/api/n/chapters', async c => { const { title, body } = await c.req.json(); return c.json(S(c).createChapter(title || 'Untitled', body ?? ''), 201); });
app.post('/api/n/chapters/reorder', async c => { const { ids } = await c.req.json(); S(c).reorderChapters(ids); return c.json(S(c).listChapters()); });
app.get('/api/n/chapters/:id', c => { const ch = S(c).getChapter(num(c.req.param('id'))); if (!ch) throw new NotFound('chapter'); return c.json(ch); });
app.patch('/api/n/chapters/:id', async c => c.json(S(c).updateChapterMeta(num(c.req.param('id')), await c.req.json())));
app.put('/api/n/chapters/:id/body', async c => {
  const { body, note } = await c.req.json<{ body: string; note?: string }>();
  const v = S(c).saveBody(num(c.req.param('id')), body ?? '', { kind: 'autosave', note });
  return c.json({ version: v, chapter: S(c).getChapter(num(c.req.param('id'))) });
});
app.post('/api/n/chapters/:id/tag', async c => { const { label, note } = await c.req.json(); if (!label) throw new BadRequest('label required'); return c.json(S(c).tagDraft(num(c.req.param('id')), label, note), 201); });
app.post('/api/n/chapters/:id/import', async c => { const { body, label, note } = await c.req.json(); return c.json(S(c).importVersion(num(c.req.param('id')), body ?? '', label, note), 201); });
app.get('/api/n/chapters/:id/versions', c => c.json(S(c).listVersions(num(c.req.param('id')))));
app.get('/api/n/chapters/:id/provenance', c => c.json(S(c).provenanceSummary(num(c.req.param('id')))));
app.get('/api/n/chapters/:id/inputs', c => c.json(S(c).inputsForChapter(num(c.req.param('id')))));
app.get('/api/n/chapters/:id/markers', c => c.json(S(c).markersForChapter(num(c.req.param('id')))));
app.get('/api/n/chapters/:id/reviews', c => c.json(S(c).listReviews(num(c.req.param('id')))));
app.get('/api/n/chapters/:id/stats', c => { const ch = S(c).getChapter(num(c.req.param('id'))); if (!ch) throw new NotFound('chapter'); return c.json({ paragraphs: splitParagraphs(ch.body).length, voice: voiceStats(ch.body) }); });
app.get('/api/n/chapters/:id/line-cap', c => c.json(lineCapState(c.get('novel'), num(c.req.param('id')))));

// ---------- versions ----------
app.get('/api/n/versions/:id', c => { const v = S(c).getVersion(num(c.req.param('id'))); if (!v) throw new NotFound('version'); return c.json(v); });
app.post('/api/n/versions/:id/restore', c => c.json(S(c).restoreVersion(num(c.req.param('id'))), 201));
app.post('/api/n/versions/:id/tag', async c => { const { label } = await c.req.json(); if (!label) throw new BadRequest('label required'); return c.json(S(c).tagExistingVersion(num(c.req.param('id')), label), 201); });

// ---------- inputs ----------
app.get('/api/n/inputs', c => c.json(S(c).listInputs({ status: c.req.query('status') as InputStatus | undefined, chapter: c.req.query('chapter') ? Number(c.req.query('chapter')) : undefined, kind: c.req.query('kind') || undefined })));
app.post('/api/n/inputs', async c => { const d = await c.req.json(); if (!d.title?.trim()) throw new BadRequest('title required'); return c.json(S(c).createInput(d), 201); });
app.patch('/api/n/inputs/:id', async c => c.json(S(c).updateInput(num(c.req.param('id')), await c.req.json())));
app.post('/api/n/inputs/:id/place', async c => { const { chapter_id, paragraph } = await c.req.json(); return c.json(S(c).placeInput(num(c.req.param('id')), Number(chapter_id), Number(paragraph)), 201); });
app.delete('/api/n/input-links/:id', c => c.json(S(c).unplaceInput(num(c.req.param('id')))));

// ---------- bible ----------
app.get('/api/n/bible', c => c.json(S(c).listBible()));
app.post('/api/n/bible', async c => { const { kind, title, body } = await c.req.json(); if (!kind || !title) throw new BadRequest('kind and title required'); return c.json(S(c).createBible(kind, title, body ?? ''), 201); });
app.patch('/api/n/bible/:id', async c => c.json(S(c).updateBible(num(c.req.param('id')), await c.req.json())));
app.post('/api/n/bible/voice/sample', async c => { const { text } = await c.req.json(); if (!text?.trim()) throw new BadRequest('text required'); return c.json(S(c).addVoiceSample(text)); });

// ---------- export ----------
app.post('/api/n/export', async c => { const n = c.get('novel'); return c.json(await exportNovel(n.store, n.folder, n.title)); });

// ---------- settings, keys, providers ----------
app.get('/api/n/settings', c => c.json(S(c).allSettings()));
app.put('/api/n/settings', async c => { const patch = await c.req.json<Record<string, string>>(); for (const [k, v] of Object.entries(patch)) { if (/key|secret|token/i.test(k)) throw new Refused('API keys are not stored in settings'); S(c).setSetting(k, v); } return c.json(S(c).allSettings()); });
app.get('/api/keys', async c => c.json({ mode: await keyStoreMode(), anthropic: !!(await getKey('anthropic')), gemini: !!(await getKey('gemini')) }));
app.put('/api/keys/:provider', async c => { const { key } = await c.req.json<{ key: string }>(); const p = c.req.param('provider'); if (p !== 'anthropic' && p !== 'gemini') throw new BadRequest('unknown provider'); await setKey(p, key ?? ''); return c.json({ ok: true, mode: await keyStoreMode() }); });
app.get('/api/n/providers', async c => c.json(await providerStatus(S(c))));
app.get('/api/n/providers/:id/models', async c => c.json(await listModels(S(c), c.req.param('id') as ProviderId, c.req.query('refresh') === '1')));
app.post('/api/n/providers/:id/test', async c => c.json(await testConnection(S(c), c.req.param('id') as ProviderId)));
app.get('/api/n/routing', c => { const s = S(c); const out: Record<string, { provider: ProviderId; model: string }> = {}; for (const p of Object.keys(PASS_LABELS) as PassName[]) out[p] = { provider: providerFor(s, p), model: modelFor(s, providerFor(s, p), p) }; return c.json(out); });
app.get('/api/n/usage', c => c.json(S(c).usageByMonth()));
app.get('/api/n/prompts/:pass', c => c.json(readPrompt(c.get('novel'), c.req.param('pass') as PassName)));
app.put('/api/n/prompts/:pass', async c => { const { text } = await c.req.json(); writePrompt(c.get('novel'), c.req.param('pass') as PassName, text); return c.json(readPrompt(c.get('novel'), c.req.param('pass') as PassName)); });

// ---------- reviews ----------
app.get('/api/n/reviews', c => c.json(S(c).listReviews(c.req.query('chapter') ? Number(c.req.query('chapter')) : undefined)));
app.get('/api/n/reviews/:id', c => { const r = S(c).getReview(num(c.req.param('id'))); if (!r) throw new NotFound('review'); return c.json(r); });
app.post('/api/n/reviews/preview', async c => {
  const req = await c.req.json();
  const { previews } = preview(c.get('novel'), req);
  // Exact token count where the provider offers one; estimate otherwise.
  for (const pv of previews) {
    try { const p = await getProvider(pv.provider, S(c)); if (pv.model) { pv.tokens = await p.countTokens(`${pv.system}\n\n${pv.user}`, pv.model); pv.exact = p.mode.includes('sdk') || p.mode.includes('genai'); } } catch { /* estimate stands */ }
  }
  return c.json(previews);
});
app.post('/api/n/reviews/run', async c => {
  const req = await c.req.json();
  const novel = c.get('novel');
  return streamSSE(c, async stream => {
    try {
      for await (const ev of runPass(novel, req)) await stream.writeSSE({ event: ev.type, data: JSON.stringify(ev) });
    } catch (e) {
      await stream.writeSSE({ event: 'error', data: JSON.stringify({ type: 'error', provider: req.provider ?? 'anthropic', message: (e as Error).message, refused: e instanceof Refused }) });
      await stream.writeSSE({ event: 'finished', data: JSON.stringify({ type: 'finished' }) });
    }
  });
});
app.post('/api/n/reviews/:id/accept', async c => { const { paragraph, alternative } = await c.req.json(); return c.json(acceptAlternative(c.get('novel'), num(c.req.param('id')), Number(paragraph), Number(alternative)), 201); });

// ---------- static client (production) ----------
const here = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.resolve(here, '..', 'dist', 'client');
if (fs.existsSync(clientDir)) {
  app.use('/*', serveStatic({ root: path.relative(process.cwd(), clientDir) || '.' }));
  app.get('*', c => c.html(fs.readFileSync(path.join(clientDir, 'index.html'), 'utf8')));
}

if (process.env.VITEST === undefined) {
  serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' }, info => {
    console.log(`Novel Workbench backend on http://127.0.0.1:${info.port}`);
  });
}
