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

- **Local Ollama inference (`ollama serve`) segfaults in this VM** (`llama-server ... segmentation
  fault`), across multiple small models and with flash-attention disabled. The AI *routing* layer
  (`services/aiService.js` → `ollamaService.js`) works, but local generation does not complete here.
  For an end-to-end chat demo, use a cloud provider key (`OPENAI_API_KEY` or `GEMINI_API_KEY`)
  rather than the local Ollama fallback.

- The bot exposes an Express health endpoint at `http://localhost:3000/health`. On invalid Discord
  token, `index.js` logs in, fails with `TokenInvalid`, and calls `process.exit(1)` — a real bot
  token is required to stay connected.
