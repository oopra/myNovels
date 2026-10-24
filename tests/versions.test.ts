import { describe, it, expect } from 'vitest';
import { diffWords } from 'diff';
import { tempNovel, fixture } from './helpers';

describe('versions are immutable', () => {
  it('refuses update and delete at the database level', () => {
    const n = tempNovel();
    const ch = n.store.createChapter('One', 'Hello.');
    const v = n.store.tagDraft(ch.id, 'draft 1');
    expect(() => n.db.prepare('UPDATE versions SET body = ? WHERE id = ?').run('changed', v.id)).toThrow(/immutable/);
    expect(() => n.db.prepare('DELETE FROM versions WHERE id = ?').run(v.id)).toThrow(/immutable/);
    expect(() => n.db.prepare('UPDATE versions SET label = ? WHERE id = ?').run('x', v.id)).toThrow(/immutable/);
  });
  it('autosaves within ten minutes collapse into the latest; a tag freezes it', () => {
    const n = tempNovel();
    const ch = n.store.createChapter('One', 'a');
    const before = n.store.listVersions(ch.id).length;
    n.store.saveBody(ch.id, 'ab');
    n.store.saveBody(ch.id, 'abc');
    expect(n.store.listVersions(ch.id).length).toBe(before); // collapsed into the open autosave
    expect(n.store.latestVersion(ch.id)!.body).toBe('abc');
    const tag = n.store.tagDraft(ch.id, 'draft 1');
    n.store.saveBody(ch.id, 'abcd');
    const vs = n.store.listVersions(ch.id);
    expect(vs.length).toBe(before + 2);
    expect(n.store.getVersion(tag.id)!.body).toBe('abc');
    expect(() => n.db.prepare('UPDATE versions SET body = ? WHERE id = ?').run('zzz', tag.id)).toThrow(/immutable/);
  });
  it('restore creates a new version pointing at the old one', () => {
    const n = tempNovel();
    const ch = n.store.createChapter('One', 'first');
    const v1 = n.store.tagDraft(ch.id, 'draft 1');
    n.store.saveBody(ch.id, 'second', { kind: 'tagged', label: 'draft 2' });
    const r = n.store.restoreVersion(v1.id);
    expect(r.kind).toBe('restore');
    expect(r.parent_version_id).toBe(v1.id);
    expect(r.note).toMatch(/restored version \d+ \(draft 1\)/);
    expect(n.store.getChapter(ch.id)!.body).toBe('first');
    expect(n.store.listVersions(ch.id).length).toBeGreaterThanOrEqual(4);
  });
});

describe('acceptance: draft 2 vs draft 3 diff', () => {
  it('shows the Saint Peter line, non-negotiable and the code review line as removed', () => {
    const n = tempNovel();
    const ch = n.store.createChapter('The Committee');
    const v2 = n.store.importVersion(ch.id, fixture('ch1-draft2.md'), 'draft 2');
    const v3 = n.store.importVersion(ch.id, fixture('ch1-draft3.md'), 'draft 3');
    expect(v2.kind).toBe('tagged'); expect(v2.label).toBe('draft 2');
    expect(v3.label).toBe('draft 3');
    const removed = diffWords(n.store.getVersion(v2.id)!.body, n.store.getVersion(v3.id)!.body).filter(p => p.removed).map(p => p.value).join('');
    expect(removed).toContain('Saint Peter');
    expect(removed).toContain('non-negotiable');
    expect(removed).toContain('thirty seconds into a code review');
  });
});
