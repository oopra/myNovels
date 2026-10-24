import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tempNovel, fixture } from './helpers';
import { setProviderFactory } from '../server/ai/registry';
import { runPass, acceptAlternative, setBackoff, type RunEvent } from '../server/ai/run';
import { ProviderError, type Provider } from '../server/ai/provider';
import type { Novel } from '../server/novel';
import type { ProviderId } from '../shared/types';

function fake(id: ProviderId, script: () => Array<string | Error>): Provider {
  return {
    id, mode: `fake ${id}`,
    async listModels() { return [{ id: 'fake-model', name: 'Fake' }]; },
    async *complete() {
      const steps = script();
      for (const s of steps) { if (s instanceof Error) throw s; yield { delta: s }; }
      yield { usage: { input_tokens: 100, output_tokens: 20 }, done: true };
    },
    async countTokens(t: string) { return Math.ceil(t.length / 4); },
  };
}
async function drain(gen: AsyncGenerator<RunEvent>): Promise<RunEvent[]> { const out: RunEvent[] = []; for await (const e of gen) out.push(e); return out; }

const LINE_OUTPUT = `### Paragraph 7\nProblem: the second sentence explains what the first already shows.\n1. The pacemaker was the point. Eleven days on one device, and Meera could've drawn the Azure XT from memory.\n2. Meera had the pacemaker cold. Eleven days will do that.\n3. The pacemaker was the point, and she'd given it eleven days to prove it.\n\n### Paragraph 9\nProblem: not marked.\n1. Should be dropped.`;

let n: Novel; let chapterId: number;
beforeEach(() => {
  n = tempNovel();
  n.store.setSetting('anthropic.model', 'fake-model');
  n.store.setSetting('gemini.model', 'fake-model');
  const ch = n.store.createChapter('The Committee', fixture('ch1-draft2.md'));
  chapterId = ch.id;
  n.store.tagDraft(chapterId, 'draft 2');
  setBackoff([0, 0, 0]);
});
afterEach(() => setProviderFactory(null));

describe('acceptance: line pass cap and accept-with-provenance', () => {
  it('allows two line passes on draft 2, refuses the third, accepts one alternative', async () => {
    setProviderFactory(async id => fake(id, () => [LINE_OUTPUT]));
    const run = () => drain(runPass(n, { pass: 'line', chapterId, marked: [7] }));
    const e1 = await run();
    const done1 = e1.find(e => e.type === 'done') as Extract<RunEvent, { type: 'done' }>;
    expect(done1).toBeDefined();
    expect(done1.review.output).not.toContain('Should be dropped');
    const meta = JSON.parse(done1.review.meta!);
    expect(meta.dropped).toEqual([9]);
    expect(meta.sections[0].alternatives).toHaveLength(3);
    await run();
    await expect(run()).rejects.toThrow('Two line passes already on draft 2. Tag a new draft or move on.');
    // Review output is read-only.
    expect(() => n.db.prepare('UPDATE reviews SET output = ? WHERE id = ?').run('x', done1.review.id)).toThrow(/read-only/);

    const { version } = acceptAlternative(n, done1.review.id, 7, 1);
    expect(version.kind).toBe('accept');
    expect(version.provenance).toBe('ai_assisted');
    expect(version.note).toMatch(/accept ¶7 alternative 2 from review \d+/);
    const ch = n.store.getChapter(chapterId)!;
    expect(ch.body).toContain('Meera had the pacemaker cold. Eleven days will do that.');
    expect(ch.body).not.toContain('The pacemaker was the point. Meera had spent eleven days');
    const prov = n.store.provenanceSummary(chapterId);
    expect(prov.aiParagraphs).toEqual([7]);
    expect(prov.totalParagraphs).toBeGreaterThan(10);
    // Accepting into a paragraph that has since changed is refused.
    expect(() => acceptAlternative(n, done1.review.id, 7, 0)).toThrow(/has changed since this review/);
    // Accepting an unmarked paragraph is refused even if the model wrote about it.
    expect(() => acceptAlternative(n, done1.review.id, 9, 0)).toThrow(/not marked/);
    // Tagging a new draft resets the cap.
    n.store.tagDraft(chapterId, 'draft 3');
    const e4 = await run();
    expect(e4.some(e => e.type === 'done')).toBe(true);
  });
  it('a failed run writes no review row and does not count against the cap', async () => {
    setProviderFactory(async id => fake(id, () => [new ProviderError('boom', false)]));
    const ev = await drain(runPass(n, { pass: 'line', chapterId, marked: [7] }));
    expect(ev.some(e => e.type === 'error')).toBe(true);
    expect(n.store.listReviews(chapterId)).toHaveLength(0);
    expect(n.store.passCount(chapterId, n.store.latestTaggedVersion(chapterId)!.id, 'line')).toBe(0);
  });
  it('retries retryable errors three times with backoff, then reports', async () => {
    let calls = 0;
    setProviderFactory(async id => fake(id, () => { calls++; return [new ProviderError('rate limited', true, 429)]; }));
    const ev = await drain(runPass(n, { pass: 'critique', chapterId }));
    expect(calls).toBe(3);
    expect(ev.filter(e => e.type === 'reset')).toHaveLength(2);
    expect(ev.some(e => e.type === 'error')).toBe(true);
  });
});

