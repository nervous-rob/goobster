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

## Broadcasting a run into Discord (Phase 1)

`run-driver.js` executes a **playbook** — a JSON script of steps — against
the local bridge and streams screenshots + captions to Goobster, who posts
them into a channel. Zero AI; this is the scripted smoke-run layer.

1. Bot owner: enable `"gbaRun": { "enabled": true }` in `config.json`
   (the public server gains `/api/gba-run/pair` + `/api/gba-run/ws`).
2. In Discord: `/gbarun link channel:#your-channel` (Manage Server) —
   you get a single-use pairing code.
3. On the mGBA machine (mGBA + `goobster-gba.lua` running):

   ```bash
   node run-driver.js --server https://<goobster-url> --code XXXX-XXXX \
       --playbook playbooks/keytest-demo.json
   ```

   The pairing is saved to `goobster-gba-run.json` next to the script, so
   later runs only need `--playbook`. `--dry-run` rehearses locally
   without Goobster.

Playbook steps (validated up front, with step positions in errors):

```json
{
  "name": "My run",
  "steps": [
    { "post": "caption", "screen": true, "upscale": 3 },
    { "press": ["UP", "A", "B+RIGHT"], "hold": 10, "gap": 5 },
    { "wait": 120 },
    { "save": 1 },
    { "load": 1 },
    { "note": "driver console only" }
  ]
}
```

Posting is rate-limited server-side (one post per ~3s per guild, bounded
queue), and delivery is best-effort: if Goobster is unreachable the run
keeps going and posts are skipped. `/gbarun status` shows the connection
and the announced game; `/gbarun unlink` revokes the harness token.

## The autonomous player (Phase 2)

`agent.js` replaces the scripted playbook with an actual brain: each turn
a vision model looks at the screen and answers with JSON (observation,
objective, actions, optional table talk); deterministic code legalizes
and executes it. Guardrails: unusable answers degrade to watching, a
stuck screen escalates from prompt warnings to a checkpoint reload
(save-state watchdog), and every screenshot/commentary post rides the
Phase 1 broadcast pipe into Discord.

```bash
# local Ollama brain (the spare-laptop deployment)
node agent.js --goal "Get the first badge" --turns 200

# OpenAI as a quality ceiling / harness debugging
node agent.js --provider openai --goal "Get out of the first town" --turns 50

# play without broadcasting
node agent.js --dry-run --turns 10
```

Options: `--provider ollama|openai` (default ollama), `--model`
(defaults: `qwen2.5vl:7b` / `gpt-5.6-terra`), `--ollama-host`,
`--reasoning minimal|low|medium|high` (OpenAI only: turns on model
reasoning for each decision — `medium` noticeably improves navigation
and battle play at the cost of slower turns),
`--turns` (0 = until Ctrl+C), `--turn-delay-ms` (default 2000),
`--post-every N` (heartbeat cadence, default 12; milestones always post),
`--checkpoint-every N` (watchdog save-state, default 20),
`--hints TEXT` / `--hints-file FILE` (game-specific notes appended to the
system prompt — `hints/pokemon-firered.txt` ships ready to use),
`--allow-memory` (below), plus the same pairing/bridge flags as
`run-driver.js`.

Menus are where vision agents go wrong (A-mashing through screens that
need the cursor moved). The system prompt teaches cursor mechanics and
the agent feeds two deterministic signals back into every prompt: actions
that were rejected by legalization, and a `[the screen did NOT change
after this]` annotation on turns whose presses did nothing. For stubborn
games, add `--hints-file` notes describing the specific menus (see the
FireRed file for the pattern).

### RAM ground truth (`--allow-memory`)

Navigation is the other place vision agents fall apart: a 240x160
screenshot cannot tell the model whether its last three UP presses
walked three tiles or bumped a wall three times. With `--allow-memory`
(the same operator opt-in as the MCP server flag, or
`GOOBSTER_GBA_ALLOW_MEMORY=1`) the agent reads the design-doc-sanctioned
ground-truth set from the emulator each turn — player coordinates, map
id, and the in-battle flag (`lib/gameState.js`, addresses from the pret
decomps for FireRed / LeafGreen / Emerald) — and feeds a deterministic
`GROUND TRUTH` block into every prompt:

- exact tile position and map id, plus what the last actions *actually*
  did ("you moved 2 tiles RIGHT", "your position did NOT change — a
  wall is blocking you, or a menu/dialog has the controls")
- battle transitions ("a battle STARTED — the D-pad only moves the
  cursor now")
- explored-map memory: how many tiles of the current map have been
  stood on and which adjacent tiles never have — systematic exploration
  instead of pacing the same corridor

The game stays vision-first — the model still plays from the screen; RAM
only keeps it honest. Unknown game codes and failed reads degrade to
vision-only play, never an error. For FireRed specifically, combine it
with the shipped hints file, which now includes the early-game critical
path (starter choice through the first two badges):

```bash
node agent.js --provider openai --reasoning medium --allow-memory \
    --hints-file hints/pokemon-firered.txt --goal "Earn the Boulder Badge"
```

While the agent plays, everyone in the broadcast channel is part of the
run: plain messages there are captured as **audience advice** (📨 ack),
forwarded into the agent's prompt with attribution, and credited in the
commentary when they pay off. Mentioning Goobster directly still reaches
normal chat. The channel also gets a **live status embed** (updated in
place with the current screenshot, turn, and objective — flips to paused
when the harness disconnects) and **milestone embeds** that are recorded
server-side (`/gbarun status` shows the recent ones).

## Setting up the laptop (Windows 10/11)

Everything below runs on the gaming machine; Goobster itself stays on
its own box (e.g. the Pi) and only needs `"gbaRun": { "enabled": true }`
plus a reachable public URL (the same tunnel the Activity/screen-vision
features use).

1. **Node 22+** — `winget install OpenJS.NodeJS.LTS` (or nodejs.org).
2. **mGBA** — installer from [mgba.io/downloads](https://mgba.io/downloads.html) (0.10.x is fine).
3. **Ollama** — installer from [ollama.com/download](https://ollama.com/download); it
   uses the NVIDIA GPU automatically. Then pull a multimodal model:
   `ollama pull qwen2.5vl:7b` (smarter, partially offloads on 6 GB VRAM)
   or `ollama pull qwen2.5vl:3b` (fits entirely, faster turns).
4. **This folder** — clone the repo or copy `clients/gba-mcp/` anywhere;
   there is nothing to `npm install`.
5. **Start the game**: open your ROM in mGBA, then
   *Tools → Scripting… → File → Load script* → `goobster-gba.lua`.
   The scripting console should log `bridge listening on 127.0.0.1:5771`.
   Keep the emulator unpaused — the bridge handles messages between frames.
6. **Pair**: in Discord run `/gbarun link channel:#your-channel`
   (Manage Server), then on the laptop:
   `node agent.js --server https://<goobster-url> --code XXXX-XXXX --goal "..."`.
   The pairing saves to `goobster-gba-run.json`; later runs only need
   `--goal`/`--turns`.

Network notes: the mGBA bridge listens on loopback only (nothing to open
in Windows Firewall), and the agent makes outbound connections to Ollama
(localhost) and Goobster (HTTPS/WSS) — no inbound ports on the laptop.

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
