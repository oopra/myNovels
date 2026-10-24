import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { NovelInfo } from '../shared/types';

/** App-level config lives outside any novel folder. */
export function configDir(): string {
  const base = process.env.NOVEL_WORKBENCH_CONFIG
    ?? (process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support', 'novel-workbench')
      : process.platform === 'win32'
        ? path.join(process.env.APPDATA ?? os.homedir(), 'novel-workbench')
        : path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'novel-workbench'));
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  return base;
}

const registryFile = () => path.join(configDir(), 'novels.json');

export function listNovels(): NovelInfo[] {
  try {
    const raw = JSON.parse(fs.readFileSync(registryFile(), 'utf8')) as NovelInfo[];
    return raw.filter(n => fs.existsSync(path.join(n.folder, 'novel.db')))
      .sort((a, b) => b.last_opened.localeCompare(a.last_opened));
  } catch { return []; }
}

export function rememberNovel(info: NovelInfo): void {
  const all = listNovels().filter(n => n.folder !== info.folder);
  all.unshift(info);
  fs.writeFileSync(registryFile(), JSON.stringify(all, null, 2), { mode: 0o600 });
}

export function forgetNovel(folder: string): void {
  const all = listNovels().filter(n => n.folder !== folder);
  fs.writeFileSync(registryFile(), JSON.stringify(all, null, 2), { mode: 0o600 });
}

export function defaultNovelsRoot(): string {
  return process.env.NOVEL_WORKBENCH_NOVELS ?? path.join(os.homedir(), 'Novels');
}
