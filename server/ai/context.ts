import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Novel } from '../novel';
import type { PassName, ContextPart, ContextPreview, ProviderId, Input } from '../../shared/types';
import { splitParagraphs, voiceStats, estimateTokens } from '../../shared/text';
import { splitVoicePage } from '../store';
import { SEED_PROMPTS } from './prompts';

export const promptFileName = (pass: PassName): string => `${pass.replace(/_/g, '-')}.md`;

export function readPrompt(novel: Novel, pass: PassName): { text: string; version: string } {
  const f = path.join(novel.promptsDir(), promptFileName(pass));
  let text: string;
  try { text = fs.readFileSync(f, 'utf8'); } catch { text = SEED_PROMPTS[pass]; fs.mkdirSync(novel.promptsDir(), { recursive: true }); fs.writeFileSync(f, text); }
  return { text, version: crypto.createHash('sha1').update(text).digest('hex').slice(0, 10) };
}
export function writePrompt(novel: Novel, pass: PassName, text: string): void {
  fs.mkdirSync(novel.promptsDir(), { recursive: true });
  fs.writeFileSync(path.join(novel.promptsDir(), promptFileName(pass)), text);
}

export interface AssembleOptions {
  chapterId?: number;
  versionId?: number;
  marked?: number[];
  question?: string;
}
export interface Assembled {
  system: string;
  user: string;
  parts: ContextPart[];
  promptVersion: string;
  chapterId: number | null;
  versionId: number | null;
  versionBody: string | null;
}

/** Number paragraphs so the model can point at them: "[¶7] text". */
export function numberedChapter(body: string): string {
  return splitParagraphs(body).map(p => `[¶${p.index}] ${p.text}`).join('\n\n');
}

function block(title: string, body: string): string {
  return `<${title}>\n${body.trim()}\n</${title}>`;
}

/** Context assembly. Order for single-chapter passes: voice, corrections, characters named in the
 *  chapter, world, timeline, then the chapter version. Continuity and stress get every bible page,
 *  the outline and every chapter. */
