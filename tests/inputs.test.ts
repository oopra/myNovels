import { describe, it, expect } from 'vitest';
import { tempNovel, fixture } from './helpers';

describe('acceptance: inputs are owed until placed', () => {
  it('capture → owed 1 → drag onto the pacemaker paragraph → placed, linked, marked, owed 0', () => {
    const n = tempNovel();
    const ch = n.store.createChapter('The Committee', fixture('ch1-draft2.md'));
    const input = n.store.createInput({ title: 'the judge chairs the committee that drafted the bill; judges do not draft bills', kind: 'critique', target_chapter_id: ch.id });
    expect(input.status).toBe('planned');
    expect(n.store.listChapters()[0].owed).toBe(1);
    const { input: placed, link } = n.store.placeInput(input.id, ch.id, 7);
    expect(placed.status).toBe('placed');
    expect(link.anchor_text).toBe('The pacemaker was the point.');
    expect(link.version_id).toBe(n.store.latestVersion(ch.id)!.id);
    const markers = n.store.markersForChapter(ch.id);
    expect(markers).toHaveLength(1);
    expect(markers[0].paragraph).toBe(7);
    expect(n.store.listChapters()[0].owed).toBe(0);
    const groups = n.store.inputsForChapter(ch.id);
    expect(groups.placed.map(i => i.id)).toEqual([input.id]);
    // removing the marker returns the input to planned; it is never deleted
    const back = n.store.unplaceInput(link.id);
    expect(back.status).toBe('planned');
    expect(n.store.listChapters()[0].owed).toBe(1);
    expect(() => n.db.prepare('DELETE FROM inputs WHERE id = ?').run(input.id)).toThrow(/never deleted/);
    n.store.updateInput(input.id, { status: 'dropped' });
    expect(n.store.listChapters()[0].owed).toBe(0);
    expect(n.store.getInput(input.id)).toBeDefined();
  });
  it('suggests unassigned inputs whose terms appear in the chapter', () => {
    const n = tempNovel();
    const ch = n.store.createChapter('The Committee', fixture('ch1-draft2.md'));
    n.store.createInput({ title: 'Hegde should mention the Metro strike', kind: 'idea' });
    n.store.createInput({ title: 'unrelated note about Mumbai', kind: 'idea' });
    const { suggested } = n.store.inputsForChapter(ch.id);
    expect(suggested.map(i => i.title)).toEqual(['Hegde should mention the Metro strike']);
  });
});
