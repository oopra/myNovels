import React, { useEffect, useMemo, useState } from 'react';
import { diffWords } from 'diff';
import type { Version, Chapter } from '../../shared/types';
import { api, fmtDate } from '../api';
import { useApp } from '../App';

export function History({ id, q }: { id: number; q: URLSearchParams }) {
  const { toast } = useApp();
  const [chapter, setChapter] = useState<Chapter | null>(null);
  const [versions, setVersions] = useState<Version[]>([]);
  const [a, setA] = useState<number | null>(q.get('a') ? Number(q.get('a')) : null);
  const [b, setB] = useState<number | null>(q.get('b') ? Number(q.get('b')) : null);
  const [prov, setProv] = useState<{ aiParagraphs: number[]; totalParagraphs: number; acceptVersions: number } | null>(null);
  const load = async () => {
    const [c, vs, p] = await Promise.all([api.chapter(id), api.versions(id), api.provenance(id)]);
    setChapter(c); setVersions(vs); setProv(p);
    if (a == null && b == null && vs.length >= 2) {
      const tagged = vs.filter(v => v.kind === 'tagged');
      if (tagged.length >= 2) { setA(tagged[1].id); setB(tagged[0].id); } else { setA(vs[1].id); setB(vs[0].id); }
    }
  };
  useEffect(() => { load(); }, [id]);
  const va = versions.find(v => v.id === a); const vb = versions.find(v => v.id === b);
  const diff = useMemo(() => (va && vb ? diffWords(va.body, vb.body) : []), [va?.id, vb?.id]);
  const removedWords = diff.filter(p => p.removed).reduce((n, p) => n + p.value.trim().split(/\s+/).filter(Boolean).length, 0);
  const addedWords = diff.filter(p => p.added).reduce((n, p) => n + p.value.trim().split(/\s+/).filter(Boolean).length, 0);
  const restore = async (v: Version) => {
    if (!confirm(`Restore version ${v.id}${v.label ? ` (${v.label})` : ''}? This creates a new version; nothing is overwritten.`)) return;
    try { await api.restore(v.id); toast('Restored as a new version'); load(); } catch (e) { toast((e as Error).message, 'err'); }
  };
  const tag = async (v: Version) => {
    const label = prompt('Label for this version (e.g. "draft 2"):', v.label ?? '');
    if (!label) return;
    try { await api.tagVersion(v.id, label); toast(`Tagged "${label}"`); load(); } catch (e) { toast((e as Error).message, 'err'); }
  };
  return (
    <div className="history">
      <div className="version-list">
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
          <strong>{chapter?.title}</strong>
          <a href={`#/chapter/${id}`} className="small">Edit</a>
        </div>
        {prov && <div className="muted small" style={{ marginBottom: 8 }}>{prov.aiParagraphs.length} of {prov.totalParagraphs} paragraphs AI-touched{prov.aiParagraphs.length ? ` (¶${prov.aiParagraphs.join(', ¶')})` : ''} · {prov.acceptVersions} accept{prov.acceptVersions === 1 ? '' : 's'}</div>}
        <div className="muted small" style={{ marginBottom: 6 }}>A = older · B = newer. Pick two to compare.</div>
        {versions.map(v => (
          <div key={v.id} className={`version-row ${v.kind === 'tagged' ? 'tagged' : ''}`}>
            <input type="radio" name="a" checked={a === v.id} onChange={() => setA(v.id)} title="A" />
            <input type="radio" name="b" checked={b === v.id} onChange={() => setB(v.id)} title="B" />
            <div>
              <div>{v.label ? <strong style={{ color: 'var(--accent)' }}>{v.label}</strong> : <span>{v.kind}</span>} {v.provenance === 'ai_assisted' && <span className="badge ai">AI</span>} <span className="muted">#{v.id}</span></div>
              <div className="meta">{fmtDate(v.created_at)} · {v.word_count} words{v.kind !== 'tagged' && v.note ? ` · ${v.note}` : ''}</div>
              <div className="row small" style={{ marginTop: 3 }}>
                <a href="#" onClick={e => { e.preventDefault(); tag(v); }}>tag as draft</a>
                <a href="#" onClick={e => { e.preventDefault(); restore(v); }}>restore</a>
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="diff-pane">
        {va && vb ? (
          <>
            <div className="diff-summary row">
              <span><strong>A</strong> {va.label ?? va.kind} #{va.id} <span className="muted">{fmtDate(va.created_at)}</span></span>
              <span>→</span>
              <span><strong>B</strong> {vb.label ?? vb.kind} #{vb.id} <span className="muted">{fmtDate(vb.created_at)}</span></span>
              <span className="muted">· <span style={{ color: 'var(--err)' }}>−{removedWords}</span> / <span style={{ color: 'var(--ok)' }}>+{addedWords}</span> words</span>
              <button className="small" onClick={() => { setA(b); setB(a); }}>swap</button>
            </div>
            <div className="diff">
              <div className="col">{diff.map((p, i) => p.added ? null : <span key={i} className={p.removed ? 'removed' : ''}>{p.value}</span>)}</div>
              <div className="col">{diff.map((p, i) => p.removed ? null : <span key={i} className={p.added ? 'added' : ''}>{p.value}</span>)}</div>
            </div>
          </>
        ) : <div className="muted pad">Select two versions to see a word-level diff.</div>}
      </div>
    </div>
  );
}
