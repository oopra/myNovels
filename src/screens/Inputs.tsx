import React, { useEffect, useState } from 'react';
import type { Input, InputStatus, InputKind, Chapter } from '../../shared/types';
import { INPUT_KINDS } from '../../shared/types';
import { api } from '../api';
import { useApp } from '../App';

const COLS: InputStatus[] = ['inbox', 'planned', 'placed', 'dropped'];

export function Inputs({ q }: { q: URLSearchParams }) {
  const { toast } = useApp();
  const [inputs, setInputs] = useState<Input[]>([]);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [text, setText] = useState('');
  const [kind, setKind] = useState<InputKind>('idea');
  const [target, setTarget] = useState<string>(q.get('chapter') ?? '');
  const [priority, setPriority] = useState('2');
  const [fChapter, setFChapter] = useState(q.get('chapter') ?? '');
  const [fKind, setFKind] = useState('');
  const [fPriority, setFPriority] = useState('');
  const [over, setOver] = useState<InputStatus | null>(null);
  const [dropOver, setDropOver] = useState(false);
  const [editing, setEditing] = useState<Input | null>(null);
  const load = () => Promise.all([api.inputs(), api.chapters()]).then(([i, c]) => { setInputs(i); setChapters(c); }).catch(e => toast(e.message, 'err'));
  useEffect(() => { load(); }, []);

  const capture = async (title = text, body = '', source?: string, k: InputKind = kind) => {
    if (!title.trim()) return;
    try {
      await api.createInput({ title: title.trim(), body, kind: k, source, target_chapter_id: target ? Number(target) : null, priority: Number(priority) });
      setText(''); load();
    } catch (e) { toast((e as Error).message, 'err'); }
  };
  const captureText = () => {
    const t = text.trim();
    if (/^https?:\/\/\S+$/i.test(t)) return capture(t.replace(/^https?:\/\//, '').slice(0, 80), '', t, 'source');
    return capture();
  };
  const onFiles = async (files: FileList | null) => {
    if (!files) return;
    for (const f of Array.from(files)) {
      const body = f.type.startsWith('text/') || /\.(md|txt|markdown)$/i.test(f.name) ? (await f.text()).slice(0, 20000) : '';
      await capture(f.name, body, f.name, 'source');
    }
  };
  const move = async (id: number, status: InputStatus) => {
    try { await api.updateInput(id, { status }); load(); } catch (e) { toast((e as Error).message, 'err'); }
  };
  const visible = inputs.filter(i => (!fChapter || String(i.target_chapter_id) === fChapter) && (!fKind || i.kind === fKind) && (!fPriority || String(i.priority) === fPriority));
  const chapterName = (id: number | null) => { const c = chapters.find(c => c.id === id); return c ? `ch ${c.number}` : null; };
  return (
    <div className="pad" style={{ maxWidth: 1400 }}>
      <h1>Inputs <span className="muted" style={{ fontSize: 14, fontWeight: 400 }}>· {inputs.filter(i => i.status === 'inbox' || i.status === 'planned').length} owed</span></h1>
      <div className="capture">
        <input type="text" placeholder="Capture: an idea, a line, a note, or paste a URL. Enter to add." value={text} onChange={e => setText(e.target.value)} onKeyDown={e => e.key === 'Enter' && captureText()} />
        <select value={kind} onChange={e => setKind(e.target.value as InputKind)}>{INPUT_KINDS.map(k => <option key={k} value={k}>{k.replace('_', ' ')}</option>)}</select>
        <select value={target} onChange={e => setTarget(e.target.value)}><option value="">no chapter yet</option>{chapters.map(c => <option key={c.id} value={c.id}>ch {c.number}: {c.title}</option>)}</select>
        <select value={priority} onChange={e => setPriority(e.target.value)}><option value="1">p1 high</option><option value="2">p2</option><option value="3">p3 low</option></select>
        <button className="primary" onClick={captureText} disabled={!text.trim()}>Add</button>
      </div>
      <div className="row" style={{ marginBottom: 14 }}>
        <div className={`dropzone ${dropOver ? 'over' : ''}`} onDragOver={e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDropOver(true); } }} onDragLeave={() => setDropOver(false)} onDrop={e => { e.preventDefault(); setDropOver(false); onFiles(e.dataTransfer.files); }}>
          Drop a file here to capture it as a source{' '}<label style={{ color: 'var(--accent)', cursor: 'pointer' }}>or choose<input type="file" multiple style={{ display: 'none' }} onChange={e => onFiles(e.target.files)} /></label>
        </div>
        <span className="muted small" style={{ marginLeft: 'auto' }}>Filter:</span>
        <select value={fChapter} onChange={e => setFChapter(e.target.value)}><option value="">any chapter</option>{chapters.map(c => <option key={c.id} value={c.id}>ch {c.number}: {c.title}</option>)}</select>
        <select value={fKind} onChange={e => setFKind(e.target.value)}><option value="">any kind</option>{INPUT_KINDS.map(k => <option key={k} value={k}>{k.replace('_', ' ')}</option>)}</select>
        <select value={fPriority} onChange={e => setFPriority(e.target.value)}><option value="">any priority</option><option value="1">p1</option><option value="2">p2</option><option value="3">p3</option></select>
      </div>
      <div className="board">
        {COLS.map(col => (
          <div key={col} className={`column ${over === col ? 'over' : ''}`} onDragOver={e => { if (e.dataTransfer.types.includes('text/x-nw-move')) { e.preventDefault(); setOver(col); } }} onDragLeave={() => setOver(null)} onDrop={e => { const id = Number(e.dataTransfer.getData('text/x-nw-move')); setOver(null); if (id) { if (col === 'placed') toast('Place an input by dragging it onto a paragraph in the editor.', 'err'); else move(id, col); } }}>
            <h3>{col} <span className="muted">({visible.filter(i => i.status === col).length})</span></h3>
            {visible.filter(i => i.status === col).map(i => (
              <div key={i.id} className="input-card" draggable onDragStart={e => e.dataTransfer.setData('text/x-nw-move', String(i.id))} onClick={() => setEditing(i)}>
                <div className="kind">{i.kind.replace('_', ' ')} · p{i.priority}{chapterName(i.target_chapter_id) ? ` · ${chapterName(i.target_chapter_id)}` : ''}</div>
                <div>{i.title}</div>
                {i.source && <div className="anchor">{i.source.length > 50 ? i.source.slice(0, 48) + '…' : i.source}</div>}
                {i.links?.map(l => <div key={l.id} className="anchor">placed: <a href={`#/chapter/${l.chapter_id}`} onClick={e => e.stopPropagation()}>{chapterName(l.chapter_id)}</a> · “{l.anchor_text.slice(0, 60)}”</div>)}
              </div>
            ))}
          </div>
        ))}
      </div>
      <p className="muted small">Drag cards between Inbox, Planned and Dropped. Placing happens in the editor: drag the input onto a paragraph. Nothing here is ever deleted; Dropped is a status.</p>
      {editing && <EditDialog input={editing} chapters={chapters} onClose={() => { setEditing(null); load(); }} />}
    </div>
  );
}

