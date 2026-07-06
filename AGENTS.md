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
  (`OPENAI_API_KEY`, `GEMINI_API_KEY`, `PERPLEXITY_API_KEY`, `ELEVENLABS_API_KEY`) ARE read from
  env by `config/aiConfig.js` / root `config.js`, so those can come from injected secrets.
  Build `config.json` from secrets before starting, e.g.:
  ```bash
  [ -f config.json ] || cat > config.json <<JSON
  {
    "clientId": "${DISCORD_CLIENT_ID}",
    "guildIds": [${DISCORD_GUILD_IDS:-\"\"}],
    "token": "${DISCORD_BOT_TOKEN}",
    "DEFAULT_PROMPT": "You are Goobster, a quirky and clever Discord bot.",
    "ai": { "provider": "" }
  }
  JSON
  ```
  (`ai.provider` empty = auto-detect: OpenAI if `OPENAI_API_KEY` set, else Gemini, else Ollama.)

- **`npm run lint` currently fails: no ESLint config exists** in the repo (ESLint 8 needs
  `.eslintrc*`). This is a pre-existing repo gap, not an environment issue.

- **`npm test` exits 1 with "No tests found"** — there are no Jest test files yet (the `tests/`
  folder holds standalone manual scripts, not Jest specs). Use `jest --passWithNoTests` if a
  zero-exit is needed.

- **Local Ollama inference (`ollama serve`) segfaults in this VM** (`llama-server ... segmentation
  fault`), across multiple small models and with flash-attention disabled. The AI *routing* layer
  (`services/aiService.js` → `ollamaService.js`) works, but local generation does not complete here.
  For an end-to-end chat demo, use a cloud provider key (`OPENAI_API_KEY` or `GEMINI_API_KEY`)
  rather than the local Ollama fallback.

- The bot exposes an Express health endpoint at `http://localhost:3000/health`. On invalid Discord
  token, `index.js` logs in, fails with `TokenInvalid`, and calls `process.exit(1)` — a real bot
  token is required to stay connected.
