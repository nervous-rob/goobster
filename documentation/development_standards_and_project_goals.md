# Development Standards and Project Goals

## Project Overview
Goobster is a self-hostable Discord bot designed to provide engaging AI chat, helpful utilities, music playback, and fun features for users. This edition is optimized to run on low-power hardware such as a **Raspberry Pi 4B**, with no mandatory cloud dependencies.

## Architecture Principles

### Self-hosted first
- **Local SQLite database** (better-sqlite3, WAL mode) — no external database server. All schema lives in `db/schema.sql` and is applied automatically when the database opens.
- **Local file storage** for music (`data/music`), playlists (`data/playlists`), and images (`data/images`) — no cloud blob storage.
- **System FFmpeg** for all audio work (multi-arch, including ARM64) — never binary-only npm packages that ship a single architecture.
- **Graceful degradation**: every cloud integration (OpenAI, Gemini, Perplexity, ElevenLabs, Spotify) is optional. Missing credentials must produce a warning and disable the feature — never a startup crash.

### Database access
- All database access goes through the `db/` module: `db.get(sql, params)`, `db.all(sql, params)`, `db.run(sql, params)`, and `db.transaction(fn)`.
- SQL is written natively for SQLite (UPSERT via `ON CONFLICT`, `LIMIT`, `datetime('now', ...)`, `CURRENT_TIMESTAMP`, `RETURNING`).
- Named parameters use the `@name` style. Values are normalized automatically (booleans → 0/1, Date → UTC text, objects → JSON).
- Discord snowflake IDs are stored as **TEXT** (they exceed JavaScript's safe integer range).
- Timestamps are stored as UTC text (`YYYY-MM-DD HH:MM:SS`).

### AI providers
- `services/aiService.js` routes between providers: **OpenAI** (default when configured), **Gemini**, and **Ollama** (local LLM, used automatically as fallback when no cloud provider is configured).
- All model IDs and API keys are resolved through `config/aiConfig.js` (environment first, then `config.json`, then defaults). Never hardcode a model ID in a service or command.
  - Defaults: OpenAI chat `gpt-5.4-mini`, thoughtful mode `gpt-5.5` (high reasoning effort), images `gpt-image-2`, Gemini `gemini-3.5-flash`, Perplexity `sonar-pro`.
- Provider contract — every provider implements:
  - `chat(messages, opts)` → `{ content: string, toolCalls: [{ id, name, arguments }] }` (never a raw SDK response).
  - `generateText(prompt, opts)` → `string`.
  - `isConfigured()`, `setDefaultModel(name)`, `getDefaultModel()`.
  - Accepted message roles: `system`, `user`, `assistant` (optionally carrying `toolCalls`), and tool results as `{ role: 'tool', toolCallId, name, content }`.
  - `opts.onDelta(textDelta)` enables streaming; providers invoke it per text chunk and still return the full normalized result.
- OpenAI uses the **Responses API** (`client.responses.create`) — not Chat Completions or the legacy `functions` parameter. Reasoning models (GPT-5 family, o-series) must not receive `temperature`/`top_p`; use `reasoning: { effort }`.
- Tool calling: OpenAI and Gemini use native function calling; Ollama uses the prompt-based JSON protocol from `utils/toolPromptBuilder.js`. Shared tool guidance lives in that module — never duplicate tool prompts inside a provider.
- Web search: OpenAI (`web_search` built-in tool) and Gemini (Search Grounding) search natively mid-response via `opts.webSearch`; the legacy detect-and-approve Perplexity flow only runs for providers without native search (Ollama). Perplexity remains the backend for the `performSearch` tool and `/search` command.
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

### Voice conversations
- `/voicechat` runs live voice sessions with two engines behind one manager (`services/voice/voiceSessionService.js`, one session per guild):
  - **realtime** (default): GPT-Voice-style low latency. Per-user Opus audio streams into ElevenLabs **Scribe v2 Realtime** (`services/voice/scribeRealtimeService.js`, 16kHz mono via `pcmUtils.stereo48kToMono16k`) *while the user is talking*; LLM replies stream token-by-token (`opts.onDelta`) into the ElevenLabs **multi-context TTS WebSocket** (`services/voice/multiContextTTSService.js`), so playback starts on the first sentence. True **barge-in**: a wordful speaker starting to talk (or words detected on a previously-noisy mic) closes the TTS context server-side, stops playback instantly, and the interrupted reply is recorded in history as `[interrupted by a user mid-reply]`. The coordinator lives in `services/voice/realtimeVoiceEngine.js`. Requires only an ElevenLabs key; per-segment fallback to OpenAI batch STT when the realtime API errors and a key is available. Protocol note (verified live): the multi-stream API only emits `isFinal` after `close_context`, so `finish()` sends `flush` + `close_context` together — a closing context still delivers its remaining flushed audio.
  - **classic**: the original batch pipeline — silence-based end-of-utterance capture, batch transcription via `services/transcriptionService.js` (OpenAI `gpt-4o-mini-transcribe`), full reply generation, then ElevenLabs HTTP streaming TTS. Requires OpenAI (STT) and ElevenLabs (TTS) keys.
- Cost/noise guardrails shared by both engines: an RMS energy gate keeps open-mic noise away from paid STT entirely (the realtime engine buffers locally and only opens an STT connection once a chunk crosses the gate), and per-speaker `emptyStreak` tracking stops noisy mics from blocking turn-taking or triggering barge-in.
- Shared turn logic (polite-mode gate, tool interaction context, tool-call execution loop) lives in `services/voice/voiceTurnShared.js` — never duplicate it in an engine.
- **Voice tool calling**: voice turns run the same `aiService.chat` + `toolsRegistry` loop as text chat (up to 3 rounds per turn), so users can trigger server functions by speaking — web search (`performSearch`, plus native `opts.webSearch` on OpenAI/Gemini), `rememberFact`/`forgetFact`, `setNickname`, and (only when the session has a transcript text channel) `generateImage` and `scheduleFollowUp`. The registry exposes this subset via `toolsRegistry.getDefinitions(names)`.
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
