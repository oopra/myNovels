import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Chapter, PassName, ProviderId, Review as ReviewRow, ContextPreview, Version } from '../../shared/types';
import { PASS_LABELS, PASS_DEFAULT_PROVIDER } from '../../shared/types';
import { api, runPass, getMarked, fmtDate, type RunEvent } from '../api';
import { useApp } from '../App';

const PASSES: PassName[] = ['critique', 'line', 'voice', 'continuity', 'stress', 'research', 'place_inputs'];
const NEEDS_CHAPTER: PassName[] = ['critique', 'line', 'voice', 'place_inputs'];
const PASS_HELP: Record<PassName, string> = {
  critique: 'Structure review of one version: logic holes, clichés, unclear beats, weakest paragraph, what a reader would skip. No line edits.',
  line: 'For each marked paragraph: what is wrong, then up to three alternatives in the voice. Two runs per tagged draft.',
  voice: 'Drift report against the voice page. Sentence-length and contraction statistics are computed here and handed to the model as facts.',
  continuity: 'Whole bible and every chapter: contradictions, timeline slips, changed facts, setups without payoff, repeated phrases.',
  stress: 'Both models separately: where does the plot break? Agreement is marked.',
  research: 'A question against the world page, with search grounding and sources. You decide whether to capture the answer as an input.',
  place_inputs: 'For each planned input, where it could land and how. You drag to confirm.',
};

interface Pane { provider: ProviderId; text: string; status: string; error?: string; discarded?: string; review?: ReviewRow; preview?: ContextPreview }

