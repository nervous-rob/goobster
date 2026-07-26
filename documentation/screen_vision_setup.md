# Screen Vision - letting Goobster see players' screens

Discord's API does not let bots watch Go Live screen shares (video is
user-client only). Screen vision works around that with a small **companion
app** (`clients/screen-companion/`) each user runs on their own machine. It
holds an outbound WebSocket to Goobster and answers on-demand screenshot
requests, so when a paired user talks to Goobster — in text chat or in a
`/voicechat` session — his answer is grounded in:

- a **live screenshot** of the user's primary display (attached to the AI
  turn as a vision input),
- **active window metadata** from the companion (app name + window title),
- **Discord presence game metadata** (Rich Presence `details`/`state` when
  the game publishes them — read via the `GuildPresences` intent the bot
  already has),
- everything he already uses: conversation history, long-term memory, and
  native/Perplexity web search.

Small text summaries of screen-assisted exchanges ("Alice was playing ELDEN
RING and asked about Margit") are stored in long-term memory via
`memoryService`, so Goobster can refer back to them in later sessions. The
frames themselves are **never** persisted — they live in an in-memory cache
for ~10 seconds and only ever go to the AI provider.

## Enabling (server side)

Everything is **off by default**. In `config.json`:

```json
{
    "screenVision": {
        "enabled": true,
        "publicUrl": "https://your-goobster-domain.example.com",
        "releasesUrl": "https://github.com/<owner>/<repo>/releases/latest"
    }
}
```

This makes the public HTTP server (the one serving `/health` and the Casino
Activity) also serve:

- `GET /companion` — self-serve install page (per-OS copy-paste commands,
  pairing code prefilled via `?code=`)
- `GET /companion.js` — the single-file zero-dependency companion app
- `POST /api/screen/pair` — one-time pairing-code exchange
- `WS /api/screen/ws` — the companion connections

All must be publicly reachable from players' PCs. If you already expose the
server for the Activity (e.g. a cloudflared tunnel with a domain), you're
done — Cloudflare proxies WebSockets by default, and everything rides the
same origin. `publicUrl` is that public origin; with it set, `/screenvision
link` hands users a personal install link. Restart Goobster and run `npm run
deploy-commands` once so the `/screenvision` command registers.

## Pairing (per user) — no repo clone needed

1. `/screenvision link` in Discord → one-time code (10 min, single use) plus
   a personal install link (`https://<domain>/companion?code=XXXX-XXXX`).
2. On the gaming PC, either **download the native app** (Option A on the
   install page: `.exe` / `.dmg` / Linux binary, no Node required — run it
   and paste the server URL + code when prompted) or **run the single file
   with Node** — `curl -fsSL https://<domain>/companion.js -o
   goobster-companion.js` then `node goobster-companion.js --server
   https://<domain> --code XXXX-XXXX` ([Node.js 22+](https://nodejs.org)).
   Screenshots use the OS's own tools either way (PowerShell /
   `screencapture` / `import`/`grim`).
3. `/screenvision test` → Goobster replies ephemerally with exactly what he
   can see. `/screenvision status` shows the connection; `/screenvision
   unlink` revokes the token.

## Native binaries (.exe / .dmg)

`.github/workflows/release-companion.yml` builds the companion as
self-contained executables with Node's Single Executable Application
tooling, on native runners for each platform:

- `goobster-companion-win-x64.exe`
- `goobster-companion-macos-arm64.dmg` / `goobster-companion-macos-x64.dmg`
- `goobster-companion-linux-x64`

**To publish a release:** push a tag like `companion-v2.1.0` (or run the
workflow manually to build artifacts without releasing). The workflow
creates a GitHub Release with the binaries attached. Set
`screenVision.releasesUrl` to your repo's
`https://github.com/<owner>/<repo>/releases/latest` and the `/companion`
install page shows the download links automatically.

The binaries are unsigned (no paid certificates): Windows SmartScreen needs
"More info → Run anyway", macOS needs right-click → Open (or
`xattr -d com.apple.quarantine <file>`). Double-clicking prompts
interactively for the server URL + pairing code, so no terminal knowledge is
required; the pairing is saved to `~/.goobster-companion.json`.

## How it flows

- **Text chat**: `utils/chatHandler.js` asks `screenVisionService` for the
  author's screen context; the frame joins `userTurn.images` (same path as
  attachments) and a `LIVE SCREEN CONTEXT` block is appended to the system
  prompt.
- **Voice**: both engines (`realtimeVoiceEngine.js`, `voiceSessionService.js`)
  call `buildScreenTurnContext` (in `voiceTurnShared.js`) for every distinct
  speaker of the turn — up to 2 frames per turn.
- **Providers**: frames travel as base64 data URLs. OpenAI accepts them
  natively; Anthropic/Gemini/Ollama translation lives in each service via
  `utils/imageDataUrl.js`.

## Security notes

- Client tokens are stored **hashed** (SHA-256) in `screen_vision_clients`;
  a re-pair or unlink revokes the old token and disconnects the client.
- Pairing-code redemption is throttled (10 attempts/min) and codes expire in
  10 minutes; unused codes are purged.
- One live connection per user (newest wins); dead connections are reaped by
  a WebSocket heartbeat.
- Captures happen **only** when the paired user addresses Goobster; the
  companion logs every capture to its console.

## Known limitations

- Some fullscreen games with anti-cheat block standard capture APIs (black
  frame). Borderless-windowed mode is the reliable path.
- The companion captures the **primary display** only.
- Linux needs `imagemagick` for capture and (optionally) `xdotool` for
  active-window metadata; Wayland setups may not report the active window.
