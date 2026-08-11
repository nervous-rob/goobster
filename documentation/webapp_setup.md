# Goobster Web App - Setup

The web app is a browser interface for Goobster, served by the bot itself:

- **Chat** - a full LLM chat that runs through the *same pipeline* as
  Discord chat (memory recall, facts, personality, tool calling, per-user
  settings). Conversations live in the user's DM scope, so web chat and
  Discord DMs share long-term memory. Replies stream token-by-token, render
  full Markdown with syntax-highlighted code, and are not bound by Discord's
  2000-character limits (inputs up to 20k characters, unchunked replies).
  The chat UX matches the ChatGPT/Claude class of apps: a conversation
  sidebar with auto-generated titles, rename/delete/search, Stop generating
  (a real server-side abort between agent rounds), Regenerate, edit &
  resend, image attachments for vision (file picker or paste), copy buttons
  on messages and code blocks, Markdown export, a light/dark theme, and a
  Thoughtful Mode toggle (the web face of `/thoughtfulmode`, pinned to the
  user's DM scope so Discord DMs follow along).
- **The Parlor** - a multi-persona AI workspace where conversations become
  persistent, evolving knowledge. Create personas with distinct charters
  (a researcher, an engineer, a philosopher...), seed each one's private
  tag-first knowledge workspace (notes connect through shared tags; semantic
  search; an interactive graph), and hold discussions with up to four
  personas at once. Before every reply a persona retrieves from its own
  workspace (the notes used are shown as grounding chips under the message),
  and after replying it extracts durable knowledge from the exchange back
  into the workspace - so each persona develops its own expertise over time.
- **Memory dashboard** - a per-user transparency console: the
  `/what-do-you-know-about-me` report, browsable facts and memories with
  individual delete buttons, and (for Manage Server members) an interactive
  visualization of the guild's knowledge graph plus the internal monologue's
  recent thoughts and scratch pad.

Everything is **off by default**. Enabling it makes Goobster's public HTTP
server (the one that serves `/health` and the Activity) also serve the web
client at `/app` and its API under `/api/app/*`.

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
- Guild data access is verified live through the bot client: browsing a
  guild scope requires actual membership, and the knowledge graph requires
  Manage Server (parity with `/monologue graph`).
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

The knowledge model is **tag-first** (the Spitball design): notes never
link to each other directly - tags create the relationships, so notes that
share a concept connect automatically and the graph stays maintainable.
Notes carry their own embeddings (computed fire-and-forget on write;
semantic search is a bounded brute-force cosine scan over one persona's
notes, with a keyword fallback when no embedding backend is available).

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
the discussion and persist in the transcript. Parlor-management tools are
deliberately not offered to personas.

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

## 7. Local development / testing

```json
{ "webapp": { "enabled": true, "devMode": true } }
```

Open `http://localhost:3000/app/`, mint a dev identity (any snowflake-shaped
id), and chat. Dev identities get real DM-scope data keyed on that id, so
use a test id if you don't want test conversations mixed into a real user's
memory.
