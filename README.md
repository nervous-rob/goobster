# Goobster

A self-hostable AI workspace where conversation, computation, knowledge,
collaboration, and initiative share one persistent substrate. It runs as
a browser portal with **no Discord at all**, or with Discord connected as
an additional front door. Designed for small hosts, including a
**Raspberry Pi 4B**, with SQLite by default, system FFmpeg, and optional
cloud integrations. This is a deployment target, not a measured capacity
claim for concurrent users, local models or local voice.
See [Where your data goes](#where-your-data-goes) for what that does and
does not mean for privacy.

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
- [Where your data goes](#where-your-data-goes)
- [Documentation](#documentation)
- [Ways to run it](#ways-to-run-it)
- [Prerequisites](#prerequisites)
- [Configuration](#configuration)
- [Installation](#installation)
  - [Standalone Installation (no Discord)](#standalone-installation-no-discord)
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
this feature. Jobs (shown as **Runs**) run through the sandbox
(persistence, never new execution powers). Triggers schedule future work.
Collaborators sit at the project table; the built-in Goobster seat acts
as the member who spoke and writes back into the project’s Spitball.
Organizing projects is on by default; running code in them needs
`observatory.enabled` and the sandbox. In the portal each project has its
own address (`/projects/<owner>/<slug>/<view>`) with Overview, Plan,
Conversation, Knowledge, Files, Apps, Runs, People and Automations views.
See `documentation/projects.md`.

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

- **Privacy you can inspect:** `/what-do-you-know-about-me`,
  `/forget-me`, retention windows, per-channel exclusions, and a settings
  and report export. Data is stored on the host you run; see
  [Where your data goes](#where-your-data-goes) for what leaves it.
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
- **Self-knowledge:** Goobster reads his own documentation. The Markdown
  in this repository is seeded into the database on every start and
  consulted through the `consultDocs` tool - including skill guides for
  troubleshooting, project examples, and working guidelines
  (`documentation/self_knowledge.md`).
- **Deployment:** lite (one process, SQLite) or full (Postgres +
  pgvector + bot + api + nginx). npm workspaces; core never imports an
  app.

## Where your data goes

Self-hosted storage does not mean all processing stays local. Plainly:

- **Stored on your host.** Chats, memory, knowledge, projects, files and
  settings live in the installation's database (SQLite or Postgres) and
  `data/` directory.
- **Sent to the providers you configure.** Model requests go to whichever
  of OpenAI, Anthropic, Gemini or Ollama answers them, with the context the
  turn needs (messages, retrieved notes and memories, attachments). Web
  search, speech, image, music and integration providers (Perplexity,
  ElevenLabs, GitHub, Notion, Spotify, ...) receive what their feature
  sends them. Research runs query public sources (Wikipedia, arXiv, and
  Perplexity when configured) with the topic being researched. Discord,
  when connected, carries the messages exchanged there.
- **Local model processing.** With `ai.provider: "ollama"`, Ollama on the
  host for chat and embeddings, and no cloud keys in config or the
  environment, chat, memory, knowledge retrieval (BM25),
  projects and the Tavern's deterministic rules run without a cloud
  model provider. Voice, Perplexity web search, image generation and
  generated audio are unavailable in that setup today. Research still
  queries public sources without a Perplexity key. Fully offline use also
  means avoiding web/research tools and remote integrations and restricting
  outbound network access; removing keys alone is not an offline switch.
- **Readable by the host operator.** Whoever runs the installation can read
  its database and files. The application keeps each account's private
  data separate from other accounts (adversarial isolation testing is
  tracked in issue #247); it does not hide data from the operator.
- **What the privacy commands guarantee.** `/what-do-you-know-about-me` and
  `/forget-me` report and erase a person's data inside this installation,
  with an audit that checks nothing is left behind. They cannot recall data
  already sent to an external provider, they do not reach into backup
  archives made before the erasure, and they are not a compliance
  certification. **There is no automatic archive expiry:** the host must
  choose, enforce and disclose a backup-retention window. Older archives
  can retain erased data indefinitely if the host does not rotate them.
  Only `config.json` is encrypted in an archive; the database and files
  need protected storage. See the authoritative
  [backup privacy contract](documentation/backup_and_restore.md#privacy).

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
| Self-knowledge (`consultDocs`) | `documentation/self_knowledge.md` |
| Application identity (principals, accounts, invitations, native sign-in, verified email, outbound mail) | `documentation/identity.md` |
| Running without Discord (adapter switch, assistant identity, the Inbox, runtime modes, people discovery) | `documentation/independent_runtime.md` |
| Backup and tested restore (`npm run backup` / `npm run restore`, the paused instance, the recovery test) | `documentation/backup_and_restore.md` |
| The work ledger (failures, resource events, operator audit, cost per accepted result) | `documentation/work_ledger.md` |
| Shared-instance roadmap handoff (what shipped, where the next steps hook in) | `documentation/shared_instance_handoff.md` |
| Private single-user pilot (task, measurements, cycle record and exit decision) | `documentation/pilot_plan.md` |
| Owner-judged research evaluation (30 fixed-evidence questions, optional live runner and review artifacts) | `documentation/research_evaluation.md` |

### Planned product work

The [shared-instance product plan](documentation/shared_instance_product_spec.md)
defines the next invitation-only multi-user release: clearer navigation,
Discord-independent accounts, private data boundaries, and shared resource limits.
Its first increments have shipped - application identity (principals,
accounts, the `identity:report` migration tooling), native sign-in
(operator invitations, login name + password, audited recovery, Discord
connect/disconnect, the Host room) behind `identity.nativeLogin`, and an
optional verified email per account (sign in by email, self-service password
reset, and `identity.registration: "open"` sign-up) once an outbound mail
provider is configured (`mail.*`: SMTP or Resend); see
`documentation/identity.md`. The assistant also runs with **no Discord at
all**: `apps/api` in standalone mode serves the portal with chat, memory,
tasks, projects, and an in-app **Inbox** where reminders, task results,
watch reports, and invitations land (Discord DMs become an optional echo);
members find each other by name; see `documentation/independent_runtime.md`.
The [guided tutorial spec](documentation/guided_tutorials_spec.md) covers each
room's demonstrations and independent skip, resume, and reset behavior.
[Naming exploration](documentation/product_naming_exploration.md) records
candidate directions without selecting a new name. These are plans, not
instructions for features already available in the app.

## Ways to run it

| Shape | Discord | Process | Database | Start |
|---|---|---|---|---|
| **Standalone** | None | `apps/api` serves the portal and runs the schedulers | SQLite or Postgres | `node apps/api` |
| **Lite** (default install) | Required | `apps/bot` runs the Discord adapter and serves the portal in-process | SQLite | `npm start` |
| **Full** | Required | postgres + bot + api + nginx (`deploy/docker-compose.yml`) | Postgres + pgvector | `docker compose -f deploy/docker-compose.yml up -d` |

**Without Discord** you get the portal's Chat, Knowledge (including
Research), Projects, Discussions, Activity (Inbox, Attention, Scheduled)
and memory; results land in the in-app Inbox. Discord-only features (slash
commands, server scopes, the trading game, music and voice channels, the
Tavern in a channel) report that Discord is not connected. See
[`documentation/independent_runtime.md`](documentation/independent_runtime.md)
for the standalone setup and
[`documentation/identity.md`](documentation/identity.md) for creating
operator and member accounts.

## Prerequisites

- Node.js v20 or higher (v22 recommended)
- FFmpeg (`sudo apt install ffmpeg`)
- A Discord bot token ([Discord Developer Portal](https://discord.com/developers/applications)),
  only for the lite profile or to connect Discord
- Optional: [Ollama](https://ollama.com) for local AI chat with no cloud dependency
- Optional: OpenAI / Anthropic / Gemini / Perplexity / ElevenLabs / Spotify API keys

## Configuration

For a new standalone installation, create `config.json` with this minimum
configuration. Keep the HTTP example on a private local connection. Before
remote access, set `publicUrl` to your actual HTTPS origin and proxy to
port 3100. `apps/api` listens on that port; protect it from direct public
access. Existing installations should merge the relevant keys into their
configuration instead of replacing it.

```json
{
    "discord": { "enabled": false },
    "webapp": {
        "enabled": true,
        "devMode": false,
        "publicUrl": "http://localhost:3100"
    },
    "identity": {
        "nativeLogin": true,
        "requireAccount": true,
        "registration": "invite"
    }
}
```

Add the provider settings you use from `config.example.json`: for example,
`openaiKey`, `anthropicKey`, `googleAIKey`, or local `ollama.host` and
`ollama.model`. Without a configured, reachable model, sign-in and stored
content still work, but AI work needs one. Email is optional for an
invitation-based first operator; it enables verified email and self-service
recovery later. See [identity](documentation/identity.md).

To add Discord, set `discord.enabled: true` and supply `token`, `clientId`
and `guildIds`; use the lite or full profile below. Never set `devMode` on
a deployed instance. AI keys may also come from the environment (`OPENAI_API_KEY`,
`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `PERPLEXITY_API_KEY`,
`ELEVENLABS_API_KEY`). Discord credentials are read from `config.json`
only.

Anthropic chat uses five-minute prompt caching by default; standalone text
jobs do not. Set `ANTHROPIC_PROMPT_CACHING=false` to disable it. Usage reports
cache reads and writes separately, within the total input count. See
[Anthropic prompt caching](documentation/anthropic_prompt_caching.md) for
controls, tradeoffs, and measurement.

### Audio via ElevenLabs

A single ElevenLabs API key (config `elevenlabs.apiKey` or the `ELEVENLABS_API_KEY` env var) powers all generated audio:

- **Text-to-speech** (`/speak`, `/voice` replies, AI DJ announcements)
  - `voiceId` accepts either a voice ID (e.g. `21m00Tcm4TlvDq8ikWAM` — Rachel, the default) or a voice name from your voice library (e.g. `Rachel`), which is resolved automatically.
  - `modelId` defaults to `eleven_flash_v2_5` (low latency); use `eleven_multilingual_v2` for the highest quality.
  - Change the voice at runtime with `/setvoice` (admin) or per-message with the `voice` option on `/speak`.
- **Mood music** (`/playmusic`, `/generatemusic`) — generated with the ElevenLabs Music API (`music_v2`) and cached under `cache/music/`. Note: the Music API requires a paid ElevenLabs plan.
- **Ambient sounds** (`/playambience`, `/generateambience`) — generated as seamless loops with the ElevenLabs Sound Effects API and cached under `data/ambience/`.

## Installation

### Standalone Installation (no Discord)

```bash
git clone https://github.com/nervous-rob/goobster.git
cd goobster
npm ci
npm run build:web
# Create config.json using Configuration above; add your model settings.
```

Before starting the service, create the first operator with the
[local, one-time invitation procedure](documentation/independent_runtime.md#first-operator-without-discord).
It uses the normal native registration screen, needs no Discord identity
or email service, and refuses an installation that already has an account.
Then start the portal:

```bash
GOOBSTER_RUNTIME_MODE=standalone npm run start:api
```

Open the generated invitation link, register, and confirm the Host room is
available. The API applies the database schema on startup. Check
`http://localhost:3100/health` for standalone mode and disabled Discord.
Keep the token cap unset for a single-user pilot unless you choose to set
one. Complete the [dated restore test](documentation/backup_and_restore.md#the-recovery-test)
on the actual host before starting the [pilot](documentation/pilot_plan.md).

The Raspberry Pi installer, Docker defaults, `npm start` and the systemd
example below start the **Discord adapter**. For standalone service
management, use `npm run start:api` with the same working directory,
configuration and database as the setup above; do not run both processes
against one SQLite file.

### Raspberry Pi Installation

One-shot installer (Raspberry Pi OS 64-bit, Bookworm):

```bash
git clone https://github.com/nervous-rob/goobster.git
cd goobster
./scripts/install-rpi.sh --service   # --service also installs the systemd unit
# Edit config.json: add Discord credentials for this lite-profile service.
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
OAuth. Destinations: Home, Chat, Knowledge (Notes, Map, Research),
Projects, Discussions, Activity (Inbox, Attention, Scheduled) and Tools
(Music Lab, Trading game, Card decks), plus Usage & limits, Settings and
the operator's Host room. Older room names and paths still resolve
(`documentation/portal_navigation.md`). Without a bot token, `node apps/api`
serves the same portal in standalone mode
(`documentation/independent_runtime.md`).

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
npm run test:group -- core  # one named CI group (see tests/ciGroups.js)
npm run test:live         # optional live provider checks; skips unset keys
npm run test:e2e          # Playwright portal journeys (needs build:web + Chromium)
npm run test:e2e:install  # download Chromium once
npm run test:coverage     # 80% gate on utils + slash commands only
npm run lint
npm run smoke             # every module must require() cleanly
npm run docs:check        # every doc parses for the self-knowledge corpus
npm run typecheck:web && npm run build:web
```

CI (`.github/workflows/ci.yml`) runs lint, smoke, typecheck, the web
build, and the named Jest groups on **both** engines, plus a separate
`test (playwright)` job. A change must pass on both database engines. Live
provider tests run on trusted `main` pushes and manual dispatch; they
skip when secrets are absent and never replace mocked coverage.

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
