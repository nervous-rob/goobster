# AGENTS.md

## Cursor Cloud specific instructions

Goobster is a self-hostable Node.js Discord bot using discord.js, a local SQLite database
(`better-sqlite3`), system FFmpeg, and pluggable AI providers (OpenAI / Anthropic / Gemini /
local Ollama). All cloud integrations are optional and degrade gracefully.

**Repo layout.** This is an npm-workspaces monorepo (`packages/*`, `apps/*`). Shared code —
services, the chat pipeline, the database facade, config resolution, the Discord gateway seam,
and the portal backend — lives in `packages/core` (`@goobster/core`). The apps are `apps/bot`
(the Discord client; entry `apps/bot/index.js`), `apps/api` (the split deployment's web
backend), `apps/sandbox` (the code-execution runner), and `apps/web` (the React portal client,
the only TypeScript in the repo). The default *lite* deployment is still a single process:
`apps/bot` serves the portal in-process against SQLite. Apps import core; core must never
import an app, and that boundary is ESLint-enforced.

Standard commands live in `package.json` and `README.md`; prefer those. Key ones:
- Dev run: `npm run dev` (nodemon `apps/bot/index.js`) — does NOT call `deploy-commands`.
- Prod-style run: `npm start` (runs `apps/bot/deploy-commands.js` then `apps/bot/index.js`).
- DB init: `npm run db-init` (creates `data/goobster.sqlite`; `packages/core/db/schema.sql` is also applied automatically on every DB open).
- Tests: `npm test` / `npm run test:integration`. Lint: `npm run lint`.
  Portal browser journeys: `npm run build:web && npm run test:e2e`
  (Playwright + Chromium; first time run `npm run test:e2e:install`).

### Non-obvious caveats (discovered during setup)

- **`config.json` is required and gitignored.** It stays at the repo root (the bot resolves it
  through `packages/core/runtimePaths.js`). `apps/bot/index.js` and `apps/bot/deploy-commands.js`
  read Discord credentials (`token`, `clientId`, `guildIds`) from `config.json` **only** — NOT
 from env vars.
 The VM starts without it, so create it before running the bot. AI/integration keys
 (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `PERPLEXITY_API_KEY`,
 `ELEVENLABS_API_KEY`) ARE read from env by `packages/core/config/aiConfig.js` /
 `packages/core/config.js`, so those can come from injected secrets.
  Build `config.json` from secrets before starting (guild id may be a bare id or a JSON array;
  snowflakes must be quoted strings):
  ```bash
  if [ ! -f config.json ]; then
    case "$DISCORD_GUILD_IDS" in
      \[*) GID_JSON="$DISCORD_GUILD_IDS" ;;   # already a JSON array
      *)   GID_JSON="[\"$DISCORD_GUILD_IDS\"]" ;;
    esac
    cat > config.json <<JSON
  {
    "clientId": "${DISCORD_CLIENT_ID}",
    "guildIds": ${GID_JSON},
    "token": "${DISCORD_BOT_TOKEN}",
    "DEFAULT_PROMPT": "You are Goobster, a quirky and clever Discord bot.",
    "ai": { "provider": "" }
  }
  JSON
  fi
  ```
  (`ai.provider` empty = auto-detect: OpenAI if `OPENAI_API_KEY` set, else Anthropic, else
 Gemini, else Ollama.)
  Then `npm run deploy-commands` registers slash commands to the guild, and `npm run dev`
  (or `node apps/bot/index.js`) starts the bot. A successful connect logs
  `Ready! Logged in as <tag>`.

- **Lint, smoke, typecheck, build, and tests all pass and are enforced in CI**
  (`.github/workflows/ci.yml`), across two jobs. The `test (sqlite)` job runs `npm run lint`
  (ESLint flat config in `eslint.config.js`, zero errors required), `npm run smoke` (every module
  must `require()` cleanly with a minimal config), `npm run typecheck:web`, `npm run build:web`,
  and `npm test`. The `test (postgres)` job re-runs `npm test` against a pgvector container with
  `GOOBSTER_DB_URL` set, so a change has to pass on **both** database engines.

- **Local Postgres 17 + pgvector is available for the engine-parity suite.**
  `scripts/ensure-local-postgres.sh` is idempotent (install packages, start the
  cluster even when systemd is offline, create role/db `goobster`/`goobster`,
  enable `vector` + `citext`). `npm test` stays on throwaway SQLite; do **not**
  export `GOOBSTER_DB_URL` globally. After the script reports ready:
  ```bash
  npm run test:postgres
  # or a single file:
  GOOBSTER_DB_URL=postgres://goobster:goobster@127.0.0.1:5432/goobster \
    GOOBSTER_PG_TEST_ISOLATE=1 npx jest tests/projectTriggerService.test.js
  ```
  Isolated PG schemas apply the full `schema.sql` on a suite's first query, so
  `tests/setup/perSuite.js` raises the Jest timeout to 20s when `GOOBSTER_DB_URL`
  is set. Never bind `datetime('now', @param)` — the dialect only rewrites
  literal modifiers; compute UTC `YYYY-MM-DD HH:MM:SS` in JS and bind the text.

- **`npm test` runs the Jest specs in `tests/*.test.js`** (e.g. `privacyService.test.js`,
  `memoryVecIndex.test.js`) and must pass. They use a throwaway SQLite file via `GOOBSTER_DB_PATH`,
  so no config or network is needed. The other `tests/test*.js` files are standalone manual
  scripts, not Jest specs. Playwright lives in `e2e/*.spec.js` and is not part of `npm test`.

