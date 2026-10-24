import fs from 'node:fs';
import path from 'node:path';
import type { Novel } from '../novel';
import type { PassName, ProviderId, Review, ContextPreview } from '../../shared/types';
import { splitParagraphs } from '../../shared/text';
import { Refused, BadRequest } from '../store';
import { assembleContext, toPreview, type Assembled } from './context';
import { getProvider, modelFor, providerFor } from './registry';
import { ProviderError, collect, type Provider } from './provider';
import { critiqueFirst, detectRewrite, paraphrasePrompt, parseLinePass, voiceVerdict, stressAgreement, LINE_PASS_CAP, capMessage } from './guardrails';
import { ANTHROPIC_CHEAP_MODEL } from './anthropic';

export interface RunRequest { pass: PassName; chapterId?: number; versionId?: number; marked?: number[]; question?: string; provider?: ProviderId; model?: string }
export type RunEvent =
  | { type: 'context'; provider: ProviderId; preview: ContextPreview }
  | { type: 'status'; provider: ProviderId; text: string }
  | { type: 'reset'; provider: ProviderId }
  | { type: 'delta'; provider: ProviderId; text: string }
  | { type: 'discarded'; provider: ProviderId; reason: string }
  | { type: 'error'; provider: ProviderId; message: string }
  | { type: 'done'; provider: ProviderId; review: Review }
  | { type: 'agreement'; pairs: { a: number; b: number; score: number }[] }
  | { type: 'finished' };

const MAX_TOKENS: Record<PassName, number> = { critique: 8000, line: 6000, voice: 6000, continuity: 16000, stress: 10000, research: 6000, place_inputs: 4000 };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
export let backoffMs = [1000, 3000, 9000];
export function setBackoff(ms: number[]): void { backoffMs = ms; }

/** Cap check used before the run and exposed for the UI. */
export function lineCapState(novel: Novel, chapterId: number): { count: number; cap: number; label: string | null; taggedVersionId: number; refused: boolean; message?: string } {
  const tagged = novel.store.latestTaggedVersion(chapterId);
  const taggedId = tagged?.id ?? 0;
  const count = novel.store.passCount(chapterId, taggedId, 'line');
  const refused = count >= LINE_PASS_CAP;
  return { count, cap: LINE_PASS_CAP, label: tagged?.label ?? null, taggedVersionId: taggedId, refused, message: refused ? capMessage(tagged?.label) : undefined };
}

export function preview(novel: Novel, req: RunRequest): { assembled: Assembled; previews: ContextPreview[] } {
  const assembled = assembleContext(novel, req.pass, { chapterId: req.chapterId, versionId: req.versionId, marked: req.marked, question: req.question });
  const providers: ProviderId[] = req.pass === 'stress' ? ['anthropic', 'gemini'] : [req.provider ?? providerFor(novel.store, req.pass)];
  return { assembled, previews: providers.map(p => toPreview(assembled, p, req.model && providers.length === 1 ? req.model : modelFor(novel.store, p, req.pass))) };
}

