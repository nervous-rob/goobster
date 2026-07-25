# The Goobster Tavern + Adventure Mode ("Tavern Alpha")

The Goobster Tavern is a persistent social hub: a magical inn between worlds with
resident NPCs, a daily rumor, a quest board, and lightweight tabletop adventures
playable entirely inside Discord. The world remembers: characters persist,
adventures leave recaps and trophies, and completed stories change what the
Tavern shows.

## Player quickstart

```
/tavern status            step into the Common Room
/character create         make a character (about a minute)
/adventure join quest:    post a party for a quest (buttons let others join)
/adventure begin          start once the party is big enough
```

During play, every scene shows **option buttons** — but freeform actions are
first-class: `/adventure act action:I use my cooking pot as a helmet and ram
the door` never gets "invalid command". The engine picks the stat and
difficulty (AI-assisted when a provider is configured, deterministic keyword
matching otherwise) and folds the result into the story.

### Commands

| Command | What it does |
|---|---|
| `/tavern status` | Common Room embed: rumor of the day, NPCs, quest board summary, open parties |
| `/tavern board` / `/adventure browse` | the full quest board |
| `/tavern rumor` | today's rumor |
| `/tavern npc name:` | talk to a resident (Marnie, Bix, Sister Caldra, Albert) |
| `/tavern profile [user]` | a member's character and trophies |
| `/tavern reload-quests` | (Manage Server) reload campaign YAML from disk |
| `/character create/sheet/edit/advance/retire` | character management |
| `/adventure join/begin/act/bigmove/status/recap/leave/abandon` | play |
| `/roll check stat: [dc]` / `/roll dice expression:` | dice, in or out of adventures |

## Character rules

- **Four stats**, each +0..+3, distribute **6 points** (classic spreads: 3/2/1/0 or 2/2/1/1):
  **Might** (force, endurance, fighting), **Finesse** (stealth, reflexes, precision),
  **Wits** (knowledge, investigation, planning), **Heart** (charm, courage, empathy).
- **Checks** are `d20 + stat (+ situational bonus)` vs a DC: routine 10,
  challenging 13, difficult 16, heroic 19.
- **Callings** (archetypes): Vanguard, Scoundrel, Mystic, Guide, Tinkerer,
  Troubadour. Each has a flavor "always move" and a once-per-adventure
  **big move** (`/adventure bigmove`) that makes your next check succeed.
- **Complication**: a chosen flaw ("Cannot resist a dare"). Complications are
  story fuel: natural 1s grant **Spark** alongside their trouble.
