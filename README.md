# Goobster

A self-hostable AI workspace where conversation, computation, knowledge,
collaboration, and initiative share one persistent substrate. Discord is
the original front door; the browser portal is a first-class room of the
same house. Optimized for a **Raspberry Pi 4B**: local SQLite by default,
system FFmpeg, and every cloud integration optional.

The distinctive product is not “a bot that can call tools.” It is a
closed cognitive loop:

**Study / Parlor → Observatory Projects → Spitball → Attention → conversation**

A project conversation can cause work, produce artifacts, alter a
knowledge graph, schedule future work, and later surface an outcome.
Model output proposes; deterministic code enforces permissions, budgets,
provenance, confidence bounds, and state transitions.

## Table of Contents

- [The cognitive loop](#the-cognitive-loop)
- [Also in the house](#also-in-the-house)
- [Documentation](#documentation)
- [Prerequisites](#prerequisites)
- [Configuration](#configuration)
- [Installation](#installation)
  - [Raspberry Pi Installation](#raspberry-pi-installation)
  - [Docker Installation](#docker-installation)
  - [Manual Installation](#manual-installation)
- [Running as a Service](#running-as-a-service)
- [Automatic Updates](#automatic-updates)
- [Usage](#usage)
- [Development](#development)
- [Contributing](#contributing)
- [License](#license)

## The cognitive loop

### Study and the Parlor

The portal Study is the same chat pipeline Discord uses (shared DM
memory, streaming, Thoughtful Mode, attachments). The **Parlor** is a
multi-persona workspace: each seat keeps a private tag-first knowledge
base, grounds every reply in its own notes, and files what it learns.
A one-prompt quickstart designs the cast. Goobster can operate a parlor
from chat via `manageParlor`.

### Observatory Projects

A **Project** is the aggregate for one piece of work: a durable
workspace, versioned assets, checkpointed jobs, triggers, collaborators,
project knowledge, and a shared project parlor. The Observatory *is*
this feature. Jobs run through the sandbox (persistence, never new
execution powers). Triggers schedule future work. Collaborators sit at
the project table; the built-in Goobster seat acts as the member who
spoke and writes back into the project’s Spitball. See
`documentation/projects.md`.

### Spitball and Expeditions

**Spitball** is the user-facing name for the knowledge graph (Notes,
Connections, Tags, Sources, Map, Reflect). An **Expedition** is
deliberate autonomous research: seed → plan → sources → claims →
legalized notes → leads → the next cycle. Evidence is persisted before
any note exists; “why does this note say this?” always has an answer.
See `documentation/spitball_expeditions.md`.

### Attention

Asking and scheduling both start with the user. **Attention** is the
path that does not: something changes → he notices → compares it against
what matters to you → decides whether intervention is worthwhile → acts,
asks, nudges, or stays silent. Silence is the feature. Enrollment is
explicit (`/attention enable`); nobody is messaged because a feature
shipped. See `documentation/attention.md`.

### Conversation closes the loop

Guild chat, DMs, the portal, automations, watches, and project parlor
turns all go through the same agent loop and the same tool registry.
A watch that fires, a trigger that runs, or an expedition that finishes
can land as an Attention notice and come back as a conversation — with
provenance still attached.

## Also in the house

These stay first-class; they are no longer the shape of the product.

- **Privacy that is provable:** `/what-do-you-know-about-me`,
  `/forget-me`, retention windows, per-channel exclusions. Everything
  lives on hardware you own.
- **Long-term memory and Server Wrapped:** local embeddings, `/recall`,
  counts-only activity stats.
- **The Goobster Tavern:** a persistent tabletop RPG in Discord, playable
  with no AI key (`documentation/tavern_adventure_mode.md`).
- **Point economy and the Jimbucks Exchange:** named currency, gambling,
  stocks, margin, options, perps, the Goblin Wheel
  (`documentation/jimbucks_exchange.md`).
- **GitHub + Cursor agents:** watched repos, mission-control threads,
  confirmation-gated writes (`documentation/github_cursor_integration.md`).
- **Music and voice:** SpotDL/yt-dlp, playlists, ElevenLabs TTS/music/
  ambience, `/voicechat`.
- **Deployment:** lite (one process, SQLite) or full (Postgres +
  pgvector + bot + api + nginx). npm workspaces; core never imports an
  app.

## Documentation

Authoritative conventions live in
`documentation/development_standards_and_project_goals.md`. Architecture
decisions from the hardening cycle live in `documentation/adr/`.

| Topic | Doc |
| --- | --- |
| Projects / Observatory | `documentation/projects.md` |
| Attention | `documentation/attention.md` |
| Spitball Expeditions | `documentation/spitball_expeditions.md` |
| Web portal | `documentation/webapp_setup.md` |
| Raspberry Pi | `documentation/raspberry_pi_guide.md` |
| Continuous deploy | `documentation/continuous_deployment.md` |
| Docker | `documentation/docker_deployment.md` |
| Architecture | `documentation/architecture.md` |

## Prerequisites

- Node.js v20 or higher (v22 recommended)
- FFmpeg (`sudo apt install ffmpeg`)
- A Discord bot token ([Discord Developer Portal](https://discord.com/developers/applications))
- Optional: [Ollama](https://ollama.com) for local AI chat with no cloud dependency
- Optional: OpenAI / Anthropic / Gemini / Perplexity / ElevenLabs / Spotify API keys

## Configuration

Copy `config.example.json` to `config.json` and fill in your values. Only the Discord credentials are required — everything else degrades gracefully:

```json
{
    "clientId": "<discord bot client id>",
    "guildIds": ["<discord server id>"],
    "token": "<discord bot token>",
    "DEFAULT_PROMPT": "You are Goobster, a quirky and clever Discord bot.",

    "openaiKey": "<optional - openai API key>",
    "anthropicKey": "<optional - anthropic API key>",
    "ollama": {
        "host": "http://127.0.0.1:11434",
        "model": "llama3.2:3b"
    },
    "perplexity": { "apiKey": "<optional - enables web search>" },
    "spotify": { "clientId": "<optional>", "clientSecret": "<optional>" },
    "elevenlabs": { "apiKey": "<optional - enables TTS + audio generation>", "voiceId": "21m00Tcm4TlvDq8ikWAM" }
}
```

AI keys may also come from the environment (`OPENAI_API_KEY`,
`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `PERPLEXITY_API_KEY`,
`ELEVENLABS_API_KEY`). Discord credentials are read from `config.json`
only.

### Audio via ElevenLabs

A single ElevenLabs API key (config `elevenlabs.apiKey` or the `ELEVENLABS_API_KEY` env var) powers all generated audio:

- **Text-to-speech** (`/speak`, `/voice` replies, AI DJ announcements)
  - `voiceId` accepts either a voice ID (e.g. `21m00Tcm4TlvDq8ikWAM` — Rachel, the default) or a voice name from your voice library (e.g. `Rachel`), which is resolved automatically.
  - `modelId` defaults to `eleven_flash_v2_5` (low latency); use `eleven_multilingual_v2` for the highest quality.
  - Change the voice at runtime with `/setvoice` (admin) or per-message with the `voice` option on `/speak`.
- **Mood music** (`/playmusic`, `/generatemusic`) — generated with the ElevenLabs Music API (`music_v2`) and cached under `cache/music/`. Note: the Music API requires a paid ElevenLabs plan.
- **Ambient sounds** (`/playambience`, `/generateambience`) — generated as seamless loops with the ElevenLabs Sound Effects API and cached under `data/ambience/`.

## Installation

### Raspberry Pi Installation

One-shot installer (Raspberry Pi OS 64-bit, Bookworm):

```bash
git clone https://github.com/nervous-rob/goobster.git
cd goobster
./scripts/install-rpi.sh --service   # --service also installs the systemd unit
# Edit config.json with your Discord token
sudo systemctl start goobster
```

For local AI with no cloud dependency:

```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama pull llama3.2:3b
```

See `documentation/raspberry_pi_guide.md` for details.

### Docker Installation

**Lite** (default — one container, SQLite, bot + portal in-process). The
Dockerfile is multi-arch (amd64 and arm64):

```bash
git clone https://github.com/nervous-rob/goobster.git
cd goobster
# Create config.json first
docker build -t goobster .
docker run -d --name goobster \
    -v ./config.json:/app/config.json:ro \
    -v goobster-data:/app/data \
    -v goobster-logs:/app/logs \
    goobster
```

Or `docker compose up -d --build` from the repo root (same lite path).

**Full** (postgres + bot + api + nginx, ≥4GB RAM, USB SSD for the database):

```bash
cp deploy/.env.example deploy/.env   # set POSTGRES_PASSWORD and GOOBSTER_INTERNAL_TOKEN
# config.json must have webapp.enabled = true
docker compose -f deploy/docker-compose.yml up -d --build
```

Only nginx is published (`localhost:3000`). Point a tunnel at that port
the same way as today. See `documentation/docker_deployment.md`.

### Manual Installation

```bash
git clone https://github.com/nervous-rob/goobster.git
cd goobster
npm install
# Create config.json (see Configuration)
npm run db-init
npm start
```

## Running as a Service

**systemd** (recommended on Raspberry Pi):

```bash
sudo cp deploy/goobster.service /etc/systemd/system/   # adjust paths/user inside first
sudo systemctl daemon-reload
sudo systemctl enable --now goobster
journalctl -u goobster -f
```

**PM2**:

```bash
pm2 start ecosystem.config.js
pm2 save && pm2 startup
```

## Automatic Updates

Keep a Pi in sync with `main` without logging in. A systemd timer checks the
deploy branch every 5 minutes and, when it has moved, stops the bot, pulls,
reinstalls dependencies, reloads systemd, restarts the service, and waits for
`/health` — rolling back to the previous commit if the new one does not come up.

```bash
./scripts/install-rpi.sh --auto-update     # install + enable the timer
sudo ./scripts/auto-update.sh --check      # is a deploy pending? (exit 10 = yes)
sudo systemctl start goobster-update       # deploy right now
journalctl -u goobster-update -f
```

Settings live in `/etc/goobster-update.conf` (branch, health URL, Discord
notification webhook, whether to require green CI before deploying). See
`documentation/continuous_deployment.md` for the full guide, including push
triggers for near-instant deploys.

**Production should set `GOOBSTER_REQUIRE_CI=true`.** Combined with a
GitHub ruleset that requires both `test (sqlite)` and `test (postgres)`
on `main`, that is the difference between “merged” and “merged and
green on both engines.” The script defaults to off so an unconfigured
box still deploys; the default is not a recommendation.

## Usage

### Available Commands

Use `/help` in Discord to see all available commands, organized by categories:
- 💭 Chat Commands - AI conversation and prompts
- 🎵 Music Commands - Background music control
- 🎤 Voice Commands - Text-to-speech
- 🔍 Search Commands - Web search functionality
- 💰 Economy Commands - `/points`, `/gamble`, `/stocks`, `/margin`, `/options`, `/futures`, `/orders`, `/predict`, `/wheel`, `/exchange`
- 🛠️ Utility Commands - Bot configuration, `/systemstatus`, help
- 🔔 Attention - `/attention enable|status|inbox` (per person, DM-capable)

### Portal

Set `"webapp": { "enabled": true }` in `config.json` and open `/app/`
(run `npm run build:web` first). Dev mode mints a session without
OAuth. Rooms: Study, Parlor, Observatory (Projects), Spitball
(including Expeditions), Noticed (Attention), plus Exchange, Workshop,
and Tasks.

### Voice Features

1. Join a voice channel
2. Use voice commands to:
    - Convert text to speech: `/speak <text>`
    - Change the global TTS voice (admin): `/setvoice <voice>`

### Music and Ambience

1. Join a voice channel
2. Download tracks using SpotDL: `/spotdl download <url>`
3. Play tracks and manage playlists: `/playtrack play <track_name>`, `/playtrack queue`, `/playtrack playlist_play <playlist_name>`
4. Play generated background music: `/playmusic <mood>` (requires ElevenLabs)
5. Play ambient sounds: `/playambience <type>`

## Development

npm workspaces (`packages/core`, `apps/bot`, `apps/api`, `apps/sandbox`,
`apps/web`). Core must never import an app.

```bash
npm test                  # Jest unit tests (SQLite; no keys or network)
npm run test:postgres     # same suite against local Postgres + pgvector
npm run test:e2e          # Playwright portal journeys (needs build:web + Chromium)
npm run test:e2e:install  # download Chromium once
npm run test:coverage     # 80% gate on utils + slash commands only
npm run lint
npm run smoke             # every module must require() cleanly
npm run typecheck:web && npm run build:web
```

CI (`.github/workflows/ci.yml`) runs lint, smoke, typecheck, the web
build, and `npm test` on **both** engines, plus a separate
`test (playwright)` job. A change must pass on both database engines.

```bash
npm run build:web   # Vite → apps/web/dist
npm run dev:web     # Vite on :5173, proxies /api to :3000
```

Set `"webapp": { "enabled": true, "devMode": true }` in `config.json` and
open `/app/`. See `documentation/webapp_setup.md`.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Push to the branch
5. Create a Pull Request

Both database CI jobs should stay green. Prefer a hardening fix over a
new subsystem when the edit would grow `toolsRegistry.js`, `appApi.js`,
`parlorService.js`, or `projectService.js` — split or extend the module
that already owns that capability.

## License

MIT License - See LICENSE file for details
