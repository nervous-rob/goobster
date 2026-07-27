# Goobster Plays Pokémon — Design & Roadmap

> Goobster plays a GBA Pokémon game (FireRed first) on a spare gaming
> machine, live-streamed into Discord: screenshots and AI commentary in a
> channel, milestone events, an advice inbox the server can shout into,
> and — later — betting on his progress through the guild point economy.

## Why this exists

The concept came out of a brainstorm about putting an idle gaming laptop
(Ryzen 9 4900HS, RTX 2060 6GB) to work for Goobster. Local compute makes
marginal inference cost zero, which unlocks the category of features that
are economically impossible on cloud APIs: always-on, continuous,
personality-driven things. "Twitch Plays Pokémon, but the player is your
server's bot and he has opinions about your suggestions" is the flagship:
a 24/7 GPU workload that produces daily entertainment, where even failure
(being lost in Mt. Moon for six hours) is content.

## Architecture: the laptop is the player, the Pi is the broadcaster

The perceive-think-act loop runs on the laptop next to the emulator and
the GPU. Goobster (on the Pi) never blocks on any of it: he receives
events and screenshots over an outbound WebSocket (the same pattern as
the screen-vision companion app), narrates them to Discord, and forwards
the server's advice back. When the laptop is off, everything degrades to
"the run is paused" — never an error.

```
┌────────────────────── laptop ──────────────────────┐   ┌──── Pi ────┐
│  mGBA (+ goobster-gba.lua)                          │   │  Goobster  │
│    ▲ loopback TCP (line protocol)                   │   │   bot      │
│  goobster-gba-mcp (MCP server, stdio)               │   │            │
│    ▲ MCP tools                                      │   │  channel   │
│  AI handler (MCP client: VLM eyes, LLM objectives,  │◄──┤  posts,    │
│  deterministic action layer, anti-stuck machinery)  ├──►│  advice    │
└─────────────────────────────────────────────────────┘ WS│  inbox     │
                                                          └────────────┘
```

Choosing MCP for the emulator surface is deliberate: the same server
works for the autonomous handler **and** for a human driving from
Cursor/Claude Desktop. That collapses a whole category of "is the harness
broken or is the agent dumb?" debugging, and it means the harness is
useful today, before any agent exists.

## The five components

1. **Emulator harness** — mGBA + `clients/gba-mcp/goobster-gba.lua`
   (loopback TCP bridge) + `clients/gba-mcp/server.js` (MCP server).
   Tools: `get_screen` (upscaled PNG), `press_buttons` (validated
   sequences and combos), `wait`, `save_state`/`load_state`,
   `get_status`, and opt-in `read_memory`. **Shipped (Phase 0).**
   The broadcast pipe — `/gbarun` pairing, `services/gbaRunService.js`,
   and the scripted playbook driver `clients/gba-mcp/run-driver.js` —
   is **shipped (Phase 1)**.
2. **AI handler** — the autonomous player (`clients/gba-mcp/agent.js`).
   Shipped v1 is a single-level perceive-think-act loop: a multimodal
   model (Ollama `qwen2.5vl` by default) sees each screen and proposes
   observation/objective/actions as ONLY JSON, carried objective state
   threading between turns. The designed evolution (Phase 2.x) is the
   hierarchical stack: a mostly-hardcoded goal graph (badge order), the
   LLM picking objectives every ~30-60s, and a deterministic action layer
   (pathfinding, menu macros, battle heuristics) executing between model
   calls. The repo-wide trust boundary applies throughout: **the model
   proposes, deterministic code legalizes** (like
   `botPlayer`/`botAdventurer`).
3. **Anti-stuck machinery** — explored-map memory, a loop detector
   (same position/objective for N decisions), and an escalation ladder:
   alternate route → systematic explore mode → **ask the Discord channel
   for help**. Stuck-ness becomes engagement, not a dead stream.
4. **Broadcast layer** (Pi, inside Goobster) — a dedicated channel with a
   live status embed (screenshot, party, badges, current objective),
   event posts for milestones (badge, catch, faint, blackout), and a
   daily recap chapter. Run state journals into SQLite (restart-safe,
   like `agent_runs`); save states checkpoint on the laptop.
