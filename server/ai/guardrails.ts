import { splitParagraphs, splitSentences, normalizeSentence, wordCount } from '../../shared/text';

/** Critique before praise: the first paragraph must name a problem. */
export const CRITIQUE_KEYWORDS = ['problem', 'weak', 'unclear', 'cliché', 'cliche', 'slip', 'cut', 'missing', 'contradiction'];
export function critiqueFirst(output: string): { ok: boolean; firstParagraph: string } {
  const paras = splitParagraphs(output.trim());
  if (!paras.length) return { ok: false, firstParagraph: '' };
  let first = paras[0].text;
  // A heading-only first block ("### Paragraph 7") is not a paragraph; include the block after it.
  if (/^#{1,6}\s/.test(first.trim()) && paras[1]) first = `${first}\n${paras[1].text}`;
  const lower = first.toLowerCase();
  return { ok: CRITIQUE_KEYWORDS.some(k => lower.includes(k)), firstParagraph: first };
}

export interface RewriteVerdict { rewrite: boolean; reason?: string; sequenceShare: number; suspectSpans: string[] }
export type ParaphraseVerifier = (span: string, chapter: string) => Promise<boolean>;

/** No rewrites. Two tests: (1) more than 40% of the chapter's sentences appear in the output in
 *  sequence; (2) a contiguous output span over 120 words looks like a retelling of the chapter,
 *  confirmed by a cheap second call supplied by the caller. */
export async function detectRewrite(chapter: string, output: string, verify?: ParaphraseVerifier): Promise<RewriteVerdict> {
  const chapSents = splitSentences(chapter).map(normalizeSentence).filter(s => wordCount(s) >= 4);
  const outSents = splitSentences(output).map(normalizeSentence);
  const outIndex = new Map<string, number[]>();
  outSents.forEach((s, i) => { const a = outIndex.get(s) ?? []; a.push(i); outIndex.set(s, a); });
  // Mark chapter sentences that appear in the output, then count those in in-order runs of ≥2.
  const pos = chapSents.map(s => outIndex.get(s)?.[0] ?? -1);
  let inSequence = 0;
  for (let i = 0; i < pos.length; i++) {
    if (pos[i] < 0) continue;
    const prevRun = i > 0 && pos[i - 1] >= 0 && pos[i - 1] < pos[i];
    const nextRun = i + 1 < pos.length && pos[i + 1] >= 0 && pos[i + 1] > pos[i];
    if (prevRun || nextRun) inSequence++;
  }
  const sequenceShare = chapSents.length ? inSequence / chapSents.length : 0;
  if (sequenceShare > 0.4) return { rewrite: true, reason: `${Math.round(sequenceShare * 100)}% of the chapter's sentences appear in sequence`, sequenceShare, suspectSpans: [] };

  const chapterVocab = contentWords(chapter);
  const suspect: string[] = [];
  const blocks = splitParagraphs(output).map(p => p.text).filter(t => !/^#{1,6}\s/.test(t.trim()));
  const candidates: string[] = [];
  for (let i = 0; i < blocks.length; i++) {
    if (wordCount(blocks[i]) > 120) candidates.push(blocks[i]);
    if (i + 1 < blocks.length && wordCount(blocks[i]) + wordCount(blocks[i + 1]) > 120 && wordCount(blocks[i]) <= 120) candidates.push(`${blocks[i]}\n\n${blocks[i + 1]}`);
  }
  for (const span of candidates) {
    const quoted = (span.match(/["“][^"”]+["”]/g) ?? []).join(' ');
    if (wordCount(quoted) > wordCount(span) * 0.6) continue; // mostly quotations pointing at problems
    const vocab = contentWords(span);
    if (!vocab.size) continue;
    let shared = 0; for (const w of vocab) if (chapterVocab.has(w)) shared++;
    const overlap = shared / vocab.size;
    if (overlap >= 0.55 && !looksLikeCritique(span)) suspect.push(span);
  }
  if (suspect.length && verify) {
    for (const span of suspect) {
      if (await verify(span, chapter)) return { rewrite: true, reason: 'a span of more than 120 words paraphrases the chapter (confirmed by second call)', sequenceShare, suspectSpans: [span] };
    }
  }
  return { rewrite: false, sequenceShare, suspectSpans: suspect };
}

const STOP = new Set('the a an and or but of to in on at for with from by as is was were be been are it its this that these those he she they them his her their i you we me my your our not no so if then than into out up down over under about after before while when where which who whom what why how all any some more most such very can could would should will just only also there here had has have do does did said says like'.split(' '));
function contentWords(text: string): Set<string> {
  return new Set(text.toLowerCase().replace(/[^a-z0-9'\s]/g, ' ').split(/\s+/).filter(w => w.length > 3 && !STOP.has(w)));
}
function looksLikeCritique(span: string): boolean {
  const lower = span.toLowerCase();
  const markers = ['problem', 'weak', 'unclear', 'cliché', 'cliche', 'reader', 'paragraph', 'the chapter', 'the scene', 'this line', 'the author', 'suggest', 'consider', 'cut ', 'contradict', 'logic', 'beat'];
  return markers.filter(m => lower.includes(m)).length >= 3;
}

/** Prompt for the cheap verification call. */
export function paraphrasePrompt(span: string, chapter: string): { system: string; user: string } {
  return {
    system: 'You compare two texts. Answer with exactly one word: YES or NO.',
    user: `TEXT A is a chapter of a novel. TEXT B is part of an editor's note about it.\nDoes TEXT B retell, rewrite or closely paraphrase a contiguous passage of TEXT A (as opposed to describing, quoting briefly or criticising it)?\n\n<text-a>\n${chapter}\n</text-a>\n\n<text-b>\n${span}\n</text-b>\n\nAnswer YES or NO.`,
  };
}

export interface LineSection { paragraph: number; problem: string; alternatives: string[]; fine: boolean; raw: string }
export interface ParsedLine { sections: LineSection[]; dropped: number[]; filteredOutput: string; formatted: boolean }

const HEADING = /^#{1,6}\s*(?:paragraph|para|¶)\s*#?\s*(\d+)\b.*$/gim;

/** Marked paragraphs only: keep sections that address marked paragraphs, drop everything else. */
export function parseLinePass(output: string, marked: number[]): ParsedLine {
  const heads: { n: number; start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  HEADING.lastIndex = 0;
  while ((m = HEADING.exec(output)) !== null) heads.push({ n: Number(m[1]), start: m.index, end: m.index + m[0].length });
  if (!heads.length) return { sections: [], dropped: [], filteredOutput: '', formatted: false };
  const sections: LineSection[] = []; const dropped: number[] = []; const kept: string[] = [];
  const markedSet = new Set(marked);
  for (let i = 0; i < heads.length; i++) {
    const bodyText = output.slice(heads[i].end, heads[i + 1]?.start ?? output.length).trim();
    const raw = output.slice(heads[i].start, heads[i + 1]?.start ?? output.length).trim();
    if (!markedSet.has(heads[i].n)) { dropped.push(heads[i].n); continue; }
    const problemMatch = /^\s*\**problem\**\s*:\s*\**(.+?)\**\s*$/im.exec(bodyText);
    const problem = problemMatch?.[1]?.trim() ?? (bodyText.split('\n').find(l => l.trim())?.trim() ?? '');
    const alternatives = parseNumbered(bodyText).slice(0, 3);
    const fine = alternatives.length === 0 && /\b(fine|works|no change|leave it|nothing to offer)\b/i.test(bodyText);
    sections.push({ paragraph: heads[i].n, problem, alternatives, fine, raw });
    kept.push(raw);
  }
  return { sections, dropped, filteredOutput: kept.join('\n\n'), formatted: true };
}

function parseNumbered(text: string): string[] {
  const lines = text.split('\n');
  const items: string[] = [];
  let cur: string[] | null = null;
  for (const line of lines) {
    const m = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
    if (m) { if (cur) items.push(cur.join('\n').trim()); cur = [m[2]]; continue; }
    if (cur) {
      if (/^\s*$/.test(line)) { items.push(cur.join('\n').trim()); cur = null; }
      else if (/^\s{2,}\S/.test(line) || /^\S/.test(line) && !/^\s*\**problem/i.test(line)) cur.push(line.trim());
    }
  }
  if (cur) items.push(cur.join('\n').trim());
  return items.map(s => s.replace(/^\*\*alternative\s*\d*\*\*:?\s*/i, '').replace(/^["“](.*)["”]$/s, '$1').trim()).filter(Boolean);
}

export function voiceVerdict(output: string): 'HOLDS' | 'DRIFTED' | null {
  const m = [...output.matchAll(/\b(HOLDS|DRIFTED)\b/g)];
  if (!m.length) return null;
  const v = /verdict\s*:?\s*\**\s*(HOLDS|DRIFTED)/i.exec(output);
  return ((v?.[1] ?? m[m.length - 1][1]).toUpperCase()) as 'HOLDS' | 'DRIFTED';
}

/** Stress: find items the two models agree on by content-word overlap. */
export function stressAgreement(a: string, b: string): { a: number; b: number; score: number }[] {
  const itemsA = listItems(a), itemsB = listItems(b);
  const out: { a: number; b: number; score: number }[] = [];
  itemsA.forEach((ia, i) => {
    const wa = contentWords(ia);
    itemsB.forEach((ib, j) => {
      const wb = contentWords(ib);
      let shared = 0; for (const w of wa) if (wb.has(w)) shared++;
      const union = new Set([...wa, ...wb]).size;
      const score = union ? shared / union : 0;
      if (score >= 0.2) out.push({ a: i, b: j, score: Math.round(score * 100) / 100 });
    });
  });
  return out;
}
export function listItems(text: string): string[] {
  const paras = splitParagraphs(text).map(p => p.text);
  const numbered = paras.filter(p => /^\s*(\d+[.)]|[-*])\s+/.test(p));
  return numbered.length ? numbered : paras;
}

export const LINE_PASS_CAP = 2;
export function capMessage(label: string | null | undefined): string {
  return `Two line passes already on ${label ?? 'the untagged draft'}. Tag a new draft or move on.`;
}
