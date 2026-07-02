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
- Memory writes are fire-and-forget (never block or fail a reply); recall injects a `LONG-TERM MEMORY` block into the system prompt, excluding content already in the active context window.
- Vectors are only compared when produced by the same embedding model; per-guild storage is capped (default 5000 entries) and admins can inspect/clear via `/memory`.

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
- Schema note: `db/index.js` has a minimal column-migration helper (`applyColumnMigrations`) because `schema.sql` only creates missing tables; new columns on existing tables must be added there.

### Voice conversations
- `/voicechat` runs live voice sessions: `services/voice/voiceSessionService.js` captures per-user Opus audio (silence-based end-of-utterance), transcribes via `services/transcriptionService.js` (OpenAI `gpt-4o-mini-transcribe`), generates replies through the normal `aiService` stack, and speaks them with ElevenLabs TTS.
- One session per guild; utterances are processed sequentially so the bot never talks over itself. Requires an OpenAI key (STT) and ElevenLabs key (TTS).

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

### Retired Features
The adventure mode (party/story system) and mystery heroes mode were retired to keep the bot lean on low-power hardware. Their commands, services, and database tables were removed.

## Development Standards

### Code Organization
- Modular architecture: commands in `commands/<category>/`, business logic in `services/`, shared helpers in `utils/`, database in `db/`
- Clear separation of concerns
- Consistent file structure
- Proper error handling — commands must always answer the interaction, even on failure

### Documentation
- Clear and concise comments (explain intent, not mechanics)
- JSDoc for functions and classes
- README files for major components
- Keep this document authoritative and current

### Testing
- Unit tests for core functionality (Jest)
- Smoke test: every module must `require()` cleanly with an empty/minimal config
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