5. **Advice inbox** — channel messages become suggestions in the
   objective prompt (never commands). Outcomes are attributed ("Dave told
   me to buy Repels. Dave is a prophet."), and `factsService` lets
   Goobster track whose advice historically pans out.

## Design rules

- **Vision-first, RAM-assist optional.** The agent plays from
  screenshots. mGBA's Lua API can read memory, and the pret decomps
  (`pokefirered`/`pokeemerald`) publish full symbol maps, but memory taps
  are an operator opt-in (`--allow-memory`) intended for loop-detector
  ground truth (player coords, map id, in-battle flag) — not for playing
  the game from RAM. Emerald DMA-shifts key structures; FireRed is tamer.
- **FireRed for season one.** Kanto's critical path is the
  best-documented in the franchise and the quest graph carries over from
  the original Red/Blue design. Emerald is season two.
- **No ROMs ship, ever.** The harness is pointed at the operator's own
  files, like spotdl/yt-dlp. A homebrew test ROM
  (`clients/gba-mcp/test-rom/`) exercises everything legally.
- **Failure is content, but honesty first**: expected pace is
  days-per-badge with a local model. Commentary, advice, and betting are
  first-class features because they carry the pace, not decoration.

## Phase plan

- **Phase 0 — the harness (shipped).** mGBA Lua bridge + MCP server +
  homebrew test ROM + Jest specs (`tests/gbaMcp.test.js`). Verified
  end-to-end by driving mGBA through MCP tool calls: screenshots,
  movement, save/load, memory reads, input legalization.
- **Phase 1 — scripted smoke run (shipped).** The broadcast pipe, zero
  AI. `/gbarun link` (Manage Server) binds a guild to a broadcast channel
  and issues a pairing code; `clients/gba-mcp/run-driver.js` (zero-dep,
  Node 22+) redeems it, holds an outbound WebSocket to Goobster
  (`services/gbaRunService.js`, opt-in via `config.gbaRun.enabled`), and
  executes a **playbook** — a validated JSON script of
  press/wait/post/save/load steps (`lib/playbook.js`) — posting
  screenshots + captions into the bound channel, rate-limited server-side.
  Verified end-to-end against a live Discord guild. Jest spec:
  `tests/gbaRunService.test.js`.
- **Phase 2 — the agent (shipped, v1).** `clients/gba-mcp/agent.js` +
  `lib/gameAgent.js`: each turn a vision model (local Ollama multimodal
  model by default, OpenAI as a quality ceiling via `--provider openai`)
  sees the screen and answers ONLY JSON (observation, objective, actions,
  optional table talk, milestone flag); `lib/agentBrain.js` legalizes
  every action, caps counts, and degrades unusable answers to watching.
  `lib/stuckDetector.js` compares frames as a coarse cell grid (idle
  animations don't mask stuckness) and escalates: prompt warning →
  stronger warning → checkpoint reload (watchdog save-states every N
  turns). Screenshots + commentary broadcast through the Phase 1 pipe
  (milestones immediately, heartbeat every N turns). Verified end-to-end
  with real vision (OpenAI) driving mGBA and posting to a live guild.
  Jest spec: `tests/gbaAgent.test.js`. v1 is a single-level brain — the
  hierarchical goal-graph/objective split below remains the Phase 2.x
  evolution path as local-model quality demands it.
- **Phase 3 — the show.** Live status embed, milestone events, advice
  inbox, daily recaps.
- **Phase 4 — the stakes.** Prediction markets on milestones through
  `economyService` escrow (the casino settlement patterns already exist),
  and voice commentary via the existing TTS pipeline.

Phases 0-1 need no GPU and no AI; they are independently buildable and
testable. The agent phases sit on the local-model foundation (Ollama on
the laptop via `OLLAMA_HOST`).

## Hardware notes (the original brainstorm constraints)

A 6GB RTX 2060 runs a 7-8B Q4 LLM resident (~4.5GB); decisions take a
few seconds, which is fine because the deterministic action layer doesn't
need the GPU. The VLM swaps in as needed (Ollama handles load/unload). If
the same laptop also serves voice/image sidecars for Goobster, the
Pokémon model competes for VRAM — decide whether peak hours belong to
"Goobster's brain" or "Goobster's game console"; overnight it can be both.

## Risk register

- **Getting stuck is guaranteed** (even frontier cloud models needed
  weeks for early badges). Mitigations: hierarchy, loop detector,
  ask-the-channel escalation, betting/commentary carrying slow stretches.
- **Menus and battles are a long tail** of stateful jank. The
  deterministic action layer needs real investment; save states plus a
  reset-to-checkpoint watchdog bound the damage.
- **mGBA headless quirk**: dev builds' `mgba-headless` lacks a video
  buffer and crashes on `emu:screenshot()`;
  `clients/gba-mcp/mgba-headless-videobuffer.patch` fixes it (candidate
  for upstreaming). GUI frontends are unaffected.
