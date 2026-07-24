# Changelog

## 2026-07-24

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

