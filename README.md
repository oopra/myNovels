# Novel Workbench

A local writing app for novels: a chapter editor with built-in version history, an inputs tray for everything still owed to the book, and AI review passes (Claude and Gemini) that read and flag but never write into the manuscript. The brief it is built from is `CLAUDE.md`.

## Install

Every release on the [Releases page](https://github.com/oopra/myNovels/releases) carries ready-made builds, produced by the `release` GitHub Actions workflow when a `v*` tag is pushed:

| What | File | Install |
| --- | --- | --- |
| Windows app | `Novel Workbench_<version>_x64-setup.exe` (or the `.msi`) | Run it. Windows SmartScreen asks once because the build is not code-signed: choose *More info → Run anyway*. |
| Android app | `novel-workbench-<version>-android.apk` | Open it on the phone, allow installing from this source. Unless you add a keystore as repository secrets (`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`), each release is signed with a fresh key and an update needs the old one uninstalled first. |
| Server (cloud) | `ghcr.io/oopra/mynovels:<version>` | Run the image on any host with a volume at `/data`; see "In the cloud" below. No build step. |

On first launch the app asks for the server URL and access token; after that everything lives on the server.

To cut a release: bump `version` in `package.json` and push to `main` (or push a `v*` tag). The workflow creates or updates the release `v<version>`.

## Run it

```bash
npm install
npm run dev          # backend on http://127.0.0.1:4801, UI on http://localhost:5180
npm test             # Vitest: guardrails, versions, inputs, export, HTTP
npm run build        # typecheck + bundle the UI into dist/client
npm start            # serve the built UI and the API from one process on 127.0.0.1:4801
```

Open the UI, create a novel (a folder you pick; it gets `novel.db`, `prompts/` and `discarded/`), add a chapter, write.

### Central server for several devices

```bash
HOST=0.0.0.0 npm start        # or: npm run serve (build + start)
```

Bound to a non-loopback host the server requires an access token on every API call. It is generated once, printed at startup, and kept at `<config dir>/access-token` (`~/.config/novel-workbench` on Linux, `~/Library/Application Support/novel-workbench` on macOS). The UI asks for it on first use and keeps it in the browser. Set `NOVEL_WORKBENCH_TOKEN` to choose your own. Put the server behind HTTPS (Tailscale, Caddy) before exposing it beyond a LAN; the token is sent as a bearer header.

In this mode the novel folders live on the server and every device sees the same database live. Writing needs the server to be reachable; see "Sync" below for the offline-first alternative.

### In the cloud

The novels, prompts, exports and the access token all live under `/data` in the container, so mount a persistent volume there. The `claude` CLI login is not available in the cloud; set `ANTHROPIC_API_KEY` (Claude Console; Max plans include monthly API credit) and `GEMINI_API_KEY` (AI Studio) as secrets and the app uses the API routes. Environment keys win over anything saved in Settings.

**Fly.io** (TLS, a volume and suspend-when-idle come built in). With the published image nothing is built locally:

```bash
fly launch --copy-config --no-deploy --image ghcr.io/oopra/mynovels:latest   # pick your region
fly volumes create workbench_data --size 1  # 1 GB holds many novels
fly secrets set ANTHROPIC_API_KEY=sk-ant-... GEMINI_API_KEY=... NOVEL_WORKBENCH_TOKEN=$(openssl rand -base64 24)
fly deploy
fly open                                    # paste the token when the UI asks
```

**Any VPS with Docker** (Hetzner, DigitalOcean, Lightsail): `docker compose up -d`, then put Caddy or another TLS proxy in front of port 4801. Railway and Render work the same way from the Dockerfile with a volume mounted at `/data`.

**Backups and the manuscript never being trapped:** set *Export git remote* in Settings to a repository URL that carries a token (`https://<token>@github.com/you/manuscript.git`); every "Export + commit" then also pushes. For the database itself, snapshot the volume (`fly volumes snapshots list`) or copy `/data/novels/*/novel.db`; SQLite in WAL mode copies safely with `sqlite3 novel.db ".backup out.db"`.

## Native app (Windows and Android)

`src-tauri/` is a Tauri 2 shell around the same UI. It stores nothing on the device: on first launch the Home screen asks for the server URL (your cloud workbench, HTTPS) and the access token, and every screen then talks to that server. HTML5 drag-and-drop is kept working by turning off Tauri's native drag handler (`dragDropEnabled: false`), which the editor's place-an-input gesture depends on.

**Windows** (build on Windows; produces an `.msi` and an NSIS `.exe` under `src-tauri/target/release/bundle/`):

```powershell
# once: Rust (https://rustup.rs), Visual Studio Build Tools with the "Desktop development with C++" workload, Node 22
npm install
npm run app:build
```

The installer downloads the WebView2 runtime if the machine lacks it. `npm run app:dev` opens the shell against the Vite dev server for UI work.

**Android** (any OS with Android Studio; produces an `.apk`/`.aab` under `src-tauri/gen/android/app/build/outputs/`):

```bash
# once: Android Studio with SDK + NDK, set ANDROID_HOME and NDK_HOME, then the Rust targets:
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
npm install
npm run tauri android init        # generates src-tauri/gen/android once
npm run app:android               # release build; `npm run tauri android dev` runs on a connected device
```

Android blocks plain `http://` by default, so the server must be reachable over HTTPS (Fly.io gives that for free). Sign the release build with your own keystore before distributing it; Tauri's Android guide covers `keystore.properties`.

The Rust side was type-checked for the Windows target from this Linux build (`cargo check --target x86_64-pc-windows-msvc`); the packaged installers themselves can only be produced on the target platform's toolchain. macOS and iOS need only `npm run app:build` on a Mac and `npm run tauri ios init` respectively, with the same shell.

## Layout

```
shared/   types and text utilities used by server, client and tests (paragraph numbering lives here)
server/   Hono API, SQLite via better-sqlite3, export, AI layer
  db.ts         schema and the triggers that enforce immutability
  store.ts      all reads and writes
  ai/           provider interface, Anthropic (CLI + SDK), Gemini, context assembly, guardrails, pass runner
  lib/export.ts markdown export + git commit
src/      Vite + React UI; src/editor/cm.ts holds the CodeMirror extensions
tests/    Vitest; fixtures are chapter one draft 2 (in voice) and draft 3 (flattened)
```

## Guardrails and where they are enforced

| Guardrail | Where |
| --- | --- |
| AI text enters a chapter only by accept | `server/ai/run.ts` `acceptAlternative` is the only path; it refuses unmarked paragraphs and paragraphs that changed since the review |
| No rewrites | `server/ai/guardrails.ts` `detectRewrite`: >40% of sentences in sequence, or a >120-word span confirmed as paraphrase by a cheap second call (Haiku) |
| Pass cap | `pass_counters` keyed on the latest tagged version; third line pass refused with the brief's message; failed runs do not count |
| Marked paragraphs only | `parseLinePass` keeps only `### Paragraph N` sections for marked N and records what it dropped |
| Critique before praise | `critiqueFirst`: first paragraph must contain one of the keywords; a clean result must open "No problem found." |
| No "simplify" | Review has no free-text instruction field. Research takes a question, but the model never sees the manuscript on that pass |
| Versions immutable | SQLite triggers refuse UPDATE/DELETE on `versions` (see the autosave note below) |
| Inputs never deleted | trigger refuses DELETE on `inputs`; dropped is a status |
| Reviews read-only | triggers refuse UPDATE/DELETE on `reviews` |
| Autosave | 2 s pause and blur; `pagehide` sends a keepalive save noted "recovered on close" |
| Export always works | `exportNovel` needs no network and no key; commits with a local identity if git has none |

**Autosave collapse.** "Autosaves within 10 minutes collapse into the latest" is implemented as: an autosave row may be superseded (body only) while it is still the newest version of its chapter and younger than ten minutes. The trigger permits exactly that and nothing else. Tagging, restoring, importing or accepting always creates a new row, so a tagged draft can never be altered.

## AI providers

- **Anthropic, default:** spawns `claude -p --output-format stream-json --include-partial-messages --tools "" --system-prompt …` and parses the events into the provider stream. Uses the Claude Code login on the machine; if the CLI is missing the app says to run `claude` once and sign in. Token counts on this route are estimates.
- **Anthropic, fallback:** `@anthropic-ai/sdk` with an API key; bible context goes in the system prompt with `cache_control`. Exact token counting.
- **Gemini:** `@google/genai` with an AI Studio key. The model id is never hard-coded: it comes from `listModels` (cached a day) and Settings. Research turns on `googleSearch` grounding and records the sources on the review row.
- Keys: `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` in the environment win (cloud); otherwise the OS keychain through `keytar`; if that library cannot load (no libsecret on this Linux container) a 0600 file in the config directory. Never SQLite, never the novel folder.
- Rate limits and timeouts retry three times (1 s, 3 s, 9 s). A failed run writes no review row.

Prompts are seeded to `<novel>/prompts/*.md` from `server/ai/prompts.ts` and edited in Settings; each review records the prompt's content hash. The line prompt carries an output-format footer the parser depends on.

## Sync

The brief lists sync as a non-goal; the owner has since asked for a central database reachable from several devices. The central-server mode above delivers that today. Two further designs are possible and differ a lot in effort:

1. **Thin clients, one server** (built): the server owns the SQLite files; devices use the UI over the network. No offline writing away from the server.
2. **Local database per device with reconciliation**: each device keeps its own `novel.db`, and a sync step exchanges rows with a central store. The schema helps: `versions`, `reviews` and `input_links` are append-only (union them), while `chapters`, `inputs`, `bible_pages` and `settings` are last-writer-wins on `updated_at`, with `chapters.body` re-derived from the newest version. Needs device ids on rows, a change log, and a conflict rule for two devices editing the same chapter offline (keep both as versions, mark the later one as current).

## Not done yet

- Packaged installers for Windows and Android must be built on those toolchains; the shell code is in place and type-checked.
- The acceptance tests that need a live model (Voice on draft 3 saying DRIFTED) are covered with a fake provider; the statistics the model receives are tested for real.
