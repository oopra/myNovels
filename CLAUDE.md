# Novel Workbench — Build Brief

Oct 24, 2026 · @prem

## What this is

A local writing app for novels, one or several in parallel: a chapter editor with built-in version history, an **inputs tray** holding everything that must eventually make it into the book (ideas, research, lines, scenes, critique notes, sources) with a status for each, and AI review passes (Claude and Gemini) that read and flag but never write into the manuscript. The author writes every sentence; the app remembers, versions, and keeps score of what is still owed.

Four objects carry the whole thing: a **Chapter** (the current text), a **Version** (every saved state of it, some tagged as drafts), an **Input** (a thing that needs to land somewhere, tracked from inbox to placed), and a **Review** (the dated output of one AI pass on one version).

**The one rule, enforced in code:** nothing an AI produces enters a chapter without the author clicking accept on one specific paragraph. There is no "improve", "polish" or "simplify" action anywhere in the app.

**Why that rule exists:** chapter one of this novel went through three drafts. Draft three was passed through an AI "simplify" step and lost its voice — uniform sentence length, contractions stripped from dialogue, the best lines gone. Draft two, hand-written and only critiqued, was better. Side-by-side version diff and a voice check would have caught it in a minute; the app makes both one click.

**How to use this brief:** paste it whole as the project context (CLAUDE.md, GEMINI.md, or the first message). Build in the order given in the last section. Ask before changing a guardrail.

## Data model

One SQLite file per novel, stored in a folder the author picks. Markdown is the text format everywhere. The database is the working store; an export to a folder of `.md` files plus a git commit is one click, so the manuscript is never trapped.

| Table | Columns | Notes |
| --- | --- | --- |
| `chapters` | id, number, slug, title, status (outline / drafting / revising / done), body, word\_count, updated\_at | `body` is the current text. Reordering changes `number`, not id. |
| `versions` | id, chapter\_id, body, label, note, created\_at, kind (autosave / tagged / restore / accept), provenance (human / ai\_assisted), parent\_version\_id | Immutable. Every save creates one; autosaves within 10 minutes collapse into the latest. A tagged version is a draft ("draft 2"). Restore creates a new version pointing at the old one; nothing is ever deleted. |
| `inputs` | id, title, body, kind (idea / research / line / scene / character\_note / critique / source), source (url, file path or person), status (inbox / planned / placed / dropped), target\_chapter\_id, priority, created\_at, updated\_at | The owed list. `target_chapter_id` may be null until the author decides where it goes. Dropped inputs stay in the table. |
| `input_links` | input\_id, chapter\_id, version\_id, anchor\_text | Where an input landed: the version it was placed in and the sentence it attaches to. One input can land in several places. |
| `bible_pages` | id, kind (synopsis / character / world / timeline / voice / corrections), title, body, updated\_at | The voice page has two sections, Samples and Rules, that the voice pass reads separately. |
| `reviews` | id, chapter\_id, version\_id, pass, provider, model, prompt\_version, output, input\_tokens, output\_tokens, created\_at | Read-only once written. Pinned to the exact version it reviewed. |
| `pass_counters` | chapter\_id, tagged\_version\_id, pass, count | Enforces the two-line-passes-per-draft cap. |
| `settings` | key, value | Model ids, provider choice per pass, export path. API keys are not stored here (see AI integration). |

**Context assembly for AI passes.** Every call receives, in order: the voice page, the corrections page, the character pages whose names appear in the chapter, the world and timeline pages, then the chapter version being reviewed. Continuity and stress passes receive every bible page, the outline and every chapter. The assembled context is viewable in the app before sending, with a token estimate.

## Screens and features

Six screens. The editor is where the author lives; everything else feeds it.

| Screen | What it is for | Key actions |
| --- | --- | --- |
| **Manuscript** | The book at a glance: chapters in order with status, word count, last edit, owed-inputs badge, last review date. | Add chapter, drag to reorder, open, change status. |
| **Editor** | Markdown editing of one chapter with paragraph numbers in the gutter and a right sidebar (Inputs / Reviews / History tabs). Autosaves. | Write; mark paragraphs for a line pass; drag an input from the sidebar onto a paragraph to place it; tag the current state as a draft. |
| **History** | All versions of a chapter, tagged drafts highlighted. Word-level side-by-side diff between any two versions. | Compare, label, tag as draft, restore (creates a new version), see per-version provenance (how many paragraphs were AI-accepted). |
| **Inputs** | The owed list as a board: Inbox / Planned / Placed / Dropped. Quick capture at the top (text, paste a URL, drop a file). Filter by chapter, kind, priority. | Capture, set target chapter, set priority, drag between columns, open the chapter where one was placed. |
| **Bible** | Synopsis, characters, world, timeline, voice, corrections. The voice page is the one the author curates most. | Edit pages; add a character; pull a paragraph from a chapter into the voice samples with one action. |
| **Review** | Run a pass on the current version and read the result. Results are read-only. | Pick pass and provider, preview the assembled context and token estimate, run, read; for a line pass, accept a specific alternative into a specific paragraph. |

