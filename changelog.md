# Changelog

## 2026-09-01

### Added
- **A full-screen voice-chat surface in the Study (the ChatGPT/Gemini voice-mode pattern).** The composer 🎤 now opens an overlay with a level-reactive orb, **live transcription captions** while you talk (so a mishearing is visible before it sends), reply captions while Goobster speaks, and controls for mute, **auto-send vs press-to-send** (pause-to-send, or hold the floor and hit Send yourself), Goobster's voice + playback speed, and end — plus **tap-to-interrupt** while the reply is playing. Live captions ride a new transcription-only WebSocket (`WS /api/app/voice/live`, `services/voiceLiveService.js`): the Parlor Live capture pipeline (mic worklet → 16kHz PCM → RMS energy gate → Scribe v2 Realtime, per-utterance batch fallback) without the persona/turn machinery — committed utterances go back to the client and through the normal chat SSE route, so tools, memory, history, and the turn lock all apply unchanged. Servers without an ElevenLabs key degrade to the batch engine (MediaRecorder + local VAD, no partials); no keys at all and the button never renders. New Jest spec: `voiceLiveService`
- **Per-scope TTS voices instead of one global voice.** `guild_settings` gained `tts_voice_id`/`tts_voice_name`/`tts_voice_speed` (`getTtsVoice`/`setTtsVoice`, the personality-directive pattern): each server picks its own voice, and each user has a personal voice under their `dm:<userId>` scope that drives the web portal's voice chat and read-aloud. `/setvoice` is reworked from "admin writes config.json globally" to scoped subcommands (`set`/`clear`/`view`, DM-enabled, Manage Server in guilds, names resolved against the voice library at save time); the portal exposes the same preference at `GET/PATCH /api/app/voice/settings` with the picker fed by `GET /api/app/voice/voices`. Every synthesis path — web read-aloud and voice chat, `/voicechat` (both engines), `/speak`, the AI DJ, table-game voice comments — now passes the scope's voice as a per-request `fetchStream`/`textToSpeech` override instead of mutating the shared engine (`/speak voice:` previously changed the voice for every server until restart). Playback speed is applied client-side (`playbackRate`), stored per user, valid 0.5–2×. The preference lives on the DM-scope settings row `/forget-me` already deletes — no new erasure surface. New Jest spec: `guildSettingsTtsVoice`

## 2026-08-22

