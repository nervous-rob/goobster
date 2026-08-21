# AGENTS.md

## Cursor Cloud specific instructions

Goobster is a **single service**: a self-hostable Node.js Discord bot (`index.js`) using discord.js,
a local SQLite database (`better-sqlite3`), system FFmpeg, and pluggable AI providers
(OpenAI / Gemini / local Ollama). All cloud integrations are optional and degrade gracefully.

Standard commands live in `package.json` and `README.md`; prefer those. Key ones:
- Dev run: `npm run dev` (nodemon `index.js`) — does NOT call `deploy-commands`.
- Prod-style run: `npm start` (runs `deploy-commands.js` then `index.js`).
- DB init: `npm run db-init` (creates `data/goobster.sqlite`; `db/schema.sql` is also applied automatically on every DB open).
- Tests: `npm test` / `npm run test:integration`. Lint: `npm run lint`.

### Non-obvious caveats (discovered during setup)

- **`config.json` is required and gitignored.** `index.js` and `deploy-commands.js` read Discord
  credentials (`token`, `clientId`, `guildIds`) from `config.json` **only** — NOT from env vars.
 The VM starts without it, so create it before running the bot. AI/integration keys
 (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `PERPLEXITY_API_KEY`,
 `ELEVENLABS_API_KEY`) ARE read from env by `config/aiConfig.js` / root `config.js`, so those
 can come from injected secrets.
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
  (or `node index.js`) starts the bot. A successful connect logs `Ready! Logged in as <tag>`.

- **Lint, smoke, and tests all pass and are enforced in CI** (`.github/workflows/ci.yml`):
  `npm run lint` (ESLint flat config in `eslint.config.js`, zero errors required),
  `npm run smoke` (every module must `require()` cleanly with a minimal config), and `npm test`.

- **`npm test` runs the Jest specs in `tests/*.test.js`** (e.g. `privacyService.test.js`,
 `memoryVecIndex.test.js`) and must pass. They use a throwaway SQLite file via `GOOBSTER_DB_PATH`,
 so no config or network is needed. The other `tests/test*.js` files are standalone manual
 scripts, not Jest specs.

- **Memory recall uses the sqlite-vec extension** (loaded in `db/index.js`, prebuilts for x64 and
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
 true } } }))` on a plain express app; it serves the built React client from `apps/web/dist`.
 Note the score bands in `config/attentionConfig.js` are calibrated to the range
 `U × I × C × A − K` can actually reach (~0.12/0.28/0.45/0.75) — respacing them across `[0, 1]`
 silently makes every band above `inbox` unreachable.

- **The sandbox Python toolkit needs two apt packages in this VM.** `npm run sandbox-python`
  builds a venv at `data/sandbox/venv` (gitignored) from the catalog in `config/sandboxPackages.js`
  — core numerics/plotting plus the `astro` and `imaging` bundles, ~700 MB, ~30 s from a warm
  network. The VM ships without `ensurepip`, so the venv creation fails until
  `sudo apt install -y python3.12-venv`; add `sudo apt install -y bubblewrap` to exercise the
  strongest isolation rung (otherwise runs fall back to `unshare -rn`). Both installs are quick.
  A sandbox run can be driven straight from Node without Discord: enable
  `require('./config/sandboxConfig').enabled`, then `sandboxService.run({ language: 'python',
  code, userId, projectDir })`.

- **Local Ollama inference (`ollama serve`) segfaults in this VM** (`llama-server ... segmentation
  fault`), across multiple small models and with flash-attention disabled. The AI *routing* layer
  (`services/aiService.js` → `ollamaService.js`) works, but local generation does not complete here.
  For an end-to-end chat demo, use a cloud provider key (`OPENAI_API_KEY` or `GEMINI_API_KEY`)
  rather than the local Ollama fallback.

- The bot exposes an Express health endpoint at `http://localhost:3000/health`. On invalid Discord
 token, `index.js` logs in, fails with `TokenInvalid`, and calls `process.exit(1)` — a real bot
 token is required to stay connected.

- **Web app browser testing**: set `"webapp": { "enabled": true, "devMode": true }` in `config.json`
 and open `http://localhost:3000/app/` — dev mode mints a session for any snowflake-shaped user id
 without OAuth (real Discord OAuth needs a public `webapp.publicUrl` + portal redirect, unavailable
 in this VM). Guild-scope dashboard routes verify real guild membership through the bot client, so
 use an id that is actually a member of the connected guild (e.g. the guild owner) to exercise
 guild scopes and the knowledge-graph view (Manage Server gated).