function EditDialog({ input, chapters, onClose }: { input: Input; chapters: Chapter[]; onClose: () => void }) {
  const { toast } = useApp();
  const [d, setD] = useState<Input>(input);
  const save = async () => {
    try { await api.updateInput(input.id, { title: d.title, body: d.body, kind: d.kind, source: d.source, target_chapter_id: d.target_chapter_id, priority: d.priority, status: d.status }); onClose(); }
    catch (e) { toast((e as Error).message, 'err'); }
  };
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 40 }} onClick={onClose}>
      <div className="card" style={{ width: 560, maxWidth: '90vw' }} onClick={e => e.stopPropagation()}>
        <h2 style={{ marginTop: 0 }}>Input #{input.id}</h2>
        <div className="settings-grid">
          <label>Title</label><input value={d.title} onChange={e => setD({ ...d, title: e.target.value })} />
          <label>Kind</label><select value={d.kind} onChange={e => setD({ ...d, kind: e.target.value as InputKind })}>{INPUT_KINDS.map(k => <option key={k} value={k}>{k.replace('_', ' ')}</option>)}</select>
          <label>Target chapter</label><select value={d.target_chapter_id ?? ''} onChange={e => setD({ ...d, target_chapter_id: e.target.value ? Number(e.target.value) : null, status: d.status === 'inbox' && e.target.value ? 'planned' : d.status })}><option value="">none yet</option>{chapters.map(c => <option key={c.id} value={c.id}>ch {c.number}: {c.title}</option>)}</select>
          <label>Priority</label><select value={d.priority} onChange={e => setD({ ...d, priority: Number(e.target.value) })}><option value="1">p1 high</option><option value="2">p2</option><option value="3">p3 low</option></select>
          <label>Status</label><select value={d.status} onChange={e => setD({ ...d, status: e.target.value as InputStatus })}>{COLS.filter(c => c !== 'placed' || d.status === 'placed').map(c => <option key={c}>{c}</option>)}</select>
          <label>Source</label><input value={d.source ?? ''} placeholder="url, file path or person" onChange={e => setD({ ...d, source: e.target.value || null })} />
        </div>
        <label className="muted small" style={{ display: 'block', marginTop: 10 }}>Body</label>
        <textarea value={d.body} onChange={e => setD({ ...d, body: e.target.value })} style={{ minHeight: 120 }} />
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 10 }}>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={save}>Save</button>
        </div>
      </div>
    </div>
  );
}