export function assembleContext(novel: Novel, pass: PassName, opts: AssembleOptions): Assembled {
  const s = novel.store;
  const parts: ContextPart[] = [];
  const sys: string[] = [];
  const usr: string[] = [];
  const add = (into: string[], name: string, text: string) => {
    if (!text.trim()) return;
    into.push(text);
    parts.push({ name, chars: text.length, tokens: estimateTokens(text) });
  };
  const prompt = readPrompt(novel, pass);
  let promptText = prompt.text;
  if (pass === 'line') promptText = promptText.replace('{PARAS}', (opts.marked ?? []).join(', ') || 'none');
  add(sys, `prompt ${promptFileName(pass)} (${prompt.version})`, promptText);

  const bible = s.listBible();
  const page = (kind: string) => bible.find(p => p.kind === kind);
  let chapter = opts.chapterId ? s.getChapter(opts.chapterId) : undefined;
  let version = opts.versionId ? s.getVersion(opts.versionId) : undefined;
  if (chapter && !version) version = s.currentVersion(chapter.id);
  if (version && !chapter) chapter = s.getChapter(version.chapter_id);
  const body = version?.body ?? chapter?.body ?? '';

  const voice = page('voice');
  const corrections = page('corrections');
  const world = page('world');
  const timeline = page('timeline');
  const synopsis = page('synopsis');
  const characters = bible.filter(p => p.kind === 'character');

  if (pass === 'continuity' || pass === 'stress') {
    for (const p of bible) add(sys, `bible: ${p.title}`, block(`bible-${p.kind}`, `# ${p.title}\n\n${p.body}`));
    const chapters = s.listChapters();
    const outline = chapters.map(c => `${c.number}. ${c.title} [${c.status}, ${c.word_count} words]${c.body.trim() ? `\n   ${splitParagraphs(c.body)[0]?.text.slice(0, 200) ?? ''}` : ''}`).join('\n');
    add(sys, 'outline', block('outline', outline));
    if (pass === 'continuity') {
      for (const c of chapters) if (c.body.trim()) add(usr, `chapter ${c.number}: ${c.title}`, block(`chapter-${c.number}`, `# ${c.number}. ${c.title}\n\n${numberedChapter(c.body)}`));
      if (!usr.length) usr.push('No chapters have text yet.');
    } else {
      usr.push('Where does the plot break? Use the bible and outline above.');
    }
    return { system: sys.join('\n\n'), user: usr.join('\n\n'), parts, promptVersion: prompt.version, chapterId: null, versionId: null, versionBody: null };
  }

  if (pass === 'research') {
    if (world) add(sys, `bible: ${world.title}`, block('bible-world', world.body));
    add(usr, 'question', opts.question?.trim() || '(no question)');
    return { system: sys.join('\n\n'), user: usr.join('\n\n'), parts, promptVersion: prompt.version, chapterId: null, versionId: null, versionBody: null };
  }

  if (!chapter || !version) throw new Error('this pass needs a chapter');

  if (pass === 'voice') {
    if (voice) {
      const { samples, rules } = splitVoicePage(voice.body);
      add(sys, 'voice samples', block('voice-samples', samples || '(no samples yet)'));
      add(sys, 'voice rules', block('voice-rules', rules || '(no rules yet)'));
      const sampleStats = samples ? voiceStats(samples) : null;
      const chapterStats = voiceStats(body);
      add(usr, 'statistics (computed by the app)', block('statistics', statsTable(chapterStats, sampleStats)));
    }
  } else {
    if (voice) add(sys, 'voice', block('voice', voice.body));
    if (corrections) add(sys, 'corrections', block('corrections', corrections.body));
    for (const c of characters) {
      const first = c.title.split(/\s+/)[0];
      if (first && new RegExp(`\\b${escapeRe(first)}\\b`).test(body)) add(sys, `character: ${c.title}`, block('character', `# ${c.title}\n\n${c.body}`));
    }
    if (world) add(sys, 'world', block('world', world.body));
    if (timeline) add(sys, 'timeline', block('timeline', timeline.body));
    if (pass === 'place_inputs' && synopsis) add(sys, 'outline', block('outline', s.listChapters().map(c => `${c.number}. ${c.title} [${c.status}]`).join('\n') + '\n\n' + synopsis.body));
  }

  add(usr, `chapter ${chapter.number}: ${chapter.title} (version ${version.id}${version.label ? `, ${version.label}` : ''})`,
    block('chapter', `# ${chapter.number}. ${chapter.title}\n\n${numberedChapter(body)}`));

  if (pass === 'line') {
    const paras = splitParagraphs(body);
    const marked = (opts.marked ?? []).filter(n => paras[n - 1]);
    add(usr, 'marked paragraphs', block('marked-paragraphs', marked.length ? marked.map(n => `[¶${n}] ${paras[n - 1].text}`).join('\n\n') : '(none)'));
  }
  if (pass === 'place_inputs') {
    const { planned } = s.inputsForChapter(chapter.id);
    add(usr, 'planned inputs', block('inputs', planned.length ? planned.map(formatInput).join('\n') : '(no planned inputs for this chapter)'));
  }
  return { system: sys.join('\n\n'), user: usr.join('\n\n'), parts, promptVersion: prompt.version, chapterId: chapter.id, versionId: version.id, versionBody: body };
}

function formatInput(i: Input): string {
  return `- Input #${i.id} (${i.kind}${i.source ? `, source: ${i.source}` : ''}): ${i.title}${i.body.trim() ? ` — ${i.body.trim().replace(/\s+/g, ' ')}` : ''}`;
}

function statsTable(c: ReturnType<typeof voiceStats>, s: ReturnType<typeof voiceStats> | null): string {
  const row = (label: string, a: unknown, b: unknown) => `| ${label} | ${a} | ${s ? b : 'n/a'} |`;
  const lines = [
    '| measure | chapter | voice samples |', '| --- | --- | --- |',
    row('sentences', c.sentences, s?.sentences),
    row('mean sentence length (words)', c.meanSentenceLength, s?.meanSentenceLength),
    row('sentence length std dev', c.sentenceLengthStdDev, s?.sentenceLengthStdDev),
    row('longest run of uniform-length sentences (±2 words)', c.longestUniformRun, s?.longestUniformRun),
    row('dialogue words', c.dialogueWords, s?.dialogueWords),
    row('contractions in dialogue', c.contractions, s?.contractions),
    row('uncontracted forms in dialogue (do not, it is, ...)', c.uncontractedForms, s?.uncontractedForms),
    row('contraction share of opportunities', c.contractionShare ?? 'n/a', s?.contractionShare ?? 'n/a'),
  ];
  if (c.uniformRunExample.length) lines.push('', `Example of the uniform run in the chapter: ${c.uniformRunExample.map(x => `"${x}"`).join(' ')}`);
  return lines.join('\n');
}

function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export function toPreview(a: Assembled, provider: ProviderId, model: string, exactTokens?: number): ContextPreview {
  const tokens = exactTokens ?? a.parts.reduce((n, p) => n + p.tokens, 0);
  return { system: a.system, user: a.user, parts: a.parts, tokens, exact: exactTokens != null, provider, model, promptVersion: a.promptVersion };
}
