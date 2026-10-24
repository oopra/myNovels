import React, { useEffect, useRef, useState } from 'react';
import type { BiblePage } from '../../shared/types';
import { api, fmtDate } from '../api';
import { useApp } from '../App';

const KIND_LABEL: Record<string, string> = { synopsis: 'Synopsis', character: 'Characters', world: 'World', timeline: 'Timeline', voice: 'Voice', corrections: 'Corrections' };
const ORDER = ['synopsis', 'character', 'world', 'timeline', 'voice', 'corrections'];

export function Bible({ q }: { q: URLSearchParams }) {
  const { toast } = useApp();
  const [pages, setPages] = useState<BiblePage[]>([]);
  const [sel, setSel] = useState<number | null>(q.get('page') ? Number(q.get('page')) : null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [state, setState] = useState<'saved' | 'dirty' | 'saving'>('saved');
  const timer = useRef<number | null>(null);
  const load = async () => { const p = await api.bible(); setPages(p); if (sel == null && p.length) setSel(p.find(x => x.kind === 'voice')?.id ?? p[0].id); };
  useEffect(() => { load(); }, []);
  const page = pages.find(p => p.id === sel);
  useEffect(() => { if (page) { setTitle(page.title); setBody(page.body); setState('saved'); } }, [page?.id]);
  const save = async (t = title, b = body) => {
    if (!page) return;
    setState('saving');
    try { const p = await api.updateBible(page.id, { title: t, body: b }); setPages(ps => ps.map(x => x.id === p.id ? p : x)); setState('saved'); }
    catch (e) { setState('dirty'); toast((e as Error).message, 'err'); }
  };
  const onBody = (v: string) => { setBody(v); setState('dirty'); if (timer.current) clearTimeout(timer.current); timer.current = window.setTimeout(() => save(title, v), 1500); };
  const addCharacter = async () => {
    const name = prompt('Character name:'); if (!name) return;
    const p = await api.createBible('character', name, `# ${name}\n\nAge:\nRole:\nWants:\nVoice tics:\n`);
    await load(); setSel(p.id);
  };
  const voiceSections = page?.kind === 'voice' ? splitVoice(body) : null;
  return (
    <div className="bible">
      <div className="bible-list">
        {ORDER.map(kind => {
          const group = pages.filter(p => p.kind === kind);
          return (
            <div key={kind}>
              <h3>{KIND_LABEL[kind]}{kind === 'character' && <button className="small" style={{ marginLeft: 8 }} onClick={addCharacter}>+ add</button>}</h3>
              {group.map(p => <a key={p.id} href="#" className={sel === p.id ? 'active' : ''} onClick={e => { e.preventDefault(); setSel(p.id); }}>{p.title}</a>)}
              {group.length === 0 && kind === 'character' && <div className="muted small" style={{ padding: '0 8px' }}>No characters yet.</div>}
            </div>
          );
        })}
      </div>
      <div className="bible-edit">
        {page ? (
          <>
            <div className="row" style={{ marginBottom: 8 }}>
              <input value={title} onChange={e => setTitle(e.target.value)} onBlur={() => title !== page.title && save()} style={{ fontSize: 16, fontWeight: 600, flex: 1 }} />
              <span className="muted small">{state === 'saved' ? `Saved ${fmtDate(page.updated_at)}` : state === 'saving' ? 'Saving…' : 'Unsaved'}</span>
            </div>
            {page.kind === 'voice' && (
              <div className="warn-box small" style={{ marginBottom: 8 }}>
                The voice pass reads <strong>## Samples</strong> and <strong>## Rules</strong> separately. Samples: {voiceSections?.samplesParas ?? 0} paragraph{voiceSections?.samplesParas === 1 ? '' : 's'} · Rules: {voiceSections?.rulesLines ?? 0} line{voiceSections?.rulesLines === 1 ? '' : 's'}. Add a sample from the editor with “→ Voice sample”.
              </div>
            )}
            {page.kind === 'corrections' && <div className="muted small" style={{ marginBottom: 8 }}>Facts the model keeps getting wrong, one per line. Every pass receives this page.</div>}
            <textarea value={body} onChange={e => onBody(e.target.value)} onBlur={() => state === 'dirty' && save()} spellCheck />
          </>
        ) : <div className="muted">Pick a page.</div>}
      </div>
    </div>
  );
}

function splitVoice(body: string): { samplesParas: number; rulesLines: number } {
  const m = /^##\s*Samples\s*$([\s\S]*?)(?=^##\s*Rules|$(?![\s\S]))/mi.exec(body);
  const r = /^##\s*Rules\s*$([\s\S]*)/mi.exec(body);
  return { samplesParas: (m?.[1] ?? '').split(/\n\s*\n/).filter(x => x.trim()).length, rulesLines: (r?.[1] ?? '').split('\n').filter(x => x.trim()).length };
}
