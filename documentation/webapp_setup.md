# Goobster Web App - Setup

The web app is a browser interface for Goobster, served by the bot itself.
It is one house with rooms, not eight products in a nav. The sidebar has
**seven primary destinations** - Home, Chat, Knowledge, Projects,
Discussions, Activity, Tools - plus an account area (Usage & limits,
Settings, and the operator-only Host). The house names stay as secondary
labels ("Knowledge · Spitball", "Discussions · the Parlor") and every older
URL still resolves; the contract, the room registry and the alias table are
in [portal_navigation.md](portal_navigation.md). **Home** is the front door
(new chat / note / project, personal memory, Activity, pick up where you
left off).

- **Chat (the Study, `/chat`)** - a full LLM chat that runs through the *same pipeline* as
  Discord chat (memory recall, facts, personality, tool calling, per-user
  settings). Conversations live in the user's DM scope, so web chat and
  Discord DMs share long-term memory. Replies stream token-by-token, render
  full Markdown with syntax-highlighted code and **LaTeX math** (KaTeX,
  served locally - `\( ... \)` inline, `\[ ... \]` / `$$ ... $$` display),
  and are not bound by Discord's 2000-character limits (inputs up to 20k
  characters, unchunked replies).
  The chat UX matches the ChatGPT/Claude class of apps: a conversation
  sidebar with auto-generated titles, rename/delete/search, Stop generating
  (a real server-side abort between agent rounds), Regenerate, edit &
  resend, image attachments for vision (file picker or paste), copy buttons
  on messages and code blocks, Markdown export, a light/dark theme, and a
  Thoughtful Mode toggle (the web face of `/thoughtfulmode`, pinned to the
  user's DM scope so Discord DMs follow along). On phones the sidebar
  becomes a slide-in drawer behind a ☰ button.
- **Mini-apps** - ask Goobster to *build* something visual or playable and
  he answers with a complete self-contained HTML document in an ` ```html `
  code block, which the chat renders as a live interactive app: a sandboxed
  iframe with Preview/Code tabs, restart, fullscreen, and a download button.
  The sandbox has no `allow-same-origin`, so generated code runs on an
  opaque origin and can never touch the session cookie, the API, or the
  page's DOM. Observatory files the signed-in user owns can be read only
  through a parent-mediated capability bridge: the applet declares
  `<meta name="goobster-observatory-read" content="project-slug">`, the
  user is prompted the first time, and the parent fetches an owner-only
  content route. Demos, visualizations, simulators, calculators, little
  games - the system prompt tells the model about this canvas, so
  "build me a ..." just works.
- **Discussions (the Parlor, `/discussions`)** - a multi-persona AI workspace where conversations become
  persistent, evolving knowledge. Create personas with distinct charters
  (a researcher, an engineer, a philosopher...), seed each one's private
  tag-first knowledge workspace (notes connect through shared tags; semantic
  search; an interactive graph), and hold discussions with up to four
  personas at once. Before every reply a persona retrieves from its own
  workspace (the notes used are shown as grounding chips under the message),
  and after replying it extracts durable knowledge from the exchange back
  into the workspace - so each persona develops its own expertise over time.
- **Knowledge (Spitball, `/knowledge`; formerly the Library)** - what you
  chose to keep. Opens on **Notes** (`/knowledge/notes`: search, filters,
  New note, edit, delete, **Keep** for unsorted legacy rows), with **Map**
  (`/knowledge/map`: the same notes as a graph - typed connections plus
  shared-tag hubs) and **Research** (`/knowledge/research`: expeditions) as
  its other views. *Your notes* is the default projection; *All retained
  knowledge* also shows what Goobster distilled. Manage Server members can
  switch the Map to the server's own shared graph (labelled as such).
  What Goobster knows *about you* - the transparency report, Facts and
  Memories with one-by-one deletion, retention and **Forget me** - lives in
  **Settings → Memory & privacy**, one click away from Chat, Knowledge and
  Home's *Personal memory* card. See `documentation/knowledge_and_memory.md`.
- **Projects (the Observatory, `/projects`)** - shown only when the feature
  is enabled. Persistent simulation projects on top of the sandbox, plus the
  unfiled generated apps that used to be the Workshop (`/workshop` and
  `/observatory` still resolve here). Home grows a Projects card with
  project and running-job counts. See `documentation/observatory.md`.
- **Tools (`/tools`)** - the door to the optional specialist rooms: **Music
  Lab** (the Conservatory, `/conservatory`), the **Trading game** (the
  Exchange, `/exchange`) and **Card decks** (MTG Arena, `/decks`). Each card
  says what the tool is for and, when it cannot open on this installation
  (the trading game without a Discord adapter), why - instead of opening a
  room that fails.
- **The exchange** - a browser trading terminal for one of your servers:
  the account audit (equity, buying power, positions, liquidation levels,
  risk flags, and the wallet-vs-ledger reconciliation), quotes with a price
  chart, market buy/sell/short/cover, the simulated option chain, resting
  orders, and the equity leaderboard. It drives the *same* services the
  slash commands use, so every feature gate and margin rule applies
  identically - see `documentation/jimbucks_exchange.md`.

- **Activity (`/activity`)** - one destination, three views that keep their
  own actions: **Inbox** (`/activity/inbox`, formerly `/inbox`) is where
  unattended work lands - due reminders, scheduled task output, watch
  reports, attention notices, invitations. Every result is stored here first
  and echoed to Discord DMs as an optional extra, so a person with no
  Discord account (or an installation with no Discord) still receives
  everything - see `documentation/independent_runtime.md`. **Attention**
  (`/activity/attention`, formerly Noticed) is the proactive-attention
  ledger with its why/acknowledge/snooze controls (`documentation/attention.md`),
  and **Scheduled** (`/activity/scheduled`, formerly Tasks) is reminders and
  recurring AI tasks. The sidebar badge is the Inbox unread count alone.

Everything is **off by default**. Enabling it makes Goobster's public HTTP
server (the one that serves `/health` and the Activity) also serve the web
client at `/app` and its API under `/api/app/*`. The same portal can also
run **without Discord** as `apps/api` in standalone mode (no bot token,
`discord.enabled: false` or simply no `token`): chat, memory, tasks,
projects, and the Inbox all work; server scopes and the Exchange say the
installation is not connected to Discord.

## 1. Configuration

In `config.json`:

```json
{
    "webapp": {
        "enabled": true,
        "devMode": false,
        "publicUrl": "https://activity.nervouslabs.com"
    }
}
```

- `enabled` - serves `/app` (client) and `/api/app/*` (auth + chat + dashboard)
  on the health server (`PORT`, default 3000).
- `publicUrl` - the public HTTPS origin the app is reached on. Required for
  Discord login: the OAuth redirect URI is derived from it
  (`<publicUrl>/api/app/auth/callback`) and must match the Developer Portal.
- `devMode` - allows minting arbitrary browser identities via
  `POST /api/app/auth/dev-session` so the app can be developed at
  `http://localhost:3000/app/` without Discord. **Never enable on an
  internet-exposed server** - it bypasses Discord authentication entirely.
- `/app` serves the React client built by `npm run build:web`
  (`apps/web/dist`); there is no other client. A missing build answers
  `503 WEB_CLIENT_UNBUILT` instead of falling back. `/app/next/*`
  (the strangler-era URL) redirects to `/app/*`, and share viewers
  (`/app/share/:token`) are SPA routes. During Vite development,
  `npm run dev:web` proxies `/api` to the bot/api process on port 3000.
- The OAuth client secret is shared with the Activity: set
  `DISCORD_CLIENT_SECRET` (env) or `activity.clientSecret` /
  `webapp.clientSecret` in `config.json`.

## 2. Public HTTPS exposure

Same as the Activity: the app rides the existing cloudflared tunnel. If the
Activity is already mapped (e.g. `activity.nervouslabs.com` -> port 3000),
the web app is simply available at `https://activity.nervouslabs.com/app/` -
no new tunnel or mapping needed.

## 3. Developer Portal setup

On the same application the bot runs under, add the OAuth redirect:

1. **OAuth2 → Redirects**: add `<publicUrl>/api/app/auth/callback`
   (e.g. `https://activity.nervouslabs.com/api/app/auth/callback`).

That's it - the login flow only requests the `identify` scope, uses the
access token once to resolve the user, and never stores it.

## 4. Auth model

- Sessions are SQLite-backed (`web_sessions`): only the SHA-256 of the
  session token is stored, sessions last 30 days, and they survive restarts
  (a Pi reboot never logs everyone out). The raw token lives in an
  httpOnly, SameSite=Lax cookie (plus `Secure` when `publicUrl` is HTTPS).
- Every API route requires the session; state-changing requests also pass
  an Origin guard.
- Two sign-in methods mint the same session: Discord OAuth, and - once the
  host sets `identity.nativeLogin: true` - a login name + password issued
  through an invitation from the **Host** room. With an outbound mail
  provider configured (`mail.*`, see `identity.md`) and `publicUrl` set,
  accounts can add a verified email address, sign in with it, and reset a
  forgotten password themselves; `identity.registration: "open"` then also
  allows self-service sign-up. Sessions carry `authenticatedAt` (sensitive
  changes need a recent one) and an account `sessionVersion` snapshot (a
  password reset or disable revokes them). Details: `identity.md`.
- Guild data access is verified live through the bot client: browsing a
  guild scope requires actual membership, and the knowledge graph requires
  Manage Server (parity with `/monologue graph`). With the bot unreachable
  those panes answer `503 BOT_OFFLINE` (transient); with no Discord adapter
  at all they answer `503 DISCORD_DISABLED`; a native account with no linked
  Discord identity gets `403 NO_DISCORD_IDENTITY` and a pointer to
  Settings → Account. `GET /api/app/me` carries `discord: { enabled,
  connected, reason }`, `assistant: { id, name }`, and `inbox: { unread }`
  so the client can degrade the right surfaces.
- `/forget-me` deletes the user's web sessions along with everything else,
  and the erasure audit counts the table.

## 5. How chat works

`services/webChatService.js` builds a web-shaped pseudo-interaction (the
`createPseudoInteraction` pattern from `events/messageCreate.js`) and feeds
it to the normal `handleChatInteraction`. Web-specific capabilities the
pipeline understands:

- `onStreamDelta` - raw token deltas, forwarded over SSE (no Discord edit
  throttling).
- `sendFullResponse` - the reply is delivered whole instead of chunked to
  Discord's 1900-character limit.
- `maxInputLength` - the input cap is 20k characters instead of 2000.
- The context window is rebuilt from SQLite (the `messages` table) instead
  of the Discord API, so history survives restarts and reloads.

Scoping: chat rows, memories, and facts are keyed on the user's DM scope
(`dm:<userId>`). Each sidebar conversation is a `web_conversations` row
naming its own synthetic channel (`web:<userId>:<key>`), so long-term
memory and facts are **shared** with the user's Discord DMs while every
conversation keeps an independent message window. "Edit & resend" and
"Regenerate" are one primitive: truncate the message rows from a point,
then send a fresh turn (the context window rebuilds from SQLite).
Conversation titles are auto-generated ChatGPT-style: a cheap fallback
lands immediately, a short model-written title replaces it asynchronously.

Stop generating: the Stop button aborts the client stream AND flips a
server-side flag polled by the agent loop (`shouldAbort`), so generation
halts at the next round boundary; partial text is kept and stored.

Guardrails: one in-flight turn per user, 10 turns/minute rate limit,
vision attachments validated server-side (max 4 data URLs, ~6MB each),
image-tool output served through an owner-bound authenticated file route.

## 6. How the Parlor works

`services/parlorService.js` owns everything (routes in `web/appApi.js`
under `/api/app/parlor/*` stay thin). Personas, their workspaces, and
discussions are private to the signed-in user.

The knowledge model is the **same graph as Spitball**: each persona
workspace is a `kg_*` scope (`PARLOR:<personaId>` under the owner's DM
guild id). Notes are typed nodes, tags cluster them, and typed edges are
first-class. The workspace graph overlays tag hubs the same way the Map
does (`withTagLinks`). Notes carry embeddings on `kg_node_embeddings`
(computed fire-and-forget on write; semantic search is a bounded
brute-force cosine scan over one persona's notes, with a keyword fallback
when no embedding backend is available).

Every persona reply follows a fixed workflow, so it is based on the
persona's *current knowledge state*, not only the immediate conversation:

1. **Retrieve** - semantic search over the persona's own notes.
2. **Generate** - the reply is grounded in the retrieved notes; their ids
   are stored on the message and rendered as grounding chips (traceable
   context).
3. **Write back** - an ONLY-JSON extraction pass proposes up to two durable
   notes from the exchange; deterministic code legalizes them (length and
   per-persona caps, title dedupe, tag normalization) and files them with a
   `learned` badge. The model proposes, the service decides.

Multi-persona discussions stream over one SSE connection: each seated
persona replies in turn and sees the others' replies as labeled messages,
so they can engage and disagree. In group discussions every persona first
*considers* whether it actually has something to add - personas the topic
doesn't concern show a quiet "listens" line instead of piling on
(addressing one by name always makes them speak, and if everyone declines
the first seat answers anyway). Clicking a participant chip manually asks
that persona to speak right now - no new message needed, even if they just
replied - which is the lever for storytelling rounds and long-form
planning. Deleting a discussion keeps everything the personas learned;
deleting a persona removes its whole workspace. `/forget-me` deletes the
entire parlor.

Personas are tool users, too: replies run through the same bounded agent
loop as Goobster's chat with a curated subset - web search (plus native
provider search), image generation, the sandboxed code runner (when
enabled), dice, and stock quotes - and the prompt tells each persona to
use them the way its charter would (a researcher verifies and cites, an
engineer runs the numbers). Generated images and charts appear inline in
the discussion (other generated files appear as download chips) and
persist in the transcript. Personas render the same rich replies as the
main chat - LaTeX math and live sandboxed HTML mini-apps - so you can ask
a persona to *build* the thing you're discussing. Parlor-management tools
are deliberately not offered to personas.

**Quickstart**: a fresh parlor offers a one-prompt setup - describe what
you want to talk about and an AI concierge designs the cast (2-4 personas
with distinct perspectives), seeds each one's workspace with starting
notes, opens a titled discussion, and suggests an opening message. All
proposals pass through the same validation as manual creation.

**Chat integration**: Goobster himself can operate your parlor from any
text chat via the `manageParlor` tool - ask him to set up a salon about a
topic, add a persona, seed workspace notes, or check what a persona knows.
The tool only ever touches the requesting user's parlor and has no delete
actions (removal stays in the web UI).

**Inviting people**: a discussion can be shared with up to three other
humans. Open **People** in the discussion header and pick someone - the
picker lists your Discord friends first, then the people you share a server
with Goobster. Friends come from the Activity (the only place Discord lets
an app read a friend list; enable `activity.relationships` and see
`documentation/activity_setup.md`), so without it the picker falls back to
your shared servers. Pasting a Discord user id always works. Invitees get a
DM with accept/decline buttons and see the invitation in their own web app,
so closed DMs never block joining.

## 7. How the exchange terminal works

The **Exchange** pane is the browser face of the stock game and the Jimbucks
Exchange. It is **per-server**, not per-user: wallets, positions, and the
feature switches all live in a Discord guild, so the pane opens with a server
picker and the DM scope never appears. A user who shares no server with
Goobster is told so instead of being shown an empty terminal.

Five tabs, all reading and writing through `/api/app/exchange/*`:

- **Portfolio** - the full account audit: equity, cash, buying power and
  exposure; margin state and liquidation levels when there is a loan;
  positions across stocks, shorts, options and perps with live marks and
  P/L; the risk flags; realized results per instrument; and the
  wallet-vs-ledger reconciliation that proves the books add up.
- **Trade** - symbol search, a live quote with your exposure to it, a daily
  close chart (1mo-1y), and market **buy / sell / short / cover**. Sell and
  cover with the units box empty close the whole position.
- **Options** - the calls-strike-puts ladder with greeks, IV, and ITM
  probability, plus buy-to-open and sell-to-open per contract. The tab only
  appears when the guild has options enabled, and premiums are labelled
  simulated wherever they are shown.
- **Orders** - place limit, stop, stop-limit, and trailing-stop orders and
  cancel working ones. The risk engine evaluates them on its 5-minute tick;
  this is not a continuous matching engine.
- **Leaderboard** - the guild ranked by **equity**, so a wallet full of
  borrowed points is not a big account.

`services/webExchangeService.js` verifies live guild membership through the
bot client on every call, then delegates to `stockPortfolioService`,
`shortService`, `optionsService`, `orderService`, and `auditService`. Nothing
is reimplemented: the feature gates (`/exchange settings`), the margin
requirements, and the invariant that every point moves through
`economyService.adjust()` hold for web trades by construction. Actions the
web UI cannot take are the ones that change how much risk an account may
carry - switching to a margin account, setting leverage, and Goblin Mode stay
in `/margin`, the same way the chat tools require explicit confirmation.

## 8. Local development / testing

```json
{ "webapp": { "enabled": true, "devMode": true } }
```

Open `http://localhost:3000/app/`, mint a dev identity (any snowflake-shaped
id or a `usr_…` principal id), and chat. Dev identities get real DM-scope
data keyed on that id, so use a test id if you don't want test conversations
mixed into a real user's memory.

To develop against the portal with **no Discord token at all**, run the api
in standalone mode against a throwaway database:

```bash
GOOBSTER_DISCORD_ENABLED=0 GOOBSTER_DB_PATH=/tmp/dev.sqlite GOOBSTER_API_PORT=3100 node apps/api
# then http://localhost:3100/app/
```

Guild-scoped panes (the memory dashboard's guild scopes, the knowledge graph,
and the whole exchange terminal) verify real membership through the bot
client, so a dev identity only reaches a server it is actually a member of -
use a real member's id (for example the guild owner's) to exercise them.

Headless portal journeys (no Discord token) live in `e2e/`. After
`npm run build:web` and `npm run test:e2e:install`, `npm run test:e2e`
mounts the same `createWebAppApp` / `devMode` stack Playwright clicks.

### File response and incognito boundaries

`/api/app/files/:fileId` keeps owner authentication and serves only raster
images, audio, and video inline. Text/code (including existing HTML, SVG,
and XML artifacts) is served as `text/plain` with attachment disposition;
other files use `application/octet-stream`. Every file response includes
`nosniff`, a sandbox CSP, and private/no-store caching. Browser attachment
previews still fetch and render text through the existing safe renderers.
New web downloads with active document extensions are named `.txt`.

Incognito does not offer `rememberFact`, `saveArtifact`, `findImages`, or
`fetchWebFile`. The tool registry rejects stale calls to those tools before
network requests or storage writes. Read-only lookup remains available.
Use a regular chat to save memories or fetch files into Spitball.
