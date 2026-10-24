import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { SEED_PROMPTS } from './ai/prompts';

export type DB = Database.Database;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS chapters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number INTEGER NOT NULL,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'drafting' CHECK (status IN ('outline','drafting','revising','done')),
  body TEXT NOT NULL DEFAULT '',
  word_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chapter_id INTEGER NOT NULL REFERENCES chapters(id),
  body TEXT NOT NULL,
  label TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  kind TEXT NOT NULL CHECK (kind IN ('autosave','tagged','restore','accept','import')),
  provenance TEXT NOT NULL DEFAULT 'human' CHECK (provenance IN ('human','ai_assisted')),
  parent_version_id INTEGER REFERENCES versions(id)
);
CREATE INDEX IF NOT EXISTS versions_chapter ON versions(chapter_id, id);
CREATE TABLE IF NOT EXISTS inputs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'idea' CHECK (kind IN ('idea','research','line','scene','character_note','critique','source')),
  source TEXT,
  status TEXT NOT NULL DEFAULT 'inbox' CHECK (status IN ('inbox','planned','placed','dropped')),
  target_chapter_id INTEGER REFERENCES chapters(id),
  priority INTEGER NOT NULL DEFAULT 2,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS input_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  input_id INTEGER NOT NULL REFERENCES inputs(id),
  chapter_id INTEGER NOT NULL REFERENCES chapters(id),
  version_id INTEGER NOT NULL REFERENCES versions(id),
  anchor_text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS bible_pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('synopsis','character','world','timeline','voice','corrections')),
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chapter_id INTEGER REFERENCES chapters(id),
  version_id INTEGER REFERENCES versions(id),
  pass TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  output TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  meta TEXT
);
CREATE TABLE IF NOT EXISTS pass_counters (
  chapter_id INTEGER NOT NULL,
  tagged_version_id INTEGER NOT NULL DEFAULT 0,
  pass TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chapter_id, tagged_version_id, pass)
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Guardrails enforced by the database itself.
-- Versions are immutable. The single exception: an autosave may be superseded
-- (body only) while it is still the newest version and within its ten-minute window;
-- that is how "autosaves within 10 minutes collapse into the latest" works without
-- ever touching a tagged, restore, accept or import row.
CREATE TRIGGER IF NOT EXISTS versions_no_delete BEFORE DELETE ON versions
BEGIN SELECT RAISE(ABORT, 'versions are immutable: delete refused'); END;
CREATE TRIGGER IF NOT EXISTS versions_no_update BEFORE UPDATE ON versions
WHEN OLD.kind <> 'autosave'
  OR NEW.kind <> OLD.kind OR NEW.id <> OLD.id OR NEW.chapter_id <> OLD.chapter_id
  OR NEW.created_at <> OLD.created_at OR NEW.provenance <> OLD.provenance
  OR coalesce(NEW.parent_version_id,0) <> coalesce(OLD.parent_version_id,0)
  OR coalesce(NEW.label,'') <> coalesce(OLD.label,'')
  OR OLD.id <> (SELECT max(id) FROM versions WHERE chapter_id = OLD.chapter_id)
BEGIN SELECT RAISE(ABORT, 'versions are immutable: update refused'); END;

-- Inputs are never deleted; dropped is a status.
CREATE TRIGGER IF NOT EXISTS inputs_no_delete BEFORE DELETE ON inputs
BEGIN SELECT RAISE(ABORT, 'inputs are never deleted: set status to dropped'); END;

-- Reviews are read-only once written.
CREATE TRIGGER IF NOT EXISTS reviews_no_update BEFORE UPDATE ON reviews
BEGIN SELECT RAISE(ABORT, 'reviews are read-only'); END;
CREATE TRIGGER IF NOT EXISTS reviews_no_delete BEFORE DELETE ON reviews
BEGIN SELECT RAISE(ABORT, 'reviews are read-only'); END;
`;

export const DEFAULT_BIBLE: { kind: string; title: string; body: string }[] = [
  { kind: 'synopsis', title: 'Synopsis', body: '' },
  { kind: 'world', title: 'World', body: '' },
  { kind: 'timeline', title: 'Timeline', body: '' },
  { kind: 'voice', title: 'Voice', body: '## Samples\n\n\n## Rules\n\n- Contractions in dialogue.\n- Varied sentence length.\n- Dry, not sentimental.\n- Do not explain what the scene already shows.\n' },
  { kind: 'corrections', title: 'Corrections', body: '' },
];

export function openNovelDb(folder: string, create = false): DB {
  const file = path.join(folder, 'novel.db');
  if (!create && !fs.existsSync(file)) throw new Error(`No novel at ${folder}`);
  fs.mkdirSync(folder, { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  const count = db.prepare('SELECT count(*) c FROM bible_pages').get() as { c: number };
  if (count.c === 0) {
    const ins = db.prepare('INSERT INTO bible_pages (kind, title, body) VALUES (?, ?, ?)');
    for (const p of DEFAULT_BIBLE) ins.run(p.kind, p.title, p.body);
  }
  seedPrompts(folder);
  for (const d of ['prompts', 'discarded']) fs.mkdirSync(path.join(folder, d), { recursive: true });
  return db;
}

export function openMemoryDb(): DB {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  const ins = db.prepare('INSERT INTO bible_pages (kind, title, body) VALUES (?, ?, ?)');
  for (const p of DEFAULT_BIBLE) ins.run(p.kind, p.title, p.body);
  return db;
}

export function seedPrompts(folder: string): void {
  const dir = path.join(folder, 'prompts');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(SEED_PROMPTS)) {
    const f = path.join(dir, `${name.replace(/_/g, '-')}.md`);
    if (!fs.existsSync(f)) fs.writeFileSync(f, text);
  }
}

export function now(): string { return new Date().toISOString(); }
