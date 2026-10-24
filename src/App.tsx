import React, { useEffect, useState, createContext, useContext, useCallback } from 'react';
import { api, currentNovel, setCurrentNovel } from './api';
import { Home } from './screens/Home';
import { Manuscript } from './screens/Manuscript';
import { Editor } from './screens/Editor';
import { History } from './screens/History';
import { Inputs } from './screens/Inputs';
import { Bible } from './screens/Bible';
import { Review } from './screens/Review';
import { Settings } from './screens/Settings';

export interface Route { name: string; id?: number; q: URLSearchParams }
export function parseHash(): Route {
  const h = location.hash.replace(/^#\/?/, '');
  const [pathPart, query = ''] = h.split('?');
  const [name = '', id] = pathPart.split('/');
  return { name: name || 'home', id: id ? Number(id) : undefined, q: new URLSearchParams(query) };
}
export const go = (path: string) => { location.hash = path.startsWith('#') ? path : `#/${path}`; };

interface Ctx { novel: { folder: string; title: string } | null; refreshNovel: () => Promise<void>; toast: (msg: string, kind?: 'ok' | 'err') => void }
const AppCtx = createContext<Ctx>({ novel: null, refreshNovel: async () => {}, toast: () => {} });
export const useApp = () => useContext(AppCtx);

export function App() {
  const [route, setRoute] = useState<Route>(parseHash());
  const [novel, setNovel] = useState<{ folder: string; title: string } | null>(null);
  const [toasts, setToasts] = useState<{ id: number; msg: string; kind: 'ok' | 'err' }[]>([]);
  const toast = useCallback((msg: string, kind: 'ok' | 'err' = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts(t => [...t, { id, msg, kind }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), kind === 'err' ? 8000 : 3500);
  }, []);
  const refreshNovel = useCallback(async () => {
    const f = currentNovel();
    if (!f) { setNovel(null); return; }
    try { const i = await api.info(); setNovel({ folder: i.folder, title: i.title }); }
    catch { setCurrentNovel(null); setNovel(null); }
  }, []);
  useEffect(() => { const h = () => setRoute(parseHash()); addEventListener('hashchange', h); return () => removeEventListener('hashchange', h); }, []);
  useEffect(() => { refreshNovel(); }, [refreshNovel]);
  useEffect(() => { if (!currentNovel() && route.name !== 'home') go('home'); }, [route]);

  const nav = [['manuscript', 'Manuscript'], ['inputs', 'Inputs'], ['bible', 'Bible'], ['review', 'Review'], ['settings', 'Settings']];
  let screen: React.ReactNode;
  switch (route.name) {
    case 'home': screen = <Home />; break;
    case 'manuscript': screen = <Manuscript />; break;
    case 'chapter': screen = <Editor id={route.id!} />; break;
    case 'history': screen = <History id={route.id!} q={route.q} />; break;
    case 'inputs': screen = <Inputs q={route.q} />; break;
    case 'bible': screen = <Bible q={route.q} />; break;
    case 'review': screen = <Review id={route.id} q={route.q} />; break;
    case 'settings': screen = <Settings />; break;
    default: screen = <div className="pad">Unknown screen.</div>;
  }
  return (
    <AppCtx.Provider value={{ novel, refreshNovel, toast }}>
      <div className="app">
        <header className="topbar">
          <a href="#/home" className="brand">Novel Workbench</a>
          {novel && <span className="novel-title" title={novel.folder}>{novel.title}</span>}
          <nav>
            {novel && nav.map(([k, label]) => <a key={k} href={`#/${k}`} className={route.name === k || (k === 'manuscript' && ['chapter', 'history'].includes(route.name)) ? 'active' : ''}>{label}</a>)}
          </nav>
        </header>
        <main className={`screen screen-${route.name}`}>{screen}</main>
        <div className="toasts">{toasts.map(t => <div key={t.id} className={`toast ${t.kind}`}>{t.msg}</div>)}</div>
      </div>
    </AppCtx.Provider>
  );
}