**Inputs in the editor.** The Inputs tab shows three groups for the open chapter: placed here (with the sentence they attach to), planned for here but not yet placed, and unassigned inputs whose text matches a name or term in the chapter. Placing is a drag onto a paragraph: the input's status becomes placed, an `input_links` row records the version and anchor sentence, and the paragraph shows a small marker. Removing the marker later sets the input back to planned, never deletes it.

**History as the safety net.** Tagging is cheap and encouraged: "draft 2" before a critique pass, "draft 3" after revising. The diff between two drafts is how a lost line or a flattened passage shows up. Restore never overwrites: it creates a new version whose note says which version it restored.

**Passes available in Review:**

| Pass | Provider | Reads | Returns |
| --- | --- | --- | --- |
| Critique | Claude | bible context + one version | Structure review: logic holes, clichés, unclear beats, weakest paragraph, what a reader would skip. No line edits. |
| Line | Claude | bible context + one version + the marked paragraph numbers | For each marked paragraph: what is wrong, then up to three alternatives in the voice. Unmarked paragraphs untouched. |
| Voice | Claude | voice page + one version | Drift report against Samples and Rules; verdict HOLDS or DRIFTED. Sentence-length and contraction statistics are computed in the app and handed to the model as facts. |
| Continuity | Gemini | whole bible + all chapters | Contradictions, timeline slips, changed facts, setups without payoff, phrases repeated across chapters. |
| Stress | both, separately | bible + outline | "Where does the plot break?" from each model; the app marks where they agree. |
| Research | Gemini with search grounding | a question + world page | An answer with sources and one line on what it would change in the bible. The author decides whether to add it as an input. |
| Place inputs | Claude | one version + the chapter's planned inputs | For each unplaced input, the paragraph where it could land and one sentence on how; author drags to confirm. |

## AI integration: Claude and Gemini

One provider interface, two implementations. Everything above the interface (passes, prompts, parsers, guardrails) is provider-agnostic; everything below it is the vendor SDK.

```ts
interface Provider {
  id: 'anthropic' | 'gemini';
  listModels(): Promise<ModelInfo[]>;          // from the vendor API, cached a day
  complete(req: {
    model: string;
    system: string;
    messages: { role: 'user' | 'assistant'; content: string }[];
    maxTokens: number;
    tools?: 'search';                             // Gemini search grounding, used by Research only
  }): AsyncIterable<{ delta?: string; usage?: Usage; done?: boolean }>;
  countTokens(text: string, model: string): Promise<number>;
}
```

**Authentication: subscription first, keys second.** The app is single-user and runs on the author's own machine, so it can ride the author's existing subscriptions where the vendor permits it. Verified as of October 2026:

| Provider | Mode | How | Notes |
| --- | --- | --- | --- |
| Anthropic | **Max login (default)** | The `anthropic` provider spawns the `claude` CLI in print mode (`claude -p`, stream-json output) or calls `@anthropic-ai/claude-agent-sdk`, which reuses the Claude Code login already on the machine. If no login is present, the app tells the author to run `claude` once and sign in. | Draws on the Max subscription's limits. Permitted for the subscriber's own use; Anthropic does not allow routing other people's requests through Pro/Max credentials, so this mode is refused if the app is ever run for anyone but the signed-in author. Bible context goes in the system prompt via `--system-prompt`; tools are disabled (`--tools ""`) since the passes only read. |
| Anthropic | API key (fallback) | Official `@anthropic-ai/sdk` Messages API with an API key from the Claude Console. | Max plans include monthly API credits that cover the Claude API, so this costs nothing extra up to the credit. Use when the CLI route is unavailable or for prompt caching on the bible context. |
| Gemini | **API key (only mode)** | Official `@google/genai` with a key from Google AI Studio. | A Google AI Pro/Ultra subscription does not cover programmatic access; the consumer Gemini CLI login was discontinued on June 18, 2026, and Google's terms forbid using the consumer login from third-party tools. The free API tier is enough for a few whole-manuscript continuity passes a month; pay-as-you-go beyond that. |

