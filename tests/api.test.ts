import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { tempNovel, fixture } from './helpers';
import { app } from '../server/index';
import { exportNovel } from '../server/lib/export';

const json = (r: Response) => r.json() as Promise<any>;

describe('http api', () => {
  it('opens a novel, writes a chapter, autosaves, tags, lists versions, refuses keys in settings', async () => {
    const n = tempNovel();
    const H = { 'content-type': 'application/json', 'x-novel': n.folder };
    let r = await app.request('/api/n/chapters', { method: 'POST', headers: H, body: JSON.stringify({ title: 'One' }) });
    expect(r.status).toBe(201);
    const ch = await json(r);
    r = await app.request(`/api/n/chapters/${ch.id}/body`, { method: 'PUT', headers: H, body: JSON.stringify({ body: fixture('ch1-draft2.md') }) });
    expect((await json(r)).chapter.word_count).toBeGreaterThan(400);
    r = await app.request(`/api/n/chapters/${ch.id}/tag`, { method: 'POST', headers: H, body: JSON.stringify({ label: 'draft 2' }) });
    expect((await json(r)).label).toBe('draft 2');
    r = await app.request(`/api/n/chapters/${ch.id}/versions`, { headers: H });
    expect((await json(r)).length).toBeGreaterThanOrEqual(2);
    r = await app.request('/api/n/settings', { method: 'PUT', headers: H, body: JSON.stringify({ 'gemini.api_key': 'abc' }) });
    expect(r.status).toBe(409);
    r = await app.request('/api/n/chapters', { headers: {} });
    expect(r.status).toBe(400);
    r = await app.request(`/api/n/chapters/${ch.id}/line-cap`, { headers: H });
    expect((await json(r)).label).toBe('draft 2');
  });
  it('export writes markdown and commits without network or keys', async () => {
    const n = tempNovel();
    n.store.createChapter('The Committee', fixture('ch1-draft2.md'));
    n.store.createInput({ title: 'owed thing' });
    const res = await exportNovel(n.store, n.folder, 'Test Novel');
    expect(res.gitError).toBeUndefined();
    expect(res.commit).toMatch(/^[0-9a-f]{7,}$/);
    expect(fs.existsSync(path.join(res.dir, 'chapters', '01-the-committee.md'))).toBe(true);
    expect(fs.readFileSync(path.join(res.dir, 'inputs.md'), 'utf8')).toContain('owed thing');
    expect(fs.existsSync(path.join(res.dir, 'bible', 'voice-voice.md'))).toBe(true);
    const again = await exportNovel(n.store, n.folder, 'Test Novel');
    expect(again.commit).toBe(res.commit); // nothing changed, no empty commit
  });
});
