import React, { useEffect, useState } from 'react';
import type { Chapter, ChapterStatus } from '../../shared/types';
import { api, ago } from '../api';
import { useApp } from '../App';

const STATUSES: ChapterStatus[] = ['outline', 'drafting', 'revising', 'done'];

export function Manuscript() {
  const { toast } = useApp();
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [title, setTitle] = useState('');
  const [drag, setDrag] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [exporting, setExporting] = useState(false);
  const load = () => api.chapters().then(setChapters).catch(e => toast(e.message, 'err'));
  useEffect(() => { load(); }, []);
  const add = async () => {
    if (!title.trim()) return;
    const c = await api.createChapter(title.trim());
    setTitle('');
    location.hash = `#/chapter/${c.id}`;
  };
  const drop = async (targetId: number) => {
    if (drag == null || drag === targetId) { setDrag(null); setOver(null); return; }
    const ids = chapters.map(c => c.id).filter(id => id !== drag);
    ids.splice(ids.indexOf(targetId), 0, drag);
    setChapters(await api.reorder(ids));
    setDrag(null); setOver(null);
  };
  const doExport = async () => {
    setExporting(true);
    try {
      const r = await api.export();
      toast(r.gitError ? `Exported ${r.files.length} files to ${r.dir}; git: ${r.gitError}` : `Exported ${r.files.length} files to ${r.dir} (commit ${r.commit})`, r.gitError ? 'err' : 'ok');
    } catch (e) { toast((e as Error).message, 'err'); } finally { setExporting(false); }
  };
  const words = chapters.reduce((n, c) => n + c.word_count, 0);
  const owed = chapters.reduce((n, c) => n + (c.owed ?? 0), 0);
  return (
    <div className="pad">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1>Manuscript</h1>
        <div className="row">
          <span className="muted">{chapters.length} chapters · {words.toLocaleString()} words · {owed} owed</span>
          <button onClick={doExport} disabled={exporting}>{exporting ? 'Exporting…' : 'Export + commit'}</button>
        </div>
      </div>
      <table>
        <thead><tr><th style={{ width: 36 }}>#</th><th>Title</th><th>Status</th><th>Words</th><th>Owed</th><th>Last edit</th><th>Last review</th><th></th></tr></thead>
        <tbody>
          {chapters.map(c => (
            <tr key={c.id} draggable onDragStart={() => setDrag(c.id)} onDragOver={e => { e.preventDefault(); setOver(c.id); }} onDragLeave={() => setOver(null)} onDrop={() => drop(c.id)} onDragEnd={() => { setDrag(null); setOver(null); }}
              className={`${drag === c.id ? 'dragging' : ''} ${over === c.id ? 'drop-target' : ''}`}>
              <td className="muted">{c.number}</td>
              <td><a href={`#/chapter/${c.id}`}><strong>{c.title}</strong></a></td>
              <td><select className="status-select" value={c.status} onChange={async e => { await api.updateChapter(c.id, { status: e.target.value as ChapterStatus }); load(); }}>{STATUSES.map(s => <option key={s}>{s}</option>)}</select></td>
              <td>{c.word_count.toLocaleString()}</td>
              <td><span className={`badge ${c.owed ? '' : 'zero'}`}>{c.owed ?? 0}</span></td>
              <td className="muted">{ago(c.updated_at)}</td>
              <td className="muted">{c.last_review_at ? ago(c.last_review_at) : <span>—</span>}</td>
              <td className="row small"><a href={`#/history/${c.id}`}>History</a><a href={`#/review/${c.id}`}>Review</a></td>
            </tr>
          ))}
          {chapters.length === 0 && <tr><td colSpan={8} className="muted">No chapters yet. Add one below.</td></tr>}
        </tbody>
      </table>
      <div className="row" style={{ marginTop: 14 }}>
        <input placeholder="New chapter title" value={title} onChange={e => setTitle(e.target.value)} onKeyDown={e => e.key === 'Enter' && add()} style={{ width: 320 }} />
        <button className="primary" onClick={add} disabled={!title.trim()}>Add chapter</button>
        <span className="muted small">Drag rows to reorder. Owed = inputs in inbox or planned for that chapter.</span>
      </div>
    </div>
  );
}
