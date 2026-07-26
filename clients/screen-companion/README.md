# Goobster Screen Companion

A tiny desktop app that lets Goobster **see your screen** — with your consent,
on demand — so he can answer questions about whatever you're doing ("how do I
beat this boss?", "what does this error mean?") with real visual context plus
your game's metadata.

Discord does not let bots watch Go Live screen shares, so this companion runs
on your own machine instead and holds an **outbound** WebSocket to your
Goobster server. When you talk to Goobster (a message that addresses him, or a
turn in a `/voicechat` session), he asks the companion for one screenshot of
your primary display and the active window's title/app name. That frame is
attached to the AI request and then discarded — it is never stored.

## Privacy model

- **Opt-in twice**: you install this app AND pair it via `/screenvision link`.
- **Capture only on demand**: a frame is taken only when Goobster is answering
  *you*, never on a timer. Every capture is logged to this console.
- **Nothing persisted**: frames live in memory for a few seconds server-side.
  Only small text summaries ("was playing Elden Ring and asked about Margit")
  go to Goobster's long-term memory so he can refer back in later sessions.
- **Kill switch**: Ctrl+C stops all access instantly; `/screenvision unlink`
  revokes the token permanently.

## Requirements

- Node.js 20+
- Your Goobster instance must have screen vision enabled
  (`"screenVision": { "enabled": true }` in `config.json`) and its public
  HTTP server reachable from your PC (the same tunnel/domain that serves the
  Casino Activity works, e.g. `https://activity.example.com`).
- Linux only: `imagemagick` (for `screenshot-desktop`) and `xdotool`
  (optional, for active-window metadata).

## Setup

1. In Discord, run `/screenvision link` — Goobster gives you a one-time code.
2. On the PC whose screen Goobster should see:

   ```bash
   cd clients/screen-companion
   npm install
   node index.js --server https://your-goobster-host --code XXXX-XXXX --label "Gaming PC"
   ```

   The token is saved to `companion.config.json`; from then on just:

   ```bash
   node index.js
   ```

3. Verify with `/screenvision test` in Discord — Goobster replies (privately)
   with exactly what he can see.
4. Play something, then ask him: *"Goobster, what should I do here?"*

The app reconnects automatically if the connection drops. Run it only while
you want Goobster to have eyes.