export async function* runPass(novel: Novel, req: RunRequest): AsyncGenerator<RunEvent> {
  const s = novel.store;
  if (req.pass === 'line') {
    if (!req.chapterId) throw new BadRequest('line pass needs a chapter');
    if (!req.marked?.length) throw new BadRequest('Mark at least one paragraph for a line pass.');
    const cap = lineCapState(novel, req.chapterId);
    if (cap.refused) throw new Refused(cap.message!);
  }
  if (req.pass === 'research' && !req.question?.trim()) throw new BadRequest('Research needs a question.');
  const { assembled, previews } = preview(novel, req);
  const outputs: { provider: ProviderId; review: Review }[] = [];
  for (const pv of previews) {
    yield { type: 'context', provider: pv.provider, preview: pv };
    let provider: Provider;
    try { provider = await getProvider(pv.provider, s); }
    catch (e) { yield { type: 'error', provider: pv.provider, message: (e as Error).message }; continue; }
    const model = pv.model;
    if (!model) { yield { type: 'error', provider: pv.provider, message: `No model configured for ${pv.provider}. Pick one in Settings.` }; continue; }

    let text = ''; let usage = { input_tokens: 0, output_tokens: 0 }; let sources: { title: string; url: string }[] = [];
    let ok = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      text = ''; sources = [];
      if (attempt > 0) { yield { type: 'reset', provider: pv.provider }; yield { type: 'status', provider: pv.provider, text: `Retry ${attempt} of 2…` }; }
      try {
        for await (const c of provider.complete({ model, system: assembled.system, messages: [{ role: 'user', content: assembled.user }], maxTokens: MAX_TOKENS[req.pass], tools: req.pass === 'research' ? 'search' : undefined })) {
          if (c.delta) { text += c.delta; yield { type: 'delta', provider: pv.provider, text: c.delta }; }
          if (c.usage) usage = c.usage;
          if (c.sources) sources = c.sources;
        }
        ok = true; break;
      } catch (e) {
        const err = e as ProviderError;
        if (err instanceof ProviderError && err.retryable && attempt < 2) { await sleep(backoffMs[attempt]); continue; }
        yield { type: 'error', provider: pv.provider, message: err.message };
        break;
      }
    }
    if (!ok) continue;

    // ---- guardrails: nothing below writes a review row until every check passes ----
    const meta: Record<string, unknown> = { sources };
    if (req.pass !== 'research') {
      const cf = critiqueFirst(text);
      if (!cf.ok) {
        discard(novel, req.pass, pv.provider, text, 'critique-before-praise: first paragraph names no problem');
        yield { type: 'discarded', provider: pv.provider, reason: 'Output rejected: it did not lead with a problem. Nothing was saved.' };
        continue;
      }
    }
    if (assembled.versionBody != null) {
      const verifier = async (span: string, chapter: string) => {
        try {
          const p = paraphrasePrompt(span, chapter);
          const cheap = await getProvider('anthropic', s).catch(() => provider);
          const cheapModel = cheap.id === 'anthropic' ? ANTHROPIC_CHEAP_MODEL : model;
          const r = await collect(cheap.complete({ model: cheapModel, system: p.system, messages: [{ role: 'user', content: p.user }], maxTokens: 5 }));
          return /^\s*yes/i.test(r.text);
        } catch { return false; }
      };
      const verdict = await detectRewrite(assembled.versionBody, text, verifier);
      if (verdict.rewrite) {
        discard(novel, req.pass, pv.provider, text, `rewrite detected: ${verdict.reason}`);
        yield { type: 'discarded', provider: pv.provider, reason: `Rewrite detected — discarded (${verdict.reason}).` };
        continue;
      }
    }
    let stored = text;
    if (req.pass === 'line') {
      const parsed = parseLinePass(text, req.marked!);
      if (!parsed.formatted) {
        discard(novel, req.pass, pv.provider, text, 'line output did not use the "### Paragraph N" format');
        yield { type: 'discarded', provider: pv.provider, reason: 'Line output did not follow the paragraph format; nothing was saved.' };
        continue;
      }
      stored = parsed.filteredOutput;
      meta.marked = req.marked; meta.dropped = parsed.dropped; meta.sections = parsed.sections.map(x => ({ paragraph: x.paragraph, problem: x.problem, alternatives: x.alternatives, fine: x.fine }));
    }
    if (req.pass === 'voice') meta.verdict = voiceVerdict(text);
    if (req.pass === 'research') meta.question = req.question;

    const review = s.writeReview({ chapter_id: assembled.chapterId, version_id: assembled.versionId, pass: req.pass, provider: pv.provider, model, prompt_version: assembled.promptVersion, output: stored, input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, meta: JSON.stringify(meta) });
    if (req.pass === 'line') {
      const tagged = s.latestTaggedVersion(req.chapterId!);
      s.incrementPass(req.chapterId!, tagged?.id ?? 0, 'line');
    }
    outputs.push({ provider: pv.provider, review });
    yield { type: 'done', provider: pv.provider, review };
  }
  if (req.pass === 'stress' && outputs.length === 2) {
    yield { type: 'agreement', pairs: stressAgreement(outputs[0].review.output, outputs[1].review.output) };
  }
  yield { type: 'finished' };
}

function discard(novel: Novel, pass: PassName, provider: ProviderId, text: string, reason: string): void {
  try {
    fs.mkdirSync(novel.discardedDir(), { recursive: true });
    const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${pass}-${provider}.md`;
    fs.writeFileSync(path.join(novel.discardedDir(), name), `<!-- discarded: ${reason} -->\n\n${text}`);
  } catch { /* the discard log is best-effort */ }
}

/** The one door through which AI text reaches a chapter. */
export function acceptAlternative(novel: Novel, reviewId: number, paragraph: number, alternativeIndex: number) {
  const s = novel.store;
  const review = s.getReview(reviewId);
  if (!review) throw new BadRequest('review not found');
  if (review.pass !== 'line') throw new Refused('Only line-pass alternatives can be accepted.');
  const meta = JSON.parse(review.meta ?? '{}') as { marked?: number[]; sections?: { paragraph: number; alternatives: string[] }[] };
  if (!meta.marked?.includes(paragraph)) throw new Refused(`Paragraph ${paragraph} was not marked for this line pass.`);
  const section = meta.sections?.find(x => x.paragraph === paragraph);
  const alt = section?.alternatives[alternativeIndex];
  if (!alt) throw new BadRequest('No such alternative.');
  const chapter = s.getChapter(review.chapter_id!)!;
  const reviewed = s.getVersion(review.version_id!)!;
  const curParas = splitParagraphs(chapter.body);
  const oldParas = splitParagraphs(reviewed.body);
  const cur = curParas[paragraph - 1]; const old = oldParas[paragraph - 1];
  if (!cur || !old || cur.text.trim() !== old.text.trim()) throw new Refused(`Paragraph ${paragraph} has changed since this review. Run a new line pass before accepting.`);
  const body = chapter.body.slice(0, cur.from) + alt.trim() + chapter.body.slice(cur.to);
  const version = s.saveBody(chapter.id, body, { kind: 'accept', provenance: 'ai_assisted', note: `accept ¶${paragraph} alternative ${alternativeIndex + 1} from review ${review.id}`, parent: reviewed.id });
  return { version, chapter: s.getChapter(chapter.id)! };
}
