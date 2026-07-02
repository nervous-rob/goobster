# Goobster

## Description

A feature-rich, **self-hostable** Discord chatbot built on Discord.js, featuring AI-powered chat (cloud or fully local via Ollama), intelligent web search, dynamic audio capabilities, and voice interaction. This edition is optimized to run on low-power hardware such as a **Raspberry Pi 4B**: it uses a local SQLite database, local file storage, and system FFmpeg, with every cloud integration optional.

## Table of Contents

- [Features](#features)
- [Documentation](#documentation)
- [Prerequisites](#prerequisites)
- [Configuration](#configuration)
- [Installation](#installation)
  - [Raspberry Pi Installation](#raspberry-pi-installation)
  - [Docker Installation](#docker-installation)
  - [Manual Installation](#manual-installation)
- [Running as a Service](#running-as-a-service)
- [Usage](#usage)
- [Development](#development)
- [Contributing](#contributing)
- [License](#license)

## Features

### AI & Chat
- AI-powered chat using OpenAI, Google Gemini, or a **local LLM via Ollama** (no cloud required)
- Automatic fallback to Ollama when no OpenAI key is configured
- Intelligent web search using Perplexity AI (optional) with enhanced formatting
- Multi-turn dialogue support with conversation memory (local SQLite)
- Customizable chat prompts, per-guild personality directives, meme mode
- Configurable thread preferences (use threads or respond in channel)
- Message reactions: regenerate, pin, branch, deep dive, summarize

### Audio System
- Music downloads via SpotDL/yt-dlp to local storage
- Playlists persisted locally, playback queue, AI DJ
- Mood-based music generation via ElevenLabs Music (optional)
- Ambient sound effects via ElevenLabs Sound Effects (forest, ocean, tavern, camp)
- Text-to-speech using ElevenLabs (optional)

### Self-hosted Infrastructure
- **SQLite database** (better-sqlite3, WAL mode) — zero configuration, no database server
- **Local file storage** for music, playlists, and images
- **System FFmpeg** — works on all architectures including ARM64
- Rotating file logs under `logs/`
- `/systemstatus` — CPU load and temperature, Raspberry Pi throttle state, memory, disk, database size
- Slash command registration skipped when unchanged (protects against Discord rate limits on frequent reboots)
- systemd unit, PM2 config, and a one-shot Raspberry Pi installer script

## Documentation

Detailed documentation is available in the `/documentation` directory:
- `raspberry_pi_guide.md` - Raspberry Pi setup guide
- `development_standards_and_project_goals.md` - Architecture principles and standards
- `architecture.md` - System architecture and components
- `audio_system.md` - Audio processing and playback
- `voice_commands.md` - Voice interaction features
- `configuration_guide.md` - Setup and configuration
- And many more...

## Prerequisites

- Node.js v20 or higher (v22 recommended)
- FFmpeg (`sudo apt install ffmpeg`)
- A Discord bot token ([Discord Developer Portal](https://discord.com/developers/applications))
- Optional: [Ollama](https://ollama.com) for local AI chat with no cloud dependency
- Optional: OpenAI / Gemini / Perplexity / ElevenLabs / Spotify API keys

## Configuration

Copy `config.example.json` to `config.json` and fill in your values. Only the Discord credentials are required — everything else degrades gracefully:

```json
{
    "clientId": "<discord bot client id>",
    "guildIds": ["<discord server id>"],
    "token": "<discord bot token>",
    "DEFAULT_PROMPT": "You are Goobster, a quirky and clever Discord bot.",

    "openaiKey": "<optional - openai API key>",
    "ollama": {
        "host": "http://127.0.0.1:11434",
        "model": "llama3.2:3b"
    },
    "perplexity": { "apiKey": "<optional - enables web search>" },
    "spotify": { "clientId": "<optional>", "clientSecret": "<optional>" },
    "elevenlabs": { "apiKey": "<optional - enables TTS + audio generation>", "voiceId": "21m00Tcm4TlvDq8ikWAM" }
}
```

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

The Dockerfile is multi-arch (amd64 and arm64):

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

## Usage

### Available Commands

Use `/help` in Discord to see all available commands, organized by categories:
- 💭 Chat Commands - AI conversation and prompts
- 🎵 Music Commands - Background music control
- 🎤 Voice Commands - Text-to-speech
- 🔍 Search Commands - Web search functionality
- 🛠️ Utility Commands - Bot configuration, `/systemstatus`, help

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

### Testing
```bash
npm test                  # unit tests
npm run test:integration  # integration tests
npm run test:coverage     # with coverage
```

### Code Style
```bash
npm run lint
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Push to the branch
5. Create a Pull Request

## License

MIT License - See LICENSE file for details
