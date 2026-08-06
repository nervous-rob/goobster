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

## 6. Local development / testing

```json
{ "webapp": { "enabled": true, "devMode": true } }
```

Open `http://localhost:3000/app/`, mint a dev identity (any snowflake-shaped
id), and chat. Dev identities get real DM-scope data keyed on that id, so
use a test id if you don't want test conversations mixed into a real user's
memory.
