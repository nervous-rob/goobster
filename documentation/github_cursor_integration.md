# GitHub & Cursor Agent Integration

Goobster can watch GitHub repositories (events posted into Discord channels, plus
chat tools that read code) and launch [Cursor cloud agents](https://cursor.com/docs/cloud-agent)
against those repositories from Discord. Both integrations are optional and degrade
gracefully: without credentials the commands explain what's missing and nothing crashes.

## Credentials

All keys resolve environment-first, then `config.json` (see `config/integrationsConfig.js`).

| Credential | Env var | config.json key | Needed for |
|---|---|---|---|
| GitHub fine-grained PAT | `GITHUB_TOKEN` | `github.token` | Higher rate limits, code search, private repos (public reads work keyless) |
| GitHub webhook secret | `GITHUB_WEBHOOK_SECRET` | `github.webhookSecret` | Live repo events in watch channels |
| Cursor API key | `CURSOR_API_KEY` | `cursor.apiKey` | Everything under `/agent` |
| Cursor webhook secret | `CURSOR_WEBHOOK_SECRET` | `cursor.webhookSecret` | Instant agent status updates (optional — polling is the default) |

### Creating a GitHub fine-grained personal access token

1. GitHub → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. Resource owner: your user or org; Repository access: **Only select repositories** (pick the repos Goobster should see).
3. Repository permissions:
   - **Contents: Read** (files, commits)
   - **Metadata: Read** (always required)
   - **Issues: Read and write** (write is only needed for the `createGithubIssue` conversation→issue flow; use Read if you don't want Goobster filing issues)
   - **Pull requests: Read**
   - **Actions: Read** (CI status)
4. Set an expiration, generate, and store the token as `GITHUB_TOKEN`.

### Creating a Cursor API key

1. Go to [cursor.com/dashboard → API Keys](https://cursor.com/dashboard/api) and create a user API key
   (teams can use a [service account key](https://cursor.com/docs/account/enterprise/service-accounts) instead,
   so agent launches aren't tied to one person).
2. Store it as `CURSOR_API_KEY`. Note that launched agents spend your Cursor plan's compute.

### Webhook secrets

Generate each secret yourself (any random string, 32+ chars):

```bash
openssl rand -hex 32
```

Set it as `GITHUB_WEBHOOK_SECRET` / `CURSOR_WEBHOOK_SECRET`. A receiver is enabled
only when its secret is configured; every delivery is HMAC-SHA256 verified against
the raw body before parsing.

## Exposing the webhook receivers

The receivers mount on the public health server (`PORT`, default 3000):

- `POST /api/webhooks/github`
- `POST /api/webhooks/cursor`

**Already running the Discord Activity?** Then you're done — the Activity is
served by the same health server, so the hostname you mapped for it (e.g.
`activity.example.com` → `http://localhost:3000`) also reaches the webhook
receivers. Use `https://<activity-host>/api/webhooks/github` as the payload URL.
The routes only exist while the matching secret is configured; unsigned or
mis-signed deliveries are rejected 401, so sharing the public hostname adds no
new attack surface.

Otherwise, a Pi behind NAT needs a tunnel (see `documentation/activity_setup.md`
for the cloudflared setup).

Then in the GitHub repo: **Settings → Webhooks → Add webhook** → Payload URL
`https://<your-host>/api/webhooks/github`, content type `application/json`,
your secret, and under "Which events?" choose **Let me select individual
events**: Pushes, Pull requests, Issues, Releases, Workflow runs. GitHub sends
a `ping` on creation — Goobster ACKs it (202) and ignores it, so a green check
in **Recent Deliveries** confirms the whole path works.

Note on the Cursor receiver: the Cloud Agents **v1** API doesn't take a webhook
URL at launch yet (v0 did; v1 webhooks are "coming soon"), so today agent
updates arrive via the built-in poller regardless — the receiver is ready for
when per-launch webhooks land in v1.

No tunnel? Everything still works: GitHub watch channels won't receive live events
(the rest of `/github` is request/response), and Cursor agent updates arrive via
the built-in poller (default every 60s, `cursor.pollIntervalMs`) instead of webhooks.

## Commands

- `/github watch repo:<owner/name> [channel] [events]` (Manage Server) — post repo
  events into a channel. Events: `push`, `pull_request`, `issues`, `release`, `ci`
  (CI posts failures only). Watching also **allowlists the repo** for the chat tools
  and `/agent launch` in that server.
- `/github unwatch repo:<owner/name>` (Manage Server), `/github watches`
- `/github repo|pr|issue` — overview, AI-summarized pull request, issue view
- `/agent launch repo:<owner/name> prompt:<text> [branch] [model] [auto_pr]`
  (Manage Server) — launch a Cursor cloud agent; status changes, the final summary,
  and the PR link post back to the launch channel.
- `/agent status`, `/agent followup`, `/agent cancel`

## Mission-control threads

`/agent launch` (and a confirmed `launchCursorAgent` proposal) opens a thread off
the launch message. Status updates post into the thread, and **replying in the
thread sends the agent a follow-up run** (Manage Server required — other replies
get a 🚫). Without thread permissions the agent simply keeps reporting to the
channel.

## Chat tools

- `searchGithubCode` / `readGithubFile` — the AI answers questions from real repo
  content ("what does memoryService.recall do?") in chat and voice. Read-only.
- `launchCursorAgent` / `createGithubIssue` — the AI can *propose* launching an
  agent or filing an issue from conversation ("goobster, file that as a bug").
  Neither executes directly: a Confirm/Cancel button message is posted, and a
  member with **Manage Server** must confirm within 15 minutes. Pending
  proposals live in SQLite, so they survive a restart. In voice sessions these
  tools are available when the session has a transcript text channel (the
  buttons post there).

All four refuse repos that aren't watched in the asking server.

## Guardrails

- Repo allowlist per guild: tools and agent launches only touch watched repos.
- `Manage Server` required for watches and anything that spends compute or changes state — including confirming tool-proposed actions and sending thread follow-ups.
- Chat/voice tools never write directly: every write goes through an explicit confirmation button.
- Every write-side action is recorded in the `integration_audit` table.
- Webhook receivers verify HMAC signatures and reject unsigned deliveries.
