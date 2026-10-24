import React, { useEffect, useRef, useState, useCallback } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { Chapter, Input, InputLink, Review, Version } from '../../shared/types';
import { PASS_LABELS } from '../../shared/types';
import { api, getMarked, setMarked as persistMarked, ago, fmtDate } from '../api';
import { useApp } from '../App';
import { workbenchExtensions, setMarked, setMarkers, setAiParas, paragraphAt, DRAG_TYPE, type EditorCallbacks } from '../editor/cm';

type Tab = 'inputs' | 'reviews' | 'history';

export function Editor({ id }: { id: number }) {
  const { toast } = useApp();
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const cbs = useRef<EditorCallbacks>(null!);
  const [chapter, setChapter] = useState<Chapter | null>(null);
  const [title, setTitle] = useState('');
  const [saveState, setSaveState] = useState<'saved' | 'dirty' | 'saving'>('saved');
  const [marked, setMarkedState] = useState<number[]>(() => getMarked(id));
  const [tab, setTab] = useState<Tab>('inputs');
  const [groups, setGroups] = useState<{ placed: Input[]; planned: Input[]; suggested: Input[] }>({ placed: [], planned: [], suggested: [] });
  const [markers, setMarkersState] = useState<{ link: InputLink; input: Input; paragraph: number | null }[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [versions, setVersions] = useState<Version[]>([]);
  const [paraCount, setParaCount] = useState(0);
  const dirty = useRef<string | null>(null);
  const timer = useRef<number | null>(null);

  const refreshSide = useCallback(async () => {
    const [g, m, r, v, prov] = await Promise.all([api.chapterInputs(id), api.markers(id), api.chapterReviews(id), api.versions(id), api.provenance(id)]);
    setGroups(g); setMarkersState(m); setReviews(r); setVersions(v);
    view.current?.dispatch({ effects: [
      setMarkers.of(m.filter(x => x.paragraph != null).map(x => ({ paragraph: x.paragraph!, label: x.input.title.length > 28 ? x.input.title.slice(0, 26) + '…' : x.input.title, linkId: x.link.id, inputId: x.input.id }))),
      setAiParas.of(prov.aiParagraphs),
    ] });
  }, [id]);

  const save = useCallback(async (note?: string, keepalive = false) => {
    const body = dirty.current;
    if (body == null) return;
    setSaveState('saving');
    try {
      const r = await api.saveBody(id, body, note, keepalive);
      if (dirty.current === body) { dirty.current = null; setSaveState('saved'); }
      setChapter(r.chapter);
    } catch (e) { setSaveState('dirty'); toast(`Autosave failed: ${(e as Error).message}`, 'err'); }
  }, [id, toast]);

  cbs.current = {
    onChange(doc) {
      dirty.current = doc; setSaveState('dirty');
      if (view.current) setParaCount(countParas(view.current.state));
      if (timer.current) clearTimeout(timer.current);
      timer.current = window.setTimeout(() => save(), 2000);
    },
    onBlur() { if (dirty.current != null) save(); },
    onSave() { save(); },
    onToggleMark(p) {
      const next = marked.includes(p) ? marked.filter(x => x !== p) : [...marked, p].sort((a, b) => a - b);
      setMarkedState(next); persistMarked(id, next);
      view.current?.dispatch({ effects: setMarked.of(next) });
    },
    async onDropInput(inputId, paragraph) {
      try {
        if (dirty.current != null) await save();
        await api.placeInput(inputId, id, paragraph);
        toast(`Placed on paragraph ${paragraph}`);
        await refreshSide();
      } catch (e) { toast((e as Error).message, 'err'); }
    },
    async onMarkerClick(linkId) {
      if (!confirm('Remove this marker? The input goes back to planned; it is not deleted.')) return;
      try { await api.unplace(linkId); await refreshSide(); } catch (e) { toast((e as Error).message, 'err'); }
    },
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const c = await api.chapter(id);
      if (cancelled) return;
      setChapter(c); setTitle(c.title);
      const m = getMarked(id); setMarkedState(m);
      const state = EditorState.create({ doc: c.body, extensions: workbenchExtensions(() => cbs.current) });
      view.current?.destroy();
      view.current = new EditorView({ state, parent: host.current! });
      view.current.dispatch({ effects: setMarked.of(m) });
      setParaCount(countParas(state));
      await refreshSide();
    })();
    const onHide = () => { if (dirty.current != null) { api.saveBody(id, dirty.current, 'recovered on close', true).catch(() => {}); } };
    addEventListener('pagehide', onHide); addEventListener('beforeunload', onHide);
    return () => { cancelled = true; removeEventListener('pagehide', onHide); removeEventListener('beforeunload', onHide); if (dirty.current != null) onHide(); if (timer.current) clearTimeout(timer.current); view.current?.destroy(); view.current = null; dirty.current = null; };
  }, [id, refreshSide]);

  const saveTitle = async () => { if (chapter && title.trim() && title !== chapter.title) setChapter(await api.updateChapter(id, { title: title.trim() })); };
  const tagDraft = async () => {
    const label = prompt('Tag the current state as a draft. Label:', suggestLabel(versions));
    if (!label) return;
    if (dirty.current != null) await save();
    try { await api.tag(id, label); toast(`Tagged "${label}"`); refreshSide(); } catch (e) { toast((e as Error).message, 'err'); }
  };
  const toVoiceSample = async () => {
    const v = view.current; if (!v) return;
    const p = paragraphAt(v.state, v.state.selection.main.head);
    if (!p) { toast('Put the cursor in a paragraph first.', 'err'); return; }
    try { await api.addVoiceSample(p.text); toast(`Paragraph ${p.index} added to voice samples`); } catch (e) { toast((e as Error).message, 'err'); }
  };

  const dragStart = (e: React.DragEvent, input: Input) => { e.dataTransfer.setData(DRAG_TYPE, String(input.id)); e.dataTransfer.effectAllowed = 'link'; };

  return (
    <div className="editor-layout">
      <div className="editor-main">
        <div className="editor-head">
          <a href="#/manuscript" className="muted">‹</a>
          <input className="title" value={title} onChange={e => setTitle(e.target.value)} onBlur={saveTitle} onKeyDown={e => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
          <span className="save-state">{saveState === 'saved' ? 'Saved' : saveState === 'saving' ? 'Saving…' : 'Unsaved'}</span>
          <span className="muted small">{chapter?.word_count.toLocaleString() ?? 0} words · {paraCount} ¶</span>
          {marked.length > 0 && <span className="badge" title="Paragraphs marked for a line pass">{marked.length} marked → <a href={`#/review/${id}?pass=line`}>line pass</a></span>}
          <button className="small" onClick={toVoiceSample} title="Add the paragraph at the cursor to the voice page's Samples">→ Voice sample</button>
          <button className="small" onClick={tagDraft}>Tag as draft</button>
          <a className="small" href={`#/history/${id}`}>History</a>
          <a className="small" href={`#/review/${id}`}>Review</a>
        </div>
        <div className="cm-host" ref={host} />
      </div>
      <aside className="sidebar">
        <div className="tabs">
          {(['inputs', 'reviews', 'history'] as Tab[]).map(t => <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{t[0].toUpperCase() + t.slice(1)}{t === 'inputs' && groups.planned.length ? ` (${groups.planned.length})` : ''}</button>)}
        </div>
        <div className="sidebar-body">
          {tab === 'inputs' && (
            <>
              <h3>Placed here</h3>
              {groups.placed.length === 0 && <div className="muted small">Nothing placed yet.</div>}
              {groups.placed.map(i => (
                <div key={i.id} className="input-card" style={{ cursor: 'default' }}>
                  <div className="kind">{i.kind}</div>
                  <div>{i.title}</div>
                  {markers.filter(m => m.input.id === i.id).map(m => <div key={m.link.id} className="anchor">¶{m.paragraph ?? '?'} · “{m.link.anchor_text}” <a href="#" onClick={e => { e.preventDefault(); cbs.current.onMarkerClick(m.link.id); }}>remove</a></div>)}
                </div>
              ))}
              <h3>Planned for this chapter</h3>
              {groups.planned.length === 0 && <div className="muted small">Nothing planned. Capture on the Inputs screen with this chapter as target.</div>}
              {groups.planned.map(i => <div key={i.id} className="input-card" draggable onDragStart={e => dragStart(e, i)} title="Drag onto a paragraph to place"><div className="kind">{i.kind} · p{i.priority}</div><div>{i.title}</div></div>)}
              <h3>Unassigned, mentions this chapter</h3>
              {groups.suggested.length === 0 && <div className="muted small">No unassigned inputs match a name or term here.</div>}
              {groups.suggested.map(i => <div key={i.id} className="input-card" draggable onDragStart={e => dragStart(e, i)}><div className="kind">{i.kind} · {i.status}</div><div>{i.title}</div></div>)}
              <p className="muted small" style={{ marginTop: 14 }}>Drag a card onto a paragraph to place it. Click a paragraph number to mark it for a line pass.</p>
            </>
          )}
          {tab === 'reviews' && (
            <>
              {reviews.length === 0 && <div className="muted small">No reviews yet. <a href={`#/review/${id}`}>Run a pass.</a></div>}
              {reviews.map(r => (
                <div key={r.id} className="review-list-item" onClick={() => { location.hash = `#/review/${id}?review=${r.id}`; }}>
                  <strong>{PASS_LABELS[r.pass]}</strong> <span className="muted">· {r.provider} · {ago(r.created_at)}</span>
                  <div className="muted small">version {r.version_id}{verdictOf(r)}</div>
                </div>
              ))}
            </>
          )}
          {tab === 'history' && (
            <>
              {versions.slice(0, 30).map(v => (
                <div key={v.id} className="version-item">
                  {v.label && <span className="label">{v.label} · </span>}<span>{v.kind}</span>{v.provenance === 'ai_assisted' && <span className="badge ai" style={{ marginLeft: 6 }}>AI</span>}
                  <div className="muted small">{fmtDate(v.created_at)} · {v.word_count} words{v.note ? ` · ${v.note}` : ''}</div>
                </div>
              ))}
              <p><a href={`#/history/${id}`}>Open full history and diff →</a></p>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

function countParas(state: EditorState): number {
  let n = 0; let pos = 0; const text = state.doc.toString();
  for (const block of text.split(/\n\s*\n/)) { if (block.trim()) n++; pos += block.length; }
  return n;
}
function suggestLabel(versions: Version[]): string {
  const nums = versions.map(v => Number(/draft\s*(\d+)/i.exec(v.label ?? '')?.[1] ?? 0));
  return `draft ${Math.max(0, ...nums) + 1}`;
}
function verdictOf(r: Review): string {
  try { const m = JSON.parse(r.meta ?? '{}'); return m.verdict ? ` · ${m.verdict}` : ''; } catch { return ''; }
}
