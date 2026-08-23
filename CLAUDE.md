# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What Goobster is

A self-hostable Discord bot (discord.js v14, Node >= 20, CommonJS) with AI chat, a browser portal, long-term semantic memory, a tabletop-RPG mode, a point economy with a full exchange (margin/options/futures), music/voice, and GitHub/Cursor integrations. It targets low-power hardware (Raspberry Pi 4B): local SQLite by default, system FFmpeg, and **every cloud integration optional with graceful degradation** — missing credentials produce a warning and disable the feature, never a startup crash.

The authoritative conventions document is `documentation/development_standards_and_project_goals.md`. Read the relevant section before changing the database layer, AI providers, memory, chat routing, or privacy code. `AGENTS.md` covers environment-setup caveats and how to exercise subsystems headlessly (attention sweeps, sandbox runs, Spitball expeditions, the portal without a bot token).

## Commands

```bash
npm test                          # Jest unit tests (no config, keys, or network needed)
npx jest tests/attentionService.test.js       # single test file
npx jest -t "name substring"                  # single test by name
npm run lint                      # ESLint flat config, zero errors, max 60 warnings
npm run smoke                     # every module must require() cleanly with minimal config
npm run typecheck:web             # tsc --noEmit for the React client
npm run build:web                 # Vite build → apps/web/dist (served at /app)
npm run test:integration          # needs a real config.json with credentials
npm run dev                       # nodemon apps/bot/index.js (does NOT deploy slash commands)
npm start                         # deploy-commands then apps/bot/index.js
npm run db-init                   # creates data/goobster.sqlite (schema is also applied on every DB open)
```

CI (`.github/workflows/ci.yml`) runs lint, smoke, typecheck:web, build:web, and `npm test` twice — once on SQLite and once on Postgres (`GOOBSTER_DB_URL` set, pgvector image). A change must pass on **both engines**.

Test notes:
- Only `tests/*.test.js` are Jest specs. The `tests/test*.js` files are standalone manual scripts — do not convert or run them under Jest.
- Jest's `globalSetup` writes a placeholder `config.json` if missing, and suites use a throwaway SQLite file via `GOOBSTER_DB_PATH`. Tests inject fake providers/pipelines/gateways instead of hitting the network.
- Coverage thresholds (80% global) apply to `packages/core/utils/**` and `apps/bot/commands/**` when running `npm run test:coverage`.

`config.json` (gitignored, from `config.example.json`) is **required to run the bot**: Discord credentials (`token`, `clientId`, `guildIds`) are read from it only — not from env. AI/integration keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `PERPLEXITY_API_KEY`, `ELEVENLABS_API_KEY`) are also read from env via `packages/core/config/aiConfig.js`.

## Monorepo layout

npm workspaces (`packages/*`, `apps/*`):

- **`packages/core`** (`@goobster/core`) — everything shared: `services/` (~75 domain services), `utils/` (chat pipeline, handlers), `db/` (database facade), `config/` (config resolution), `gateway/` (the Discord gateway seam), `web/` (portal backend).
- **`apps/bot`** — the Discord client: `index.js` entry, `commands/<category>/` slash commands, `events/` (`interactionCreate.js`, `messageCreate.js`), `web/` (HTTP layer: health, portal hosting, Activity, internal gateway API).
- **`apps/api`** — split-deployment web backend: portal against Postgres + a `RemoteGateway` to the bot. Refuses SQLite; requires `GOOBSTER_DB_URL` and `GOOBSTER_INTERNAL_TOKEN`.
- **`apps/sandbox`** — the sandboxed code-execution runner (port 3200, shared-secret auth).
- **`apps/web`** — React portal client (TypeScript, Vite, TanStack Router/Query). The only TypeScript in the repo; everything else is CommonJS JavaScript.

**Boundary rule (ESLint-enforced):** core must never import from any app. Apps import `@goobster/core/...`; never the other way around.

Two deployment profiles: **lite** (one process, SQLite — the default; the bot serves the portal in-process) and **full** (`deploy/docker-compose.yml`: postgres + bot + api + nginx), selected by `GOOBSTER_DB_URL`.

## Key architecture and invariants

