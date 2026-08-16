# Changelog

## 2026-08-16

### Added
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

