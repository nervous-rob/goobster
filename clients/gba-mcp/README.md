# Goobster GBA Harness (goobster-gba-mcp)

Phase 0 of **Goobster Plays Pokémon** (design:
`documentation/goobster_plays_pokemon.md`): an [MCP](https://modelcontextprotocol.io)
server that exposes a GBA game running in [mGBA](https://mgba.io) as a
standard tool surface — see the screen, press buttons, wait, and manage
save states. Any MCP client can drive it: the future autonomous AI
handler, or a human playing through Cursor / Claude Desktop, which is
also exactly how you debug the harness ("is the harness broken or is the
agent dumb?" becomes answerable).

Like `clients/screen-companion`, this is a **zero-dependency** tool meant
for the machine that runs the emulator (e.g. a spare gaming laptop) — not
for the Raspberry Pi that runs Goobster. Nothing to `npm install`; Node
20+ is all it needs.

## Pieces

- `goobster-gba.lua` — runs **inside mGBA** (0.10+ scripting API) and
  listens on `127.0.0.1:5771`, translating a tiny line protocol into
  emulator calls (screenshots, key sequences, save states, memory reads).
- `server.js` — the MCP server (newline-delimited JSON-RPC over stdio).
  Connects to the Lua bridge lazily and reconnects if mGBA restarts.
- `test-rom/` — a 792-byte homebrew ROM (`build.sh`, needs
  `gcc-arm-none-eabi`) so the harness can be exercised without any
  commercial game: a D-pad-movable square, A/B color changes, and a
  frame-counter sweep make every tool's effect visible in screenshots.

Both processes must run on the **same machine** — the screenshot hand-off
uses a temp file.

## Setup

1. Start mGBA with the bridge script and your ROM:
   - mGBA 0.10.x GUI: open the ROM, then *Tools > Scripting… > File > Load script* → `goobster-gba.lua`
   - dev/0.11+ builds: `mgba-qt --script goobster-gba.lua <rom.gba>`
   - headless dev builds: `mgba-headless --script goobster-gba.lua <rom.gba>`
     (current dev builds need `mgba-headless-videobuffer.patch`, see below)

   The scripting console logs `goobster-gba: bridge listening on 127.0.0.1:5771`.

2. Register the MCP server with your client. For Cursor (`mcp.json`):

   ```json
   {
     "mcpServers": {
       "goobster-gba": {
         "command": "node",
         "args": ["/path/to/goobster/clients/gba-mcp/server.js"]
       }
     }
   }
   ```

   Options (flags win over environment):
   - `--host` / `GOOBSTER_GBA_HOST` (default `127.0.0.1`)
   - `--port` / `GOOBSTER_GBA_PORT` (default `5771`; must match the value at the top of the Lua script)
   - `--allow-memory` / `GOOBSTER_GBA_ALLOW_MEMORY=1` — enables the `read_memory` tool. Off by default: the harness is vision-first, and RAM assists are an explicit operator opt-in.

## Tools

| Tool | What it does |
|---|---|
| `get_screen` | PNG screenshot, nearest-neighbor upscaled (default 3x — VLMs read 240x160 badly) |
| `press_buttons` | Press a sequence: `["UP", "UP", "A"]`; `"B+RIGHT"` holds a combo. Returns a screenshot after |
| `wait` | Let the game run N frames (60 = 1 in-game second), screenshot after |
| `save_state` / `load_state` | Numbered checkpoint slots 1-9 |
| `get_status` | Bridge connectivity, game title/code, frame counter |
| `read_memory` | Hex dump from the GBA bus (only with `--allow-memory`) |

Bad tool input (unknown buttons, out-of-range values) comes back as a
readable tool error the model can correct — the deterministic code
legalizes, the model proposes (the same trust boundary as the casino
`botPlayer` and tavern `botAdventurer`).

## Testing without a commercial ROM

```bash
sudo apt install gcc-arm-none-eabi   # or brew install --cask gcc-arm-embedded
clients/gba-mcp/test-rom/build.sh    # produces keytest.gba
mgba-qt --script clients/gba-mcp/goobster-gba.lua clients/gba-mcp/test-rom/keytest.gba
```

Then call `press_buttons` with D-pad directions from any MCP client and
watch the square move in `get_screen` output.

## Headless note

mGBA dev builds ship `mgba-headless`, ideal for running the harness on a
server. Current dev builds never attach a video buffer in headless mode,
so `emu:screenshot()` segfaults; `mgba-headless-videobuffer.patch` fixes
it (5 lines) until it's addressed upstream. The GUI frontends are
unaffected.

## Legal

The harness ships no game. Point it at your own legally-obtained ROM
files, the same way `spotdl`/`yt-dlp` are user-supplied capabilities.
