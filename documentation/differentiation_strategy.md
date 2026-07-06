# Goobster Differentiation Strategy

> **Goobster is a private, self-hosted Discord companion with long-term memory — not a generic command bot.**

## Context

The user asked: given Goobster's current feature set (AI chat with OpenAI/Gemini/Ollama, voice chat via OpenAI STT + ElevenLabs TTS, music generation/playback, self-hosted SQLite/Pi infrastructure), what else could the bot do to stand out in the saturated AI Discord bot market?

This is a strategy/ideation document grounded in a codebase audit — several capabilities beyond the README feature list already exist and shape what's worth building next.

## Who this is for

**Target servers:**
- D&D / tabletop groups (voice + narration + music/ambience are already core strengths)
- Small-to-mid friend servers that want a bot with personality and memory, not a utility box
- Homelab / privacy-first communities who self-host on Pis and run Home Assistant

**Explicit non-targets:** large moderation-heavy public servers (MEE6/Dyno territory — scale, dashboards, and mod tooling are their moat, not ours) and servers wanting a hosted SaaS bot with zero setup.

## What already exists (beyond the pasted feature list)

The audit found substantial hidden differentiators already in the repo:

- **Semantic long-term memory** — `services/memoryService.js` + `services/embeddingService.js` (OpenAI or Ollama embeddings, cosine recall from SQLite)
- **Distilled facts / user dossiers** — `services/factsService.js`, nightly `services/memoryConsolidationService.js`
- **Proactive "heartbeat"** — `services/heartbeatService.js` (bot chimes into active channels on its own, with per-guild proactive modes)
- **Self-scheduled follow-ups** — `services/followupService.js` ("ask Rob tomorrow how the deploy went")
- **User-defined cron automations** — `services/automationService.js` + `/automation`
- **Channel digests** (`/digest`), **usage/cost tracking** (`/usage`), **intent detection**, **thoughtful mode**
- **Vision input** — image attachments on mentions and the `/chat` `image` option are already understood by all three providers (OpenAI passes URLs; Gemini/Ollama inline base64)
- **AI tool registry** — `utils/toolsRegistry.js`: performSearch, generateImage, playTrack, rememberFact/forgetFact, scheduleFollowUp, setNickname, speakMessage, echoMessage, executePlan

## Differentiation thesis

Goobster can't out-scale MEE6/Midjourney-style SaaS bots on generic features. Its winnable niche is the intersection of two things almost no bot occupies:

1. **A persistent "member of the server," not a command responder** — memory + facts + heartbeat already point here.
2. **Genuinely self-hosted and private, on hardware people already own** — the Pi 4B + SQLite + Ollama story.

Every recommendation below deepens one of those two moats.

## Recommended standout directions (ranked)

### Tier 1 — highest leverage, builds directly on existing code

1. **Server memory as a product: "ask the server anything" + Server Wrapped**
   The embedding recall in `memoryService.js` is currently used to enrich chat context. Expose it directly: `/recall what did we decide about the minecraft server?`, auto-answer repeated questions (FAQ deflection), "on this day" retrospectives from the heartbeat, and a yearly/monthly **Server Wrapped** (Spotify-Wrapped-style stats card via the existing image generator + usage/digest data). Nobody else can do this because SaaS bots can't afford to store and embed full server history — a self-hosted bot with local SQLite can. First in the order because it's the fastest visible win with the lowest technical risk.
   *Success metrics: /recall weekly active users; FAQ deflection rate (repeated questions answered without a human).*
   *GTM artifact: monthly Wrapped share card designed to be screenshotted and reposted — every card is an ad.*

