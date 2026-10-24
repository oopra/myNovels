import React, { useEffect, useState } from 'react';
import type { NovelInfo } from '../../shared/types';
import { api, setCurrentNovel, ago, serverUrl, setServerUrl, accessToken, setAccessToken, isNativeShell, ApiError } from '../api';
import { go, useApp } from '../App';

export function Home() {
  const { refreshNovel, toast } = useApp();
  const [novels, setNovels] = useState<NovelInfo[]>([]);
  const [root, setRoot] = useState('');
  const [title, setTitle] = useState('');
  const [folder, setFolder] = useState('');
  const [openPath, setOpenPath] = useState('');
  const [server, setServer] = useState(serverUrl());
  const [token, setToken] = useState(accessToken() ?? '');
  const [connState, setConnState] = useState<'idle' | 'ok' | 'error'>('idle');
  const [connError, setConnError] = useState('');
  const [showServer, setShowServer] = useState(isNativeShell() || !!serverUrl());
  const load = async () => {
    try { const r = await api.novels(); setNovels(r.novels); setRoot(r.defaultRoot); setConnState('ok'); setConnError(''); }
    catch (e) { setConnState('error'); setConnError(e instanceof ApiError ? `${e.status} ${e.message}` : (e as Error).message); setShowServer(true); }
  };
  useEffect(() => { load(); }, []);
  const connect = async () => { setServerUrl(server); setAccessToken(token.trim() || null); setServer(serverUrl()); await load(); };
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
      <p className="muted">One SQLite file per novel, kept on the workbench server. Nothing leaves it unless you run a review pass.</p>
      {showServer ? (
        <div className="card" style={{ marginBottom: 18 }}>
          <h2 style={{ marginTop: 0 }}>Server</h2>
          <div className="settings-grid">
            <label>Server URL</label><input className="mono" placeholder="https://novel-workbench.fly.dev" value={server} onChange={e => setServer(e.target.value)} />
            <label>Access token</label><input type="password" placeholder="NOVEL_WORKBENCH_TOKEN on the server" value={token} onChange={e => setToken(e.target.value)} />
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <button className="primary" onClick={connect}>Connect</button>
            {connState === 'ok' && <span className="badge ok">connected{server ? ` to ${server}` : ' (same origin)'}</span>}
            {connState === 'error' && <span className="badge err" title={connError}>cannot reach server: {connError}</span>}
          </div>
          {isNativeShell() && <div className="muted small" style={{ marginTop: 6 }}>This app keeps nothing locally. Point it at your cloud workbench server (HTTPS) and paste the token once.</div>}
        </div>
      ) : (
        <div className="muted small" style={{ marginBottom: 12 }}>Connected to this server. <a href="#" onClick={e => { e.preventDefault(); setShowServer(true); }}>Use a different server</a></div>
      )}
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
