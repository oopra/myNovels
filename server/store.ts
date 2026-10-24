import type { DB } from './db';
import type { Chapter, Version, Input, InputLink, BiblePage, Review, VersionKind, Provenance, InputStatus } from '../shared/types';
import { wordCount, slugify, splitParagraphs, firstSentence, properTerms } from '../shared/text';

const AUTOSAVE_WINDOW_MS = 10 * 60 * 1000;

export class Store {
  constructor(public db: DB) {}

  // ---------- settings ----------
  getSetting(key: string): string | undefined {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return r?.value;
  }
  setSetting(key: string, value: string): void {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }
  allSettings(): Record<string, string> {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    return Object.fromEntries(rows.map(r => [r.key, r.value]));
  }

  // ---------- chapters ----------
  listChapters(): Chapter[] {
    return this.db.prepare(`
      SELECT c.*,
        (SELECT count(*) FROM inputs i WHERE i.target_chapter_id = c.id AND i.status IN ('inbox','planned')) AS owed,
        (SELECT max(created_at) FROM reviews r WHERE r.chapter_id = c.id) AS last_review_at,
        (SELECT count(*) FROM versions v WHERE v.chapter_id = c.id) AS version_count
      FROM chapters c ORDER BY c.number`).all() as Chapter[];
  }
  getChapter(id: number): Chapter | undefined {
    return this.db.prepare('SELECT * FROM chapters WHERE id = ?').get(id) as Chapter | undefined;
  }
  createChapter(title: string, body = ''): Chapter {
    const n = (this.db.prepare('SELECT coalesce(max(number),0) m FROM chapters').get() as { m: number }).m + 1;
    const r = this.db.prepare(`INSERT INTO chapters (number, slug, title, body, word_count) VALUES (?, ?, ?, ?, ?)`)
      .run(n, slugify(title), title, body, wordCount(body));
    const id = Number(r.lastInsertRowid);
    this.db.prepare(`INSERT INTO versions (chapter_id, body, kind, note) VALUES (?, ?, 'autosave', 'created')`).run(id, body);
    return this.getChapter(id)!;
  }
  updateChapterMeta(id: number, patch: Partial<Pick<Chapter, 'title' | 'status'>>): Chapter {
    const c = this.getChapter(id);
    if (!c) throw new NotFound('chapter');
    const title = patch.title ?? c.title;
    const status = patch.status ?? c.status;
    this.db.prepare(`UPDATE chapters SET title = ?, slug = ?, status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
      .run(title, slugify(title), status, id);
    return this.getChapter(id)!;
  }
  reorderChapters(ids: number[]): void {
    const upd = this.db.prepare('UPDATE chapters SET number = ? WHERE id = ?');
    this.db.transaction(() => { ids.forEach((id, i) => upd.run(i + 1, id)); })();
  }

  /** Save the chapter body. Creates a version of the given kind; autosaves collapse within a window. */
  saveBody(chapterId: number, body: string, opts: { kind?: VersionKind; note?: string; label?: string; provenance?: Provenance; parent?: number } = {}): Version {
    const kind = opts.kind ?? 'autosave';
    return this.db.transaction(() => {
      const c = this.getChapter(chapterId);
      if (!c) throw new NotFound('chapter');
      this.db.prepare(`UPDATE chapters SET body = ?, word_count = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
        .run(body, wordCount(body), chapterId);
      const latest = this.latestVersion(chapterId);
      if (kind === 'autosave' && latest && latest.kind === 'autosave' && latest.body !== body
          && Date.now() - Date.parse(latest.created_at) < AUTOSAVE_WINDOW_MS && !opts.note) {
        this.db.prepare(`UPDATE versions SET body = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(body, latest.id);
        return this.getVersion(latest.id)!;
      }
      if (kind === 'autosave' && latest && latest.body === body && !opts.note) return latest;
      const r = this.db.prepare(`INSERT INTO versions (chapter_id, body, kind, note, label, provenance, parent_version_id) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(chapterId, body, kind, opts.note ?? null, opts.label ?? null, opts.provenance ?? 'human', opts.parent ?? null);
      return this.getVersion(Number(r.lastInsertRowid))!;
    })();
  }

  // ---------- versions ----------
  listVersions(chapterId: number): Version[] {
    const rows = this.db.prepare('SELECT * FROM versions WHERE chapter_id = ? ORDER BY id DESC').all(chapterId) as Version[];
    return rows.map(v => ({ ...v, word_count: wordCount(v.body) }));
  }
  getVersion(id: number): Version | undefined {
    return this.db.prepare('SELECT * FROM versions WHERE id = ?').get(id) as Version | undefined;
  }
  latestVersion(chapterId: number): Version | undefined {
    return this.db.prepare('SELECT * FROM versions WHERE chapter_id = ? ORDER BY id DESC LIMIT 1').get(chapterId) as Version | undefined;
  }
  latestTaggedVersion(chapterId: number): Version | undefined {
    return this.db.prepare(`SELECT * FROM versions WHERE chapter_id = ? AND kind = 'tagged' ORDER BY id DESC LIMIT 1`).get(chapterId) as Version | undefined;
  }
  /** Ensure there is a version row whose body equals the chapter's current body; create an autosave if not. */
  currentVersion(chapterId: number): Version {
    const c = this.getChapter(chapterId);
    if (!c) throw new NotFound('chapter');
    const latest = this.latestVersion(chapterId);
    if (latest && latest.body === c.body) return latest;
    return this.saveBody(chapterId, c.body, { kind: 'autosave', note: 'snapshot before action' });
  }
  tagDraft(chapterId: number, label: string, note?: string): Version {
    const c = this.getChapter(chapterId);
    if (!c) throw new NotFound('chapter');
    return this.saveBody(chapterId, c.body, { kind: 'tagged', label, note });
  }
  /** Relabel a version. Labels on tagged drafts are set at tag time; only the free-text note may change,
   *  and only on an autosave that is still open. Everything else goes through a new tagged version. */
  tagExistingVersion(versionId: number, label: string): Version {
    const v = this.getVersion(versionId);
    if (!v) throw new NotFound('version');
    const r = this.db.prepare(`INSERT INTO versions (chapter_id, body, kind, label, note, provenance, parent_version_id) VALUES (?, ?, 'tagged', ?, ?, ?, ?)`)
      .run(v.chapter_id, v.body, label, `tagged from version ${v.id}`, v.provenance, v.id);
    const nv = this.getVersion(Number(r.lastInsertRowid))!;
    // Tagging a historical state does not change the chapter's current text.
    return nv;
  }
  restoreVersion(versionId: number): Version {
    const v = this.getVersion(versionId);
    if (!v) throw new NotFound('version');
    return this.saveBody(v.chapter_id, v.body, { kind: 'restore', note: `restored version ${v.id}${v.label ? ` (${v.label})` : ''}`, parent: v.id, provenance: v.provenance });
  }
  importVersion(chapterId: number, body: string, label?: string, note?: string): Version {
    const v = this.saveBody(chapterId, body, { kind: 'import', note: note ?? 'imported' });
    if (label) return this.tagExistingVersion(v.id, label);
    return v;
  }
  /** How many of the chapter's paragraphs were last touched by an AI accept. */
  provenanceSummary(chapterId: number): { aiParagraphs: number[]; totalParagraphs: number; acceptVersions: number } {
    const c = this.getChapter(chapterId);
    if (!c) throw new NotFound('chapter');
    const rows = this.db.prepare(`SELECT note FROM versions WHERE chapter_id = ? AND kind = 'accept'`).all(chapterId) as { note: string }[];
    const paras = new Set<number>();
    for (const r of rows) { const m = /¶(\d+)/.exec(r.note ?? ''); if (m) paras.add(Number(m[1])); }
    return { aiParagraphs: [...paras].sort((a, b) => a - b), totalParagraphs: splitParagraphs(c.body).length, acceptVersions: rows.length };
  }

  // ---------- inputs ----------
  listInputs(filter: { status?: InputStatus; chapter?: number; kind?: string } = {}): Input[] {
    const where: string[] = []; const args: unknown[] = [];
    if (filter.status) { where.push('status = ?'); args.push(filter.status); }
    if (filter.chapter) { where.push('target_chapter_id = ?'); args.push(filter.chapter); }
    if (filter.kind) { where.push('kind = ?'); args.push(filter.kind); }
    const rows = this.db.prepare(`SELECT * FROM inputs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY priority, updated_at DESC`).all(...args) as Input[];
    const links = this.db.prepare('SELECT * FROM input_links ORDER BY id').all() as InputLink[];
    for (const r of rows) r.links = links.filter(l => l.input_id === r.id);
    return rows;
  }
  getInput(id: number): Input | undefined {
    const r = this.db.prepare('SELECT * FROM inputs WHERE id = ?').get(id) as Input | undefined;
    if (r) r.links = this.db.prepare('SELECT * FROM input_links WHERE input_id = ? ORDER BY id').all(id) as InputLink[];
    return r;
  }
  createInput(data: Partial<Input> & { title: string }): Input {
    const r = this.db.prepare(`INSERT INTO inputs (title, body, kind, source, status, target_chapter_id, priority) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(data.title, data.body ?? '', data.kind ?? 'idea', data.source ?? null,
        data.status ?? (data.target_chapter_id ? 'planned' : 'inbox'), data.target_chapter_id ?? null, data.priority ?? 2);
    return this.getInput(Number(r.lastInsertRowid))!;
  }
  updateInput(id: number, patch: Partial<Input>): Input {
    const cur = this.getInput(id);
    if (!cur) throw new NotFound('input');
    const next = { ...cur, ...patch };
    this.db.prepare(`UPDATE inputs SET title=?, body=?, kind=?, source=?, status=?, target_chapter_id=?, priority=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
      .run(next.title, next.body, next.kind, next.source, next.status, next.target_chapter_id, next.priority, id);
    return this.getInput(id)!;
  }
  /** Place an input on a paragraph of a chapter. Records the exact version and anchor sentence. */
  placeInput(inputId: number, chapterId: number, paragraph: number): { input: Input; link: InputLink } {
    return this.db.transaction(() => {
      const input = this.getInput(inputId);
      if (!input) throw new NotFound('input');
      const c = this.getChapter(chapterId);
      if (!c) throw new NotFound('chapter');
      const paras = splitParagraphs(c.body);
      const p = paras[paragraph - 1];
      if (!p) throw new BadRequest(`chapter has no paragraph ${paragraph}`);
      const v = this.currentVersion(chapterId);
      const anchor = firstSentence(p.text);
      const r = this.db.prepare('INSERT INTO input_links (input_id, chapter_id, version_id, anchor_text) VALUES (?, ?, ?, ?)').run(inputId, chapterId, v.id, anchor);
      this.updateInput(inputId, { status: 'placed', target_chapter_id: input.target_chapter_id ?? chapterId });
      const link = this.db.prepare('SELECT * FROM input_links WHERE id = ?').get(Number(r.lastInsertRowid)) as InputLink;
      return { input: this.getInput(inputId)!, link };
    })();
  }
  /** Remove a placement marker. The input goes back to planned; it is never deleted. */
  unplaceInput(linkId: number): Input {
    return this.db.transaction(() => {
      const link = this.db.prepare('SELECT * FROM input_links WHERE id = ?').get(linkId) as InputLink | undefined;
      if (!link) throw new NotFound('link');
      this.db.prepare('DELETE FROM input_links WHERE id = ?').run(linkId);
      const remaining = (this.db.prepare('SELECT count(*) c FROM input_links WHERE input_id = ?').get(link.input_id) as { c: number }).c;
      if (remaining === 0) this.updateInput(link.input_id, { status: 'planned' });
      return this.getInput(link.input_id)!;
    })();
  }
  /** The three groups the editor sidebar shows for one chapter. */
  inputsForChapter(chapterId: number): { placed: Input[]; planned: Input[]; suggested: Input[] } {
    const c = this.getChapter(chapterId);
    if (!c) throw new NotFound('chapter');
    const all = this.listInputs();
    const placed = all.filter(i => i.links!.some(l => l.chapter_id === chapterId));
    const planned = all.filter(i => i.target_chapter_id === chapterId && i.status === 'planned' && !placed.includes(i));
    const chapterTerms = properTerms(c.body);
    const lower = c.body.toLowerCase();
    const suggested = all.filter(i => i.target_chapter_id == null && (i.status === 'inbox' || i.status === 'planned')).filter(i => {
      const terms = properTerms(i.title + ' ' + i.body);
      for (const t of terms) if (chapterTerms.has(t)) return true;
      const quoted = (i.title + ' ' + i.body).match(/["“]([^"”]{4,40})["”]/g) ?? [];
      return quoted.some(q => lower.includes(q.slice(1, -1).toLowerCase()));
    });
    return { placed, planned, suggested };
  }
  /** Lines in the chapter that carry a placed input: paragraph index per link, resolved by anchor text. */
  markersForChapter(chapterId: number): { link: InputLink; input: Input; paragraph: number | null }[] {
    const c = this.getChapter(chapterId);
    if (!c) throw new NotFound('chapter');
    const paras = splitParagraphs(c.body);
    const links = this.db.prepare('SELECT * FROM input_links WHERE chapter_id = ? ORDER BY id').all(chapterId) as InputLink[];
    return links.map(link => {
      const input = this.getInput(link.input_id)!;
      const needle = link.anchor_text.trim().toLowerCase();
      const p = paras.find(p => p.text.toLowerCase().includes(needle));
      return { link, input, paragraph: p ? p.index : null };
    });
  }

  // ---------- bible ----------
  listBible(): BiblePage[] {
    return this.db.prepare(`SELECT * FROM bible_pages ORDER BY CASE kind WHEN 'synopsis' THEN 0 WHEN 'character' THEN 1 WHEN 'world' THEN 2 WHEN 'timeline' THEN 3 WHEN 'voice' THEN 4 ELSE 5 END, title`).all() as BiblePage[];
  }
  getBible(id: number): BiblePage | undefined {
    return this.db.prepare('SELECT * FROM bible_pages WHERE id = ?').get(id) as BiblePage | undefined;
  }
  biblePage(kind: string): BiblePage | undefined {
    return this.db.prepare('SELECT * FROM bible_pages WHERE kind = ? ORDER BY id LIMIT 1').get(kind) as BiblePage | undefined;
  }
  createBible(kind: string, title: string, body = ''): BiblePage {
    const r = this.db.prepare('INSERT INTO bible_pages (kind, title, body) VALUES (?, ?, ?)').run(kind, title, body);
    return this.getBible(Number(r.lastInsertRowid))!;
  }
  updateBible(id: number, patch: Partial<Pick<BiblePage, 'title' | 'body'>>): BiblePage {
    const cur = this.getBible(id);
    if (!cur) throw new NotFound('bible page');
    this.db.prepare(`UPDATE bible_pages SET title = ?, body = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
      .run(patch.title ?? cur.title, patch.body ?? cur.body, id);
    return this.getBible(id)!;
  }
  /** Append a paragraph to the Samples section of the voice page. */
  addVoiceSample(text: string): BiblePage {
    const voice = this.biblePage('voice') ?? this.createBible('voice', 'Voice', '## Samples\n\n## Rules\n');
    const { samples, rules } = splitVoicePage(voice.body);
    const body = `## Samples\n\n${[samples.trim(), text.trim()].filter(Boolean).join('\n\n')}\n\n## Rules\n\n${rules.trim()}\n`;
    return this.updateBible(voice.id, { body });
  }

  // ---------- reviews ----------
  listReviews(chapterId?: number): Review[] {
    if (chapterId) return this.db.prepare('SELECT * FROM reviews WHERE chapter_id = ? ORDER BY id DESC').all(chapterId) as Review[];
    return this.db.prepare('SELECT * FROM reviews ORDER BY id DESC LIMIT 200').all() as Review[];
  }
  getReview(id: number): Review | undefined {
    return this.db.prepare('SELECT * FROM reviews WHERE id = ?').get(id) as Review | undefined;
  }
  writeReview(r: Omit<Review, 'id' | 'created_at'>): Review {
    const res = this.db.prepare(`INSERT INTO reviews (chapter_id, version_id, pass, provider, model, prompt_version, output, input_tokens, output_tokens, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(r.chapter_id, r.version_id, r.pass, r.provider, r.model, r.prompt_version, r.output, r.input_tokens, r.output_tokens, r.meta);
    return this.getReview(Number(res.lastInsertRowid))!;
  }
  usageByMonth(): { provider: string; month: string; input_tokens: number; output_tokens: number; runs: number }[] {
    return this.db.prepare(`SELECT provider, substr(created_at,1,7) month, sum(input_tokens) input_tokens, sum(output_tokens) output_tokens, count(*) runs FROM reviews GROUP BY provider, month ORDER BY month DESC, provider`).all() as never;
  }

  // ---------- pass counters ----------
  passCount(chapterId: number, taggedVersionId: number, pass: string): number {
    const r = this.db.prepare('SELECT count FROM pass_counters WHERE chapter_id = ? AND tagged_version_id = ? AND pass = ?').get(chapterId, taggedVersionId, pass) as { count: number } | undefined;
    return r?.count ?? 0;
  }
  incrementPass(chapterId: number, taggedVersionId: number, pass: string): number {
    this.db.prepare(`INSERT INTO pass_counters (chapter_id, tagged_version_id, pass, count) VALUES (?, ?, ?, 1)
      ON CONFLICT(chapter_id, tagged_version_id, pass) DO UPDATE SET count = count + 1`).run(chapterId, taggedVersionId, pass);
    return this.passCount(chapterId, taggedVersionId, pass);
  }
}

export function splitVoicePage(body: string): { samples: string; rules: string } {
  const m = /^##\s*Samples\s*$([\s\S]*?)(?=^##\s*Rules\s*$|$(?![\s\S]))/mi.exec(body);
  const r = /^##\s*Rules\s*$([\s\S]*?)(?=^##\s|$(?![\s\S]))/mi.exec(body);
  return { samples: (m?.[1] ?? '').trim(), rules: (r?.[1] ?? (m ? '' : body)).trim() };
}

export class NotFound extends Error { status = 404; constructor(what: string) { super(`${what} not found`); } }
export class BadRequest extends Error { status = 400; }
export class Refused extends Error { status = 409; }