2. **Privacy controls as product features, not just positioning**
   Make "private and self-hosted" *provable*: `/what-do-you-know-about-me` (dump the user's facts + memory summary, building on `factsService.js` dossiers), `/forget-me` (full per-user erasure — extends the existing forgetFact tool), per-guild/per-channel retention settings, and memory scope controls (channels the bot may not remember). Ships alongside #1 since exposing memory publicly demands user control over it.
   **`/forget-me` deletion scope (explicit, to avoid ambiguity later):** the schema holds user-attributed data in more places than the memory system, and all of them are in scope —
   - **Delete:** `memory_embeddings` rows (by `authorId`), `facts` rows with `subjectType='USER'` and matching `subjectId`, pending `followups` created by or about the user, conversation history (`messages` via `createdBy`, the user's `conversations`), `user_nicknames`, `UserPreferences`, and finally the `users` row itself.
   - **Anonymize:** `usage_log` rows (`userId` nulled, token counts kept) so cost accounting stays intact.
   - **Review, don't blind-delete:** `facts` rows with `subjectType='GUILD'` and `conversation_summaries` may mention the user by name without carrying their ID. `/forget-me` should scan these for the user's username/nicknames and delete (or re-summarize) matches — this is the hard 10% and must not be silently skipped.
   *Success metrics: % of guilds that touch a privacy setting; zero unresolved "delete my data" gaps.*
   *GTM artifact: a "what Goobster knows about me → forget me → empty" screen-recording clip for the README and r/selfhosted.*

3. **Scene director mode: TTS narration + generated music + ambience, orchestrated**
   The pieces all exist separately (ElevenLabs TTS, `services/voice/musicService.js`, `services/voice/ambientService.js`, the retired adventure system's DNA). Combine them into a D&D/session-runner mode where the bot narrates, cross-fades mood music, and layers ambience as the story shifts. Tabletop groups are a huge, underserved Discord population and this is a demo that markets itself.
   **Pi constraint to validate up front:** adventure mode was retired specifically to keep the bot lean on low-power hardware (< 500MB RSS target), and this mode runs up to three concurrent audio pipelines (TTS + music crossfade + ambience) through FFmpeg on a Pi 4B. Prototype the audio mixing first and measure CPU/RSS before committing to the full feature.
   *Success metrics: scene sessions per week; average session duration; CPU/RSS headroom on Pi 4B during a session.*
   *GTM artifact: a 60-second demo clip of a narrated scene with music crossfade — made for tabletop Discords/subreddits.*

4. **Fully offline voice stack ("no cloud hears your server")**
   STT currently requires OpenAI (`services/transcriptionService.js`) and TTS requires ElevenLabs. Add local fallbacks — whisper.cpp (tiny/base models) for STT and Piper for TTS — mirroring the existing OpenAI→Ollama chat fallback pattern in `services/aiService.js`. A 100% offline voice assistant living in a Discord voice channel on a $60 board is a genuine market first and completes the README's "every cloud integration optional" promise (and the standards doc's existing long-term goal of "fully offline operation option"). Deliberately last in Tier 1: it's the biggest moat but carries the highest latency/quality risk on a Pi 4B, so it lands better as phase 2/3 after visible wins have shipped. Ship with a Pi 4B benchmark table.
   *Success metrics: % of interactions served fully local (measurable today via the `provider` column in `usage_log`); median STT/TTS latency on Pi 4B.*
   *GTM artifact: "local-only badge" screenshot + the benchmark table itself — homelab audiences share benchmarks.*

### Tier 2 — strong differentiators, moderate new surface area

5. **Home Assistant / MQTT bridge** — the self-hosting Pi audience overlaps almost perfectly with Home Assistant users. A `controlDevice` tool in `toolsRegistry.js` ("goobster, turn off the office lights") makes Discord the chat interface to the house. No mainstream bot does this because SaaS bots can't reach a LAN — Goobster lives on it.
   **Security guardrails are a launch requirement, not a follow-up:** device/entity allowlists in config, Discord role-based permission checks per action, explicit confirmation prompts for risky actions (locks, garage, climate), and an audit log table in SQLite recording who triggered what. The same guardrail layer should gate any future plugin-provided tools.
   *Success metrics: guilds with the bridge enabled; zero unauthorized-action reports.*

6. **Community rituals engine** — daily trivia/word games with persistent SQLite leaderboards, birthday tracking (facts service already stores per-user facts), prediction bets on server events, running-gag callbacks surfaced by the heartbeat. This converts the memory system into daily-active-use habits.
   *Success metrics: D7 retention of ritual participants after launch; daily game participation rate.*

7. **LAN web dashboard** — the Express health endpoint in `index.js` already exists; grow it into a small local dashboard: live logs, memory/facts browser ("what does Goobster know about me?"), usage costs, playback queue, config editing. Doubles as a privacy/transparency feature that reinforces the self-hosted story.

### Tier 3 — worth noting

8. **Plugin/skill system** — a `skills/` directory of drop-in tool modules auto-registered into `toolsRegistry.js`, turning Goobster from a bot into a platform others extend. Plugin tools must pass through the same permission/allowlist/audit guardrails as #5.
9. **Proactive image reactions** — vision *input* already works (attachments on mentions, `/chat` `image` option, reply-to-edit via `utils/imageDetectionHandler.js`); the actual gap is reacting to images posted *without* a mention — e.g. the heartbeat or dynamic-response path noticing a meme and chiming in. Gemini and Ollama (llava) make the inference nearly free; the work is in the trigger path and rate-limiting, not the vision itself.
10. **Voice wake-word / always-listening companion mode** — extends #4; heavier Pi CPU budget concern, prototype after local STT lands.

## Not now (explicitly deferred)

To keep the roadmap disciplined, these stay off the board until Tier 1 has shipped and metrics exist:

- **Wake-word / always-listening mode** — depends on local STT landing first, and the Pi CPU budget is unproven. Revisit after the offline-voice benchmark table exists.
- **Full plugin system / marketplace** — a platform play before the product has an audience is scope creep. The guardrail layer built for the Home Assistant bridge is the prerequisite; the plugin system inherits it later.

## Roadmap framing

- **Now:** `/recall`, Server Wrapped MVP, privacy commands (`/what-do-you-know-about-me`, `/forget-me`, retention settings), and fixing the test runner (see Verification)
  - ✅ Shipped: `/recall` (with channel-visibility filtering and a `command_log` usage counter surfaced in `/usage`), `/what-do-you-know-about-me`, `/forget-me` (full deletion scope below, incl. the name-mention review pass and a post-erasure audit), `/privacy` retention + channel exclusions, and real Jest specs (`npm test` passes).
  - ⏳ Still open in "Now": Server Wrapped MVP.
- **Next:** Scene Director MVP (audio-pipeline Pi benchmark first)
- **Later:** Offline voice beta + Pi 4B benchmark table; then Home Assistant bridge with guardrails

## Baseline metrics (capture at week 0, before anything ships)

KPI targets are fuzzy without a baseline. Week-0 capture uses the existing `usage_log` table (`services/usageTracker.js`) plus a few new counters; anything not yet instrumented is recorded as TBD and instrumented as part of the "Now" phase.

| Metric | Current baseline | Source |
|---|---|---|
| /recall WAU | TBD (week 0) | new command counter |
| FAQ deflection rate | TBD (week 0) | new counter |
| Guilds touching a privacy setting | TBD (week 0) | guild settings table |
| Scene sessions/week, avg duration | TBD (week 0) | new session log |
| % fully-local interactions | TBD (week 0) | `usage_log` provider column |
| STT/TTS median latency (Pi 4B) | TBD (week 0) | benchmark script |
| D7 retention (ritual participants) | TBD (week 0) | new participation log |

## Implementation conventions (repo-specific, easy to miss)

- New columns on **existing** tables must go through `applyColumnMigrations` in `db/index.js` — `db/schema.sql` only creates missing tables. New tables go in `schema.sql` as usual.
- `documentation/development_standards_and_project_goals.md` is the authoritative standards doc and must be updated as each Tier 1 feature lands ("keep this document authoritative and current").
- Model IDs and API keys always resolve through `config/aiConfig.js`; never hardcode a model in a service or command.

## If implementation is requested next

Start with **/recall + privacy commands** — additive, reuses the memory/facts patterns already in the codebase, and independently shippable on its own feature branch.

## Verification (for any implemented follow-up)

- `npm run dev` with a test guild config (see AGENTS.md for the config.json bootstrap); confirm `Ready! Logged in as <tag>`
- Exercise the new command/tool end-to-end in a test guild; for voice features, join a voice channel and confirm audio round-trip
- For privacy commands: verify `/forget-me` leaves zero user-attributed rows across memories, embeddings, facts, follow-ups, conversation history, nicknames, and preferences, and that usage rows are anonymized
- `npm test` — **currently fails with "No tests found, exiting with code 1"** (the scripts in `tests/` don't match jest's default `*.test.js` pattern and `passWithNoTests` isn't set). The "Now" phase must either add real Jest specs for the new services (preferred) or configure `passWithNoTests` as a stopgap
