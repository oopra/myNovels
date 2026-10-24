import { describe, it, expect } from 'vitest';
import { splitParagraphs, voiceStats, splitSentences, firstSentence } from '../shared/text';
import { fixture } from './helpers';

describe('paragraphs', () => {
  it('numbers markdown blocks 1-based and keeps offsets', () => {
    const body = 'One.\n\nTwo\nstill two.\n\n\n\nThree.';
    const p = splitParagraphs(body);
    expect(p.map(x => x.index)).toEqual([1, 2, 3]);
    expect(p[1].text).toBe('Two\nstill two.');
    expect(body.slice(p[2].from, p[2].to)).toBe('Three.');
  });
  it('draft 2 has the pacemaker paragraph at 7', () => {
    const p = splitParagraphs(fixture('ch1-draft2.md'));
    expect(p[6].text).toMatch(/^The pacemaker was the point/);
  });
  it('first sentence of a paragraph is a usable anchor', () => {
    expect(firstSentence('The pacemaker was the point. Meera had spent eleven days.')).toBe('The pacemaker was the point.');
  });
});

describe('voice statistics computed in the app', () => {
  const d2 = voiceStats(fixture('ch1-draft2.md'));
  const d3 = voiceStats(fixture('ch1-draft3.md'));
  it('draft 3 has stripped contractions in dialogue', () => {
    expect(d2.contractions).toBeGreaterThan(5);
    expect(d3.contractions).toBe(0);
    expect(d3.uncontractedForms).toBeGreaterThan(d2.uncontractedForms);
    expect(d3.contractionShare).toBe(0);
    expect(d2.contractionShare!).toBeGreaterThan(0.6);
  });
  it('draft 3 has more uniform sentence lengths', () => {
    expect(d3.sentenceLengthStdDev).toBeLessThan(d2.sentenceLengthStdDev);
  });
  it('splits sentences around quotes', () => {
    expect(splitSentences('"You\'re early," said Rohan. He smelled of coffee. "Is that him?"').length).toBe(3);
  });
});
