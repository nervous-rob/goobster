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

## Install — no repo clone needed

**Easiest: the native app.** When the bot owner has published binaries
(see `.github/workflows/release-companion.yml` — push a `companion-v*` tag),
the install page offers `.exe` / `.dmg` / Linux downloads that need no Node
at all: run the app and paste your server URL + pairing code when prompted.
Pairing is saved to `~/.goobster-companion.json`.

**Or run the single file with Node.** The companion is also a **single
zero-dependency file** (`companion.js`) that Goobster serves himself.
Players never need this repository:

1. In Discord, run `/screenvision link` — Goobster replies with a personal
   install link (`https://<goobster-host>/companion?code=XXXX-XXXX`) showing
   copy-paste commands per OS with the pairing code prefilled.
2. The commands boil down to (any OS, [Node.js 22+](https://nodejs.org) required):

   ```bash
   curl -fsSL https://<goobster-host>/companion.js -o goobster-companion.js
   node goobster-companion.js --server https://<goobster-host> --code XXXX-XXXX
   ```

3. Verify with `/screenvision test` in Discord — Goobster replies (privately)
   with exactly what he can see.
4. Next time, just `node goobster-companion.js` — the pairing is saved in
   `goobster-companion.json` next to the script.

Screenshots use the OS's own tools, so there is nothing to `npm install`:
PowerShell/.NET on Windows, `screencapture` on macOS, and
`import` (imagemagick, X11) / `grim` (Wayland) / `gnome-screenshot` /
`spectacle` on Linux (`xdotool` adds active-window metadata on X11).

## Privacy model

- **Opt-in twice**: you run this app AND pair it via `/screenvision link`.
- **Capture only on demand**: a frame is taken only when Goobster is answering
  *you*, never on a timer. Every capture is logged to this console.
- **Nothing persisted**: frames live in memory for a few seconds server-side.
  Only small text summaries ("was playing Elden Ring and asked about Margit")
  go to Goobster's long-term memory so he can refer back in later sessions.
- **Kill switch**: Ctrl+C stops all access instantly; `/screenvision unlink`
  revokes the token permanently.

The app reconnects automatically if the connection drops. Run it only while
you want Goobster to have eyes.