### Database facade (`packages/core/db/`)
All data access goes through the async facade: `await db.get/all/run/insert(sql, params)` and `await db.transaction(async (tx) => ...)` (use the `tx` handle inside; nesting becomes savepoints). Rules:
- Write SQL in the **SQLite dialect** (`@name` params, `datetime('now')`, `ON CONFLICT`, `RETURNING`); the Postgres adapter translates at prepare time. Engine-specific SQL lives **only** in `db/dialect.js` — never fork on `db.engine` elsewhere.
- Use `db.insert()` for new-row ids (`lastInsertRowid` is SQLite-only).
- Never fire-and-forget a write a later read depends on — un-awaited `db.run()` happens synchronously on SQLite but not on Postgres.
- Discord snowflakes are stored as **TEXT**; timestamps as UTC text (`YYYY-MM-DD HH:MM:SS`).
- All schema lives in `db/schema.sql`, applied/verified automatically on DB open.

### Discord gateway seam (`packages/core/gateway/`)
Web-reachable core code never touches discord.js directly — it talks to the small `DiscordGateway` interface (`LocalGateway` wraps the live client; `RemoteGateway` is an HTTP client to the bot's `/internal/gateway/*` API). Reads throw `GatewayUnavailableError` when the bot is unreachable; callers degrade (DM-scoped features keep working, guild panes return `BOT_OFFLINE`) rather than crash. `sendDm`/`sendToChannel` never throw.

### AI providers (`services/aiService.js`)
Routes between OpenAI, Anthropic, Gemini, and Ollama (local fallback; auto-detect in that order). Every provider implements the same contract (`chat(messages, opts)` → `{ content, toolCalls }`, `generateText`, streaming via `opts.onDelta`, `opts.reasoning_effort`). Rules:
- **Cloud-provider parity**: never add a capability to one cloud provider without the others.
- Model IDs and keys resolve through `config/aiConfig.js` (env → config.json → defaults). Never hardcode a model ID in a service or command.
- Callers size `opts.max_tokens` for the visible reply only; thinking headroom is added by `utils/aiTokenBudget.js`. Don't hand-inflate `max_tokens`.
- Tool-calling chat turns go through `runAgentLoop` in `utils/chat/agentOrchestrator.js` (bounded rounds, guaranteed user-facing answer). Never reintroduce an inline tool loop; extend the orchestrator. LangChain-the-dependency was evaluated and rejected.
- OpenAI uses the Responses API; Anthropic uses the Messages API via plain `fetch` (no SDK).

### Memory and privacy
`memoryService` stores embeddings in `memory_embeddings`, mirrored into per-dimension `vec0` virtual tables via **sqlite-vec** (pgvector on Postgres), with brute-force fallback when the extension can't load. **Every deletion path for memories must clean orphaned vectors** (`memoryService.cleanupVecIndex()`) — derived embeddings never outlive their memories. Privacy commands (`/forget-me`, `/what-do-you-know-about-me`, retention windows) are load-bearing features; new per-user data stores must be reachable by the erasure path (`privacyService`).

### DM scope rule
Everything keyed on `guildId` uses the synthetic scope `dm:<userId>` (`utils/dmScope.js`) in DMs. Never store DM data under a NULL or shared guild id.

### Guild message routing
`apps/bot/events/messageCreate.js` is the only gate for when Goobster answers, and its order matters: agent mission-control threads → reply-to-edit → explicit address → reply detection (`utils/replyDetection.js`) → opt-in dynamic-response scoring.

### Tavern / Adventure mode
Campaigns are YAML files under `campaigns/`, validated on load; server operators drop overrides into `data/tavern/campaigns/`. The game is fully playable with no AI key (deterministic rules + authored prose); AI adds narration. Related services live in `services/tavern/`.

## Code style

- CommonJS (`require`/`module.exports`), 4-space indent, ESLint flat config in `eslint.config.js`. Empty catch blocks for best-effort cleanup are intentional and allowed.
- Browser-facing clients (panel, Activity, legacy web app under `apps/bot/web/`) are ES modules — the ESLint config carves them out separately.
- Runtime state lives under `data/` and `logs/` (gitignored); transient re-derivable state stays in memory, not SQLite.
