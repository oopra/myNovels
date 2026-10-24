/** Text utilities shared by server, client and tests. Paragraph numbering is the
 *  one thing every screen and every pass must agree on, so it lives here. */

export interface Paragraph { index: number; text: string; from: number; to: number; }

/** Markdown paragraphs: runs of non-blank lines separated by blank lines. 1-based index. */
export function splitParagraphs(body: string): Paragraph[] {
  const out: Paragraph[] = [];
  let pos = 0;
  let blockStart = -1;
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const blank = line.trim().length === 0;
    if (!blank && blockStart < 0) blockStart = pos;
    const lineEnd = pos + line.length;
    const isLast = i === lines.length - 1;
    if (blockStart >= 0 && (blank || isLast)) {
      const to = blank ? pos - 1 : lineEnd;
      out.push({ index: out.length + 1, text: body.slice(blockStart, to), from: blockStart, to });
      blockStart = -1;
    }
    pos = lineEnd + 1;
  }
  return out;
}

export function wordCount(text: string): number {
  const t = text.trim();
  if (!t) return 0;
  return t.split(/\s+/).length;
}

/** Sentence split that is good enough for statistics and for the rewrite detector. */
export function splitSentences(text: string): string[] {
  const plain = text.replace(/\s+/g, ' ').trim();
  if (!plain) return [];
  const parts = plain.split(/(?<=[.!?…]["'”’)]?)\s+(?=["'“‘(]?[A-Z0-9])/);
  return parts.map(s => s.trim()).filter(s => s.length > 0);
}

export function normalizeSentence(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function firstSentence(paragraph: string): string {
  const s = splitSentences(paragraph.replace(/^#+\s*/, '').replace(/^>\s*/, ''));
  return s[0] ?? paragraph.trim().slice(0, 120);
}

export function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'chapter';
}

/** Dialogue spans: text inside straight or curly double quotes. */
export function extractDialogue(text: string): string[] {
  const out: string[] = [];
  const re = /["“]([^"”]{2,}?)["”]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m[1]);
  return out;
}

const CONTRACTION = /\b(?:\w+n['’]t|\w+['’](?:s|re|ve|ll|d|m)|let['’]s|o['’]clock)\b/gi;
const UNCONTRACTED = /\b(?:do not|does not|did not|is not|are not|was not|were not|cannot|can not|could not|would not|should not|will not|have not|has not|had not|I am|you are|we are|they are|it is|that is|there is|he is|she is|I will|you will|we will|they will|I have|you have|we have|they have|I would|you would|he would|she would|we would|they would|let us)\b/gi;

export interface VoiceStats {
  sentences: number;
  words: number;
  meanSentenceLength: number;
  sentenceLengthStdDev: number;
  /** longest run of consecutive sentences whose word counts are within ±2 of each other */
  longestUniformRun: number;
  uniformRunExample: string[];
  dialogueWords: number;
  contractions: number;
  uncontractedForms: number;
  contractionRatePer100DialogueWords: number;
  /** contractions / (contractions + uncontracted forms) in dialogue, 0..1 */
  contractionShare: number | null;
}

export function voiceStats(text: string): VoiceStats {
  const sentences = splitSentences(text.replace(/^#.*$/gm, ''));
  const lengths = sentences.map(wordCount);
  const n = lengths.length;
  const mean = n ? lengths.reduce((a, b) => a + b, 0) / n : 0;
  const variance = n ? lengths.reduce((a, b) => a + (b - mean) ** 2, 0) / n : 0;
  let best = 0, bestStart = 0, run = 1, runStart = 0;
  for (let i = 1; i < n; i++) {
    if (Math.abs(lengths[i] - lengths[i - 1]) <= 2) { run++; } else { run = 1; runStart = i; }
    if (run > best) { best = run; bestStart = runStart; }
  }
  if (n === 1) best = 1;
  const dialogue = extractDialogue(text);
  const dialogueText = dialogue.join(' ');
  const dialogueWords = wordCount(dialogueText);
  const contractions = (dialogueText.match(CONTRACTION) ?? []).length;
  const uncontracted = (dialogueText.match(UNCONTRACTED) ?? []).length;
  const opportunities = contractions + uncontracted;
  return {
    sentences: n,
    words: wordCount(text),
    meanSentenceLength: round(mean),
    sentenceLengthStdDev: round(Math.sqrt(variance)),
    longestUniformRun: best,
    uniformRunExample: best >= 3 ? sentences.slice(bestStart, bestStart + Math.min(best, 5)) : [],
    dialogueWords,
    contractions,
    uncontractedForms: uncontracted,
    contractionRatePer100DialogueWords: dialogueWords ? round((contractions / dialogueWords) * 100) : 0,
    contractionShare: opportunities ? round(contractions / opportunities) : null,
  };
}

function round(x: number): number { return Math.round(x * 100) / 100; }

/** Cheap token estimate used when no provider count is available. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Capitalised terms (names, places) of at least 4 letters, excluding sentence-initial common words. */
export function properTerms(text: string): Set<string> {
  const out = new Set<string>();
  const re = /\b([A-Z][a-z]{3,})\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (!STOP.has(m[1])) out.add(m[1]);
  }
  return out;
}
const STOP = new Set(['This', 'That', 'There', 'They', 'Then', 'When', 'What', 'With', 'From', 'Have', 'Were', 'Will', 'Would', 'Could', 'Should', 'Because', 'After', 'Before', 'Chapter', 'Draft', 'Some', 'Every', 'Their', 'Those', 'These', 'Which', 'While', 'Where', 'About', 'Into', 'Over', 'Under', 'Just', 'Like', 'Only', 'Even', 'Still', 'Also', 'Here', 'Nothing', 'Something', 'Everything', 'Maybe', 'Perhaps']);
