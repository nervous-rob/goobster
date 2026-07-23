# Development Standards and Project Goals

## Project Overview
Goobster is a self-hostable Discord bot designed to provide engaging AI chat, helpful utilities, music playback, and fun features for users. This edition is optimized to run on low-power hardware such as a **Raspberry Pi 4B**, with no mandatory cloud dependencies.

## Architecture Principles

### Self-hosted first
- **Local SQLite database** (better-sqlite3, WAL mode) — no external database server. All schema lives in `db/schema.sql` and is applied automatically when the database opens.
- **Local file storage** for music (`data/music`), playlists (`data/playlists`), and images (`data/images`) — no cloud blob storage.
- **System FFmpeg** for all audio work (multi-arch, including ARM64) — never binary-only npm packages that ship a single architecture.
- **Graceful degradation**: every cloud integration (OpenAI, Anthropic, Gemini, Perplexity, ElevenLabs, Spotify) is optional. Missing credentials must produce a warning and disable the feature — never a startup crash.

### Database access
- All database access goes through the `db/` module: `db.get(sql, params)`, `db.all(sql, params)`, `db.run(sql, params)`, and `db.transaction(fn)`.
- SQL is written natively for SQLite (UPSERT via `ON CONFLICT`, `LIMIT`, `datetime('now', ...)`, `CURRENT_TIMESTAMP`, `RETURNING`).
- Named parameters use the `@name` style. Values are normalized automatically (booleans → 0/1, Date → UTC text, objects → JSON).
- Discord snowflake IDs are stored as **TEXT** (they exceed JavaScript's safe integer range).
- Timestamps are stored as UTC text (`YYYY-MM-DD HH:MM:SS`).

### AI providers
- `services/aiService.js` routes between providers: **OpenAI** (default when configured), **Anthropic** (Claude), **Gemini**, and **Ollama** (local LLM, used automatically as fallback when no cloud provider is configured). Auto-detect order: OpenAI → Anthropic → Gemini → Ollama.
- **Full parity across the three cloud providers**: each has a `chatModel` (everyday tier) and a `thoughtfulModel` (state-of-the-art tier), native tool calling, text streaming, native web search, vision, and `opts.reasoning_effort` support. Feature work must preserve this parity — never add a capability to one cloud provider without the others.
- All model IDs and API keys are resolved through `config/aiConfig.js` (environment first, then `config.json`, then defaults). Never hardcode a model ID in a service or command.
  - Chat defaults (latest model of each platform's standard tier): OpenAI `gpt-5.6-terra`, Anthropic `claude-sonnet-5`, Gemini `gemini-3.5-flash`.
  - Thoughtful defaults (used with high reasoning effort): OpenAI `gpt-5.6-sol`, Anthropic `claude-fable-5`, Gemini `gemini-3.1-pro-preview`.
  - Other defaults: images `gpt-image-2`, Perplexity `sonar-pro`.
- Provider contract — every provider implements:
  - `chat(messages, opts)` → `{ content: string, toolCalls: [{ id, name, arguments }] }` (never a raw SDK response).
  - `generateText(prompt, opts)` → `string`.
  - `isConfigured()`, `setDefaultModel(name)`, `getDefaultModel()`.
  - Accepted message roles: `system`, `user`, `assistant` (optionally carrying `toolCalls`), and tool results as `{ role: 'tool', toolCallId, name, content }`.
  - `opts.onDelta(textDelta)` enables streaming; providers invoke it per text chunk and still return the full normalized result.
  - `opts.reasoning_effort` (`minimal`/`low`/`medium`/`high`) maps to each provider's reasoning knob: OpenAI `reasoning.effort`, Anthropic `output_config.effort` (`minimal`→`low`; skipped on models without effort support, e.g. Haiku), Gemini `thinkingConfig.thinkingLevel` (Gemini 3.x only; `minimal`→`low` on Pro models). Unsupported combinations are silently dropped, never errors.
  - **Token budgeting**: callers size `opts.max_tokens` for the *visible* reply only. Hidden reasoning shares the same output cap on all three platforms (OpenAI reasoning tokens, Claude thinking, Gemini thinking), so providers add a thinking allowance on top via `utils/aiTokenBudget.js` (`withThinkingHeadroom`: minimal +1k, low +4k, medium +8k, high +24k) whenever reasoning is active — including model defaults when no effort is requested (OpenAI reasoning models default `medium`, Claude adaptive-thinking models `high`, Gemini 3.x Flash `medium`/Pro `high`). Never hand-tune inflated `max_tokens` at call sites to make room for thinking. The model's native hidden thinking channel *is* the per-reply scratchpad; don't build prompt-level scratchpad loops for cloud providers.
- OpenAI uses the **Responses API** (`client.responses.create`) — not Chat Completions or the legacy `functions` parameter. Reasoning models (GPT-5 family, o-series) must not receive `temperature`/`top_p`; use `reasoning: { effort }`.
- Anthropic uses the **Messages API** via plain `fetch` (no SDK dependency). Adaptive-thinking models (Claude Fable/Mythos 5) and effortful requests must not receive `temperature`/`top_p`; on newer Claude models the two are mutually exclusive, so the provider sends only one.
- Thoughtful Mode is provider-aware: `aiService.getThoughtfulPreset(providerKey)` returns `{ provider, model, reasoningEffort: 'high' }` using the provider's `thoughtfulModel` (null for Ollama). `/thoughtfulmode` and the panel toggle pin the preset for the guild's effective provider.
- Tool calling: OpenAI, Anthropic, and Gemini use native function calling; Ollama uses the prompt-based JSON protocol from `utils/toolPromptBuilder.js`. Shared tool guidance lives in that module — never duplicate tool prompts inside a provider.
- Web search: OpenAI (`web_search` built-in tool), Anthropic (`web_search` server tool), and Gemini (Search Grounding) search natively mid-response via `opts.webSearch`; the legacy detect-and-approve Perplexity flow only runs for providers without native search (Ollama). Perplexity remains the backend for the `performSearch` tool and `/search` command.
- Image generation goes through `openaiService.generateImage()`/`editImage()` (GPT Image models return base64, not URLs). DALL-E models were removed from the OpenAI API in May 2026.

### Long-term memory
- `services/memoryService.js` stores message embeddings in the `memory_embeddings` SQLite table and recalls them by cosine similarity (`services/embeddingService.js`: OpenAI `text-embedding-3-small`, or Ollama `nomic-embed-text` when self-hosted).
- Recall is indexed: vectors are mirrored into per-dimension `vec0` virtual tables (`memory_vec_<dims>`, partitioned by `guildId|model`, cosine distance) via the **sqlite-vec** extension, loaded in `db/index.js` (prebuilts cover x64 and ARM64 incl. Pi 4B). When the extension can't load, recall transparently falls back to the original brute-force scan. Every deletion path (prune, retention, channel exclusion, per-user/guild erasure, `/forget-me`) must clean orphaned vectors — derived embeddings never outlive their memories. First use backfills pre-index rows (`syncVecIndex`).
- Memory writes are fire-and-forget (never block or fail a reply); recall injects a `LONG-TERM MEMORY` block into the system prompt, excluding content already in the active context window.
- Vectors are only compared when produced by the same embedding model; per-guild storage is capped (default 5000 entries) and admins can inspect/clear via `/memory`.
- `/recall <question>` exposes memory directly ("ask the server anything"): retrieves relevant memories, filters out ones from channels the asking user cannot view, and synthesizes a grounded answer with source snippets. Invocations are counted in `command_log` (via `usageTracker.logCommand`) and surfaced in `/usage`.

### Privacy controls (product features, not just positioning)
- `/what-do-you-know-about-me` — per-user transparency report (ephemeral): facts, memory counts, pending follow-ups, nickname, preferences, chat-history totals, usage rows, activity counters. Built by `services/privacyService.js` `buildUserReport`.
- `/forget-me` — full per-user erasure (button-confirmed, bot-wide, single transaction) via `privacyService.forgetUser`:
  - **Deletes:** `memory_embeddings` by `authorId`, USER-subject `facts`, `followups` created by the user, the user's conversation history (`messages`, `conversations`, `prompts`), `user_nicknames`, `UserPreferences`, and the `users` row.
  - **Anonymizes:** `usage_log`/`command_log` rows (userId nulled, token counts kept for cost accounting) and `guild_activity` rows (userId nulled, message counts kept so server-wide `/wrapped` totals stay accurate).
  - **Review pass:** GUILD-subject `facts`, `conversation_summaries`, and follow-up notes are scanned for the user's known names (username, display names, stored nicknames, memory author names) with word-boundary matching, and matches are deleted. Never skip this pass.
  - `privacyService.auditUser` re-counts user-attributed rows afterwards; the command reports the audit so "zero gaps" is provable.
- `/privacy` (Manage Server) — retention and scope: `retention days:<n>` sets `guild_settings.memory_retention_days` (purged on write and nightly from the consolidation run via `memoryService.applyRetentionAll`); `exclude`/`include channel:<c>` manage `memory_channel_exclusions` (excluding also purges that channel's stored memories **and its `guild_activity` counter rows**; `memoryService.remember` and `activityService.recordMessage` both refuse excluded channels).

### Activity counters and Server Wrapped
- `services/activityService.js` counts messages into the `guild_activity` table (one aggregated row per guild/channel/user/UTC-day, UPSERT increment) from the `messageCreate` event. **Counts only — message content is never stored.** Recording is wrapped like `usageTracker.log`: it must never break message handling. Channels excluded via `/privacy` are skipped, and `/forget-me` anonymizes a user's rows (userId nulled, counts kept — NULLs are distinct in SQLite unique indexes, so anonymization cannot hit a PK conflict and aggregations simply SUM across rows).
- `services/wrappedService.js` aggregates Server Wrapped stats per guild and window (activity totals/top members/top channels/busiest day from `guild_activity`; AI calls and tokens from `usage_log`; command and `/recall` counts from `command_log`; new memories, facts, and delivered follow-ups from the memory tables). `resolvePeriod` maps `this-month`/`last-month`/`this-year` to UTC date windows. `buildBlurb` optionally adds a short AI-written intro (never throws; returns null without a provider).
- `/wrapped show [period]` (`commands/utility/wrapped.js`) posts the recap **publicly** — it's a shareable artifact. Presentation lives in `utils/serverWrapped.js` (`buildWrappedMessage`): an embed is always rendered; when OpenAI is configured, a stats-card image is generated via `openaiService.generateImage()` (model resolved through `config/aiConfig.js`) and attached, falling back to embed-only on any failure. Invocations are logged to `command_log`.
- `/wrapped schedule|unschedule` (Manage Guild) manages a monthly `automations` row with promptText marker `__SERVER_WRAPPED__` (cron `0 17 1 * *`), handled directly by `automationService.executeWrapped` — like `__CHANNEL_DIGEST__`, it bypasses the chat pipeline and the user-online check, and wraps the month that just ended.

### Usage tracking, vision, per-guild AI, and digests
- `services/usageTracker.js` logs token counts for every AI call (`usage_log` table); providers report usage automatically (including streaming and Ollama), with attribution threaded via `opts.usageContext = { guildId, userId }`. `/usage` shows per-guild summaries.
- Vision: user messages may carry `images: [url]`; OpenAI passes URLs directly, Gemini/Ollama download and inline base64. Sources: image attachments on mentions and the `/chat` `image` option.
- Per-guild AI overrides (`/aisettings`, `/thoughtfulmode`): `guild_settings.ai_provider/ai_model/ai_reasoning_effort` are applied per-request via `opts.provider`/`opts.model` — never by mutating global provider state.
- Reply-to-edit: replying to a bot message containing an image routes to `imageDetectionHandler.editImageFromUrl()` (gpt-image-2 edits endpoint).
- `/digest now|schedule`: channel summaries via `utils/channelDigest.js`; scheduled digests are `automations` rows with promptText `__CHANNEL_DIGEST__` handled specially by `automationService`.

### Facts, follow-ups, and the heartbeat (proactive mode)
- `services/factsService.js` stores distilled facts (`facts` table) about users and the server - separate from raw embeddings. The model curates them itself via the `rememberFact`/`forgetFact` tools; per-user dossiers and server facts are injected into every chat prompt.
- `services/memoryConsolidationService.js` runs daily ("sleep cycle"): reviews the last day's raw memories per guild and distills new durable facts, deduplicated against existing ones.
- `services/followupService.js` (`followups` table) holds one-shot self-scheduled follow-ups created by the `scheduleFollowUp` tool; delivery runs every minute from the heartbeat.
- `services/heartbeatService.js` is the proactive agent tick (every 20 minutes): for guilds opted in via `/proactive`, it reviews the most active channel, known facts, and pending follow-ups, then decides via a cheap model call to chime in, react, update its mood, or (the default) stay silent. Guardrails: opt-in per guild, 45-minute action cooldown, minimum-activity bar, and no interrupting when the bot spoke recently. The per-guild mood it maintains subtly colors normal chat replies.
- Heartbeat state (mood + cooldown anchor) persists in the `heartbeat_state` table so restarts don't reset cooldowns or forget the server vibe.
- Schema note: `db/index.js` has a minimal column-migration helper (`applyColumnMigrations`) because `schema.sql` only creates missing tables; new columns on existing tables must be added there.

### Internal monologue and knowledge graph
- `services/monologueService.js` is a background thought process, opt-in per guild via `/monologue` (`guild_settings.monologue_mode`). Every tick (15 minutes, 30-minute per-guild cooldown) it privately reviews the most active channel's recent conversation, its own scratch pad, recalled long-term memories (`memoryService.recall`), known facts, and a relevant knowledge-graph excerpt, then answers with ONLY JSON: a required `thought` (journaled to `monologue_thoughts`), optional `scratchpad` add/remove operations (`monologue_scratchpad`), and optional `graph` mutations (node upsert/link/delete). **Nothing here posts to Discord** - the monologue is introspection only.
- The cooldown anchor is derived from `monologue_thoughts.createdAt` (restart-safe, per the SQLite-not-memory rule). Ticks are skipped when the guild is quiet (fewer than 2 human messages in 2 hours, or nothing new since the last thought), and channels excluded via `/privacy` are never observed. Per-tick action caps bound how much one model response can change (4 note adds, 6 node upserts, 10 links, 3 node deletes).
- `services/knowledgeGraphService.js` owns the per-guild semantic network: `kg_nodes` (types: concept/fact/opinion/experience/person/place/event/thing, labels unique per guild case-insensitive, salience 0-1) and `kg_edges` (typed, weighted semantic relationships; `ON DELETE CASCADE` from either endpoint). It exposes create/update (`upsertNode` - omitted fields are preserved), query (`searchNodes` keyword match, `topNodes`, `getNeighborhood` BFS traversal), delete, `link`/`unlink` (missing endpoints are auto-created as stub concepts), and prompt rendering (`describeForPrompt`). Storage is capped (500 nodes / 1500 edges per guild), pruning the least salient, least recently touched first.
- Chat integration: when the mode is enabled, the chat pipeline injects a compact `INNER LIFE` block (latest private thought, a few scratch pad notes, knowledge-graph nodes relevant to the incoming message) into the system prompt via `monologueService.buildChatContext` - the prompt explicitly forbids quoting or revealing it.
- `/monologue` (Manage Server): `enable`/`disable`, `status` (counts), `thoughts` (peek at recent private thoughts + scratch pad, ephemeral), `graph` (most salient nodes and links, ephemeral), `reset` (erase thoughts, scratch pad, and graph). The panel Settings tab mirrors the toggle (`monologueMode`).
- Privacy: `/forget-me` runs review passes over `monologue_thoughts`, `monologue_scratchpad`, and `kg_nodes` (label + content) with the same word-boundary name matching as guild facts; matching rows are deleted and incident edges cascade.

### Point economy, gambling, and the stock trading game
- `services/economyService.js` owns the per-guild point currency: `economy_settings` (currency name — anything, e.g. "Jimmy points" — plus starting balance and daily amount), `economy_wallets` (INTEGER balances, never negative, enforced in code and by CHECK constraint), and `economy_transactions` (a full ledger: signed amount + resulting balance per change). **Every point movement goes through `economyService.adjust()`** — games, trades, grants, daily claims — so the ledger is complete by construction. Wallets are created lazily with the guild's starting balance (recorded as a `starting-balance` ledger entry). Errors use `EconomyError` (machine-readable `code` + user-presentable `message`); commands and tools surface the message directly.
- `/points` (`commands/economy/points.js`): balance, `daily` (24h cooldown tracked in SQLite), `give` (atomic transfer), leaderboard, `history` (ephemeral ledger view); `admin` subcommand group (Manage Server) renames the currency and sets starting/daily amounts (`/points admin name|grant|config`).
- `services/gamblingService.js` + `utils/pokerHands.js` implement the games behind `/gamble`: coin flip (call heads/tails), d20 showdown (both roll, higher wins, tie pushes), and 5-card poker vs. the dealer (one shuffled deck, standard hand rankings incl. the wheel, kicker tie-breaks). All games pay even money and settle as a **single net ledger entry** (`gamble-<game>` with a JSON detail of the outcome). The RNG is constructor-injectable (`new GamblingService(rng)`) so game logic is deterministic under test; bets are validated against the balance before any dice are rolled.
- `services/stockService.js` is the market data layer for the stock game: quotes and daily history from Yahoo Finance's keyless public endpoints (chart + search), with a **short-TTL quote cache in SQLite** — every fresh fetch upserts `stock_symbols` (the symbol indicator database, grown by lookups/searches) and appends a `stock_prices` snapshot; quotes younger than 5 minutes are served locally, and on network failure the last snapshot of any age is returned flagged `stale` (graceful degradation, no API key required). Errors use `StockError`.
- `services/stockPortfolioService.js` is the trading game: **1 point = $1**, `units` are shares (fractional to 4 dp). `buy` debits `ceil(units × price)` points, `sell` credits `floor(units × price)` (rounding always favors the house); holdings keep an average cost basis (`stock_holdings`), every fill is recorded in `stock_trades` (side, units, price at trade time, points moved), and `getPortfolio` re-quotes each symbol to compute value and P/L vs. cost. Only USD-quoted symbols are tradable (the peg would otherwise need FX). `/stocks` exposes quote, search, buy, sell, portfolio (works for other users too), `chart` (historical price graph rendered as SVG → PNG via sharp in `utils/stockChart.js`, unicode-sparkline fallback), and `trades`.
- Chat/voice integration: `toolsRegistry` exposes `checkPoints`, `gamblePoints`, `stockQuote`, `tradeStock`, and `checkPortfolio`, all included in the voice session tool subset — the whole economy is operable by speaking to the bot.
- Privacy: economy data is **deleted outright** on `/forget-me` (wallet, ledger, holdings, trades — personal financial data, not aggregate accounting), reported by `/what-do-you-know-about-me`, and covered by `auditUser`.

### Multiplayer table games (Discord Activity)
- **Architecture rule: engines are pure, the manager owns side effects.** Game engines under `services/tableGames/` (`blackjack.js`, `roulette.js`, `baccarat.js`, `holdem.js`) are pure state machines: `createTable()`, `applyAction(state, action, rng) -> { state, events, charges }`, `getView(state, userId)` (per-player view; hidden information like the dealer's hole card and the deck never leaves the server), `getEscrowRefunds(state)`, `isEmpty(state)`. No database, no timers, no Discord, injectable RNG — fully deterministic under test. New games implement this interface (shared `GameError` lives in `gameError.js`) and register in `ENGINES`; their player actions must also be added to the WebSocket action allowlist in `web/activityApi.js` and get a renderer module under `web/activity/games/`.
- `services/tableGames/tableManager.js` is the only side-effect zone: one live table per guild+channel, and every transition **commits engine `charges` through `economyService.adjust()` and journals the new state (`table_games` row) in a single SQLite transaction** — a bet can never be escrowed without the state that took it being durable, and an unaffordable bet rolls the whole transition back (`INSUFFICIENT_FUNDS` surfaces to the client, state unchanged). Engines declare timers in `state.timer`; the manager schedules the system action (`timeout-act` auto-stand, betting-window `deal`/`spin`, `next-hand`/`next-round`) and tolerates stale fires. On boot, `recoverFromJournal()` refunds bets escrowed in crash-interrupted hands (ledger type `table-<game>-refund`) and clears the journal; the journal is transient (deleted when tables close), so it adds no `/forget-me` surface.
- **Game selection**: the client lobby sends `gameType` with the WebSocket `join`; `getTable` keeps the one-table-per-channel invariant by switching an existing table's engine **in place only when it has no seated players** (subscribers stay attached and receive the fresh state) — with players seated, the running game wins and later joiners land in it. A `leave-table` message returns a socket to the lobby (vacating the seat, with the engine refunding any betting-phase escrow).
- House rules (v1): **Blackjack** — 4-deck shoe per hand, dealer stands on all 17s, blackjack pays 3:2 rounded down, double on any first two cards, no splits, 5 seats. **Roulette** — European single zero, simultaneous betting (no turn order), straight 35:1 / dozens+columns 2:1 / even-money 1:1, zero kills outside bets, up to 20 stacked bets per seat with `clear-bets` refund, 8 seats. **Baccarat** — punto banco tableau (no post-bet decisions; deal and settlement are one transition), 6-deck shoe per round, banker win pays 1:1 minus 5% commission rounded down, tie 8:1, player/banker push on tie, 7 seats. **Texas Hold'em** — no-limit with rotating button and `minBet/2`/`minBet` blinds (heads-up: button posts small), wallet-backed betting (chips escrow into the pot as they're bet; no stacks/all-ins/side pots, street raise-to capped at `maxBet`, can't-cover-the-call means fold), single deck per hand, ties split with the odd chip to the earliest seat, 6 seats. Hold'em is the first game with hidden information: `getView` reveals hole cards only to their owner (showdown reveals via `results`), and mid-hand leavers fold, forfeiting chips already in the pot while `contributions` tracks per-user escrow for crash refunds. **Slots** — a bank of classic 3-reel machines (one per seat, 6 seats) pulled together: shared betting window, all reels spin and settle in one transition; a weighted 21-stop strip and a first-match paytable (triple 7s pay 150x total, down to money-back cherry pairs) give the house roughly a 7% edge. **Casino War** — 6-deck shoe per round, one card per bettor vs. one communal dealer card, higher rank wins even money (aces high), 6 seats; a tie moves that seat to the simultaneous `war` phase (timer auto-surrenders): surrender returns half the bet rounded down, war escrows a matching bet and deals fresh cards (communal dealer war card), where winning returns both bets plus even money on the original and tying doubles that bonus. **Craps** — street rules, 8 seats, no turn order: pass/don't pass are come-out-only line bets (naturals/craps per the book, don't pass pushes on 12), the field is a single-roll bet open before every roll (2 and 12 pay 2:1, other field numbers 1:1); a round runs come-out → point → made/seven-out with the table auto-rolling on a timer (any bettor can throw early), field bets resolving mid-round via each seat's `resolved` list, and per-seat net outcome computed at settlement. Leaving with the point on refunds field bets but line bets must ride (seat flagged `left`, cleared after settlement). **Let It Ride** — single deck, 6 seats, hidden information: the ante escrows three equal bets, three cards per player + two face-down community cards; before each reveal every in-hand player simultaneously rides or pulls one bet back (timeout pulls — the safe default; pulls refund immediately), the third bet always rides, and the final 5-card hand pays all riding bets per the standard paytable (tens-or-better 1:1 up to royal 1000:1). `getView` hides hole cards from other players until showdown and reveals community cards by phase; mid-hand leavers auto-ride to showdown.
- **Goobster plays too** (`services/tableGames/botPlayer.js`): a side-effect service — never engine code — that subscribes to a table like any client, watches its own personalized view, and acts through `tableManager.act` (seated with an `isBot` flag only trusted server code can set; the WS layer never forwards it — every engine stores/exposes it per seat). **Every game is decided by the model, never by built-in strategy**: the per-game `ADVISORS` registry exposes `needsAction(view)`, `buildDecisionContext(view, { persona, balance, currencyName, images })` (serializes the full game state plus the same options a human player has into an ONLY-JSON prompt; `images` is the extension point for feeding table screenshots to vision models), `legalize(decision, view)` (the validator — repairs/clamps model output into `{ actions: [...] }` legal engine moves, `{ pass: true }` to sit a round out, or `null` for unusable responses), and `fallback(view, rng)` (plays ONLY when no provider produces a usable answer). The configurable `activity.bot.persona` is injected into every decision prompt so it shapes risk appetite and bet sizing, not just table talk. In the chance games the bot follows, never leads (it only bets into a round a human opened, and never force-deals/spins). A rejected action takes the advisor's `retreat` (check/fold/stand) or sits the round out (`skipKey` prevents retry loops); multi-move decisions (e.g. a roulette bet spread) stop cleanly at the first failed follow-up. The bot banks through the normal economy (`bot-bankroll` top-ups when low, refreshed on every settle), is invited/dismissed via WS `invite-bot`/`dismiss-bot` (inviter must be seated), and auto-leaves when the last human stands. Table talk goes to Activity clients via `tableManager.notify` (`chat` messages), optionally to the channel (`activity.bot.textComments`), and — with `activity.bot.voiceComments`, default on — out loud whenever the bot is already in a guild voice channel: a live `/voicechat` session's TTS pipeline is preferred, otherwise any existing voice connection (`getVoiceConnection`) plus `serviceManager.voiceService.tts`; it never joins voice itself. In hidden-information games, mid-hand comments run through the advisor's `sanitizeComment` (`leaksHiddenCards`): any card glyph, card-rank word, hand-strength term, or the bot's hole ranks as digits gets the comment dropped — prompts forbid reveals, the filter guarantees it. All bot AI calls carry `usageContext` and comments are rate-limited per table.
- The Activity backend (`web/activityApi.js`) is **opt-in** (`config.activity.enabled`) and mounts on the public health server, since Discord's proxy must reach it (see `documentation/activity_setup.md`; a cloudflared tunnel is the recommended exposure). Auth: the embedded client exchanges its SDK `authorize()` code at `POST /api/activity/token` (client secret from `DISCORD_CLIENT_SECRET` or `config.activity.clientSecret`), the server resolves identity via `/users/@me`, and WebSocket joins verify **actual guild membership through the bot client** before letting anyone spend that guild's points. `config.activity.devMode` mints browser-testable identities and skips those checks — never enable it on an exposed server. Sessions are transient/in-memory (re-derivable by re-auth, allowed exception to the SQLite rule).
- The client (`web/activity/`, plain browser ES modules like the panel) auto-detects Discord via the `frame_id` query param: inside Discord all requests use the `/.proxy/` path and context comes from the SDK; otherwise a dev-mode identity form appears. `@discord/embedded-app-sdk` is served directly from `node_modules` (its ESM output uses only relative imports — no bundler). Sound effects are synthesized with WebAudio (`sounds.js`) — no audio assets, muting persists in localStorage, and the AudioContext is created lazily on first gesture (autoplay policy).
- Client visuals: static art lives in `web/activity/assets/` (AI-generated, downscaled webp: per-game lobby covers and the Goobster dealer avatar shown at each table, which does a CSS "dealing" flourish on card events). Wagers and the hold'em pot render as chip piles (`chips.js`: greedy denomination stacks, pure CSS), and every broadcast's events drive flying-chip animations (bets fly to the seat, payouts fly from the dealer/bank to winners, lost bets are raked in) in a fixed overlay that survives re-renders. **Bet input rule**: every broadcast fully re-renders the action bar, so the shared amount control (`ui.js` `betAmountControls`) keeps unsubmitted edits and focus in a module-level draft keyed by storage key, restored into the rebuilt input — renderers must clear the bar via `resetActionBar()` (never `replaceChildren()` directly) so focus tracking works. The control has red subtract chips on the left and green add chips on the right (clamped at the table minimum).
- Background music: `GET /api/activity/music/casino` generates a 2-minute instrumental lounge track **once** via the ElevenLabs Music API (`elevenLabsAudioService.generateMusic`, same optional paid plan as `/playmusic`), caches it at `cache/music/casino.mp3`, and serves it from disk thereafter; without a key it returns 404 and the client stays silent (graceful degradation). The client loops it through a dedicated WebAudio gain node with a fade-in, gated on the first user gesture, with an independent 🎵 mute persisted in localStorage. Music and effects are per-viewer — never injected into the voice channel.

### Voice conversations
- `/voicechat` runs live voice sessions with two engines behind one manager (`services/voice/voiceSessionService.js`, one session per guild):
  - **realtime** (default): GPT-Voice-style low latency. Per-user Opus audio streams into ElevenLabs **Scribe v2 Realtime** (`services/voice/scribeRealtimeService.js`, 16kHz mono via `pcmUtils.stereo48kToMono16k`) *while the user is talking*; LLM replies stream token-by-token (`opts.onDelta`) into the ElevenLabs **multi-context TTS WebSocket** (`services/voice/multiContextTTSService.js`), so playback starts on the first sentence. True **barge-in**: a wordful speaker starting to talk (or words detected on a previously-noisy mic) closes the TTS context server-side, stops playback instantly, and the interrupted reply is recorded in history as `[interrupted by a user mid-reply]`. The coordinator lives in `services/voice/realtimeVoiceEngine.js`. Requires only an ElevenLabs key; per-segment fallback to OpenAI batch STT when the realtime API errors and a key is available. Protocol note (verified live): the multi-stream API only emits `isFinal` after `close_context`, so `finish()` sends `flush` + `close_context` together — a closing context still delivers its remaining flushed audio.
  - **classic**: the original batch pipeline — silence-based end-of-utterance capture, batch transcription via `services/transcriptionService.js` (OpenAI `gpt-4o-mini-transcribe`), full reply generation, then ElevenLabs HTTP streaming TTS. Requires OpenAI (STT) and ElevenLabs (TTS) keys.
- Cost/noise guardrails shared by both engines: an RMS energy gate keeps open-mic noise away from paid STT entirely (the realtime engine buffers locally and only opens an STT connection once a chunk crosses the gate), and per-speaker `emptyStreak` tracking stops noisy mics from blocking turn-taking or triggering barge-in.
- Shared turn logic (polite-mode gate, tool interaction context, tool-call execution loop) lives in `services/voice/voiceTurnShared.js` — never duplicate it in an engine.
- **Notification cues** (`services/voice/notificationSounds.js`): both engines play a soft rising chime when a turn is accepted and reply generation begins (after the polite-mode gate — silent turns must stay fully silent), and `executeToolCalls` plays a distinct double-blip once per tool round. Cues are synthesized PCM (no audio assets, no cloud API — same philosophy as the Activity's WebAudio sounds), fire-and-forget, and never throw: playback briefly subscribes its own player and then restores whichever player held the connection (session TTS players pause while unsubscribed, so in-flight speech resumes).
- **Spoken text never contains URLs** (`services/voice/speechText.js`): `stripUrlsForSpeech` sanitizes whole replies inside `elevenLabsTTSService.textToSpeech` (covering voice sessions, `/speak`, the AI DJ, and casino table talk; URL-only text skips synthesis entirely), and the realtime engine routes streamed deltas through `createStreamingUrlStripper`, which holds back the trailing unfinished word so URLs split across LLM deltas are still caught. Conversation history and the text-channel transcript keep the full reply, links included — only the audio path is stripped.
- **Voice tool calling**: voice turns run the same `aiService.chat` + `toolsRegistry` loop as text chat (up to 3 rounds per turn), so users can trigger server functions by speaking — web search (`performSearch`, plus native `opts.webSearch` on OpenAI/Gemini), `rememberFact`/`forgetFact`, `setNickname`, the economy tools (`checkPoints`, `gamblePoints`, `stockQuote`, `tradeStock`, `checkPortfolio`), and (only when the session has a transcript text channel) `generateImage` and `scheduleFollowUp`. The subset is defined once in `voiceTurnShared.js` (`VOICE_TOOL_NAMES`/`TEXT_CHANNEL_TOOL_NAMES`) and exposed via `toolsRegistry.getDefinitions(names)`.
- Tools receive a synthetic interaction context built by `_buildToolContext`: guild/channel/client plus the turn's most recent speaker as `user`/`member`; `reply()`/`editReply()` output from wrapped commands is captured and appended to the tool result so the model voices real outcomes (e.g. permission denials). `playTrack` is deliberately excluded — music playback would destroy the session's own voice connection — as are `speakMessage`/`echoMessage` (redundant when every reply is already spoken).

## Core Features

### Chat Interaction
- Natural language processing with multi-turn conversation memory (stored in SQLite)
- Context-aware responses with automatic conversation summarization
- Command-based and @mention interactions, plus optional dynamic responses
- Message reactions: regenerate, pin, branch, deep dive, summarize

### Music & Audio
- Track downloads via SpotDL/yt-dlp to local storage
- Playlists persisted as JSON on disk, playback queue, AI DJ
- All generated audio via ElevenLabs (optional): TTS, mood music (Music API), and ambient sound loops (Sound Effects API)

### Meme Mode
Meme mode allows users to receive responses with added meme flair and internet culture references.

#### Usage
- `/mememode toggle <true/false>` - Enable or disable meme mode
- `/mememode status` - Check current meme mode status

#### Technical Implementation
- User preferences stored in the `UserPreferences` table (SQLite)
- In-memory caching for 5 minutes
- Affects all AI-generated responses: chat, jokes, poems, search

### Economy & Games
- Named per-guild point currency with wallets, ledger, daily claims, transfers, and leaderboards
- Gambling: coin flips, d20 showdowns, and 5-card poker against the dealer (even money, push on ties)
- Stock trading game: live quotes (keyless Yahoo endpoints, SQLite-cached), buy/sell with points (1 point = $1), tracked cost basis and trade history, portfolio check-ins with P/L, and historical price charts
- Fully operable via slash commands, text chat tools, and live voice sessions

### System Monitoring
- `/systemstatus` reports CPU load, temperature and throttle state (Raspberry Pi), memory, disk, database size, and gateway latency
- Rotating file logs under `logs/` via the shared winston logger (`utils/logger.js`)

### Local management panel (Raspberry Pi touchscreen)
- A touch-optimized web console (800×400 landscape) for **managing the bot**, not chatting with it: browse the guilds Goobster is in, then per guild send exact bot messages, generate AI-drafted messages (private instruction → editable preview → explicit post; the instruction is never posted or persisted), start/stop live voice conversations, control music playback, and manage settings.
- The Settings tab mirrors every per-guild slash-command setting: proactive mode, dynamic responses, search approval, thread preference, AI provider/model/reasoning overrides, the Thoughtful Mode preset, personality directive, bot nickname (DB + best-effort Discord nickname), memory retention (purges immediately like `/privacy retention`), channel memory exclusions (excluding purges stored memories **and** activity counters, like `/privacy exclude`), and forget-all-memories — plus the global ElevenLabs TTS voice (mirrors `/setvoice`: persists to `config.json` and updates the live service). API: `GET`/`PATCH /api/guilds/:id/settings` (partial updates, each key validated like its slash command), `POST .../memory/exclusions`, `POST .../memory/forget`, `POST /api/settings/tts-voice`.
- Architecture: `web/server.js` starts two listeners — the unchanged `/health` server (all interfaces, `PORT`/3000) and the panel server bound to **127.0.0.1 only** (default port 3400; `config.json` `panel: { enabled, port }` or `GOOBSTER_PANEL_PORT`). A Host/Origin guard rejects non-loopback requests. The static client (`web/public/`, no framework, ES modules) and thin routes (`web/panelApi.js`) sit over `services/panelService.js`, which validates all input, resolves live guild/channel objects from the Discord client, and checks the bot's own `ViewChannel`/`SendMessages`/`Connect`/`Speak` permissions before every action. Slash-command interactions are **never** fabricated.
- Errors use `PanelError` (HTTP status + machine-readable code); confirmation-required conflicts return 409 with `requiresConfirmation: true` (moving music between guilds, starting voice chat over active music). Music keeps its single player/queue model: the panel warns and requires confirmation before moving Goobster to another guild, and a live voice-chat session in a guild blocks music there.
- Draft generation reuses the guild's personality (`utils/memeMode.getPromptWithGuildPersonality`), per-guild AI overrides, recent channel messages, and memory recall, with `usageContext: { guildId, userId: null }`.

### Retired Features
The adventure mode (party/story system) and mystery heroes mode were retired to keep the bot lean on low-power hardware. Their commands, services, and database tables were removed.

## Development Standards

### Code Organization
- Modular architecture: commands in `commands/<category>/`, business logic in `services/`, shared helpers in `utils/`, database in `db/`
- The chat pipeline lives in `utils/chatHandler.js` (orchestration only) plus focused modules under `utils/chat/`: `chatDb` (rows/tracking/diagnostics), `chatContext` (context window + summaries), `searchFlow` (legacy search approval + response directives), `reactions`, `responder` (chunked delivery), `threadManager`, `prompts`. New chat features belong in the matching module, not in the orchestrator.
- Clear separation of concerns
- Consistent file structure
- Proper error handling — commands must always answer the interaction, even on failure
- **State that must survive a restart lives in SQLite, not process memory.** Examples: heartbeat mood/cooldowns (`heartbeat_state`), pending search approvals (`pending_search_requests`), search dedup (`pending_searches`). In-memory Maps are only acceptable for transient, re-derivable state.
- Errors re-thrown from catch blocks must attach the original error as `cause` (`throw new Error(msg, { cause: error })`).

### Documentation
- Clear and concise comments (explain intent, not mechanics)
- JSDoc for functions and classes
- README files for major components
- Keep this document authoritative and current

### Testing
- Unit tests for core functionality (Jest). Specs live in `tests/*.test.js`; DB-backed specs point `GOOBSTER_DB_PATH` at a throwaway file (see `tests/privacyService.test.js`)
- Smoke test: every module must `require()` cleanly with an empty/minimal config — enforced by `npm run smoke` (`scripts/smoke-require.js`)
- Lint: `npm run lint` (ESLint flat config in `eslint.config.js`) must pass with zero errors
- CI (`.github/workflows/ci.yml`) runs lint + smoke + Jest on every push/PR
- Integration tests for key features

### Security
- Input validation at system boundaries
- Rate limiting
- Secure API key handling (config.json and .env are gitignored)
- Permission management (admin-only commands check permissions)

### Performance (Raspberry Pi constraints)
- Target < 500MB RSS at idle
- Prefer synchronous SQLite (better-sqlite3) over network round trips
- In-memory caches with TTL for hot settings (guild settings, meme mode)
- Avoid architecture-specific binaries; native modules must build or ship prebuilts for ARM64
- Slash command registration is skipped when unchanged (hash cache) to avoid Discord rate limits on frequent reboots

## Project Goals

### Short Term
- Improve response quality
- Harden self-hosted operation (systemd/PM2, monitoring)
- Enhance user experience
- Optimize performance on constrained hardware

### Long Term
- Fully offline operation option (Ollama + local TTS)
- Advanced AI features
- Build community tools

## Contributing
Please follow these guidelines when contributing:
1. Follow the code style guide
2. Write comprehensive tests
3. Document your changes
4. Submit detailed PRs
