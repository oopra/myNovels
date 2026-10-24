import path from 'node:path';
import fs from 'node:fs';
import { openNovelDb, type DB } from './db';
import { Store } from './store';
import { rememberNovel, listNovels, forgetNovel } from './paths';

export class Novel {
  store: Store;
  constructor(public folder: string, public db: DB) { this.store = new Store(db); }
  get title(): string { return this.store.getSetting('title') || path.basename(this.folder); }
  promptsDir(): string { return path.join(this.folder, 'prompts'); }
  discardedDir(): string { return path.join(this.folder, 'discarded'); }
}

const open = new Map<string, Novel>();

export function openNovel(folder: string, create = false, title?: string): Novel {
  const abs = path.resolve(folder);
  let n = open.get(abs);
  if (!n) {
    if (create && fs.existsSync(path.join(abs, 'novel.db'))) create = false;
    const db = openNovelDb(abs, create);
    n = new Novel(abs, db);
    if (title) n.store.setSetting('title', title);
    open.set(abs, n);
  }
  rememberNovel({ folder: abs, title: n.title, last_opened: new Date().toISOString() });
  return n;
}

export function closeNovel(folder: string, forget = false): void {
  const abs = path.resolve(folder);
  open.get(abs)?.db.close();
  open.delete(abs);
  if (forget) forgetNovel(abs);
}

export function knownNovels() { return listNovels(); }
