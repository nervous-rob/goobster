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
| `/tavern board` / `/adventure browse` | the full quest board (🔒 marks gated chapters) |
| `/tavern rumor` | today's rumor |
| `/tavern npc name:` | talk to a resident (Marnie, Bix, Sister Caldra, Albert) - shows your standing with them |
| `/tavern profile [user]` | a member's character and trophies |
| `/tavern room [user]` / `/tavern room-edit` | Guest Rooms: personal space, trophies, NPC standings |
| `/tavern generate-art quest:` | (Manage Server) paint scene art into `data/tavern/assets/` |
| `/tavern reload-quests` | (Manage Server) reload campaign YAML from disk |
| `/character create/sheet/edit/advance/inventory/retire` | character management (inventory: view/use/give/drop) |
| `/adventure join/invite-goobster/begin/act/attack/twist/bigmove/status/recap/leave/abandon` | play |
| `/tavern forge prompt:` | (Manage Server) Goobster writes a whole new campaign onto the board |
| `/world map` / `/world lore name:` | the Map Room: lore your adventures wrote into the world |
| `/roll check stat: [dc]` / `/roll dice expression:` | dice, in or out of adventures |

### Talking to Goobster instead of typing commands

The whole loop is also operable in plain chat (and by voice in a `/voicechat`
session with a transcript channel) through Goobster's tool registry:
`tavernInfo` (status/board/rumor/NPCs/your sheet/world lore), `tavernParty`
(create/join/begin/leave/invite Goobster), `tavernAct` (freeform actions -
"Goobster, I ram the door with my cooking pot"), `tavernAttack` ("I attack
the golem"), `tavernTwist` (bend the storyline), `tavernRecap`, and
`rollDice`.

### Combat: encounters, enemies, telegraphed intents

A scene with an `encounter:` block starts combat on entry. Enemies have
health, a defense DC, flat damage, and a cycling list of **telegraphed
intents** - the scene always shows what each foe is about to do next.
Attack with the buttons, `/adventure attack`, or by telling Goobster; a hit
deals 2 damage (3 on a natural 20), a miss still draws the round forward,
and Spark can reroll a miss. Once the party has taken as many actions as it
has members, every living enemy executes its telegraphed intent against
whoever just acted, then telegraphs the next. Defeats fire `onDefeat`
effects (loot); the last enemy falling fires the encounter's `onVictory`
block. Social and trick options remain live during combat - a good parley
can end a fight the dice never could. There is no party wipe: the danger
clock is the fail-state, exactly as outside combat.

### Inventory

`/character inventory` manages the pack: `view` (annotates which items are
usable at your current table), `use` (consumables defined by the campaign's
`items:` block - healing, Spark; using one is an action, and in combat the
enemies notice), `give` (hand an item to another character), `drop`.
Trophies and loot arrive automatically from endings and `item` effects.

### Story twists: Goobster edits the campaign mid-flight

When the players' actions bend the story somewhere the campaign never went,
any party member can call `/adventure twist description:` (or just tell
Goobster - the `tavernTwist` tool). Goobster then **writes new campaign
YAML**: a hidden fork of the running campaign
(`data/tavern/campaigns/<id>--twist-<n>/`, `canonicalId` pointing home)
containing 1-3 brand-new scenes that honor the players' idea. Two
deterministic guarantees keep the model honest:

1. The fork passes full campaign validation before a single file is written
   (one repair round on errors, then a graceful refusal).
2. A reachability check (`checkTiesBack`) proves every new branch leads back
   into the **original** scenes or endings - no new endings may be invented.
   The twist is a detour, not a different book.

The running adventure is re-pointed at the fork's entry scene; the original
campaign stays untouched for every other table, and the fork is hidden from
the quest board. One twist per adventure. Completing a twist fork still
satisfies `requires:` chapter gates on the canonical campaign.

`/tavern forge prompt:` (Manage Server) uses the same machinery to write a
**whole new campaign** onto the board - validated, playable, and saved as
ordinary editable YAML under `data/tavern/campaigns/`.

### Goobster plays too

`/adventure invite-goobster` (or asking him in chat) seats Goobster at a
forming party with his own persistent per-guild character - an **Oddity**
("The Tavern's own spirit, pouring himself a body for the evening"). He takes
a turn whenever the spotlight rotation reaches him, a couple of seconds after
the player action that handed it to him. Rules of the house
(`services/tavern/botAdventurer.js`, mirroring the casino `botPlayer`
architecture):

- **The model decides, the engine legalizes.** Every turn is an AI decision
  (persona-prompted, ONLY-JSON) repaired into a legal move; a deterministic
  fallback (best-stat option, else an in-character improvisation) plays only
  when no usable answer arrives.
- **He follows, never leads**: travel options and ending choices are the
  players' to make - he only takes checks or freeform actions.
- He never offers the humans a Spark-reroll button for his own failures, can
  sit at several tables at once (the one-party rule doesn't bind a spirit),
  and earns milestones/trophies like anyone else.

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
type: one-shot                      # one-shot | tavern-tale | campaign-chapter (display only)
requires: some-other-quest          # optional chapter gate: the board only
                                    # posts this once the server has completed
                                    # that quest (see signal-in-the-salt)
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
    effects: { npc: { key: marnie, delta: 1 } }   # optional side effects
    text: Narration for taking it.
encounter:                          # optional: combat starts on scene entry
  enemies:
    - id: clause-golem              # slug, no underscores
      name: The Clause Golem
      emoji: "🗿"
      health: 8                     # 1-20
      defense: challenging          # DC to hit (band or number)
      damage: 2                     # 0-5 per enemy attack
      intents:                      # telegraphed threats, cycled in order
        - It raises its gavel-fist toward the cracked ceiling vault.
        - It winds up the great stamp of FINAL NOTICE.
      onDefeat:                     # optional loot/consequences
        text: ...
        effects: { item: Deed-Seal of Deed's End }
  onVictory:                        # optional: fired when the last enemy falls
    text: ...
    effects: { goto: settlement }
```

`quest.yaml` may also define usable consumables:

```yaml
items:
  Lease-Sealed Poultice:
    use: { heal: 3, text: "It works beautifully." }
```

### endings.yaml

```yaml
- id: hang-bell
  title: The Bell Comes Home
  text: >
    The epilogue paragraph.
  trophy: Brinewatch Bell-Rope      # optional: lands in every survivor's inventory
  world:                            # optional: lore written into the guild's
    - kind: location                #   shared Map Room record on this ending
      name: Brinewatch              #   (kinds: location, faction, event,
      text: One-paragraph entry.    #    artifact, character)
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
| `npc: {key, delta}` | move the acting player's relationship with a resident NPC (clamped -5..+5) |
| `goto: scene-id` | move the party to a scene |
| `end: ending-id` | finish the adventure with that ending |

Travel options (`goto`/`end`) may carry an `effects` block too (applied before
the travel), so an ending *choice* can move relationships - but their effects
can never contain a second `goto`/`end`.

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

## Generated assets

Scene art lives as static files in the data folder, generated once and served
from disk forever after:

```
data/tavern/assets/scenes/<quest-id>/<scene-id>.png
```

`/tavern generate-art quest:` (Manage Server, needs an OpenAI key) paints any
missing scenes; `force:true` repaints. Scene embeds attach the art
automatically whenever the file exists and stay text-only otherwise
(`services/tavern/assetService.js`). Because the files are ordinary PNGs on
disk, server owners can also just drop their own art in.

## Phase 2 in the database

- `tavern_npc_relationships` - per-member standing with each resident NPC
  (clamped -5..+5, labels from "Banned from the good chairs" to "Sworn friend").
- `tavern_rooms` - Guest Room descriptions (trophies and standings render from
  the character sheet and relationship table).
- `tavern_lore` - the shared world record (one entry per guild+kind+name;
  retellings update content; capped at 200 entries per guild).
- Chapter gating needs no new table: a quest with `requires:` unlocks when a
  COMPLETED `tavern_adventures` row for the required quest exists in the guild.

## Roadmap (beyond phase 2)

Phase 3+: TTS narrator mode, ambient scene music, deeper downtime (crafting,
gambling with tavern currency), solo side stories, seasonal server events, and
AI-driven campaign *generation* into `data/tavern/campaigns/` (the YAML format
above is the contract for it).