describe('critique and voice passes', () => {
  it('rejects praise-first output and writes nothing', async () => {
    setProviderFactory(async id => fake(id, () => ['A beautifully controlled opening.\n\nThe weakest paragraph is 7.']));
    const ev = await drain(runPass(n, { pass: 'critique', chapterId }));
    expect(ev.some(e => e.type === 'discarded')).toBe(true);
    expect(n.store.listReviews(chapterId)).toHaveLength(0);
  });
  it('discards a rewrite and says so', async () => {
    const paras = fixture('ch1-draft2.md').split('\n\n');
    setProviderFactory(async id => fake(id, () => ['Problem: here is a cleaner version.\n\n' + paras.slice(0, 12).join('\n\n')]));
    const ev = await drain(runPass(n, { pass: 'critique', chapterId }));
    const d = ev.find(e => e.type === 'discarded') as Extract<RunEvent, { type: 'discarded' }>;
    expect(d.reason).toMatch(/^Rewrite detected — discarded/);
    expect(n.store.listReviews(chapterId)).toHaveLength(0);
  });
  it('stores the voice verdict and hands the model computed statistics', async () => {
    let seenUser = '';
    setProviderFactory(async id => ({ ...fake(id, () => ['Problem: contractions stripped from dialogue.\n\nVerdict: DRIFTED']), async *complete(req) { seenUser = req.system + req.messages[0].content; yield { delta: 'Problem: contractions stripped from dialogue.\n\nVerdict: DRIFTED' }; yield { usage: { input_tokens: 1, output_tokens: 1 }, done: true }; } }));
    n.store.importVersion(chapterId, fixture('ch1-draft3.md'), 'draft 3');
    const ev = await drain(runPass(n, { pass: 'voice', chapterId, versionId: n.store.latestVersion(chapterId)!.id }));
    const done = ev.find(e => e.type === 'done') as Extract<RunEvent, { type: 'done' }>;
    expect(JSON.parse(done.review.meta!).verdict).toBe('DRIFTED');
    expect(seenUser).toContain('contractions in dialogue | 0 |');
    expect(seenUser).toContain('<voice-samples>');
    expect(done.review.input_tokens).toBe(1);
  });
  it('stress runs both providers and marks agreement', async () => {
    setProviderFactory(async id => fake(id, () => [id === 'anthropic' ? '1. Problem: the clerk has no handler so the antagonist cannot reach him.\n\n2. Dublin is never explained.' : '1. Problem: the antagonist cannot reach the clerk without a handler.\n\n2. Meera never opens the laptop.']));
    const ev = await drain(runPass(n, { pass: 'stress' }));
    expect(ev.filter(e => e.type === 'done')).toHaveLength(2);
    const ag = ev.find(e => e.type === 'agreement') as Extract<RunEvent, { type: 'agreement' }>;
    expect(ag.pairs.some(p => p.a === 0 && p.b === 0)).toBe(true);
    expect(n.store.listReviews().map(r => r.provider).sort()).toEqual(['anthropic', 'gemini']);
  });
});