export function Review({ id, q }: { id?: number; q: URLSearchParams }) {
  const { toast } = useApp();
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [chapterId, setChapterId] = useState<number | undefined>(id);
  const [pass, setPass] = useState<PassName>((q.get('pass') as PassName) || 'critique');
  const [routing, setRouting] = useState<Record<PassName, { provider: ProviderId; model: string }> | null>(null);
  const [providerOverride, setProviderOverride] = useState<ProviderId | ''>('');
  const [versions, setVersions] = useState<Version[]>([]);
  const [versionId, setVersionId] = useState<number | ''>('');
  const [question, setQuestion] = useState('');
  const [marked, setMarkedList] = useState<number[]>([]);
  const [cap, setCap] = useState<{ count: number; cap: number; label: string | null; refused: boolean; message?: string } | null>(null);
  const [previews, setPreviews] = useState<ContextPreview[] | null>(null);
  const [showContext, setShowContext] = useState(false);
  const [panes, setPanes] = useState<Pane[]>([]);
  const [agreement, setAgreement] = useState<{ a: number; b: number; score: number }[] | null>(null);
  const [running, setRunning] = useState(false);
  const [past, setPast] = useState<ReviewRow[]>([]);
  const [selected, setSelected] = useState<ReviewRow | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => { api.chapters().then(c => { setChapters(c); if (!chapterId && c[0]) setChapterId(c[0].id); }); api.routing().then(setRouting).catch(() => {}); }, []);
  useEffect(() => {
    if (!chapterId) return;
    api.versions(chapterId).then(setVersions);
    api.lineCap(chapterId).then(setCap);
    setMarkedList(getMarked(chapterId));
    api.chapterReviews(chapterId).then(r => { setPast(r); const rid = q.get('review'); if (rid) { const sel = r.find(x => x.id === Number(rid)); if (sel) setSelected(sel); } });
  }, [chapterId]);
  useEffect(() => { setPreviews(null); setPanes([]); setAgreement(null); if (!NEEDS_CHAPTER.includes(pass) && pass !== 'stress' && pass !== 'continuity') { /* research */ } }, [pass, chapterId, versionId, providerOverride]);
  useEffect(() => { if (!chapterId) api.reviews().then(setPast); }, [chapterId]);

  const provider: ProviderId = providerOverride || routing?.[pass]?.provider || PASS_DEFAULT_PROVIDER[pass];
  const req = () => ({ pass, chapterId: NEEDS_CHAPTER.includes(pass) ? chapterId : undefined, versionId: NEEDS_CHAPTER.includes(pass) && versionId ? Number(versionId) : undefined, marked: pass === 'line' ? marked : undefined, question: pass === 'research' ? question : undefined, provider: pass === 'stress' ? undefined : provider });
  const canRun = pass === 'stress' || pass === 'continuity' || (pass === 'research' ? question.trim().length > 0 : !!chapterId && (pass !== 'line' || (marked.length > 0 && !cap?.refused)));

  const doPreview = async () => {
    try { setPreviews(await api.preview(req())); setShowContext(true); } catch (e) { toast((e as Error).message, 'err'); }
  };
  const run = async () => {
    setRunning(true); setSelected(null); setAgreement(null);
    const ps: ProviderId[] = pass === 'stress' ? ['anthropic', 'gemini'] : [provider];
    let state: Pane[] = ps.map(p => ({ provider: p, text: '', status: 'Starting…' }));
    const commit = () => setPanes([...state.map(p => ({ ...p }))]);
    commit();
    const upd = (p: ProviderId, f: (pane: Pane) => void) => { const pane = state.find(x => x.provider === p); if (pane) f(pane); commit(); };
    abort.current = new AbortController();
    try {
      await runPass(req(), (e: RunEvent) => {
        switch (e.type) {
          case 'context': upd(e.provider, p => { p.preview = e.preview; p.status = `Sent ≈${e.preview.tokens.toLocaleString()} tokens to ${e.preview.model}…`; }); setPreviews(prev => [...(prev ?? []).filter(x => x.provider !== e.provider), e.preview]); break;
          case 'status': upd(e.provider, p => { p.status = e.text; }); break;
          case 'reset': upd(e.provider, p => { p.text = ''; }); break;
          case 'delta': upd(e.provider, p => { p.text += e.text; p.status = 'Streaming…'; }); break;
          case 'discarded': upd(e.provider, p => { p.discarded = e.reason; p.status = 'Discarded'; }); break;
          case 'error': upd(e.provider, p => { p.error = e.message; p.status = 'Failed'; }); break;
          case 'done': upd(e.provider, p => { p.review = e.review; p.status = 'Saved'; p.text = e.review.output; }); break;
          case 'agreement': setAgreement(e.pairs); break;
          case 'finished': break;
        }
      }, abort.current.signal);
    } catch (e) { if ((e as Error).name !== 'AbortError') { state.forEach(p => { p.error = (e as Error).message; p.status = 'Failed'; }); commit(); } }
    setRunning(false);
    if (chapterId) { api.chapterReviews(chapterId).then(setPast); api.lineCap(chapterId).then(setCap); } else api.reviews().then(setPast);
  };
  const chapter = chapters.find(c => c.id === chapterId);
  const addResearchAsInput = async (text: string) => {
    const title = prompt('Input title:', question.slice(0, 80)); if (!title) return;
    await api.createInput({ title, body: text, kind: 'research', source: 'research pass' }); toast('Captured as an input');
  };

  return (
    <div className="review">
      <div className="review-side">
        <h2 style={{ marginTop: 0 }}>Run a pass</h2>
        <label>Pass</label>
        <select value={pass} onChange={e => setPass(e.target.value as PassName)}>{PASSES.map(p => <option key={p} value={p}>{PASS_LABELS[p]}</option>)}</select>
        <div className="muted small" style={{ marginTop: 4 }}>{PASS_HELP[pass]}</div>
        {(NEEDS_CHAPTER.includes(pass)) && (
          <>
            <label>Chapter</label>
            <select value={chapterId ?? ''} onChange={e => { setChapterId(Number(e.target.value)); setVersionId(''); }}>{chapters.map(c => <option key={c.id} value={c.id}>{c.number}. {c.title}</option>)}</select>
            <label>Version</label>
            <select value={versionId} onChange={e => setVersionId(e.target.value ? Number(e.target.value) : '')}>
              <option value="">current text</option>
              {versions.map(v => <option key={v.id} value={v.id}>#{v.id} {v.label ?? v.kind} · {fmtDate(v.created_at)}</option>)}
            </select>
          </>
        )}
        {pass === 'line' && chapterId && (
          <div className="small" style={{ marginTop: 8 }}>
            Marked paragraphs: {marked.length ? <strong>¶{marked.join(', ¶')}</strong> : <span className="muted">none</span>} · <a href={`#/chapter/${chapterId}`}>mark in editor</a>
            {cap && <div className={cap.refused ? 'err-box' : 'muted'} style={{ marginTop: 6 }}>{cap.refused ? cap.message : `${cap.count} of ${cap.cap} line passes used on ${cap.label ?? 'the untagged draft'}.`}</div>}
          </div>
        )}
        {pass === 'research' && (
          <>
            <label>Research question (not an instruction about the manuscript; the model does not see it)</label>
            <textarea value={question} onChange={e => setQuestion(e.target.value)} style={{ minHeight: 80 }} placeholder="e.g. How does a Bluetooth pacemaker receive a firmware update?" />
          </>
        )}
        {pass !== 'stress' && (
          <>
            <label>Provider</label>
            <select value={providerOverride} onChange={e => setProviderOverride(e.target.value as ProviderId | '')}>
              <option value="">default ({routing?.[pass]?.provider ?? PASS_DEFAULT_PROVIDER[pass]} · {routing?.[pass]?.model || 'no model set'})</option>
              <option value="anthropic">Claude</option>
              <option value="gemini">Gemini</option>
            </select>
          </>
        )}
        <div className="row" style={{ marginTop: 14 }}>
          <button onClick={doPreview} disabled={running || !canRun}>Preview context</button>
          <button className="primary" onClick={run} disabled={running || !canRun}>{running ? 'Running…' : 'Run'}</button>
          {running && <button onClick={() => abort.current?.abort()}>Stop</button>}
        </div>
        {previews && (
          <div style={{ marginTop: 12 }}>
            {previews.map(pv => (
              <div key={pv.provider} className="card small" style={{ padding: 8 }}>
                <div><strong>{pv.provider}</strong> · {pv.model || <span style={{ color: 'var(--err)' }}>no model</span>} · {pv.exact ? '' : '≈'}{pv.tokens.toLocaleString()} tokens · prompt {pv.promptVersion}</div>
                <ul className="parts" style={{ paddingLeft: 14, margin: '6px 0' }}>{pv.parts.map((p, i) => <li key={i}><span>{p.name}</span><span className="muted">{p.tokens.toLocaleString()}</span></li>)}</ul>
                <a href="#" onClick={e => { e.preventDefault(); setShowContext(s => !s); }}>{showContext ? 'hide' : 'show'} assembled context</a>
                {showContext && <div className="context-preview" style={{ marginTop: 6 }}>{`SYSTEM\n${pv.system}\n\nUSER\n${pv.user}`}</div>}
              </div>
            ))}
          </div>
        )}
        <h3 style={{ marginTop: 20 }}>Past reviews{chapter ? ` · ${chapter.title}` : ''}</h3>
        {past.length === 0 && <div className="muted small">None yet.</div>}
        {past.map(r => (
          <div key={r.id} className="review-list-item" onClick={() => { setSelected(r); setPanes([]); }}>
            <strong>{PASS_LABELS[r.pass]}</strong> <span className="muted">· {r.provider} · {fmtDate(r.created_at)}</span>
            <div className="muted small">{r.model} · v{r.version_id ?? '—'} · {r.input_tokens.toLocaleString()}/{r.output_tokens.toLocaleString()} tok{metaVerdict(r)}</div>
          </div>
        ))}
      </div>
      <div className="review-main">
        {panes.length > 0 && (
          <div className={panes.length === 2 ? 'two-col' : ''}>
            {panes.map((p, i) => (
              <div key={p.provider}>
                <div className="row" style={{ marginBottom: 6 }}><strong>{p.provider === 'anthropic' ? 'Claude' : 'Gemini'}</strong> <span className="muted small">{p.status}</span></div>
                {p.error && <div className="err-box" style={{ marginBottom: 8 }}>{p.error}{p.preview && <div className="small" style={{ marginTop: 4 }}><a href="#" onClick={e => { e.preventDefault(); navigator.clipboard.writeText(`SYSTEM\n${p.preview!.system}\n\nUSER\n${p.preview!.user}`); toast('Context copied'); }}>Copy the assembled context</a></div>}</div>}
                {p.discarded && <div className="err-box" style={{ marginBottom: 8 }}>{p.discarded}</div>}
                {p.review ? <ReviewOutput review={p.review} agreement={agreement} side={i} chapterId={chapterId} onAccepted={() => chapterId && api.versions(chapterId).then(setVersions)} onCapture={addResearchAsInput} />
                  : p.text && <div className="output-box"><span className="readonly">streaming</span><div className="output">{p.text}</div></div>}
              </div>
            ))}
          </div>
        )}
        {panes.length === 0 && selected && <ReviewOutput review={selected} agreement={null} side={0} chapterId={chapterId} onAccepted={() => chapterId && api.versions(chapterId).then(setVersions)} onCapture={addResearchAsInput} />}
        {panes.length === 0 && !selected && <div className="muted">Pick a pass on the left, preview the context if you want to see what will be sent, then run. Results are read-only; the only thing that can enter a chapter is one accepted line-pass alternative.</div>}
      </div>
    </div>
  );
}

function metaVerdict(r: ReviewRow): string { try { const m = JSON.parse(r.meta ?? '{}'); return m.verdict ? ` · ${m.verdict}` : ''; } catch { return ''; } }

function ReviewOutput({ review, agreement, side, chapterId, onAccepted, onCapture }: { review: ReviewRow; agreement: { a: number; b: number; score: number }[] | null; side: number; chapterId?: number; onAccepted: () => void; onCapture: (text: string) => void }) {
  const { toast } = useApp();
  const meta = useMemo(() => { try { return JSON.parse(review.meta ?? '{}'); } catch { return {}; } }, [review.meta]);
  const [accepted, setAccepted] = useState<string[]>([]);
  const accept = async (paragraph: number, alt: number) => {
    if (!confirm(`Replace paragraph ${paragraph} with alternative ${alt + 1}? This creates a new version marked AI-assisted.`)) return;
    try { await api.accept(review.id, paragraph, alt); setAccepted(a => [...a, `${paragraph}:${alt}`]); toast(`Paragraph ${paragraph} replaced; new version saved`); onAccepted(); }
    catch (e) { toast((e as Error).message, 'err'); }
  };
  const items = useMemo(() => agreement ? listItems(review.output) : null, [agreement, review.output]);
  const agreeSet = new Set((agreement ?? []).map(p => side === 0 ? p.a : p.b));
  return (
    <div className="output-box">
      <span className="readonly">read-only · {review.provider} · {review.model} · {fmtDate(review.created_at)}{meta.verdict ? ` · ${meta.verdict}` : ''}</span>
      {review.pass === 'line' && Array.isArray(meta.sections) ? (
        <div>
          <div className="muted small" style={{ marginBottom: 8 }}>Marked ¶{(meta.marked ?? []).join(', ¶')}{meta.dropped?.length ? ` · dropped output for unmarked ¶${meta.dropped.join(', ¶')}` : ''}</div>
          {meta.sections.map((s: { paragraph: number; problem: string; alternatives: string[]; fine: boolean }) => (
            <div key={s.paragraph} style={{ marginBottom: 16 }}>
              <h2 style={{ margin: '6px 0' }}>Paragraph {s.paragraph}</h2>
              <div><strong>Problem:</strong> {s.problem}</div>
              {s.fine && <div className="muted">Fine as it is.</div>}
              {s.alternatives.map((a, i) => (
                <div key={i} className="alt">
                  <div className="text">{a}</div>
                  <button className="small primary" disabled={!chapterId || accepted.includes(`${s.paragraph}:${i}`)} onClick={() => accept(s.paragraph, i)}>{accepted.includes(`${s.paragraph}:${i}`) ? 'Accepted' : 'Accept'}</button>
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : items ? (
        <div className="output">{items.map((it, i) => <div key={i} className={agreeSet.has(i) ? 'agree' : ''} style={{ padding: '2px 4px', marginBottom: 8 }}>{agreeSet.has(i) && <span className="badge ok" style={{ marginRight: 6 }}>both</span>}{it}</div>)}</div>
      ) : (
        <div className="output">{review.output}</div>
      )}
      {review.pass === 'research' && (
        <div style={{ marginTop: 10 }}>
          {Array.isArray(meta.sources) && meta.sources.length > 0 && <div className="small"><strong>Sources:</strong> {meta.sources.map((s: { title: string; url: string }, i: number) => <span key={i}> <a href={s.url} target="_blank" rel="noreferrer">{s.title}</a>{i < meta.sources.length - 1 ? ' ·' : ''}</span>)}</div>}
          <button className="small" style={{ marginTop: 6 }} onClick={() => onCapture(review.output)}>Capture as an input</button>
        </div>
      )}
    </div>
  );
}

function listItems(text: string): string[] {
  const paras = text.split(/\n\s*\n/).filter(p => p.trim());
  const numbered = paras.filter(p => /^\s*(\d+[.)]|[-*])\s+/.test(p));
  return numbered.length ? numbered : paras;
}