- **Spark** (0-5): spend 1 to reroll your latest failed check (the first
  attempt's costs stand; a success carries the action through). Earned from
  nat 20s, nat 1s, campaign effects, and finishing adventures.
- **Health**: 10; the alpha has no permadeath — dropping to the floor
  "staggers" you and ticks the danger clock instead. Finishing an adventure
  restores everyone at the hearth.
- **Advancement**: each completed adventure grants a milestone;
  `/character advance` spends one to raise a stat (max +3).

## Campaigns are YAML files

Campaigns live as **directories of YAML files** — easy to hand-author, and easy
to generate or alter mechanically, because a new campaign is just files that
match this structure:

```
campaigns/<quest-id>/                built-in, ships with the repo
  quest.yaml                         metadata, players, clocks, start scene
  endings.yaml                       list of endings (title, text, trophy?)
  scenes/<scene-id>.yaml             one file per scene

data/tavern/campaigns/<quest-id>/    custom campaigns (gitignored, server-owned)
```

A custom campaign with the same id as a built-in **overrides** it — that is the
supported way to alter a shipped module. `/tavern reload-quests` picks up new
or edited files without a restart. Invalid custom campaigns are warned about
and skipped (never a crash); built-ins are validated in CI.

### quest.yaml

```yaml
id: missing-bell-of-brinewatch      # lowercase slug; defaults to the dir name
title: The Missing Bell of Brinewatch
type: one-shot                      # one-shot | tavern-tale (display only)
hook: >
  One paragraph shown on the quest board and party card.
players: { min: 1, max: 4, recommended: 2-4 }
duration: 45-75 min
difficulty: challenging             # display only
tags: [mystery, coastal]
affectsWorld: true                  # display only (board badge)
reward: A trophy for the Tavern.
start: arrival                      # scene id to open with
clocks:
  - id: bell                        # unique slug
    name: Find the Bell
    size: 4                         # 1-12 segments
    kind: progress                  # progress | danger
  - id: collapse
    name: Flooded Chapel Collapse
    size: 6
    kind: danger
    onFull:                         # effects fired when the clock fills
      end: collapse-escape
```

### scenes/<scene-id>.yaml

```yaml
id: chapel                          # defaults to the filename
title: The Flooded Chapel
text: >
  The scene description shown in the embed.
freeform:                           # optional: freeform-action hooks
  success: Stock line when an improvised action succeeds.
  failure: Stock line when it fails.
  progressClock: bell               # defaults to the first progress clock
  dangerClock: collapse             # defaults to the first danger clock
options:
  - key: ram-door                   # unique slug, NO underscores (button ids)
    label: Ram the door open        # button label
    emoji: "🚪"                     # optional
    stat: might                     # might | finesse | wits | heart
    dc: challenging                 # a band name or a number 2-30
    once: true                      # optional: option disappears after use
    bonus: { item: Waterlogged Hymnal, value: 2 }   # optional item bonus
    success:
      text: What happens on a success.
      effects: { goto: crypt }
    failure:
      text: Failure creates complications, costs, or new paths - never a dead end.
      effects: { damage: 2, clock: { id: collapse, delta: 1 } }
  - key: to-chapel                  # a "travel" option: no roll
    label: Head for the chapel
    goto: chapel                    # or `end: <ending-id>`
    text: Narration for taking it.
```

### endings.yaml

```yaml
- id: hang-bell
  title: The Bell Comes Home
  text: >
    The epilogue paragraph.
  trophy: Brinewatch Bell-Rope      # optional: lands in every survivor's inventory
```

### The effects vocabulary (closed set)

Effects keep the engine deterministic no matter who wrote the YAML:

| Effect | Meaning |
|---|---|
| `clock: {id, delta}` | advance/rewind a declared clock (clamped; filling fires `onFull` once) |
| `damage: n` / `heal: n` | health change on the acting character |
| `item: "name"` | add an inventory item |
| `spark: n` | grant Spark (capped at 5) |
| `flag: {key, value}` | set a campaign flag in adventure state |
| `goto: scene-id` | move the party to a scene |
| `end: ending-id` | finish the adventure with that ending |

Everything is validated on load (`services/tavern/questLoader.js`): unknown
stats, dangling scene/clock/ending references, underscore option keys, and
out-of-range DCs are reported with the offending file path.

## Architecture notes

- **Structured state is separate from prose.** Deterministic records
  (`tavern_characters`, `tavern_adventures.state` JSON: clocks, flags, used
  options, spotlight, big moves, last check) never mix with narrative text
  (`tavern_adventure_log`: scene beats, actions, checks, recaps).
- **The engine is deterministic**; `AdventureService` takes an injectable RNG
  and is fully covered by Jest (`tests/tavernAdventureService.test.js`).
- **AI is flavor, never mechanics** (`services/tavern/narrator.js`): freeform
  stat/DC interpretation (clamped), outcome narration, and recap polish all
  time out and fall back to pre-authored text + keyword inference. The game is
  fully playable with no AI provider at all.
- **Buttons survive restarts**: all party/scene state is in SQLite; the button
  handler (`services/tavern/interactionHandler.js`) re-reads it per click.
- **Privacy**: `/forget-me` deletes characters and party seats, anonymizes
  shared adventure records, scrubs user ids out of adventure state JSON, and
  a review pass drops log prose naming the user or their characters — all
  audited (`tests/tavernPrivacy.test.js`).

## Roadmap (beyond the alpha)

Phase 2+: persistent NPC relationships, campaign chapters, player rooms,
lore/map records, generated scene art, solo side stories, downtime crafting,
seasonal server events, and AI-driven campaign *generation* into
`data/tavern/campaigns/` (the YAML format above is the contract for it).
