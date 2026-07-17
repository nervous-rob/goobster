# Raspberry Pi Setup Guide

Goobster runs comfortably on a **Raspberry Pi 4B** (2GB minimum, 4GB recommended if you run Ollama on the same device). This guide covers a fresh setup on Raspberry Pi OS.

## Requirements

- Raspberry Pi 4B (or newer)
- **Raspberry Pi OS 64-bit (Bookworm)** — 32-bit is not supported; several native modules only ship ARM64 prebuilts
- Reliable power supply (5V/3A) — undervoltage causes throttling, visible in `/systemstatus`
- SD card (16GB+) or, better, USB SSD boot for database longevity

## Quick Install

```bash
git clone https://github.com/nervous-rob/goobster.git
cd goobster
./scripts/install-rpi.sh --service
```

The installer:
1. Installs system packages (FFmpeg, build tools, Python)
2. Installs Node.js 22 from NodeSource
3. Installs `spotdl` and `yt-dlp` in a Python venv (`~/.local/goobster-venv`)
4. Builds Node dependencies (native modules compile on ARM64 — a few minutes on first install)
5. Creates the SQLite database and runtime directories
6. Optionally installs and enables the systemd service (`--service`)

Then edit `config.json` with your Discord credentials and start:

```bash
sudo systemctl start goobster
journalctl -u goobster -f
```

## Local AI with Ollama (no cloud required)

If you don't provide an OpenAI key, Goobster automatically uses a local Ollama server for chat.

```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama pull llama3.2:3b
```

Recommended models for a Pi 4B (4GB+):

| Model | RAM | Notes |
|---|---|---|
| `llama3.2:3b` | ~2.5GB | Default; good quality/speed balance |
| `qwen2.5:3b` | ~2.3GB | Strong multilingual |
| `phi3:mini` | ~2.5GB | Good reasoning |
| `llama3.2:1b` | ~1.3GB | Fastest, for 2GB Pis |

You can also point Goobster at an Ollama server on another machine:

```json
"ollama": { "host": "http://192.168.1.50:11434", "model": "llama3.1:8b" }
```

Note: responses from a Pi-hosted model take noticeably longer than cloud APIs (tens of seconds for long replies). Running Ollama on a separate machine on your LAN gives the best of both worlds.

## Storage Layout

| Path | Contents |
|---|---|
| `data/goobster.sqlite` | Database (WAL mode) — conversations, settings, automations |
| `data/music/` | Downloaded tracks |
| `data/playlists/` | Playlists (JSON, per guild) |
| `data/images/` | Generated images |
| `logs/` | Rotating log files (3 × 5MB per level) |

Override locations with `GOOBSTER_DB_PATH` and `GOOBSTER_LOG_DIR` environment variables.

## Touchscreen Control Panel

Goobster serves a local management console designed for an 800×400 DSI touchscreen. It is bound to `127.0.0.1` only — it is never reachable from the network.

- URL: `http://127.0.0.1:3400` (override with `GOOBSTER_PANEL_PORT` or `config.json`: `"panel": { "enabled": true, "port": 3400 }`; set `"enabled": false` to turn it off).
- Browse the servers Goobster is in, then per server: send messages as the bot (exact text, or an AI-drafted message you preview and edit before posting), start/stop live voice conversations, and control music playback (play/queue/pause/skip/volume, playlists). Moving music to a different server asks for confirmation first.
- The **Settings** tab manages everything the settings slash commands do: proactive mode, dynamic responses, search approval, thread preference, AI provider/model/reasoning (including Thoughtful Mode), personality directive, bot nickname, memory retention, per-channel memory exclusions, forget-all-memories, and the global ElevenLabs TTS voice.

To run it as a kiosk on the Pi's screen, autostart Chromium (Wayland/labwc on Bookworm — add to `~/.config/labwc/autostart`; for X11 use `~/.config/lxsession/LXDE-pi/autostart` with `@` prefixes):

```bash
chromium-browser --kiosk --noerrdialogs --disable-restore-session-state \
  --check-for-update-interval=31536000 http://127.0.0.1:3400 &
```

If the screen blanks, disable DPMS (`raspi-config` → Display → Screen Blanking, or `wlr-randr`).

## Health Monitoring

- `/systemstatus` in Discord shows CPU load, SoC temperature, **Pi throttle flags** (under-voltage, frequency capping), memory, disk, and database size.
- `curl http://localhost:3000/health` for external monitors (e.g. Uptime Kuma).
- `journalctl -u goobster -f` or `logs/goobster.log` for logs.

## Performance Tips

- **Boot from USB SSD** if possible; SQLite on an SD card works fine (WAL mode reduces write amplification) but an SSD improves longevity and latency.
- **Add a heatsink/fan**: sustained AI + audio workloads warm the SoC; throttling starts at 80°C.
- Keep `guildIds` in config limited to servers you actually use — command deployment is per-guild.
- If you don't use voice features, don't configure ElevenLabs — the voice service degrades gracefully and saves memory.

## Backups

Everything lives in `data/`. To back up:

```bash
sqlite3 data/goobster.sqlite ".backup data/backup-$(date +%F).sqlite"
tar czf goobster-backup.tar.gz data/ config.json
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| Native module build fails | Ensure 64-bit OS (`uname -m` → `aarch64`), install `build-essential` |
| `@discordjs/opus` fails with `implicit declaration of function 'celt_inner_prod_neon'` | No arm64 prebuilt exists for Node 22 / recent glibc, and the source build has a NEON bug. The installer handles this automatically; if installing manually run `CFLAGS='-DOPUS_ARM_MAY_HAVE_NEON_INTR' npm ci --omit=dev` |
| `FFmpeg is required...` on startup | `sudo apt install ffmpeg` |
| `/spotdl` says `spotdl CLI not found` | `python3 -m venv ~/.local/goobster-venv && ~/.local/goobster-venv/bin/pip install spotdl yt-dlp` (what the installer does; plain `pip install` is blocked on Bookworm). The bot checks that venv path automatically |
| Chat replies "Ollama server not reachable" | `systemctl status ollama`, or set `ollama.host` |
| Slow responses with local model | Use a smaller model (`llama3.2:1b`) or host Ollama on a stronger machine |
| `⚠️ under-voltage` in `/systemstatus` | Use an official 5V/3A power supply |
| Commands not appearing in Discord | Run `node deploy-commands.js --force` |
