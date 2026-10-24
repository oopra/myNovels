import { describe, it, expect } from 'vitest';
import { critiqueFirst, detectRewrite, parseLinePass, voiceVerdict, stressAgreement, capMessage } from '../server/ai/guardrails';
import { fixture } from './helpers';

const chapter = fixture('ch1-draft2.md');

describe('critique before praise', () => {
  it('accepts an output that leads with a problem', () => {
    expect(critiqueFirst('The most serious problem is that the clerk never pays off.\n\nMore.').ok).toBe(true);
    expect(critiqueFirst('### Paragraph 7\nProblem: the sentence explains what the scene shows.\n1. alt').ok).toBe(true);
    expect(critiqueFirst('No problem found.').ok).toBe(true);
  });
  it('rejects an output that opens with praise', () => {
    expect(critiqueFirst('This is a gripping, assured opening with a strong sense of place.\n\nThe weakest paragraph is...').ok).toBe(false);
    expect(critiqueFirst('').ok).toBe(false);
  });
});

describe('no rewrites', () => {
  it('discards an output that reproduces the chapter in sequence', async () => {
    const paras = chapter.split('\n\n');
    const rewrite = 'Here is a cleaner version:\n\n' + paras.slice(0, Math.ceil(paras.length * 0.7)).join('\n\n');
    const v = await detectRewrite(chapter, rewrite);
    expect(v.rewrite).toBe(true);
    expect(v.sequenceShare).toBeGreaterThan(0.4);
  });
  it('lets a critique that quotes a few lines through', async () => {
    const critique = 'The most serious problem is the clerk: he is set up four times and never pays off.\n\nThe weakest paragraph is "The pacemaker was the point." The technical detail stalls the scene.\n\nA reader would skip the Saint Peter exchange because the joke needs the footnotes explained.';
    const v = await detectRewrite(chapter, critique, async () => true);
    expect(v.rewrite).toBe(false);
  });
  it('asks the verifier about a long span that shares the chapter vocabulary and discards on YES', async () => {
    const paraphrase = chapter.split('\n\n').slice(5, 9).join(' ').replace(/[.]/g, ',').split(/\s+/).map((w, i) => (i % 7 === 0 ? w.toUpperCase() : w)).join(' ') + ' and so the scene ends.';
    let asked = 0;
    const v = await detectRewrite(chapter, paraphrase, async () => { asked++; return true; });
    expect(asked).toBeGreaterThan(0);
    expect(v.rewrite).toBe(true);
    const v2 = await detectRewrite(chapter, paraphrase, async () => false);
    expect(v2.rewrite).toBe(false);
  });
});

describe('marked paragraphs only', () => {
  const output = `### Paragraph 7\nProblem: the second sentence explains the first.\n1. The pacemaker was the point, and Meera had the eleven days to prove it.\n2. "The pacemaker was the point." She'd spent eleven days on it.\n3. Eleven days on one device. The pacemaker was the point.\n\n### Paragraph 8\nProblem: unmarked but tempting.\n1. Rewritten whisper.\n\n### Paragraph 12\nThis paragraph is fine as it is.`;
  it('keeps marked sections and drops the rest', () => {
    const p = parseLinePass(output, [7, 12]);
    expect(p.formatted).toBe(true);
    expect(p.sections.map(s => s.paragraph)).toEqual([7, 12]);
    expect(p.dropped).toEqual([8]);
    expect(p.sections[0].alternatives).toHaveLength(3);
    expect(p.sections[0].problem).toBe('the second sentence explains the first.');
    expect(p.sections[1].fine).toBe(true);
    expect(p.filteredOutput).not.toContain('Rewritten whisper');
  });
  it('fails loudly when the output has no paragraph headings', () => {
    expect(parseLinePass('Here is a better chapter...', [7]).formatted).toBe(false);
  });
});

describe('parsers', () => {
  it('reads the voice verdict', () => {
    expect(voiceVerdict('... (5) Verdict: DRIFTED')).toBe('DRIFTED');
    expect(voiceVerdict('The voice HOLDS here.\n\nVerdict: **HOLDS**')).toBe('HOLDS');
    expect(voiceVerdict('nothing')).toBeNull();
  });
  it('marks stress items both models flagged', () => {
    const a = '1. **The clerk** The clerk is a plant with no handler; the antagonist cannot reach him.\n\n2. **Dublin** The cloud service in Dublin is never explained.';
    const b = '1. The antagonist has no way to reach the clerk, who is a plant without a handler.\n\n2. Meera never opens her laptop.';
    const pairs = stressAgreement(a, b);
    expect(pairs.some(p => p.a === 0 && p.b === 0)).toBe(true);
    expect(pairs.some(p => p.a === 1 && p.b === 1)).toBe(false);
  });
  it('phrases the cap message with the draft label', () => {
    expect(capMessage('draft 2')).toBe('Two line passes already on draft 2. Tag a new draft or move on.');
  });
});
