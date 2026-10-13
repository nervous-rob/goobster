---
title: "UX audit and rename readiness: the first cut"
kind: decision
summary: The rename branch's first pass - where the product and assistant names now live (one build-time rename point for the portal, one runtime setting for the persona), what this pass removed from the user flows (duplicate house names in navigation, a /help and a command reference that described commands that did not exist, gendered persona copy, whimsical taglines), what still carries the old name and in which class (user-visible, compatibility, internal), and the prioritised cut list that needs a product decision before it is implemented - command sprawl, Settings sprawl, icon languages, tutorials, niche tools - and a shortlist of name directions with the UX criteria they are judged by.
when: Choosing the new name; deciding which of the proposed cuts to make; renaming anything that still says Goobster; adding copy that names the product or the assistant.
tags: [rebrand, naming, ux, audit, portal, discord, commands, settings, decision]
---

# UX audit and rename readiness

**Status: first pass, on the rename branch. No name is chosen yet.** This
document records what the audit found, what this pass changed, and what is
proposed but not done. It supersedes the pilot-era decision in
[ADR 0012](adr/0012-name-and-license.md) to keep the name; the candidates in
[product_naming_exploration.md](product_naming_exploration.md) are still the
only ones on file and none has been checked for trademark or domain
availability.

Two names are in play and they are deliberately separate:

| Name | What it labels | Where it lives now |
|---|---|---|
| **Product name** | The application: the sidebar brand, the tab title, "Install … as an app", "… was updated", the installer. | `apps/web/brand.config.cjs` (build time; one line). |
| **Assistant name** | The persona a person talks to: "Ask …", "… is thinking", "what … knows about you", slash-command descriptions. | `identity.assistantName` in `config.json` / `GOOBSTER_ASSISTANT_NAME` (runtime); the Discord bot's username when Discord is connected. |

They default to the same word. A rebrand may change the product name and
keep the persona, or change both.

## How to rename the portal and the Discord surface

1. Edit `productName` in `apps/web/brand.config.cjs`. `npm run build:web`
   inlines it into the bundle (`PRODUCT_NAME` in `src/lib/brand.ts`),
   `index.html` and `setup.html` (`%PRODUCT_NAME%`), and rewrites the static
   PWA files (`manifest.webmanifest`, `offline.html`, `sw.js`) in `dist`.
   The dev server shows the default name in those three static files.
2. Set `identity.assistantName` (and `identity.installationName`, the name
   shown on the sign-in page and invitations). The portal reads the persona
   name from `/api/app/me` and, before sign-in, from `/api/app/config`;
   slash-command descriptions and `/help` read `identityConfig.assistantName`
   at deploy time, so run `npm run deploy-commands` after changing it.
3. Regenerate the command reference: `npm run docs:commands`.
4. Run `npm test`: `tests/portalBrand.test.js` fails if the literal has crept
   back into portal source, `tests/commandDocsSync.test.js` if the reference
   is stale.

A dry run with `productName: 'Trestle'` produced a bundle whose only
remaining occurrences of the old word were the embedded documentation corpus,
the `X-Goobster-*` request headers and the `connectToGoobster()` applet API
(both compatibility surfaces, below).

## What still says Goobster, by class

| Class | Where | Count | Treatment |
|---|---|---|---|
| **User-visible, must change with the name** | Discord command replies and embeds (`apps/bot/commands`) | 34 lines | Template `identityConfig.assistantName` the way descriptions now do. |
| | Prompts, inbox items, follow-ups and notices (`packages/core/services`, `packages/core/utils`) | 149 lines | Same. Several are system prompts ("You are Goobster…") whose wording also sets the persona's voice; review them with the name. |
| | Documentation and README (public docs are also what the assistant reads about itself through `consultDocs`) | 485 mentions in 85 files; 8 in README | A sweep once the name is chosen. `documentation/features.md` and `configuration.md` are generated and need their generators changed first. |
| | Gendered persona copy outside the portal (he/him/his) | 16 lines | Replace with *it*, as the portal now does. |
| | Discord bot username, application icon, the berry mark (`apps/web/public/icons/*`, `scripts/generate-berry-icons.js`), `assets/` | - | Design work; the mark is referenced by file name in `index.html`, the manifest and the Appearance preview. |
| **Compatibility surfaces: keep, alias if renamed** | `GOOBSTER_*` environment variables | 164 names | Keep; a rename adds aliases, never removes. |
| | `@goobster/core`, `@goobster/web` package names, `goobster://` MCP resource URIs, `X-Goobster-*` headers, `connectToGoobster()` in the applet bridge, `goobster-*` `localStorage` keys, `goobster.service`, Docker image and compose names, `data/goobster.sqlite` | - | Internal or contractual. Renaming any of them breaks installs, applets or MCP clients for no user-visible gain. |
| | URL paths that carry house names (`/conservatory`, `/exchange`, `/parlor`, `/observatory`) | - | Already aliased by the room registry; leave. |
| **Internal** | Comments, test fixtures, identifiers such as `callGoobster`, `isGoobsterGateway` | - | Optional, mechanical, last. |