- **Portal Playwright journeys need Chromium and a built React client.**
  `e2e/server.js` mounts `createWebAppApp(createWebAppContext({ gateway, config:
  { webapp: { enabled: true, devMode: true } } }))` against a throwaway SQLite
  file — no Discord token. Run `npm run build:web` then `npm run test:e2e`.
  First time on a machine: `npm run test:e2e:install` (`npx playwright install
  --with-deps chromium`). CI's `test (playwright)` job does the same. The
  `both engines` aggregator does not wait on this job.

- **Memory recall uses the sqlite-vec extension** (loaded in `packages/core/db/index.js`, prebuilts for x64 and
 ARM64) with per-dimension `memory_vec_<dims>` virtual tables, falling back to a brute-force
 scan when the extension can't load. If you add a deletion path for `memory_embeddings`, call
 `memoryService.cleanupVecIndex()` afterwards so vectors don't outlive their memories.

- **The attention system is opt-in per person and needs no Discord token to exercise.**
 `documentation/attention.md` is the spec. Nothing runs until somebody has an
 `attention_policies` row (`/attention enable`), so a fresh database is inert by design — if a
 sweep seems to do nothing, check enrollment first. Everything except delivery works headless:
 `attentionService.sweepUser({ policy, gateway })` takes any object with `sendDm`, and
 `personalHeartbeatService` accepts a fake client, so the whole pipeline (generators, scoring,
 triage, notices, calibration) can be driven from a plain Node script against a throwaway
 SQLite file. Watches fire off `domainEventBus`, so `observatoryService._finishJob(jobId,
 'COMPLETED')` is enough to exercise a real condition end to end — but a fake DM channel needs
 `messages: { fetch: async () => [] }` as well as `send`, because the chat pipeline reads recent
 history through it. To browser-test the **Noticed** pane without a bot token, mount
 `createWebAppApp(createWebAppContext({ gateway, config: { webapp: { enabled: true, devMode:
 true } } }))` — both exported from `packages/core/web/appApi.js` — on a plain express app; it
 serves the built React client from `apps/web/dist` (run `npm run build:web` first).
 Note the score bands in `packages/core/config/attentionConfig.js` are calibrated to the range
 `U × I × C × A − K` can actually reach (~0.12/0.28/0.45/0.75) — respacing them across `[0, 1]`
 silently makes every band above `inbox` unreachable.

- **Music downloads (`/spotdl`, `/play url:`) need `spotdl` and `yt-dlp`.** The Cloud
  environment install puts them in `~/.local/goobster-venv` (same path as
  `scripts/install-rpi.sh` / `scripts/ensure-music-cli.sh`). The bot auto-discovers
  that venv plus `~/.local/bin` and `/opt/venv`. The snapshot this VM booted from
  did not include those CLIs, and `python3-venv` is not on the base image — install
  `python3.12-venv` first or `python3 -m venv` fails with `No module named ensurepip`.
  A `CLI not found` error that lists every candidate as missing means the environment
  snapshot is stale; Save a new environment after the music-CLI install lands.

- **The sandbox Python toolkit needs two apt packages in this VM.** `npm run sandbox-python`
  builds a venv at `data/sandbox/venv` (gitignored) from the catalog in `packages/core/config/sandboxPackages.js`
  — core numerics/plotting plus the `astro` and `imaging` bundles, ~700 MB, ~30 s from a warm
  network. The VM ships without `ensurepip`, so the venv creation fails until
  `sudo apt install -y python3.12-venv`; add `sudo apt install -y bubblewrap` to exercise the
  strongest isolation rung (otherwise runs fall back to `unshare -rn`). Both installs are quick.
  A sandbox run can be driven straight from Node without Discord: enable
  `require('@goobster/core/config/sandboxConfig').enabled`, then `sandboxService.run({ language:
  'python', code, userId, projectDir })`.

- **Spitball Expeditions run end to end in this VM.** The autonomous research
 subsystem (`documentation/spitball_expeditions.md`; services
 `spitballExpedition*`, pipeline `spitballResearchPipeline`) is exercisable
 headless: create an expedition with `spitballExpeditionService.createExpedition`
 and drive it with `spitballExpeditionRunner.kick(id)` against a throwaway
 SQLite file — the pipeline needs `OPENAI_API_KEY` (or another provider key)
 for real research, and works with just Wikipedia when `PERPLEXITY_API_KEY`
 is absent. Tests inject fake pipelines/providers (see
 `tests/spitballResearchPipeline.test.js`), so `npm test` needs no keys or
 network. In the portal it is Spitball → Expeditions (a *focused* live run
 completes in about a minute with real keys).

- **Local Ollama inference (`ollama serve`) segfaults in this VM** (`llama-server ... segmentation
  fault`), across multiple small models and with flash-attention disabled. The AI *routing* layer
  (`packages/core/services/aiService.js` → `packages/core/services/ollamaService.js`) works, but
  local generation does not complete here.
  For an end-to-end chat demo, use a cloud provider key (`OPENAI_API_KEY` or `GEMINI_API_KEY`)
  rather than the local Ollama fallback.

- The bot exposes an Express health endpoint at `http://localhost:3000/health` (served by
 `apps/bot/web/server.js`). On invalid Discord token, `apps/bot/index.js` logs in, fails with
 `TokenInvalid`, and calls `process.exit(1)` — a real bot token is required to stay connected.

- **Web app browser testing**: set `"webapp": { "enabled": true, "devMode": true }` in `config.json`
 and open `http://localhost:3000/app/` — dev mode mints a session for any snowflake-shaped user id
 without OAuth (real Discord OAuth needs a public `webapp.publicUrl` + portal redirect, unavailable
 in this VM). Guild-scope dashboard routes verify real guild membership through the bot client, so
 use an id that is actually a member of the connected guild (e.g. the guild owner) to exercise
 guild scopes and the knowledge-graph view (Manage Server gated).
