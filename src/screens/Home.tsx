import React, { useEffect, useState } from 'react';
import type { NovelInfo } from '../../shared/types';
import { api, setCurrentNovel, ago } from '../api';
import { go, useApp } from '../App';

export function Home() {
  const { refreshNovel, toast } = useApp();
  const [novels, setNovels] = useState<NovelInfo[]>([]);
  const [root, setRoot] = useState('');
  const [title, setTitle] = useState('');
  const [folder, setFolder] = useState('');
  const [openPath, setOpenPath] = useState('');
  useEffect(() => { api.novels().then(r => { setNovels(r.novels); setRoot(r.defaultRoot); }); }, []);
  const open = async (f: string, create = false, t?: string) => {
    try {
      const r = await api.openNovel(f, create, t);
      setCurrentNovel(r.folder);
      await refreshNovel();
      go('manuscript');
    } catch (e) { toast((e as Error).message, 'err'); }
  };
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const target = folder || (root && slug ? `${root}/${slug}` : '');
  return (
    <div className="pad">
      <h1>Novels</h1>
      <p className="muted">One SQLite file per novel, in a folder you pick. Nothing leaves this machine unless you run a review pass.</p>
      {novels.length > 0 && (
        <div className="home-list">
          {novels.map(n => (
            <a key={n.folder} href="#" onClick={e => { e.preventDefault(); open(n.folder); }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <strong>{n.title}</strong>
                <span className="muted small">opened {ago(n.last_opened)}</span>
              </div>
              <div className="muted mono small">{n.folder}</div>
            </a>
          ))}
        </div>
      )}
      <div className="card" style={{ marginTop: 18 }}>
        <h2 style={{ marginTop: 0 }}>New novel</h2>
        <div className="row">
          <input placeholder="Title" value={title} onChange={e => setTitle(e.target.value)} style={{ width: 260 }} />
          <input placeholder={target || 'Folder'} value={folder} onChange={e => setFolder(e.target.value)} style={{ flex: 1, minWidth: 320 }} className="mono" />
          <button className="primary" disabled={!title.trim() || !target} onClick={() => open(target, true, title.trim())}>Create</button>
        </div>
        <div className="muted small" style={{ marginTop: 6 }}>Creates <span className="mono">novel.db</span>, a <span className="mono">prompts/</span> folder and a <span className="mono">discarded/</span> folder inside it.</div>
      </div>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Open an existing folder</h2>
        <div className="row">
          <input placeholder="/path/to/novel-folder" value={openPath} onChange={e => setOpenPath(e.target.value)} style={{ flex: 1, minWidth: 320 }} className="mono" />
          <button disabled={!openPath.trim()} onClick={() => open(openPath.trim())}>Open</button>
        </div>
      </div>
    </div>
  );
}