## What this pass removed from the user flows

Each of these is reversible and none removes a feature.

- **Two vocabularies for one place.** Every primary destination carried a
  second name ("Chat · the Study", "Knowledge · Spitball", "Projects · the
  Observatory", "Discussions · the Parlor", "Research · Expeditions",
  "Attention · Noticed", "Scheduled · Tasks", "Plan · Mission", "Files ·
  Explorer", "Runs · Jobs", "Music Lab · the Conservatory", "Trading game ·
  the Exchange"). The house names are no longer rendered in the sidebar, the
  top bar, the Knowledge and Activity tabs, the Tools cards or the
  unavailable-room page. They stay in the registry as data so old links, the
  `#room` hash scheme and the start-page preference keep resolving.
- **A `/help` that lied.** The hand-written embeds named six commands that
  do not exist and omitted most of the 73 that do. `/help` is now generated
  from the commands the running bot loaded, grouped by folder, with the real
  descriptions, filtered to what works in a DM when asked from one, and
  ephemeral. Ten stale `TODO` lines went with it.
- **A command reference that lied.** `documentation/commands.md` described
  the same phantom commands, and because the documentation corpus is what
  the assistant consults about itself, it would have told people to use
  them. It is now generated (`npm run docs:commands`) and a test keeps it in
  step.
- **The brand name as copy.** 225 hard-coded occurrences in 83 portal files
  became `PRODUCT_NAME` or `assistantName()`; 51 slash-command descriptions
  in 24 files template the configured name.
- **Gendered persona copy** in the portal (31 lines: "what you call him",
  "he may reach out", "Why he raised this"). The assistant is *it*.
- **Whimsy in first-contact copy.** The sign-in subtitle ("Come in. Memory,
  parlor, and the tools he built you"), the Home greeting line ("Same
  brain as Discord… Your work starts Private."), the HTML meta description
  ("Goobster's house"), the manifest description, the offline page and the
  empty Discussions room ("Welcome to Goobster's Parlor") now say what the
  application does. The time-of-day greeting ("Still up", "Late night") and
  the "Looking around…" loading text are kept for now; see the list below.

## Proposed cuts that need a decision

Ordered by how much they simplify what a new person meets. Counts are from
this branch.

### 1. The Discord command surface: 73 slash commands and one menu

Discord shows all of them in one autocomplete list. Half are variants of
each other.

| Group | Today | Proposal |
|---|---|---|
| Music and ambience | `/play`, `/playtrack`, `/playmusic`, `/playambience`, `/music`, `/spotdl`, `/aidj`, `/stopmusic`, `/stopambience`, `/generatemusic`, `/generateallmusic`, `/generateambience`, `/generateallambience` (13) | `/music` (play, stop, queue, dj, generate) and `/ambience` (play, stop, generate); keep the right-click menu. |
| Settings | `/aisettings`, `/dynamicresponse`, `/instructions`, `/integrations`, `/memory`, `/monologue`, `/nickname`, `/personalitydirective`, `/privacy`, `/proactive`, `/replydetection`, `/requiresearchapproval`, `/thoughtfulmode`, `/threadpreference`, plus `/mememode` and `/attention` under Utility (16) | `/settings` with subcommands for the few that matter in Discord (model, instructions, privacy, proactive) and a link to the portal's Settings for the rest. Meme mode, monologue and thread preference are candidates to drop outright. |
| Developer leftovers | `/ping`, `/user`, `/server`, `/createuser`, `/diagdb` | Remove. `/systemstatus` already covers health; `/createuser` writes a bare row nobody needs. |
| Niche | `/gbarun`, `/screenvision`, `/wrapped`, `/whatsnew`, `/joke`, `/poem` | Keep behind their features but consider whether `/joke` and `/poem` earn a top-level command when `/chat` does both. |

A target of about 25 commands is realistic without losing a capability.
Command names are a public surface: removing one needs a changelog line and
a `/help` that still answers the old name for a release (the stale-command
handler in `apps/bot/index.js` already does this for disabled features).

### 2. Settings: 93 controls in 9 sections

- **Profile** has six overlapping ways to shape the persona: *Custom
  instructions*, *Personality directive*, *Personality preset*, *Meme mode*,
  *Default tone*, *Humor and emoji*. Proposal: one *Instructions* field and
  one *Style* preset; fold meme mode into the preset; drop tone and humor
  as separate controls.
- **Appearance** offers seven icon languages (emoji plus six generated
  vocabularies: Monoline, Blocks, Sigils, Pixel, Neon, Constellation), eight
  accents, a surface switch, a navigation layout, a page width, a density, a
  text size and keyboard behaviour. Proposal: keep theme, accent, text size,
  reduced motion and Enter-to-send; retire the six generated icon languages
  (their own code, document and preview), the surface switch and the page
  width. This is the largest single removal of code on the list
  (`apps/web/src/icons/*`, `documentation/portal_icons.md`).
- **Chat & models** exposes temperature and top-p ("Sampling") and a reply
  token budget to every account. Proposal: operator-only.

### 3. Tutorials: 29 guided tours

Nine are for the Music Lab alone. Proposal: keep *Orientation* and *Your
first research task*; replace the per-room tours with the documentation
pages they duplicate, which the sidebar already links.

### 4. Tools: three optional rooms

*Card decks* (Magic: The Gathering Arena deck lists) is unrelated to the
product's promise and the only room whose blurb has to explain it is not
about slide decks. Proposal: hide it by default (the per-account hidden-tools
preference already exists) or move it out of the product. *Music Lab* is
eight instruments and a studio behind one card; it is a product of its own
and should either be first-class or an add-on, not a tool. *Trading game*
is already off by default on new installs (ADR 0012).

### 5. Home

Four buttons, a practice-task card and five cards (Personal memory,
Activity, Scheduled, Pick up where we left off, plus servers and projects
further down) compete on first load. *Pick up the last chat* duplicates
the first row of *Pick up where we left off*. Proposal: one primary action
(New chat), the pick-up list, Activity, and nothing else above the fold.

### 6. Remaining vocabulary and tone

Now that navigation uses one vocabulary, the words survive in copy: back
buttons that say "← Expeditions", Settings keywords and hints that say
"Spitball", "Parlor" and "the Study", the "Ballistic Goblin Wheel", the
time-of-day greetings, "Looking around…". A copy sweep with the chosen
name should settle a voice (plain, second person, no in-jokes) and apply it
once.

### 7. Checks this pass did not make

- Screen-reader output with the emoji icon style, where the emoji precedes
  each room name and may be read aloud ("brain Knowledge"). The generated
  icon languages are decorative SVG; the default is not.
- Whether the installer's and Host room's copy reads correctly with a
  product name that is not also the assistant's (the setup client uses the
  product name throughout, which is right, but has not been read end to end
  that way).

## Name directions from the UX seat

What the audit says a name has to do, now that the product's shape is clear:

- **Be two things at once.** It is addressed ("ask …", "… noticed", "message …") and it is installed ("set up …", "… was updated"). A noun that can also be a persona; not a verb, not a compound.
- **Survive being heard once.** One obvious spelling, one or two syllables, no silent letters. Discord autocomplete, a CLI, a package scope and a service unit will all carry it.
- **Fit the promise without describing it.** Memory that accumulates, work that gets carried through, something that notices on your behalf, on your own machine. Words for *marker*, *keeper*, *grower* and *light* fit; words for *bot*, *brain*, *AI* and *hub* are taken and flat.
- **Lose the joke, keep the warmth.** The cuts in this pass remove whimsy from the flows; the name should not put it back, but a cold infrastructure word ("Workbench", "Hub") would waste the berry mark and the persona.
- **Keep the mark if it can.** The berry is drawn in every accent and is the only visual asset that already works everywhere; a name it can illustrate saves a redesign.

Candidates, unchecked for trademarks, domains or package names (the decision process in [product_naming_exploration.md](product_naming_exploration.md) still applies):

| Candidate | Why it fits | Watch out for |
|---|---|---|
| **Bramble** | A thicket that grows, connects and bears fruit: memory, notes and projects that accumulate over time. Keeps the berry mark without a redesign. Two syllables, spelled as heard. Reads as both product ("set up Bramble") and persona ("Bramble noticed"). | "Prickly" connotation; a few small software uses of the word. |
| **Cairn** | A marker people add to as they pass: knowledge built up and left where others find it. One syllable; quiet and sturdy; self-hosted on its own hill. Already on the earlier list. | Pronunciation drift ("karn"/"kairn"); several existing products and a well-known dog breed share it. |
| **Lantern** | Something that lights what matters and is carried by its owner: the Attention and Inbox half of the product. Warm without being cute; strong as a persona. | A common product word; weaker for the knowledge and projects half. |
| **Wren** | A small, clever bird that sings (the Music Lab) and notices everything. One syllable, unmistakable spelling, excellent as a *persona* name. | Weak as a product name; a large UK retailer and a carbon company use it. Best paired with a product name above. |
| **Trestle** | Supports work and bridges parts; the most "projects" of the set. Already on the earlier list. | Says structure, not understanding; collisions likely. |
| **Fieldnote** | Observation and evidence; the research and knowledge half. Already on the earlier list. | Says notebook, not action; two words' worth of syllables. |

A recommendation under the two-name model in this document: **Bramble** for
the product, with the persona either keeping its current name for continuity
or becoming **Wren**. Cairn is the strongest single-word alternative if the
berry mark is going to change anyway.

## Figures for this pass

| | Before | After |
|---|---|---|
| Portal files spelling the brand name in user-facing strings | 83 | 0 (fenced by test) |
| Slash-command descriptions with a literal name | 51 | 0 |
| Commands `/help` listed that do not exist | 6 | 0 |
| Commands `/help` omitted that do exist | 38 | 0 |
| Destinations showing two names | 12 | 0 |
| Gendered persona lines in the portal | 31 | 0 |