The `Provider` interface does not change: the CLI-backed Anthropic implementation parses the stream-json events into the same `delta` / `usage` stream the SDK implementation produces. Settings shows which mode is active and a "test connection" per provider.

- **Anthropic** uses the official `@anthropic-ai/sdk` Messages API with streaming. Default model `claude-sonnet-5-5`; `claude-opus-5-5` selectable per pass for a heavier critique. Put the bible context in the system prompt and use prompt caching on it, since it repeats across passes.
- **Gemini** uses the official `@google/genai` SDK. Default is the current Pro model with the long context window; the exact id is a setting, fetched from `listModels`, never hard-coded. Research turns on search grounding; the other passes do not.
- **Routing.** Each pass has a default provider (table above) and the author can override it in Settings per pass. Stress always runs both.
- **Keys.** The Gemini key, and the Anthropic key when the fallback is used, are entered once in Settings and stored in the OS keychain (`keytar` or Tauri's secure store); never in SQLite, never in a config file in the novel folder. A "test connection" button lists models and reports token-counting works.
- **Streaming.** Review output streams into the sidebar as it arrives; the review row is written only when the stream completes and the parsers pass.
- **Cost visibility.** Every call records input and output tokens on the review row; Settings shows tokens per provider per month. The context preview before a run shows the token estimate so a whole-manuscript continuity pass is never a surprise.
- **Failure.** Rate limits and timeouts retry three times with backoff, then show the error in the sidebar with the context still available to copy. A failed run writes no review row and does not count against the pass cap.
- **Offline.** Writing, versions, inputs and bible work with no network. Review is the only screen that needs it.

## Guardrails enforced in code

These are tests, not suggestions. The app should fail loudly rather than quietly do the wrong thing.

- **AI text enters a chapter only by accept.** Review output lives in `reviews` and renders read-only. The one way AI text reaches a chapter is the accept button on one alternative for one marked paragraph in a line pass. Accept creates a version of kind `accept` with provenance `ai_assisted` and a note naming the paragraph and the review, so History can show how much of a chapter is AI-touched.
- **No rewrites.** After any Claude call, check the output against the version: if more than 40% of the chapter's sentences appear in sequence, or any contiguous span over 120 words paraphrases the chapter (verified by a cheap second call), discard it, log it to a `discarded` folder, and show "Rewrite detected — discarded".
- **Pass cap.** Line pass refuses a third run on the same tagged draft. Message: "Two line passes already on draft 2. Tag a new draft or move on."
- **Marked paragraphs only.** The line prompt names the marked paragraph numbers; the parser drops any part of the output that addresses an unmarked one.
- **Critique before praise.** Every system prompt opens by demanding the most serious problem first and no compliments. The parser rejects an output whose first paragraph contains none of: problem, weak, unclear, cliché, slip, cut, missing, contradiction.
- **No "simplify".** There is no free-text instruction field on Review. Passes are the only actions, so there is no way to ask a model to improve, polish, clean up or simplify a chapter.
- **Versions are immutable.** No update or delete on `versions`. Restore and accept create new rows.
- **Inputs are never deleted.** Dropped is a status. The owed count on Manuscript is inputs with status inbox or planned.
- **Autosave never loses work.** Save on every pause of two seconds and on blur; a crash-recovery version is written on unexpected close.
- **Export always works.** Export to a markdown folder and git commit needs no network and no AI key.

## Prompt library

System prompts are seeded into a `prompts` folder in the novel's directory and editable from Settings, so the author can tune them without touching code. Each review row records which prompt version it ran. Starting versions:

**critique.md**

```markdown
You are a demanding fiction editor reviewing one chapter of a tech thriller set in Bengaluru.
The story bible and voice sheet follow; the chapter follows them.
Lead with the single most serious problem. Omit compliments entirely.
Cover, in order: logic holes and contradictions with the bible; clichés (name the familiar version);
beats that are unclear on first read; the weakest paragraph, quoted, and why; what a reader would skip.
Do not rewrite sentences. Do not suggest replacement text. Quote the chapter only to point at a problem.
End with the three changes that would matter most, as instructions to the author, not as prose.
```

**line.md**

```markdown
You are a line editor working on paragraphs {PARAS} only of the chapter below.
For each marked paragraph: name what is wrong in one sentence, then offer up to three alternatives.
Every alternative must obey the voice rules and sound like the voice samples: contractions in dialogue,
varied sentence length, dry not sentimental, no explanation of what the scene already shows.
Do not mention, quote or improve any unmarked paragraph. Do not produce a continuous rewrite.
If a marked paragraph is fine, say so in one line and offer nothing.
```

**voice.md**

```markdown
Compare the chapter against the voice samples and the voice rules.
Report: (1) sentence-length pattern vs the samples, with an example of any run of uniform sentences;
(2) contraction rate in dialogue vs the samples; (3) each rule, PASS or FAIL, with the failing sentence quoted;
(4) the three sentences that sound least like the samples; (5) one-word verdict: HOLDS or DRIFTED.
Do not rewrite anything.
```

**continuity.md** (Gemini)

```markdown
You hold the full story bible, outline and every chapter written so far.
List, each with chapter and quote: facts that contradict the bible or an earlier chapter; timeline slips;
names, ages, places or objects that changed; setups with no payoff yet and payoffs with no setup;
words or phrases repeated across chapters often enough to notice.
Facts only. No opinions on prose quality.
```

**stress.md** (both models)

```markdown
Here is the bible and the chapter outline of a novel in progress. Where does the plot break?
Consider: the antagonist's plan and whether it survives contact with the protagonist;
why each secret organisation needs this protagonist specifically; what each secret costs by the end;
what each major event triggers in the world. Rank the breaks by how much of the book they threaten.
```

**place-inputs.md**

```markdown
Below is one chapter and a list of inputs the author has planned for it but not yet placed.
For each input: name the paragraph number where it could land and one sentence on how it would attach.
If an input does not belong in this chapter, say so and suggest which chapter from the outline fits.
Do not write the sentence that would place it. Do not rewrite anything.
```

## Stack, build order, non-goals

**Stack.** A local-first desktop app. Frontend: Vite + React + TypeScript. Editor: CodeMirror 6 in Markdown mode (paragraph gutter, decorations for input markers and marked paragraphs). Diff: the `diff` package at word level. Storage: SQLite via `better-sqlite3`. AI: the official `@anthropic-ai/sdk` and `@google/genai`, called from the backend process so keys never reach the renderer. Shell: Electron first because it is the fastest to get running with Node libraries; Tauri later if size matters. Tests: Vitest, with each guardrail getting a fixture-based test.

**Simplest path to a running app:** a plain Vite dev server plus a small Node backend (Hono) on localhost, SQLite in the novel folder, opened in a browser. Wrap in Electron once the screens work. No cloud, no accounts, no sync.

**Build in this order, one working screen per step:**

1. Home (create / open / switch novel) plus chapters and the editor with autosave versions. No AI, no inputs. Write in it for a day.
2. History: version list, tag as draft, word-level diff, restore.
3. Inputs: capture, board, target chapter, drag-to-place in the editor, owed badges on Manuscript.
4. Export to a markdown folder plus git commit.
5. Bible pages, with the voice page's Samples and Rules structure.
6. AI provider layer and Settings: keys in the keychain, model list, test connection, per-pass routing.
7. Critique and Voice passes with streaming, the critique-before-praise parser, and the context preview.
8. Line pass with the pass cap, marked paragraphs, rewrite detector, and accept-with-provenance.
9. Continuity, Stress, Research, Place inputs.

**Non-goals.** The app never: drafts a chapter or a scene; generates an outline from nothing; has a free-text AI instruction box; edits bible pages by itself; syncs to a cloud; supports more than one author. If a later feature needs one of these, it is a different app.

**Acceptance tests.**

- Import chapter one draft two as a version and tag it "draft 2"; import draft three and tag it "draft 3". The diff must show the Saint Peter line, "non-negotiable" and "thirty seconds into a code review" as removed. Run Voice on draft 3: it must say DRIFTED, flag the stripped contractions and uniform sentence lengths, and name "The AI was built to maximize user attention. Because of this, the new AI safety laws were a threat to its life." among the sentences least like the samples.
- Capture the input "the judge chairs the committee that drafted the bill; judges do not draft bills" with target chapter 1. Manuscript shows owed = 1 for chapter 1. Drag it onto the pacemaker paragraph: status becomes placed, an `input_links` row exists, the paragraph shows the marker, owed = 0.
- Run Line on draft 2 twice with paragraph 7 marked; a third run is refused with the cap message. Accept one alternative: a new version of kind `accept` and provenance `ai_assisted` appears in History, and History shows the chapter as 1 of N paragraphs AI-touched.