### Fixed
- **Large Spotify playlist downloads dying in ~10s with a fake 429 (`too many 404 error responses`).** Two stacked problems. Upstream: spotipy retries Spotify **404s** (private / invite-only playlists, including share links with `?pt=`) until it reports `http status: 429`, so `/play` and `/spotdl` told people to add credentials or wait out a rate limit when the list was simply inaccessible. Ours: even a public playlist was handed to one `spotdl download <playlist-url>`, so a single `GET /v1/playlists/{id}` failure aborted the whole job. Goobster now expands playlists/albums and downloads track URLs in batches of 15 (`spotdl.batchSize`; a failed batch does not abort the rest).
- **`Spotify API 403` on `GET /v1/playlists/{id}/tracks` after the Feb 2026 Web API change.** Spotify removed `/tracks` and `/items` only returns contents for playlists the logged-in user owns — client-credentials 403s every playlist. Public playlists are expanded from the embed page (`__NEXT_DATA__.trackList`, typically the first ~100 tracks). A leftover `Spotify API 403 for /v1/playlists/...` is rewritten to "make the playlist public"; invite `?pt=` links are not public (Spotify's own embed 404s them). New Jest spec: `spotifyWebApi`.
- **Valid Spotify client id/secret still produced `Spotify rejected the access token`.** `/api/token` succeeds, then `GET /playlists/{id}/items` returns **401** (no user on a client-credentials token). The 401 was treated as bad config and the embed fallback never ran. Playlist expansion now skips the official items call entirely.
- **`yt-dlp` / `spotdl` CLI not found on hosts that never got a music venv (Cloud Agents included).** The bot looks in `~/.local/goobster-venv`, `~/.local/bin`, and `/opt/venv`, but the Cloud environment install only ran `npm ci` and the Pi `--update` path only rebuilt a venv that *already existed* and failed `spotdl --version` — a missing directory, or a venv that had spotdl but not yt-dlp, stayed CLI-less forever. `scripts/ensure-music-cli.sh` now creates or heals the venv when either CLI is missing, `install-rpi.sh` (full and `--update`) calls it, and the Cloud environment install installs `python3.12-venv` first (the snapshot image has no `ensurepip`).

## 2026-08-21

### Added
- **An attention system: Goobster can now notice that something changed and decide whether it matters to you.** Asking him something and scheduling something both start with the user; this is the third path, which does not — *something changes → he notices → compares it against what matters to you → decides whether intervention is worthwhile → acts, asks, nudges, or stays silent*. The last option is the feature. A new **attention ledger** (`attention_items`) holds a small, volatile working set of open loops — goals, commitments, deadlines, open questions, waiting-for items, opportunities, concerns — with provenance, confidence, importance, and expiry. It is deliberately not the knowledge graph (which answers "what does Goobster know?") and not a task list: entries are his *beliefs*, so an item may be wrong, sit at low confidence forever, or expire unacted-on. Mined loops start as `candidate` with capped confidence and cannot interrupt anybody until independent evidence corroborates them. Candidates for intervention are generated **deterministically from durable state** (a deadline inside the horizon, a loop that stopped moving, something waited on that went quiet, an Observatory run that went wrong, a contradiction that appeared) — never by handing a memory dump to a model and asking what might matter, which buys nagging, token spend, and hallucinated relevance. Scoring is pure math in `utils/attentionScore.js` (`P = U × I × C × A − K`: urgency, importance, confidence-in-understanding, actionability, minus interruption cost), and only then does one cheap model call answer the narrow question it is good at: of these few candidates, which is worth interrupting for, and how would you say them in one breath? Code keeps control — the model may nudge a score by ±0.2, can never raise something above where scoring put it, and a veto demotes to the inbox rather than erasing. Idempotence comes from a `dedupeKey` per candidate, so the new internal event bus needs no durability: a missed event delays a notice, it never loses one. New Jest specs: `attentionScore`, `attentionLedger`, `attentionService`
- **A spectrum of initiative, instead of one "proactive mode" flag.** `observe` notices and remembers but never reaches out (the inbox still fills — you asked to be able to look), `nudge` may surface useful things including a DM, `assist` may also do reversible read-only work and report it, `delegate` may start pre-authorized kinds of action. Orthogonally, per-category boundaries say what is allowed in a domain (`proactiveRead`/`proactiveCompute`/`externalWrite`), because reading a repo and pushing to it are not the same permission. Individual loops can carry their own ceiling. Enrollment is explicit — `/attention enable`, the same opt-in shape as `/proactive` — so nobody gets proactively messaged because a feature shipped. Budget per person: 3 DMs a day, 3 hours apart, plus quiet hours that hold *contact* while the inbox keeps filling
- **Watches: the third scheduling primitive.** A follow-up waits for a time, an automation repeats on a cron, and a watch waits for a **condition** — then fires one unattended agent turn through the same pipeline, with the same tools and guardrails, and is spent. "Run this overnight and see whether the bifurcation persists" is now a watch on job completion rather than a cron job that polls for it: Goobster launches the run, arms the watch, goes away, and when `observatoryService` moves the job to a terminal state the watch claims itself atomically, wakes up with the run's status and output tails already in hand, and says what it makes of the result. `watchFor` arms them from chat; `/attention watches` lists them. Observatory, reflection, the graph legalizer, and every stored memory now publish on `services/domainEventBus.js` (topic pub/sub with namespace wildcards, in-process plus `pg_notify` across the bot/api boundary, deliberately non-durable)
- **A second heartbeat whose unit of attention is the person, not the channel.** `personalHeartbeatService` wakes every 10 minutes under its own singleton lock, picks whoever is due (or whom an event has dirtied, subject to a 10-minute floor so a busy channel cannot sweep on every message), and hands each to the attention pipeline. The guild heartbeat is untouched: the two stay separate because opt-in, activity bars, contact budgets, and initiative ceilings are genuinely different guardrails
- **Reflection learned to attend.** A new `attend` pass mines latent open loops out of what somebody said — "I'll finish that this weekend", "we're waiting to hear whether CI passed", "I still haven't figured out why..." — into uncertain candidates with memory provenance, without turning any hint into a task. It no-ops cheaply for anyone who has not enrolled, and only runs on personal scopes
- **The Assistant Inbox (portal → Noticed, and `/attention inbox`).** What he observed but chose not to interrupt about, the ledger behind those judgements, armed watches, and the initiative dials. Every notice has a "why?" view showing its five score inputs and how they combined, because a system that decides when to bother you should be able to explain itself. Two deliberate absences: the pane cannot create an open loop (loops come from evidence, so each traces back to why he believes it), and there is no plain delete on a notice — **dismissing is the feedback**, recorded per category over a 30-day window, so waving off Observatory runs raises the bar for Observatory runs and never silences deadlines. Full spec: `documentation/attention.md`

### Fixed
- **`sourceDescription` was set by three callers and read by nobody.** Automations, web chat, and (newly) watches all describe on the pseudo-interaction why the turn is happening, but `chatHandler` never passed it to the shared prompt builder, so the framing was silently dropped on every Discord-side unattended turn. It now rides the prompt pack as a `SITUATION:` block ahead of the behavioural contract. This was load-bearing for watches: a firing watch's description carries the evidence it woke up for, and without it the turn woke up only to report that it could not find the thing it was started to look at
- **Intermittent CI failures in `FedericoCarboni/setup-ffmpeg@v3` (`AssertionError [ERR_ASSERTION]: Failed to read version from readme`).** That action resolves "the latest release" by fetching and regex-parsing a readme from johnvansickle.com, so a bad minute on one third-party mirror turned CI red — flaky by construction, with nothing in the failing path under our control (upstream issue #35, plus `TypeError: fetch failed` reports in #26). It also ran on node20, which GitHub is removing from the runners, so it was heading for a hard break rather than an occasional one. CI now installs ffmpeg from a local composite action (`.github/actions/setup-ffmpeg`) that downloads a static build **directly** from two independent hosts — BtbN's GitHub release CDN first, johnvansickle as a fallback — and never touches a metadata endpoint. It locates the binaries by searching the extracted tree rather than assuming a tarball layout (the two hosts disagree, and neither promises one), retries only genuinely transient failures so a moved URL fails in a second instead of after five backoffs, and runs `ffmpeg -version` before accepting the result so a truncated download fails at the install step rather than much later inside a render test. apt stays off the table for the documented reason: `apt-get install ffmpeg` pulls ~80 media libraries and hung GitHub-hosted runners for 1–6 hours once the suite split into two jobs. ffmpeg is genuinely needed — it is absent from the runner image, and the Observatory render tests stitch real PNGs into an mp4
- **The Node 20 deprecation warning on every workflow run.** It comes from any node20-based action, so removing `setup-ffmpeg` was not enough: `actions/checkout@v4` and `actions/setup-node@v4` emit it too. Both are now `@v5` (node24 runtime) in the CI and companion-release workflows. `setup-node@v5`'s new automatic package-manager caching is a no-op here — `package.json` declares no `packageManager` field and both jobs pass `cache: npm` explicitly

## 2026-08-20

### Fixed
- **Spotify playlist downloads dying inside spotdl with `KeyError: 'ownerV2'` - and the bot then showing nothing at all.** Two stacked failures. Upstream: spotdl 4.5+ defaults to an anonymous scraping client (`SpotipyFree`) that Spotify's API changes broke for playlists (tracks and albums still work), and spotdl only honors provided credentials when `--use-official-api` is passed - a flag `spotdlService` never sent, so even a configured `spotify.clientId`/`clientSecret` was silently ignored. The service now detects the resolved spotdl version (the CLI resolver captures `--version` output) and appends `--use-official-api` on 4.5+ whenever credentials are configured, so playlist downloads go through the official Spotify Web API. Ours: on failure the service embedded spotdl's entire rich boxed traceback in the error, `editReply` blew Discord's 2000-character limit (`50035 BASE_TYPE_MAX_LENGTH`), and the user saw no reply at all. `SpotDLService.summarizeFailure` now produces a short, actionable message - the known playlist breakage gets a targeted explanation (pointing at `config.json` credentials when none are set), everything else keeps just the final exception line, and the full output stays in the logs. `ytdlpService` errors are bounded the same way, and `/spotdl`, `/play`, and `/playtrack` defensively truncate any error they relay (`musicUtils.truncateForDiscord`). New Jest spec: `spotdlService`
- **`/spotdl` and `/play` failing with a bare `spotdl CLI not found` on hosts where spotdl *is* installed.** The CLI auto-discovery in `spotdlService`/`ytdlpService` collapsed every probe failure into the same generic message, so the real cause — most commonly a `~/.local/goobster-venv` orphaned by an OS Python upgrade (its `spotdl` exits with `ModuleNotFoundError` instead of being missing) — was invisible. Discovery now runs through a shared `utils/cliResolver.js` that records *why* each candidate failed (not found, `EACCES`, non-zero exit plus the last stderr line, kill signal, or a 30s timeout so one wedged binary can't hang the command forever) and appends a `Tried: ...` diagnostic to the error the Discord reply shows, with the `config.json` `spotdl.path`/`ytdlp.path` override labeled explicitly. Both services also probe the Docker image venv (`/opt/venv/bin`) as a fallback. And the breakage self-heals on the Pi: `install-rpi.sh` rebuilds a venv whose `pip` no longer runs (`python3 -m venv --clear`, which a plain `venv` invocation does not repair), **including in `--update` mode** — previously auto-updates skipped the venv entirely, so a broken one stayed broken until someone rebuilt it by hand (a rebuild failure there warns instead of blocking the rest of the update). New Jest spec: `cliResolver`

## 2026-08-19

### Fixed
- **Updating an existing install died on `npm run db-init` with `no such column: scopeKey`.** `schema.sql` was applied before the migrations that reshape existing tables, so `CREATE INDEX idx_kg_nodes_scope ON kg_nodes(guildId, scopeKey)` ran against a `kg_nodes` that only gains `scopeKey` moments later — fatal on SQLite and on Postgres alike, and it left the rest of the schema half-applied. Both adapters now migrate the tables they find *first* and let `schema.sql` fill in whatever is still missing, so a fresh database and an upgraded one end up identical; the column pass repeats afterwards for columns that live only in `migrations.js` (`stock_symbols.impliedVol` and friends). The SQLite rebuild procedure was destructive too: renaming a table to `<table>_legacy` rewrote the `REFERENCES` clauses in `kg_node_tags` and `kg_artifacts` to point at it, and dropping it left them referencing nothing, so tagging a node or saving an attachment failed with `no such table: main.kg_nodes_legacy`. Rebuilds now stage the replacement under a temporary name with foreign keys and reference rewriting off, and a database already damaged is repaired on open. Postgres swaps the constraint in place instead of rebuilding at all — its rebuild could not drop `kg_nodes` once `kg_provenance` referenced it. New Jest spec: `dbSchemaUpgrade` (both engines, from both historical knowledge-graph shapes)

### Changed
- **Study (and Parlor) on a phone / PWA is no longer a 260px conversation column plus a sliver of chat.** The conversation library is a slide-over drawer behind a 💬 toggle (backdrop + Escape; opening ☰ closes it). The header keeps the model chip and a ⋯ menu so Thoughtful / incognito / share do not crowd the title. Same breakpoint as the house sidebar (720px), plus a container query so a tablet with the rooms sidebar already taking 260px also gets the drawer.
- **`/app` is the React portal.** After `npm run build:web`, the Vite client is served at `/app` (TanStack Router `basepath` `/app`). Bookmarks to `/app/next` 302 onto `/app`. `webapp.nextClient` defaults on; set it `false` to serve the leftover ES-module client. Share viewers (`/app/share/:token`, Observatory snapshots) stay on leftover HTML — `packages/core/web/app/` is not deleted. Config reports `nextClient` only when the build exists.
- **PWA scope moved with the flip.** Manifest `start_url`/`scope` are `/app/`; `sw.js` cache is `goobster-app-v1`, network-first for `/app/*`, never `/api/*` or share URLs. PNG icons (192/512/maskable/apple-touch) live in `apps/web/public/icons/`.
- **`/app/next` was rendering a hamburger and unstyled room chrome.** The React shell used `.pane-header` / `.pane-body` and a bare `☰` button — classes the design system never defined — so even a successful CSS load looked like unformatted text. Room headers now use the same `icon-action menu-btn` as `/app` (hidden on desktop), `.pane-header` / `.pane-body` are in `styles.css`, `index.html` links a stable `/app/next/style.css` so a stale hashed asset cannot blank the sheet, and both service workers skip caching the SPA document.
- **`npm run build:web` on Pi after `npm ci --omit=dev` failed with missing React types.** Vite and `@types/react` are dev-only; the build script no longer runs `tsc` (use `npm run typecheck:web` in dev/CI). `install-rpi.sh` now runs a full `npm ci`, `build:web`, then `npm prune --omit=dev` so auto-updates produce `apps/web/dist`.
- **Library Map on `/app/next` showed a blank panel.** The React graph used `className="graph-canvas"` but CSS only sized `#constellation-canvas` / `#graph-canvas`, and the map tab omitted the `mtab-graph` flex layout — the canvas never filled its container.
- **Observatory project cards on `/app/next` looked janky.** Clickable rows were `<button class="list-row">`, so the browser's default white button chrome stacked badly; they now match the legacy `<div role="button">` rows and sit inside `.obs-view`.
- **Player.log imports can pick decks and batch Scryfall lookups (#145).** The 1500-card hard cap is gone; unknown Arena ids resolve in polite batches with 429 backoff, and the import modal previews every deck so you choose which ones to bring in. Captured on this branch after the merge to main, including the React Decks room at `/app/next`.

### Added
- **Parlor Live audio on the React client.** `useParlorLive` + `parlorLiveSession` port the leftover worklet uplink, RMS VAD (threshold 300, 900ms silence, 55s cap, 2-chunk preroll), MSE/blob TTS queue, mute, and barge-in `stop-speech`. Typed say/nudge go through the live socket while a session is up. New Jest spec: `parlorLiveAudio`.
- **Phase 4 of the reactive port — the React portal client at `/app/next`.** `apps/web` is a React 19 + Vite + TypeScript SPA (TanStack Query + TanStack Router) that talks the same frozen `/api/app/*` contract as the legacy ES-module client. Rooms: Study, Home, Library, Tasks, Usage, Decks, Workshop, Exchange, Parlor, Observatory. Renderer modules (`markdown.js`, `highlight.js`, `math.js`, `graph.js`, `codeblocks.js`) port as-is behind thin wrappers — the applet iframe still never gets `allow-same-origin`. `GET /api/app/events` invalidates the `home` and `tasks` query caches. Chat/parlor SSE is POST + a fetch body reader (`apps/web/src/lib/parseSse.cjs`). Served only when `webapp.nextClient` is true and `npm run build:web` has produced `apps/web/dist`; `/app` stays the legacy client. Lite and api images multi-stage the Vite build. New Jest spec: `webNextClient` (SSE parser, flag on/off, unbuilt 404).

## 2026-08-18

### Added
- **Phase 3 of the reactive port — the Discord gateway seam and the api service.** Web-reachable core code no longer touches discord.js: it talks to a `DiscordGateway` (`packages/core/gateway`). The bot process wraps the live client in `LocalGateway`; a new `apps/api` process reaches Discord through `RemoteGateway` over the bot's `/internal/gateway/*` API (shared-secret `GOOBSTER_INTERNAL_TOKEN`, JSON snapshots only). Membership may cache for 60s; permission checks that gate writes never cache. Postgres is required for the split (two processes, one database); the lite profile still mounts the same portal routes in-process on SQLite. New `GET /api/app/events` SSE stream fans bot-side happenings (follow-up delivered, automation ran, agent run updated) across the process boundary via Postgres `LISTEN/NOTIFY` on `goobster_events` — ids and invalidation hints only, never content. With the bot down, DM-scoped portal surfaces keep working (bot identity falls back to `config.clientId`) and guild-scoped panes return 503 `BOT_OFFLINE` instead of crashing. Compose `full` profile lands at `deploy/docker-compose.yml` (postgres + bot + api + nginx; only nginx published). Standards-doc amendments (spec §14) are in `documentation/development_standards_and_project_goals.md`. New Jest spec: `gatewaySeam` (LocalGateway, RemoteGateway against the internal API, degraded `/me`, the event bus, `createApiApp`) plus `/api/app/events` coverage in `webAppApi`

## 2026-08-17

### Changed
- **The Observatory pane is now master-detail, and the portal is the one live view of a project**: the old pane crammed an expandable card *and* a separate 📊 dashboard page into two overlapping half-views of the same objects — jobs lived in both, output tails only in the dashboard, media in neither or both. The pane now opens a project into a single standardized **project view**: status chips + the disk-quota bar, the latest render inline, the job timeline **with stdout/stderr tails**, the current `checkpoint.json`, an image gallery, and the full file table, all fed by one standardized payload (`observatoryService.getProjectDetail` → `GET /api/app/observatory/projects/:slug` returns `{ project, jobs, files, totalFiles, checkpoint }`) and auto-refreshing every few seconds while a job runs. Every action lives there too: ✨ Command, 🎬 Render video, 📸 Snapshot page, 🔗 Share, ✕ Delete, per-job Cancel/Resume. The static dashboard artifact is repositioned as the **snapshot page** — the self-contained, downloadable/shareable export — instead of a competing second dashboard. `listJobs` grows an opt-in `includeTails` flag (the tool's compact `status` listing stays small), which also fixes the snapshot page's stdout/stderr `<details>` sections having always rendered empty: `buildDashboard` expected tails the old query never selected. New specs in `observatoryService` (project detail shape, tails opt-in, checkpoint truncation)
- **Defaults sized for real observational data**: three knobs whose "runs fine on a Pi" defaults predate the astro toolkit moved up — they are caps, not allocations, so disk and RAM are only spent on what actually gets stored. `observatory.maxProjectMb` 256 → **1024** (a project holding a few calibrated NIRCam cutouts blows a 256 MB shelf immediately), `sandbox.maxFetchMb` 64 → **512** (single MAST products routinely run 100–500 MB; a fetch is still additionally capped by the project's remaining quota), and `sandbox.maxWriteMb` 16 → **256** (`ulimit -f`; a reprojected mosaic or HDF5 frame cache passes 16 MB on day one, and the fork-bomb/disk guard is intact at 256 — its ceiling moves 12,800 → 25,600 to keep the documented 100× headroom invariant). Floors and clamping are unchanged; explicit config values win as always. `maxFetchMb`/`maxOverlayMb` join the clamp-spec coverage, with `maxFetchMb` deliberately exempt from the 100× rule — it is a download/SSRF guard whose ceiling sits at 4 GB on purpose

### Added
- **The exchange comes to the browser — a trading terminal in the portal**: `services/webExchangeService.js` was written as the browser façade over the stock game and the Jimbucks Exchange and then never mounted — no routes, no client methods, no pane — so the entire exchange was Discord-only. It is now wired end to end as a five-tab **Exchange** pane. **Portfolio** is the full account audit (`auditService.auditAccount`): equity, cash, buying power and exposure, margin state and liquidation levels when there is a loan, every position across stocks/shorts/options/perps with live marks and P/L, the risk flags, realized results per instrument, and the wallet-vs-ledger reconciliation that proves the books add up. **Trade** does symbol search, a live quote annotated with your own exposure to it, a daily-close chart (1mo–1y, the same dependency-free canvas approach as the usage chart), and market **buy / sell / short / cover** — sell and cover with the units box empty close the whole position, exactly like the slash commands. **Options** renders the calls-strike-puts ladder with greeks, IV, and ITM probability plus buy-to-open and sell-to-open per contract. **Orders** places limit, stop, stop-limit, and trailing-stop orders and cancels working ones (the risk engine still evaluates them on its 5-minute tick — this was never a continuous matching engine, and the UI says so). **Leaderboard** ranks the guild by **equity**, so a wallet full of borrowed points isn't a big account. The pane is **façade, never a second implementation**: every call verifies live guild membership through the bot client (`utils/webGuildAccess.requireGuildMember`, the Activity WS-join rule) and then delegates to the same `stockPortfolioService`/`shortService`/`optionsService`/`orderService` the commands call, so the feature gates, the margin requirements, and "all point movement goes through `economyService.adjust()`" hold for web trades by construction — the new `/api/app/exchange/*` routes add nothing but `requireAuth` and an `exchangeRoute` wrapper that translates domain errors (`ExchangeError`/`StockError`/`EconomyError`) into 400s carrying their own code and message while anything unexpected stays a 500 that leaks nothing. Because wallets and positions key on `guildId`, the pane is **guild-scoped, not DM-scoped**: it opens with a server picker (remembering your last choice), the DM scope never appears, and a user who shares no server with Goobster is told so instead of being shown an empty terminal. Feature-gated instruments are gated in the UI too — the Options tab doesn't exist unless the guild enabled options, and short/cover are disabled without margin. Deliberately **not** exposed to the web: the actions that change how much risk an account may take — margin account type, leverage, and Goblin Mode stay in `/margin`, mirroring the `confirm: true` rule on the equivalent chat tools. New Jest spec: `webExchangeService` (membership gate, feature gates, and the ledger invariant against a stubbed market) plus route-plumbing and error-translation coverage in `webAppApi` (33 new tests, 1655 total)
- **✨ Observatory custom commands — prompt the agent from mission control**: the portal's Observatory pane grows a toolbar **Command** button that takes free-form instructions ("continue the simulation for another 2,000 steps, then render at 60 fps") and runs them as a **full agent turn with the `observatory` tool** — the same `webChatService` machinery as the chat composer, so the per-user turn lock, Stop, rate limits, and tool gating all apply unchanged (`POST /api/app/observatory/command`, streamed back with the chat SSE vocabulary through the now-shared `streamWebChatTurn` helper). From a project view the command is scoped to that project (the prompt names it and its slug); from the list view Goobster may create projects. Tool activity chips and the agent's report stream into the pane while it works, and every command is filed into a dedicated `🔭 <project>` web conversation, so the transcript stays browsable — and continuable — from the Chat pane
- **The model can now ask for packages and data — and a human always holds the pen**: two new operator-approved request flows (`services/sandboxRequestService.js`, `sandbox_requests`/`sandbox_packages` tables) let chat extend the sandbox without ever letting it mutate the host. **Package requests** (`requestPythonPackages` tool): a pip **dry run** (`--only-binary=:all: --report`, `--isolated`, index hard-pinned to PyPI) resolves the exact transitive set — every package, version, and sha256 — while executing nothing; the configured approvers get that set as a DM with Approve/Deny buttons, and approval installs **exactly what they saw** (`--require-hashes --no-deps`) into a new overlay at `data/sandbox/overlay` (a `pip --target` dir joined to runs via `PYTHONPATH` — the curated venv is never touched, rollback is one `rm -rf`, budget `sandbox.maxOverlayMb`). Wheels-only means no `setup.py` ever runs on the host; a strict spec grammar (`name`, `name==1.2.3`, `name:import_name`) means a request can't smuggle a pip flag, git URL, or path. Installs are recorded hash-pinned in `sandbox_packages`, advertised to the model immediately (probe cache invalidation, no restart), and rebuilt byte-for-byte by `npm run sandbox-python`. **Data fetches** (`observatory` tool, new `fetch-data` action): sandbox runs still have **no network**; instead the host downloads a proposed https URL into the project workspace `data/` dir through a new SSRF-hardened helper (`utils/safeFetch.js`) — DNS resolved once with **every** answer required publicly routable (loopback, RFC1918, link-local/metadata, CGNAT, NAT64/mapped forms all refused) and the connection pinned to the checked address, redirects refused outright, received-bytes cap (`sandbox.maxFetchMb` ∧ remaining project quota), sanitized basenames, no overwrites. Hosts on `sandbox.fetchAllowedHosts` carry standing consent and fetch immediately; anything else waits for an approver. **Approval is operator-level by design** (`sandbox.approverUserIds`, asked by DM, 12 h TTL, SQLite-persisted so pending requests survive restarts): these are host mutations shared by every guild, so Manage Server is deliberately not sufficient — and with nothing configured both features are simply off (the request tool isn't even offered). Requesters are DMed the outcome; resolved rows are the audit trail; `/forget-me` deletes a user's requests and anonymizes package attribution. New Jest specs: `safeFetch`, `sandboxRequests`, `sandboxRequestTool` (87 new tests, 1619 total)
- **The sandbox toolkit grows an astronomy bench — real datasets, not just simulations**: the Observatory could model a nebula but not *read* one, because the curated venv stopped at numpy/scipy/matplotlib/pandas/pillow/sympy/networkx — no FITS reader, no WCS, no cosmology calculator, so an expedition through published JWST products meant hand-parsing binary headers. The toolkit is now a **catalog of bundles** in `config/sandboxPackages.js` — `core` (the previous seven), **`astro`** (astropy, photutils, specutils, reproject: FITS/WCS/units/cosmology, source detection and aperture photometry, spectrum objects and line fitting, multi-filter reprojection), and **`imaging`** (scikit-image, imageio, h5py) — and `npm run sandbox-python` installs all of it by default, one pip invocation per bundle so a group that fails to build doesn't cost you the others. That catalog is the **single source of truth**: the installer and the sandbox probe read the same entries (each declaring its pip name *and* its import name), so the "keep these two lists in sync" comment is gone and `astropy` shows up in the `runCode`/`observatory` availability note the moment it is importable. Hosts that don't want ~700 MB of wheels pin a subset (`npm run sandbox-python -- --bundles core`, or `sandbox.pythonBundles`) — `core` is always included, and an unknown bundle name is a loud error instead of a quietly smaller toolkit; hosts that want *more* name it in `sandbox.extraPythonPackages` (`emcee`, or `pyyaml:yaml` when pip and import names differ), which is installed beside the bundles and probed like everything else, so operator extras finally reach the model instead of needing a personality directive. Extras are validated against a package-name pattern — a config value can never arrive at pip as a flag. `astroquery` and the `jwst` calibration pipeline stay out on purpose (one needs network, the other is GB-scale with CRDS downloads); sandbox runs still have no network, so real data reaches an expedition through the project workspace. The whole toolkit imported at once fits inside the default 2 GB `ulimit -v` (~230 MB RSS, ~2 s), so no limits moved. New Jest spec: `sandboxPackages` (+ extras coverage in `sandboxPython` — 16 new tests, 1532 total)

## 2026-08-16

### Fixed
- **Sandbox timeouts are reported honestly when SIGTERM isn't enough**: coreutils `timeout -k` escalates to SIGKILL when the snippet survives the polite TERM, and the KILL can take out the whole process group — `timeout` included — so the run ended with `signal: SIGKILL` instead of exit 124 and `timedOut` came back `false` (the flaky `wall-clock timeout` CI failure on runners without namespace isolation). Any kill-shaped death at/after the wall-clock budget now counts as a timeout (guarded by elapsed time, so an early OOM kill or a caller abort is never mislabeled). New spec: a TERM-ignoring snippet is still reported as timed out
- **A successful automation run can't be misreported as a failure**: `markRan`'s failure-streak bookkeeping (reading `metadata` to clear the notified flag) now degrades to a logged warning if it throws, instead of tripping the run's catch block and pinging the owner about a run that actually succeeded
- **Automations can finally reach the Observatory (and the sandbox) they were created to drive**: `runCode` and `observatory` default to web-only scope, and an automation run is a Discord-delivered pseudo-interaction — so the overnight "advance the simulation every hour" automation was silently refused its own tools on every fire and could only reply "I'm having trouble with this request". Unattended automation turns (`interaction.isAutomation`) now count as a **trusted surface** in both the tool-offer filter (`toolsRegistry.getDefinitions`) and the per-call execute gates: the prompt was authored through an already-gated surface, so its runs get the same tool set. New spec assertions in `toolsRegistryRunCode`/`toolsRegistryObservatory`
- **Checkpointed Observatory jobs auto-resume after a restart**: a deploy or crash reaped `RUNNING` jobs to `INTERRUPTED` and then waited for a manual resume nobody knew to issue — the lab froze overnight with no progress and no message. On startup (client ready) `observatoryService.autoResumeInterrupted` now restarts every `INTERRUPTED` job that left a `checkpoint.json`, respecting the per-user active-job cap and without consuming the timeout-resume budget; jobs without a checkpoint stay put for a manual resume
- **An automation run can no longer create more automations**: `manageAutomations` `create` is refused on automation turns. A prompt phrased "check the lab every hour" replayed the scheduling guidance every fire and could spawn sibling automations (variant names dodge the duplicate check) until the 10-per-scope cap — a runaway multiplication of unattended model calls. The run is told it IS the schedule and to do the task instead. New spec in `manageAutomationsTool`
- **A stalled provider stream can no longer lock the web portal until the next restart**: the per-user turn lock was only released when the turn settled, and a hung stream never settles — every later message got 409 `TURN_IN_FLIGHT` forever ("not responding to any messages"). Each turn now carries a real `AbortController` whose signal is plumbed through `chatOptions.signal` into the provider request/stream (OpenAI SDK per-request `signal`; Anthropic/Gemini `fetch` `signal`), Stop hard-cancels the in-flight network call instead of waiting for a round boundary, and a **15-minute watchdog** (`_liveTurn`) force-aborts and evicts a wedged turn so the lock frees itself. Deliberately-aborted turns end quietly instead of apologizing. New spec: `webChatTurnWatchdog`
- **Cron schedules are evaluated in UTC everywhere** — the tool descriptions, portal, and docs all promise UTC, but every `nextRun` computation parsed in the server's local timezone (even the wheel's "13:30 UTC" dedication fired at 13:30 *local*). All `CronExpressionParser.parse` calls that compute a fire time now pass `{ tz: 'UTC' }` (claim, manager services, `/automation`, `/digest`, `/wheel`, `/wrapped`, portal toggle). Hosts running on UTC (the common case) see no change
- **Failing automations are disabled or reported instead of silently eating the night**: a row whose cron no longer parses is disabled with a notice to its channel (previously it was re-scanned and re-failed every minute forever), and a run that throws now notifies the owner's channel **once per failure streak** (`metadata.failureNotified`, re-armed by the next success) — so quota exhaustion, a dead channel, or a provider outage is visible in the morning instead of indistinguishable from "nothing scheduled". The poll loop also stops waiting on any single run after 15 minutes (`executionWaitMs`) — the claim already advanced `nextRun`, so the straggler finishes in the background un-reclaimable while every other automation stays on schedule. New specs in `automationDurability`

### Added
- **Durable automations from chat — recurring work routes to the Automations system**: the assistant's only scheduling tool used to be one-shot `scheduleFollowUp`, so a recurring request (the hourly neurogene-lab workflow) degenerated into chained follow-ups. A new `manageAutomations` tool (create/list/pause/resume/cancel by name, backed by `services/automationManagerService`) creates real `automations` rows from conversation — guild channels get guild automations posting there; Discord DMs and the web portal get DM-scope rows delivered to the user's Discord DMs — executed by the existing `automationService` poll loop, never a parallel executor. Validation is shared with the portal (5-part cron, 15-minute floor, 10-per-scope cap, duplicate names). **Execution is now claim-before-run**: `nextRun` advances atomically while the row is still due, so each scheduled fire runs at most once — a restart or replayed due list never double-runs, and a failed run waits for its next fire instead of retrying every poll. The follow-up/automation boundary is stated everywhere the model looks (both tool descriptions + shared scheduling guidance in `toolPromptBuilder`): recurring *work* (tools run each time) → automations; reminders (one-time, or a repeating note) → follow-ups; never chained one-shots. Docs corrected (`/automation` never required the owner to be online). New Jest specs: `automationManagerService`, `automationDurability`, `manageAutomationsTool`
- **Recurring follow-ups — "check in on the lab every hour" now means every hour**: the follow-up scheduler was strictly one-shot (delivery marked the row DONE; watching a long-running Observatory job like neurogene-lab meant manually re-scheduling after every check-in). `scheduleFollowUp` grows an optional `repeat` parameter ("every hour", "every 2 hours", "daily", "weekly" — parsed deterministically, no model call; 15-minute floor matching the automation cron guardrail, one-year ceiling; `when` becomes optional for recurring and defaults the first delivery to one interval out). Recurring rows carry clear metadata (`followups.recurMinutes` + a human `recurrence` label, `deliveryCount`, `lastDeliveredAt` — added via `applyColumnMigrations` for existing databases) and **stay PENDING**: each delivery atomically advances `dueAt` to the next occurrence strictly in the future, guarded on status AND the exact dueAt being delivered so a duplicate pass is a no-op, and occurrences missed while the bot was down collapse into one catch-up message — restart-safe by construction, no delivery bursts. The heartbeat's minute loop gains a re-entrancy guard (a slow phrasing call can no longer overlap the next tick and double-deliver — one-shots benefit too), a failed send still stays PENDING at the same dueAt and retries next minute, and the portal Tasks pane shows recurring reminders with their cadence, next fire, and delivery count — cancelling one ends the whole series through the same PENDING-gated cancel. One-time follow-ups, the Observatory's due-now completion notifications, and the cron `automations` system are untouched. New Jest specs: `followupService`, `toolsRegistryFollowup` (+ portal coverage in `webTaskService` — 26 new tests, 1466 total)
- **Observatory results dashboards — the artifact at the end of every run**: the final step of each project run (foreground or background job) now regenerates a **self-contained HTML dashboard** (`services/observatoryDashboard.js`) — job timeline with statuses/segments/resumes/errors and stdout tails, the latest render playing inline, an image gallery, the current checkpoint, a workspace file table, and quota usage, with media inlined as size-capped base64 so the single file can be explored, downloaded, or forwarded as-is. **Live for the owner**: the 📊 Dashboard button on each portal project card opens it served fresh (`/api/app/observatory/projects/:slug/dashboard`), where an auth probe reveals working control buttons — per-job Cancel/Resume, Render frames to video, Refresh — wired to the normal Observatory routes. **Shareable**: 🔗 Share mints one revocable read-only link per project (`observatory_share_links`, the unguessable-token pattern from chat sharing; `/app/observatory/share/<token>`, no sign-in), regenerated on view so it always shows current state — and inert controls, since the owner-session probe fails for viewers. Security posture: the dashboard is authored ONLY by deterministic server code, stored **outside** the snippet-writable workspace, fully escaped, and pinned by a strict CSP — a run writing its own `dashboard.html` gets listed like any file, never served as the trusted page. A new `dashboard` tool action attaches the artifact in chat; share links join the transparency report, `/forget-me`, and the audit. New specs in `observatoryService`/`toolsRegistryObservatory` (8 more tests, 1440 total)
- **A real Python toolset for the sandbox and the Observatory** — "fairly simple simulations" kept dying on `ModuleNotFoundError` because the sandbox defaulted to a bare system `python3`. Three layers fix it: **(1)** `npm run sandbox-python` installs a curated simulation toolkit (numpy, scipy, matplotlib, pandas, pillow, sympy, networkx — all ARM64-wheeled, Pi-friendly) into a managed venv at `data/sandbox/venv`; **(2)** the sandbox **auto-detects** that venv as its default interpreter (an explicit `GOOBSTER_SANDBOX_PYTHON`/`sandbox.pythonCommand` still always wins); **(3)** the sandbox **probes once** which curated modules the configured interpreter can actually import (`find_spec`, nothing gets imported) and tells the model — the `runCode`/`observatory` tool descriptions now carry an honest "you may import the standard library plus exactly: …" note (or "standard library ONLY" on a bare host), and a python run that still fails on a missing import gets the same note appended to its result, so the retry is written against packages that exist. User site-packages remain invisible by design (`PYTHONNOUSERSITE=1`); the venv is the sanctioned way to grow the toolset. New Jest spec: `sandboxPython` (9 tests, 1432 total)

## 2026-08-15

### Added
- **🔭 The Observatory — persistent, long-running simulation projects** (`documentation/observatory.md`): the code sandbox grows a lifecycle. Named per-user **projects** give every run a durable workspace (`data/sandbox/projects/<userId>/<slug>/`, mode `0700`, per-user cap + per-project disk quota) bind-mounted read-write beside the throwaway run dir and exposed as `$GOOBSTER_PROJECT_DIR` — source files, checkpoints, and outputs finally survive between runs. **Background jobs** (`run` with `background: true`) detach from the chat turn and run as *segments*, each a fully legalized sandbox run holding a concurrency slot honestly; a segment killed at the timeout wall is **resumed from the job's own `checkpoint.json`** (a documented convention, not magic) up to a clamped resume budget — "one 3-hour run" becomes many short legal runs. Jobs survive restarts as SQLite rows (orphans are reaped to `INTERRUPTED`, resumable from their checkpoint), can be cancelled mid-segment, and **notify the user in their Discord DMs** through the existing follow-up machinery when they finish. Numbered frames in `frames/` are **stitched into an mp4 automatically** via system ffmpeg (or on demand with `render`, missing ffmpeg degrades gracefully). New `observatory` tool (web-scope by default, never in voice, not registered unless the Observatory AND the sandbox are enabled — it grants persistence, never new execution powers), new 🔭 portal pane (project list, live job status, cancel/resume, workspace file browser, inline video playback), config block with every knob clamped floor/ceiling (`GOOBSTER_OBSERVATORY_ENABLED` switch), and full privacy coverage: `/what-do-you-know-about-me` reports projects/jobs, `/forget-me` erases rows AND the on-disk workspace tree, `auditUser` counts both. New Jest specs: `observatoryConfig`, `observatoryService`, `toolsRegistryObservatory` (+ runCode file-delivery coverage — 71 new tests, 1423 total)

### Fixed
- **`runCode` now attaches EVERY produced file to the chat, not just images**: non-image outputs (an exported Markdown spec, a CSV, a JSON dump) were listed in the run summary but never delivered — the tool filtered `result.files` down to images before sending, so "the file is attached above" was a lie in both Discord and the web portal. All produced files are now sent via `channel.send` (images still render inline; the rest arrive as downloadable attachments) and recorded on `generatedFiles`, so the portal persists and re-serves them through the owner-bound files route
- **A Node-side sandbox kill now takes out the whole process tree**: aborting or backstop-killing a run only signalled the outer `timeout` process, so snippet descendants (e.g. a sleeping child) survived, kept the stdio pipes open, and the run refused to settle until the orphan exited on its own. Sandbox children now spawn detached (own process group) and kills signal the group
- **`/exchange reconcile` reads the clock it was given**: the settlement invariants (`unsettled-expiries`, `unsettled-markets`) compared against SQLite's `date('now')` instead of the auditor's `now`, so a fixed-clock caller got a moving answer — and the "a healthy exchange passes every check" spec started failing the day its fixture's event contract came due. `reconcile({ guildId, now })` now threads the clock like `auditAccount`/`auditGuild` do (unchanged for live callers, which still default to the real clock). New spec: an event contract left past its resolution time
- **The portal's mobile chat header no longer overlaps itself**: the header actions could not shrink, so on a phone they squeezed the title row to zero width and the model chip rendered on top of the ☰ drawer button (fully hiding it at 390px and narrower, with the page scrolling sideways as well). The actions now yield width and the model chip's label ellipsizes, and the title row can never shrink below the hamburger

### Changed
- **A real logo for the portal**: the blueberry emoji and the AI-cartoon app icon are gone, replaced by a hand-authored vector mark (`web/app/icons/goobster.svg`) — a gradient berry with its calyx crown, no face, legible at 16px. It is now the favicon, the sidebar/login/empty-state logo, and the source the PWA icons render from. **Installed shortcuts stop showing a dark grey square**: the `any` icons (192/512) are transparent, so the launcher rounds the berry itself, with a full-bleed brand plate kept only where opacity is required — the Android maskable icon (mark inside the 80% safe circle) and the iOS apple-touch icon
- **Phone-sized portal headers get a ⋯ menu**: below 720px the chat header keeps the drawer button, the conversation title, and the model chip, and moves Thoughtful, incognito, share, integrations, and export into a labelled dropdown (Escape / outside tap / picking an action closes it). The desktop header is unchanged — the same buttons stay inline

## 2026-08-13

### Added
- **Parlor Live — real-time voice sessions in the Parlor**: a 🎙️ Go Live button on any discussion opens a voice session where you talk to the cast out loud. Speech streams into ElevenLabs Scribe realtime STT while you talk (RMS energy gate first, batch STT fallback on realtime failure), committed utterances run as **normal parlor turns** (gate → retrieve → generate → write back, same turn lock and rate limits), and every persona answers aloud **in its own ElevenLabs voice**, streamed down tagged with the persona so the UI shows who is talking. Multiple humans in a shared discussion can join the same session by voice; typed messages (and other members' SSE turns) are voiced too. Solo sessions support barge-in — start talking and the persona stops. New service `services/parlorLiveService.js` + `WS /api/app/parlor/live` (cookie-authenticated before the upgrade); sessions are capped at 45 minutes with join rate limits; no ElevenLabs key simply hides the button
- **Per-persona voices**: `parlor_personas.voiceId`, set from a voice picker in the persona modal (fed by the ElevenLabs voice library) or by Goobster via `manageParlor` — resolved at save time so a bad name fails in the editor, never mid-session. Personas without a voice get a stable default from a premade pool keyed by persona id, so a fresh cast sounds distinct out of the box. New Jest spec: `parlorLiveService` (27 tests, 1351 total)
- **Voice in the web portal**: a 🎤 mic button in the composer dictates messages (batch speech-to-text: OpenAI transcription first, ElevenLabs Scribe fallback), and a 🔊 Listen action on every reply reads it aloud through the same ElevenLabs voice `/setvoice` configures — code blocks, math, and URLs are cleaned out of the audio, and without keys the buttons simply never render. New service `services/webVoiceService.js`; nothing is persisted
- **Message branching**: editing an earlier web-chat message now offers **⑂ Branch** beside Save & resend — the history before that message is copied into a fresh conversation (lineage recorded, ⑂ badge in the sidebar) and the edit continues there, while the original conversation stays fully intact
- **Read-only conversation sharing**: one revocable share link per conversation (`/app/share/<token>`), viewable by anyone without signing in. The public payload is text only — no owner identifiers, no attachment URLs, and never any other conversation; revoking (or deleting the conversation, or `/forget-me`) kills the URL instantly
- **Scheduled tasks in the portal**: a Tasks pane lists, creates, pauses, and cancels recurring agent prompts (`automations`, cron with a 15-minute floor) and one-shot reminders (`followups`). Portal-created tasks live in the DM scope and deliver to your Discord DMs; DM-scope automations run through the normal chat pipeline as unattended agent turns. `/automation` and `/privacy` (status/retention) now work in DMs for parity
- **Personal usage dashboard**: a Usage pane with your own AI calls and token volume — totals, a tokens-per-day chart, and per-model/per-operation breakdowns from `usage_log` (token counts only; no invented prices)
- **Memory retention from the portal**: the Memory overview (DM scope) sets the auto-delete window for your DM/web-chat memories with an immediate purge, mirroring `/privacy retention`
- **PWA**: the portal is installable on desktop and mobile (manifest, blueberry icon set, and a network-first service worker that never touches `/api/*`)
- **Accessibility pass**: a shared focus-trapping modal helper behind every dialog (Escape, backdrop click, focus restore), aria labels on icon buttons, keyboard-activatable sidebar rows, a live-region toast, visible focus outlines, and `prefers-reduced-motion` support
- Privacy: `automations` (a pre-existing gap), `web_share_links`, and the DM scope's `guild_settings` row are now covered by `/what-do-you-know-about-me`, `/forget-me`, and `auditUser`. New Jest specs: `webVoiceService`, `webChatBranchShare`, `webTaskService`, `webDashboardUsageRetention` (1324 tests total)

### Fixed
- `chunkMessage` no longer hangs forever on text over 1900 characters with no spaces (a `lastIndexOf(' ') === -1` treated as truthy) — long unbroken tokens now hard-split at the limit

## 2026-08-06

### Changed
- **The code sandbox can now be configured for real work**: every numeric ceiling in `config/sandboxConfig.js` moved up two orders of magnitude, so an operator on a capable host can allow long simulations, large datasets, and batches of plots without patching code — `timeoutMs` up to ~3.3h, `maxCpuSeconds` to 6000, `maxMemoryMb` to 400GB of address space, `maxWriteMb` to 12.8GB, `maxOutputBytes` to 100MB, `maxOutputFiles` to 2500, `maxFileSizeBytes` to 6.4GB, `runsPerWindow` to 10000, `maxConcurrent` to 400, and `retentionHours` to 700 days. **The defaults are unchanged** (still the conservative "runs fine on a Pi" numbers), and clamping is unchanged in kind: an out-of-range value lands on the nearest bound, so a config typo still cannot remove a guardrail. Defaults, ceilings, and the consequences of raising one are documented in `documentation/code_sandbox.md`

### Fixed
- A sandbox knob explicitly set to `null` (or `""`) in `config.json` no longer resolves to the *tightest* possible limit — `Number(null)` is `0`, which clamped up to the floor and gave, for example, a 1-second timeout. Unset now means unset: the default applies. New Jest spec: `sandboxConfig`

## 2026-07-29

### Added
- **Option writing and multi-leg spreads**: `/options write` sells to open (premium collected up front, margin account required, requirement enforced before the fill — naked 20% rule, strike width in a spread, zero when covered by shares) and `/options buyback` closes it; assignment at the bell pays the intrinsic value, borrowed onto the margin loan when the wallet cannot. `/options spread` takes a compact leg list (`"buy 100p, sell 76p, buy 130c, sell 155c"`), answers with a **pre-trade receipt** — every leg's debit/credit, net, max gain/loss, break-evens, collateral, simulated-pricing timestamp, 0DTE warning — and only executes with `fire:true`; debit legs fill first and a failed leg unwinds the rest, so a spread never half-exists. The payoff analysis is exact for any structure and honest about unbounded wings; inverse iron condors are recognized by name
- **Perpetual futures** (`/futures`, off by default): isolated-margin leveraged longs and shorts on any USD symbol, crypto pairs included. The posted margin is the whole maximum loss, funding rent erodes it daily, and the engine liquidates when the mark crosses the liquidation price shown on the ticket
- **Real corporate actions**: dividends and splits from the same keyless feed that prices everything. Longs get paid, shorts owe the dividend (onto the loan if the wallet can't), and splits adjust units, strikes, premiums, order prices, and event-contract thresholds without moving a single point of value. History observed on a symbol's first sweep is recorded without being applied — back-paying it would invent money
- **Group-play opt-ins with an override-all default** (`/wheel optin|optout|override`): a per-member registry where an explicit opt-out ALWAYS wins, and a guild-level override — **on by default** — that counts everyone with a wallet as opted in until they say otherwise. Personal allocation caps bound what any single event may deploy; every consent change is in the audit log
- **The Daily Ballistic Goblin Wheel** (`/wheel spin`, `/wheel schedule` for weekdays at 13:30 UTC — 9:30 AM Eastern): Wheel 1 picks the strike target (80%: +1–5%, 19%: +6–10%, 1%: the sacred +20% moonshot), Wheel 2 picks the wallet percentage (50/30/15/4/1 for 5/10/20/35/50%), and the exchange buys the nearest listed call at spot×(1+target%) for every participant — same-day expiry when the guild allows it, with participation standing in for the personal Goblin Mode flag. All of it lands in the event log with both rolls
- New tools `tradeSpread` (receipt first, fire only after an explicit yes), `tradePerp`, and `goblinWheel` (spinning needs Manage Server AND confirmation); `tradeOption` gains write/buyback — all voice-reachable. Privacy: `perp_positions` and `exchange_optins` join the `/forget-me` erasure, the transparency report, and the audit. 60 new tests (1007 total)
- **The Jimbucks Exchange** (`documentation/jimbucks_exchange.md`, `services/exchange/`): the point economy grew a risk desk. **Margin accounts** (`/margin`) with leverage tiers, continuously accrued interest that capitalizes into the loan instead of overdrawing a wallet, buying power, per-position **liquidation prices**, margin calls with a grace period, and force-liquidation that sells largest-exposure-first and sweeps the proceeds into the loan. **Short selling** (`/stocks short|cover`) with borrow fees. **Options** (`/options`) — long calls and puts with full greeks, break-even, probability-in-the-money and probability-of-profit, option chains across a strike ladder, index aliases so `SPX` just works, and cash settlement at expiry. **Resting orders** (`/orders`) — limit, stop, stop-limit, and trailing stop, filling through the ordinary trade path and explaining themselves when they cannot. **Binary event contracts** (`/predict`) — "Will RKLB close above $60 by Friday?", priced as the risk-neutral probability of the event and settled deterministically from the real price, with per-trader caps so one whale cannot own an outcome. Everything is **off until an admin enables it** (`/exchange settings`), and the plain cash stock game is unchanged for servers that never opt in
- **0DTE behind two deliberate switches**: same-day contracts need the server's `zero_dte` setting *and* the trader's own **Goblin Mode** (`/margin goblin`), because the most likely value of one at the bell is zero. Every same-day purchase still shows the max loss, the break-even, and the odds before it fills — an intentional nuke, never an accidental one
- **Auditing as a feature, not a debug tool** (`/exchange audit|account|leaderboard|events|reconcile`, and the `auditAccount`/`auditExchange` tools in chat *and* voice): Goobster can audit **any member** — resolved by mention, id, username, or display name — and report every position with live greeks, leverage, buying power, liquidation levels, realized P/L, risk flags, and whether their wallet reconciles with the ledger. Server-wide he reports money supply, outstanding loans, most-held and most-shorted symbols, option open interest (including what expires today), the equity leaderboard, and concentration. `/exchange reconcile` runs nine invariants that prove the books add up
- **The risk engine** (`services/exchange/riskEngine.js`, 5-minute tick): accrues interest and borrow fees, settles expired contracts and due event markets, fills resting orders, and marks every account for margin calls and liquidation — recording *why* in a new `exchange_events` log beside the *what* in the point ledger. A missing price defers everything: the exchange never liquidates, settles, or expires a position on a feed outage
- Premiums are **simulated and labelled as such everywhere**: Black-Scholes on the real underlying, volatility estimated from three months of real closes, with a front-week term bump and a house spread (one vol per expiry - premiums stay provably monotonic in strike, so no vertical arbitrage). There is no keyless real option feed, so the game says what it is doing rather than pretending
- Privacy: every exchange table is deleted outright by `/forget-me` (a market you created survives with your name removed), reported by `/what-do-you-know-about-me`, and counted by `auditUser`. New Jest specs: `exchangeOptionsMath`, `exchangeMargin`, `exchangeOptions`, `exchangeOrders`, `exchangePredictions`, `exchangeAudit`, `exchangePrivacy`, `toolsRegistryExchange`

## 2026-07-28

### Fixed
- **GBA agent Ollama model ergonomics**: the agent now probes the model's capabilities (`/api/show`) on the first turn — a model without `vision` earns a loud warning (it cannot see the screen), and thinking-family models (qwen3 etc.) get hidden thinking disabled automatically, fixing the `Ollama returned an empty response` failure where the whole reply landed in `message.thinking` (new `--think` flag re-enables it). When a reply still comes back all-thinking, the error says so instead of "empty response". The sync-mode fallback log now tells the operator exactly what to do (`reload the updated goobster-gba.lua in mGBA`), and a second Ctrl+C force-quits the agent instead of logging twice

### Added
- **Goobster Plays Pokémon — Phase 2.x, sync mode**: the game now freezes while Goobster thinks. New bridge verbs `hold`/`release` — `goobster-gba.lua` traps the emulation thread inside its frame callback (mGBA's scripting API cannot pause the frontend, so the script blocks its own frame loop and polls sockets manually), while screenshots, RAM reads, and save states keep working against the frozen state. The agent holds before every screenshot, so the frame the model deliberates over is exactly the frame its buttons land on — no staleness, however slow the model. The first press/wait resumes the game implicitly, every other exit releases explicitly, and holds self-expire (default 120s) or release when the client disconnects, so a crashed agent can never leave the emulator frozen. On by default (`--no-sync` opts out); older bridge scripts fail the first hold gracefully and the run falls back to the fresh-frame guard. Bonus fix: after a stuck-checkpoint reload the agent now re-renders and recaptures, so the model decides from the restored screen instead of the stale stuck one
- **Goobster Plays Pokémon — Phase 2.x, the fresh-frame guard**: the game keeps running while the model thinks (mGBA's scripting API cannot pause the frontend), which caused stale-screen confusion and ping-ponging. The agent now recaptures the screen right before pressing and compares it with the frame the model saw: drastic drift (battle intro, warp, transition) HOLDS the buttons and tells the model to re-decide from the fresh screenshot; a `WAIT` whose reason already resolved while thinking is skipped outright — no more turns spent waiting for text that finished seconds ago. Dialog guidance corrected for FireRed: the blinking arrow is NOT always shown and pressing A in conversations is always safe (it fast-forwards printing text, then advances) — WAIT is for animations and transitions only. The system prompt now teaches the model its own latency, and RAM ground truth gains a ping-pong detector (an A-B-A-B position trail earns "you keep reversing your own moves - pick ONE direction")
- **Goobster Plays Pokémon — Phase 2.x, the experience book**: the agent now learns from its own play across sessions (`clients/gba-mcp/lib/experience.js`, on by default, `--no-learn` opts out). The model banks durable, verified game nuances through an optional `"learn"` field in its decision JSON — deterministic code legalizes each one (trimmed, capped, deduplicated so repeats *reinforce* instead of duplicate, least-reinforced evicted first) and injects them into every future session's system prompt ("LESSONS FROM YOUR PAST SESSIONS"). The harness learns on its own too: per-tile wall bumps become known-blocked directions once seen twice, the explored-tile map now spans sessions, and achieved milestones are remembered as "PROGRESS ALREADY MADE" so an old badge is never re-announced. New lessons reshape the prompt on the very next turn, not just the next run; everything persists per game in `goobster-gba-experience.json` (atomic writes, corrupt files degrade to a fresh in-memory book). New Jest spec: `gbaExperience`

## 2026-07-27

### Added
- **Goobster Plays Pokémon — Phase 2.x, grounded play**: the agent can finally tell whether it actually moved. New `--allow-memory` (operator opt-in, per the design rules) reads the sanctioned ground-truth set from the emulator each turn — player coordinates, map id, and the in-battle flag (`clients/gba-mcp/lib/gameState.js`, pret-decomp addresses for FireRed/LeafGreen/Emerald, DMA-safe, degrading to vision-only on any failure) — and feeds a deterministic `GROUND TRUTH` block into every prompt: what the last actions really did ("you moved 2 tiles RIGHT" / "your position did NOT change — a wall is blocking you"), battle start/end transitions, same-tile streaks, and explored-map memory (never-visited adjacent directions drive systematic exploration instead of corridor-pacing). The system prompt now teaches overworld tile movement (turn-then-step, wall bumps, walk-into doors) and battle-menu play; `hints/pokemon-firered.txt` grew the early-game critical path (starter through the first two badges — the "mostly-hardcoded goal graph" in hint form); and `--reasoning minimal|low|medium|high` turns on OpenAI model reasoning per decision. New Jest spec: `gbaGameState`
- **Goobster Plays Pokémon — Phase 3, the show**: the broadcast channel is now part of the run. **Advice inbox** — plain messages in the bound channel are captured as audience advice (📨 ack), forwarded into the playing agent's prompt with attribution, and credited in commentary when they pay off (mentioning Goobster still reaches normal chat). **Live status embed** — one message per guild, edited in place (coalesced) with the current screenshot, turn, objective, and stats; flips to ⏸️ paused/session-over when the harness disconnects, keeping the last known state. **Milestone events** — the agent's milestones post as gold embeds and are recorded in `gba_run_milestones` (surfaced by `/gbarun status`, review-passed by `/forget-me`, and the future settlement source for Phase 4 betting)
- **Agent menu-competence fixes**: the system prompt now teaches cursor mechanics (D-pad moves the highlight, A confirms what's highlighted NOW), demotes SELECT (it does not mean "select the option"), and covers name-entry screens; actions rejected by legalization are reported back in the next prompt instead of vanishing silently, and turns whose presses changed nothing on screen get annotated in the rolling history. New `--hints`/`--hints-file` appends operator game notes to the system prompt (`hints/pokemon-firered.txt` ships ready to use)
- **Goobster Plays Pokémon — Phase 2, the autonomous player** (`clients/gba-mcp/agent.js`): a vision model now actually plays. Each turn it sees the mGBA screen and answers ONLY JSON (observation, running objective, actions, optional table talk); deterministic code legalizes every button before it reaches the emulator, unusable answers degrade to watching, and a stuck screen escalates from prompt warnings to a watchdog checkpoint reload. Brains: local Ollama multimodal models (default `qwen2.5vl:7b` — the spare-gaming-laptop deployment) or OpenAI (`--provider openai`) as a quality ceiling. Screenshots and in-character commentary stream into Discord through the Phase 1 pipe (milestones immediately, heartbeats on a cadence). Windows 10/11 laptop setup guide in `clients/gba-mcp/README.md`. Verified live: real vision driving mGBA to a spatial goal and narrating it into a real guild. New Jest spec: `gbaAgent`
- **Goobster Plays Pokémon — Phase 1, the broadcast pipe** (`/gbarun`, `services/gbaRunService.js`, `clients/gba-mcp/run-driver.js`): a run harness on the machine running mGBA now streams the game into Discord. `/gbarun link` (Manage Server) binds the harness to a broadcast channel with a single-use pairing code; the zero-dependency run driver executes **playbooks** (validated JSON scripts of press/wait/post/save/load steps) against the local emulator bridge and posts screenshots + captions through Goobster, rate-limited server-side so a runaway script can never flood a channel. Opt-in via `config.gbaRun.enabled`; when the harness is offline the run is simply paused, never an error. Verified end-to-end against a live guild. New Jest spec: `gbaRunService`
- **Goobster Plays Pokémon — Phase 0, the GBA harness** (`clients/gba-mcp/`, design doc `documentation/goobster_plays_pokemon.md`): a zero-dependency MCP server that exposes a GBA game running in mGBA as a standard tool surface — `get_screen` (upscaled PNG screenshots), `press_buttons` (validated sequences and held combos), `wait`, `save_state`/`load_state`, `get_status`, and opt-in `read_memory` (`--allow-memory`; the harness is vision-first by default). A Lua bridge script (`goobster-gba.lua`, mGBA 0.10+ scripting API) serves a line protocol on loopback TCP; any MCP client can drive the game — the future autonomous AI handler, or a human debugging from Cursor. Ships a buildable homebrew test ROM (`test-rom/`, no commercial ROM needed), a patch for a dev-build `mgba-headless` screenshot crash, and a Jest spec (`gbaMcp`)

## 2026-07-25

### Added
- **Tavern combat system**: scenes can declare an `encounter:` block - enemies with health, a defense DC, flat damage, and cycling **telegraphed intents** (the scene always shows what each foe does next). Attack via buttons, `/adventure attack`, or by telling Goobster (`tavernAttack` tool); hits deal 2 (+1 on nat 20), misses are Spark-rerollable, and after party-size actions every living enemy executes its telegraphed intent against the last actor. `onDefeat` drops loot, `onVictory` moves the story, and social/trick options stay live mid-combat so a good parley still beats a sword. Goobster fights too when seated. New showcase campaign: **The Dungeon That Wants Tenant Rights** (the Clause Golem awaits your citations)
- **Inventory management**: `/character inventory view|use|give|drop` with pack autocomplete. Campaigns define consumables (`items:` in quest.yaml, e.g. the Lease-Sealed Poultice) usable mid-adventure - using one is an action, and in combat the enemies notice
- **The campaign forge - Goobster writes campaign YAML**: `/adventure twist description:` (or telling Goobster; `tavernTwist` tool) lets a party bend a running story - Goobster forges 1-3 new scenes into a hidden fork campaign (`data/tavern/campaigns/<id>--twist-<n>/`) and a deterministic reachability check guarantees every new branch **ties back into the original campaign's endings** (no new endings, full validation, one repair round, graceful refusal). The original campaign stays untouched for other tables; twist completions still satisfy chapter gates. `/tavern forge prompt:` (Manage Server) uses the same machinery to write a whole new validated, playable campaign onto the quest board. New Jest specs: `tavernCombat`, `tavernForge`
- **Tavern Phase 2 - "The World Remembers"**: per-member NPC relationship scores that evolve through play (new `npc` YAML effect; ending choices can carry effects too), a shared world lore record written by adventure endings (`world:` entries → `/world map` and `/world lore`, with autocomplete), Guest Rooms (`/tavern room`, `/tavern room-edit` - trophies and NPC standings render from play), and **campaign chapters**: a quest with `requires: <quest-id>` stays locked (🔒 on the board) until the server completes that quest. New built-in chapter: **Signal in the Salt** (the beacon answers back; unlocked by finishing The Missing Bell of Brinewatch)
- **Goobster joins the party**: `/adventure invite-goobster` (or asking him in chat) seats him with his own persistent per-guild character - an Oddity, "The Tavern's own spirit, pouring himself a body for the evening". He plays when the spotlight rotation reaches him: every turn is an AI decision legalized by deterministic code (listed checks or freeform only - travel and ending choices stay with the players), with a best-stat fallback when no provider answers (`services/tavern/botAdventurer.js`)
- **The Tavern is operable by talking to Goobster** (chat and voice): new tools `tavernInfo` (status/board/rumor/NPC/sheet/world), `tavernParty` (create/join/begin/leave/invite-bot), `tavernAct` (freeform actions in plain words), `tavernRecap`, and `rollDice` - info + dice are in the voice tool subset, the play tools post into the session's transcript channel
- **Generated scene art as static data-folder assets** (`services/tavern/assetService.js`): `/tavern generate-art quest:` (Manage Server, OpenAI images) paints each scene once into `data/tavern/assets/scenes/<quest>/<scene>.png`; scene embeds attach the art automatically whenever the file exists and stay text-only otherwise. Server owners can drop in their own PNGs too
- Privacy: NPC relationships and Guest Rooms are deleted by `/forget-me`; the review pass now also covers shared lore entries; `/what-do-you-know-about-me` reports room + relationship counts. New Jest specs: `tavernWorld`, `tavernBotAdventurer`, `tavernTools`
- **The Goobster Tavern + Adventure Mode ("Tavern Alpha")**: a persistent social hub and lightweight tabletop RPG. `/tavern` (Common Room status with a daily rumor and NPC chatter — Marnie Quill, Bix Copperthumb, Sister Caldra, and Albert E. Littlefield, Keeper of the Impractical Beacon — plus the quest board, NPC cards, member profiles), `/character` (four stats +0..+3 over a 6-point spread, six Callings with once-per-adventure big moves, one complication, health, Spark, inventory, milestone advancement, confirm-gated retirement), `/adventure` (party formation with restart-safe buttons, scene play via option buttons *or* freeform `/adventure act` in your own words, Spark rerolls of failed checks, automatic recaps, leave/abandon safety tools), and `/roll` (stat checks + dice expressions)
- **Campaigns are YAML directories** (`campaigns/<id>/quest.yaml` + `scenes/*.yaml` + `endings.yaml`), parsed and validated by `services/tavern/questLoader.js` with a closed effects vocabulary (`clock`/`damage`/`heal`/`item`/`spark`/`flag`/`goto`/`end`) keeping the engine deterministic. Custom or generated campaigns drop into `data/tavern/campaigns/` (same id overrides a built-in; `/tavern reload-quests` hot-reloads; invalid custom files are skipped with warnings, never a crash). Ships with **The Missing Bell of Brinewatch** (2-4 player mystery one-shot seeding the rooftop-beacon mythology) and **Rat Problem, Unreasonably Political** (solo-friendly tavern tale). Authoring guide: `documentation/tavern_adventure_mode.md`
- The engine (`services/tavern/adventureService.js`) keeps structured state (clocks, flags, spotlight, big moves) in deterministic SQLite records separate from narrative prose (the adventure log + recaps); the RNG is injectable and the whole loop is Jest-covered. AI (`services/tavern/narrator.js`) is optional flavor only — freeform stat/DC interpretation, outcome narration, recap polish — with timeouts and deterministic fallbacks, so the mode is fully playable with no AI provider
- Privacy: `/forget-me` deletes tavern characters and party seats, anonymizes shared adventure records, scrubs user ids from adventure state JSON, and review-passes adventure-log prose for the user's character names; `/what-do-you-know-about-me` reports the tavern character. New Jest specs: `tavernQuestLoader`, `tavernCharacterService`, `tavernAdventureService`, `tavernPrivacy`

### Fixed
- **Answering Goobster no longer requires saying his name** (`utils/replyDetection.js`): when the last message in a channel is his own, the next message is run through a cheap deterministic intent check that decides whether it is a reply to him — an answer, a reaction, a correction, or a short "thanks"/"yeah do it" — and he responds if it is. The trigger is positional rather than timed, so a message he sent a while ago still counts when someone picks the thread back up, while unrelated chatter that merely comes after him is ignored. Messages visibly aimed elsewhere (another member mentioned, a reply to a human, another bot's command prefix) skip the model call entirely, cost is bounded to at most one check per message he sends, and a classifier outage falls back to recency. New per-guild setting `reply_detection` (default enabled) via `/replydetection enable|disable|status` and the panel Behavior toggle. New Jest spec: `replyDetection`
- **A Discord reply to Goobster now counts as addressing him**: Discord's reply ping is a per-user toggle, so replying with it switched off used to leave him silent. Replies to his messages are handled like an @mention

## 2026-07-24

### Fixed
- **Voice turns get the same multi-step guarantees**: both voice engines (realtime and classic) now run `runAgentLoop` instead of their own capped loops — sequential tool rounds that build on each other (`VOICE_MAX_TOOL_ROUNDS` = 3), duplicate-call caching, tool errors as recoverable observations, and a guaranteed spoken answer via the finalization round. Voice-specific behavior (tool/error cues, captured `reply()` output, barge-in aborting the loop) plugs in through the loop's hooks (`services/voice/voiceTurnShared.js` `createVoiceToolRunner`). Previously a turn whose last round still wanted tools was spoken as silence
- **Multi-step tool requests no longer die with "I executed your request successfully, but I'm having trouble generating a proper response"** (`utils/chat/agentOrchestrator.js`): the chat pipeline now runs a bounded agent loop (LangChain AgentExecutor pattern over the existing provider contract) — up to 6 sequential tool rounds where each step can use the previous steps' results, duplicate-call caching, tool errors fed back as recoverable observations, and a guaranteed final answer (a finalization nudge when the round budget runs out, then a readable transcript digest as the last resort). Tool transcripts are persisted with the bot reply (`messages.metadata`) and re-injected into the next turns' prompt as `PRIOR TOOL RESULTS`, so follow-up questions actually use the data a tool just fetched instead of losing it. Design rationale (incl. the LangChain evaluation): `documentation/agent_orchestration.md`. New Jest spec: `agentOrchestrator`

### Changed
- Text-chat visible-reply budget raised from 1,000 to 4,096 tokens (`utils/chatHandler.js`) so long multi-step answers aren't cut off mid-summary (hidden reasoning tokens were never part of this cap — providers add their own thinking allowance via `withThinkingHeadroom`). Voice keeps its short 220-token spoken budget

### Added
- **GitHub integration** (`/github`, `services/githubService.js`, `services/repoWatchService.js`): watch repositories per server — pushes, PRs, issues, releases, and CI failures post as embeds into a channel of your choice via an HMAC-verified webhook receiver; on-demand `repo`/`pr`/`issue` views (PR summaries AI-assisted); `searchGithubCode`/`readGithubFile` chat+voice tools that answer questions from real repo content. Public-repo reads work keyless; a fine-grained PAT unlocks code search, private repos, and issue creation
- **Cursor cloud-agent management** (`/agent`, `services/cursorAgentService.js`, `services/agentTrackerService.js`): launch coding agents against watched repos from Discord; each launch opens a **mission-control thread** where status updates, the final summary, and the PR link land, and replies in the thread become follow-up runs. Runs are tracked in SQLite and polled (no public exposure needed); an optional Cursor webhook feeds the same path for instant updates. Default model: **Claude Opus 4.8**, resolved against the live `/v1/models` catalog (exact ID, alias, or fuzzy name) with graceful fallback; `/agent models` lists the options
- **Conversation → action, always confirmation-gated** (`services/integrationActionService.js`): the `launchCursorAgent`/`createGithubIssue` tools, the 📋 reaction (captures any message as an AI-drafted issue), the `goobster-fix` issue label (proposes an agent launch), and the proactive heartbeat's `propose_agent` action all end at Confirm/Cancel buttons requiring Manage Server — pending proposals persist in SQLite with a 15-minute TTL. Every write-side action is recorded in the `integration_audit` ledger
- New Jest specs: `githubService`, `cursorAgentService`, `integrationsWebhooks`, `integrationActions`, `issueCaptureAndBridges`
- Setup guide: `documentation/github_cursor_integration.md` (token creation, webhook payload URLs incl. reusing the Activity tunnel hostname, guardrails)

## 2026-07-23

### Added
- **One-on-one DM conversations**: Goobster now chats in Direct Messages - every DM is an implicit prompt (no mention or command needed), with streaming replies, image attachments/vision, reply-to-edit for generated images, and reaction controls (branching politely declines since DMs have no threads). DM conversations are stored under a synthetic per-user scope (`dm:<userId>`, `utils/dmScope.js`) that keeps them isolated from guilds and from other users
- **DM slash commands**: commands flagged `dmAllowed` (`/chat`, `/joke`, `/poem`, `/generate`, `/help`, `/ping`, `/mememode`, `/forget-me`, `/what-do-you-know-about-me`) are registered once globally with DM interaction contexts; everything else stays guild-registered and never appears in DMs. Guild-only commands invoked from a DM get a friendly refusal instead of an error
- **DM memory and privacy**: long-term memory, facts, and the `rememberFact`/`forgetFact` tools work in DMs under the user's own scope (guild-isolated, capped like a guild). `/what-do-you-know-about-me` reports the DM scope when run in a DM, and `/forget-me` (now runnable from a DM) erases DM memories from both sides, DM facts, and the DM conversation containers/summaries - all covered by the post-erasure audit. New Jest specs: `dmChat`, `dmCommands`, `dmPrivacy`
- **DM "admin" settings**: a DM behaves like a one-member guild whose member is the admin - `/personalitydirective`, `/aisettings`, `/thoughtfulmode`, and `/nickname` now work in DMs, storing their values under the user's DM scope and applied by the chat pipeline (DM directive, per-DM AI provider/model/reasoning, custom bot/user nicknames in the DM). Guild permission checks still apply inside servers. Voice chat in DMs is not possible - Discord's API does not allow bots to join DM calls. New Jest spec: `dmSettings`
- **`/play url:<...>` - instant playback from a link**: paste a YouTube video/playlist URL or a Spotify track/playlist/album URL and Goobster joins your voice channel immediately, downloads the audio (yt-dlp for YouTube, spotdl for Spotify) into the shared `data/music` library, and starts playing as soon as the first track is ready. Songs already in the library are never re-downloaded - spotdl's skip detection and yt-dlp's `--no-overwrites` reuse the cached MP3 for instant playback - and the rest of a playlist keeps downloading in the background, queueing tracks progressively as they finish. New modules: `services/ytdlp/ytdlpService.js` (same CLI auto-discovery as spotdl, `ytdlp.path` override) and `services/urlPlayService.js` (URL classification + routing). New Jest spec: `urlPlayService`
- **Voice notification cues** (`services/voice/notificationSounds.js`): while in a voice conversation, Goobster plays a soft rising chime the moment he accepts a turn and starts preparing a reply, a distinct double-blip whenever he executes a tool/command mid-conversation (web search, economy actions, nicknames, image generation, ...), and a low descending error cue when something fails (a tool call errors, or the turn dies before it could be spoken). Cues are short synthesized PCM clips (no audio assets, no cloud API), play in both the realtime and classic engines, borrow the voice connection briefly, and hand playback back to any in-flight TTS afterwards. Silent polite-mode turns play no cue
- New Jest specs: `notificationSounds`, `speechText`, `elevenLabsTTSSanitize`

### Changed
- **TTS never narrates URLs** (`services/voice/speechText.js`): text is sanitized before speech synthesis — markdown links keep their label, bare/`<wrapped>` URLs are removed, and a URL-only reply is skipped entirely. The classic HTTP TTS path (`textToSpeech`, also used by `/speak`, the AI DJ, and casino table talk) strips whole replies; the realtime engine strips streamed LLM deltas through a stateful stripper that catches URLs split across chunks. History and the text-channel transcript keep the full reply, links included

## 2026-07-19

### Added
- **Anthropic Claude provider** (`services/anthropicService.js`): full member of the AI router with native tool calling, streaming, vision, native web search, and usage tracking. Configure with `ANTHROPIC_API_KEY` (or `anthropicKey` in config.json); auto-detect order is now OpenAI → Anthropic → Gemini → Ollama
- **Full cloud-provider parity** (OpenAI / Anthropic / Gemini): every provider now has an everyday `chatModel` and a state-of-the-art `thoughtfulModel`, and `reasoning_effort` works on all three (OpenAI `reasoning.effort`, Anthropic `output_config.effort`, Gemini `thinkingConfig.thinkingLevel`)
- `/thoughtfulmode` and the panel Thoughtful toggle are provider-aware: they pin the effective provider's top model with high reasoning effort (OpenAI `gpt-5.6-sol`, Anthropic `claude-fable-5`, Gemini `gemini-3.1-pro-preview`)
- New Jest specs: `anthropicService`; expanded `geminiService` (thinking levels, thought signatures) and `panelService` (provider-aware thoughtful mode)
- **Point economy**: per-guild currency with a configurable name (e.g. "Jimmy points") — `/points` covers balance, daily claims, transfers, leaderboard, personal history, and admin controls (rename, grant, starting/daily amounts). Every balance change is written to a full SQLite ledger
- **Gambling games** (`/gamble`): coin flips, d20 showdowns against Goobster, and 5-card poker against the dealer — even-money payouts, pushes returned, deterministic-testable game logic
- **Stock trading game** (`/stocks`): live quotes and symbol search via keyless Yahoo Finance endpoints with a local SQLite symbol/price database, buy/sell with points at market price (1 point = $1, fractional shares), tracked cost basis and trade history, portfolio check-ins with refreshed prices and P/L, and historical price charts (SVG→PNG via sharp, sparkline fallback)
- Economy tools in the chat/voice tool registry (`checkPoints`, `gamblePoints`, `stockQuote`, `tradeStock`, `checkPortfolio`) — the whole economy is voice-operable
- `/forget-me` now erases economy data (wallet, ledger, holdings, trades); `/what-do-you-know-about-me` reports it
- New Jest specs: `economyService`, `gamblingService` (incl. poker hand rankings), `stockPortfolioService`
- **Goobster Casino - a Discord Activity for multiplayer table games** (opt-in via `config.activity`): a generic table framework (`services/tableGames/`) where pure game engines declare state/views/charges and the table manager applies money + journal atomically, with crash-recovery refunds of escrowed bets. First game: **blackjack** - up to 5 seats plus spectators, live dealer (stands on 17, blackjack pays 3:2, double down), betting/act/next-hand timers, WebAudio sound effects, per-guild currency integration, dev mode for browser testing without Discord. New Jest specs: `blackjackEngine`, `tableManager`
- Casino lounge music: the Activity loops a 2-minute instrumental jazz track generated once via the ElevenLabs Music API (cached at `cache/music/casino.mp3`, 404s gracefully without a key), with its own 🎵 toggle next to the 🔊 effects toggle

### Changed
- Model defaults bumped to the latest of each platform's standard tier: OpenAI chat `gpt-5.4-mini` → `gpt-5.6-terra`, thoughtful `gpt-5.5` → `gpt-5.6-sol`; Anthropic chat `claude-sonnet-5`
- Realistic token budgets for reasoning: hidden thinking shares the output cap on all three cloud platforms, so providers now add a thinking allowance (up to +24k tokens at high effort, via `utils/aiTokenBudget.js`) on top of the caller's visible-reply budget — thoughtful mode no longer risks burning its whole 1000-token cap on reasoning and returning a truncated (or empty) reply
- Gemini tool calls now capture and replay `thoughtSignature` (required by Gemini 3 models for multi-turn tool loops); SSE parsing accepts `\r\n` event separators (as served by the live Gemini API)

### Fixed
- Realtime voice barge-in was too aggressive: Discord's speaking-start event (which fires on any mic blip — coughs, breaths, chair squeaks) no longer cuts off Goobster mid-reply. Interruption now requires ~350ms of sustained above-the-noise-gate audio, or actual words heard by the realtime STT; a mic blip still holds back a reply that hasn't started speaking yet

## 2026-07-18

### Added
- Realtime voice engine for `/voicechat` (new default; `engine:` option picks `realtime` or `classic`): streaming speech-to-text via ElevenLabs Scribe v2 Realtime (transcription happens while you talk), LLM replies streamed token-by-token into the ElevenLabs multi-context TTS WebSocket (audio starts on the first sentence), and true barge-in — start talking to interrupt Goobster mid-reply
- Shorter turn-taking for the realtime engine (900ms quiet window vs 2200ms) plus an RMS energy gate so open-mic noise never reaches paid STT; per-segment fallback to OpenAI batch transcription when the realtime API errors
- The realtime engine needs only an ElevenLabs key — OpenAI is no longer required for voice conversations (still used by the classic engine)
- Local panel voice-chat API gains the `engine` option and reports it in status
- New Jest specs: `pcmUtils`, `scribeRealtime`, `multiContextTTS`, `realtimeVoiceEngine` (protocol clients tested against local WebSocket servers)

### Changed
- Shared voice-turn logic (polite-mode gate, tool context, tool-call loop) extracted to `services/voice/voiceTurnShared.js`; `ws` promoted to a direct dependency

## 2026-07-06 (architecture improvements)

### Added
- Indexed long-term memory recall via the sqlite-vec extension (per-dimension `memory_vec_<dims>` virtual tables, cosine KNN inside SQLite), with automatic backfill, orphan cleanup on every deletion path, and a brute-force fallback when the extension is unavailable
- Restart-safe state: heartbeat mood/cooldowns (`heartbeat_state`), search approval requests (`pending_search_requests` — approve/deny buttons now survive restarts), and search dedup (`pending_searches`) all persist in SQLite
- ESLint flat config (`eslint.config.js`), `npm run smoke` module-load check, and a GitHub Actions CI workflow (lint + smoke + Jest)
- New Jest specs: `memoryVecIndex`, `heartbeatState`, `searchApproval`

### Changed
- `utils/chatHandler.js` (2100 lines) split into focused modules under `utils/chat/` (context, search flow, reactions, responder, thread manager, DB plumbing); public API unchanged

### Fixed
- Latent `ReferenceError`s on error paths in `aidj.js` and `generateallambience.js` (out-of-scope catch-block references), undefined `calculateAudioLevel` in the voice pipeline, `const` reassignment in thread naming, and lost error causes on re-thrown errors (now attached via `cause`)

### Removed
- Unused `services/voice/audioService.js` (no consumers; failed to load without optional opus prebuilds), stale `devnotes/to-do_analysis.md`, `changelog.md.bak`

## 2026-07-06

### Added
- `/recall` — ask the server's long-term memory anything; answers are grounded in locally stored memories with source snippets, filtered by channel visibility
- `/what-do-you-know-about-me` — private transparency report of all stored data about you
- `/forget-me` — button-confirmed, bot-wide erasure of all your data (memories, facts, follow-ups, chat history, nicknames, preferences), with name-mention review of server facts/summaries/follow-up notes, usage anonymization, and a post-erasure audit
- `/privacy` — admin memory retention windows (nightly auto-purge) and per-channel memory exclusions
- Command usage counters (`command_log`) feeding baseline metrics; `/usage` now shows `/recall` adoption
- First real Jest specs (`tests/privacyService.test.js`, `tests/memoryPrivacy.test.js`) — `npm test` now passes

## 2025-02-25

### Added
- Merge pull request #10 from nervous-rob/feature/improved-thread-handling
- Merge pull request #9 from nervous-rob/feature/improved-thread-handling

### Documentation
- Update changelog with recent improvements and feature enhancements

### Other
- Improve search functionality with current date context and better approval flow

## 2025-02-07

### Added
- Update database DDL to match existing functionality

### Maintenance
- remove Debug folders from Git tracking

## 2025-02-06

### Added
- Implement Meme Mode feature with dynamic system prompts
- Add Express server startup and logging
- Add OIDC permissions to GitHub Actions workflow
- Add health check and container app configuration
- Add Azure Login step to GitHub Actions workflow
- Add dev environment configuration to GitHub Actions workflow

### Changed
- Update container app configuration
- Update container app deployment with dynamic image tagging
- Update Azure login secrets in GitHub Actions workflow
- Update GitHub Actions workflow with Azure AD token exchange audience
- Update GitHub Actions workflow with DISCORD_GUILD_IDS validation and configuration

### Other
- Improve config.json generation with jq formatting
- Refactor GitHub Actions workflow to generate config.json directly

### Removed
- Remove hardcoded config.json generation from Dockerfile
- Remove unnecessary OIDC permissions from GitHub Actions workflow

## 2025-02-05

### Added
- Add documentation comment for Dockerfile config generation

### Changed
- Modify Dockerfile config generation to use direct envsubst output

### Documentation
- Refactor Dockerfile config generation with improved multi-line JSON formatting
- Refactor Dockerfile config generation using envsubst for dynamic configuration
- Refactor Dockerfile config generation using printf with improved variable handling
- Enhance Dockerfile config generation with improved JSON formatting and jq validation

### Removed
- Simplify Dockerfile config generation by removing template and envsubst

## 2025-02-03

### Added
- new dockerfile
- Add configuration management and GitHub Actions workflow
- new dockerfile

### Changed
- update
- update gitignore
- Update .gitignore to exclude data directories

### Documentation
- Improve Dockerfile config generation with enhanced JSON formatting and validation
- Simplify Dockerfile config generation using envsubst
- Refactor Dockerfile config generation using printf for improved readability and flexibility
- Enhance Dockerfile with dynamic configuration and improved file handling

### Fixed
- fix docker build

### Other
- Merge branch 'main' of https://github.com/nervous-rob/goobster
- Refactor adventure commands with service-based architecture and improved error handling
- Merge pull request #8 from nervous-rob/improvement/adventure-service
- Merge pull request #7 from nervous-rob/improvement/adventure-service
- Merge pull request #6 from nervous-rob/improvement/adventure-service
- Merge pull request #5 from nervous-rob/improvement/adventure-service
- Enhance database and adventure system with robust resource management and state handling
- Create an auto-deploy file
- app-icon
- Refactor adventure service with comprehensive modular architecture

### Removed
- Remove .cursor directory and .cursorrules from git tracking (moved to .gitignore)
- Remove data/music from git tracking (moved to .gitignore)

## 2025-02-02

### Added
- add gitignore
- Merge pull request #4 from nervous-rob/feature/voice-mode
- Add comprehensive TODO tracking and system improvement documentation

### Changed
- Update .gitignore to exclude cursor rules files

### Other
- Implement advanced VoiceDetectionManager with robust audio activity tracking

## 2025-02-01

### Other
- Enhance message chunking and search result formatting system
- Implement comprehensive AI search and interaction system

## 2025-01-31

### Added
- Implement comprehensive audio system with advanced features and improvements
- Add comprehensive audio system documentation for Goobster
- Add default ambient and music audio files for enhanced atmosphere
- Add comprehensive voice and audio services with advanced features

## 2025-01-19

### Added
- Merge pull request #3 from nervous-rob/feature/adventure-mode
- Refactor and enhance Goobster bot with new features and improvements

## 2025-01-03

### Other
- Enhance adventure gameplay with improved prompts and decision-making structure

## 2024-12-19

### Changed
- Enhance adventure gameplay with image generation and database updates

## 2024-12-18

### Added
- Update chat commands to use new model version "gpt-4o" for OpenAI completions

### Changed
- Update documentation to GPT-4o

### Documentation
- Enhance adventure gameplay structure and documentation

### Fixed
- Add debug logging functionality to adventure commands

### Other
- Enhance adventure gameplay with structured prompts and state management
- Refactor deploy commands to support multiple guilds

## 2024-12-17

### Added
- Add adventure commands: Implement `startAdventure`, `joinParty`, `beginAdventure`, `makeDecision`, `partyStatus` commands for managing adventure parties and gameplay. Integrate OpenAI for adventure generation and decision-making, enhancing user interaction and engagement in the Discord bot. Includes error handling and database transactions for robust functionality.
- Implement adventure mode database schema: add tables for parties, party members, adventures, adventurer states, and decision points. Update initDb.js to include new table creation and drop existing tables if they exist. Enhance documentation with a detailed schema overview for better understanding of the new features.
- Add Azure and Discord setup guides to documentation
- Add comprehensive documentation for Goobster Discord bot, including system architecture, command usage, configuration setup, database schema, and development guidelines. This enhances clarity for developers and users, ensuring proper understanding of the bot's functionality and setup requirements.
- Refactor ping command to improve database connection handling and response timing. Added immediate reply deferment to prevent timeouts, enhanced error messages, and ensured proper connection checks before querying the database.

### Changed
- Refactor chat message handling to use EmbedBuilder instead of MessageEmbed. This change updates the Discord.js integration for better compatibility with the latest library version.

### Other
- Refactor adventure commands and enhance database connection handling
- Enhance adventure commands with party size validation and game state management

## 2024-04-16

### Changed
- Update README.md

## 2024-03-18

### Other
- Merge pull request #2 from nervous-rob/UserManagement

## 2024-03-17

### Added
- Adding new commands for chat and utility

## 2024-02-23

### Added
- adding db-init command to package.json
- Adding sql to GetConnection
- Update initDB with new columns and tables

### Other
- Chat command creation

## 2024-02-22

### Added
- Adding /createuser
- Adding database init script

### Changed
- Update ping command to check DB connectivity

### Other
- Merge pull request #1 from nervous-rob/main

## 2024-02-21

### Added
- Added mssql

## 2024-02-16

### Added
- Add deploy-commands and start scripts to package.json
- Add new commands and deploy them
- Add config.json to .gitignore

### Changed
- Update installation and configuration instructions
- Update Dockerfile and README.md

## 2024-02-15

### Other
- Initial commit

