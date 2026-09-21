---
title: Troubleshooting tactics
kind: skill
summary: How to diagnose one of your own features, tools, or deployments misbehaving before you answer - gate first, error second, docs third, then an honest report.
when: A tool call of yours failed or was refused, a feature seems disabled or silent, a user says something "does not work", or you are unsure whether a capability exists on this deployment.
tags: [troubleshooting, errors, degraded, configuration, gating, diagnostics]
---

# Troubleshooting tactics

You are the software these docs describe. Almost every "it does not work" report
about you has one of four causes: the feature is **not enabled** on this
deployment, a **credential or backend is missing** and the feature degraded on
purpose, an **input or scope rule** refused the request, or a real fault. Work
through them in that order and say which one it was.

## The method

1. **Name the subsystem.** Chat/AI provider, memory, attention, automations,
   guild reply routing, DMs, music/voice, web portal, sandbox, Observatory,
   exchange, Tavern, database, host. Each has its own document; find it with
   `consultDocs` (`action: "search"`) and read the matching section before
   guessing.
2. **Check the gate.** Most capabilities are opt-in per deployment, per guild, or
   per person (table below). A tool that is not in your tool list is not broken -
   it is switched off or scoped away. Never try to reach it another way.
3. **Read the actual error.** Your tool results carry the real message. Quote it.
   Errors that end with `Tried: ...` list every location that was checked - that
   list is the diagnosis.
4. **Match symptom to cause** in the tables below, then confirm in the feature
   doc. Prefer the cheapest confirmation (a `status`/`list`/`stats` action or a
   read-only slash command) over retrying the failing action.
5. **Report honestly**: what failed, why, and who can fix it - the *user* (change
   the request, enable a per-person setting), the *server admin* (a `/` settings
   command), or the *operator* (edit `config.json`, set an environment variable,
   install a dependency, restart). Cite the document you relied on. If the docs
   do not cover the situation, say so.

## Gates: "the tool is missing" or "nothing happens"

| You notice | Why | Who fixes it and how |
|---|---|---|
| No `runCode` tool | Sandbox off (`sandbox.enabled` / `GOOBSTER_SANDBOX_ENABLED`) or scope is `web` and this is a Discord channel (`sandbox.scope`) | Operator; see *Code Sandbox* |
| No `observatory` tool | `observatory.enabled` off, or the sandbox is off (Observatory needs it), or scope is `web` | Operator; see *Projects* |
| No `requestPythonPackages` tool | No `sandbox.approverUserIds` configured | Operator |
| No `speakMessage` / `playTrack` | This is the web portal or an unattended automation turn - there is no Discord voice channel | Ask in a server voice channel |
| No `setSpeechAccent` | Portal-only setting (ElevenLabs v3 tags) | Use the portal |
| GitHub / Notion tools refuse | Personal integrations work only in DMs and the portal; in a server, GitHub needs the repo on the `/github watch` allowlist | User connects in portal Integrations; admin runs `/github watch` |
| Proactive attention does nothing | Nobody has run `/attention enable` - no policy row, no sweeps, by design | The user |
| Heartbeat / monologue silent | `/proactive` and `/monologue` are per-guild opt-ins with cooldowns and activity floors | Server admin |
| Guild message ignored | Only explicit address (mention, name, reply to you), reply detection (`/replydetection`), or opt-in dynamic response (`/dynamicresponse`) trigger a reply | Server admin / user |
| Slash command missing in Discord | Commands not deployed, or it is guild-only and you are in a DM | Operator: `node apps/bot/deploy-commands.js --force` |

## AI providers

| Symptom | Likely cause | Check |
|---|---|---|
| Replies come from a small local model, or say "Ollama server not reachable" | No cloud key; auto-detect fell through to Ollama (OpenAI → Anthropic → Gemini → Ollama) | Operator sets `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY`, or fixes `ollama.host`; see *Raspberry Pi Setup Guide → Local AI with Ollama* |
| One server behaves differently | Per-guild override (`/aisettings`, `/thoughtfulmode`) applied per request | Admin reviews `/aisettings` |
| Web search never happens | Native search needs a cloud provider; Ollama uses the approve-then-Perplexity flow, which needs `PERPLEXITY_API_KEY` and may be gated by `/requiresearchapproval` | Operator / admin |
| Image generation fails | Needs OpenAI (GPT Image models); DALL-E is gone | Operator |
| Cost questions | `/usage` shows token counts per server | Anyone with the command |

## Memory and knowledge

| Symptom | Likely cause | Check |
|---|---|---|
| `/recall`, `lookupNotes`, or memory recall return nothing | No embedding backend (needs an OpenAI key or Ollama with `nomic-embed-text`); or the channel is excluded via `/privacy exclude`; or retention purged it; or nothing was ever said there | `/memory stats`, `/memory test`; see *Development Standards → Long-term memory* |
| A fact you were told is gone | `/forget-me`, retention window, or the per-guild cap (default 5000 memories) | *Privacy controls* |
| Knowledge graph looks empty | Consolidation runs nightly; reflection can be run from the Library's Reflect button | *User knowledge graph* |
| A file saved with `fetchWebFile` / `findImages` / `saveArtifact` is not found by `lookupNotes` | Artifact lookup is lexical and immediate (no embeddings, no nightly pass) and matches label, notes, file name, extracted text, and image title/credit/provider - so a miss means a scope mismatch: files live only under the author's personal scope of the server or DM where they were saved; `about="server"` and other users never see them | `lookupNotes` with the label or file name, `about="me"`, in the same server/DM; `showSavedFiles` with no query lists the most recent saved files |
| A Markdown/CSV preview in the portal keeps collapsing, reloading, or duplicating | Fixed: previews are reconciled by file id and keep their collapse/sort state across rerenders; long previews (> 40 lines or 2,500 chars) start collapsed by design - use Expand | Reload the portal to pick up a new build |

Vectors from different embedding models are never compared - after an operator
switches embedding model, old memories are effectively invisible until they are
re-embedded. Say that plainly rather than "memory is broken".

## Scheduling: automations, follow-ups, watches

| Symptom | Likely cause | Check |
|---|---|---|
| Automation "did not fire" | Cron is evaluated in **UTC**; the 15-minute minimum gap; the row was disabled because its cron stopped parsing (a notice was posted once) | `manageAutomations` `list` shows schedule, last/next run |
| Automation fired but did nothing | Each run is a full agent turn - the prompt may have decided nothing was needed, or the owner has no permission for the tool it needed | Read the run's channel output |
| Follow-up "should have run a tool" | Follow-ups only repost a note; work belongs in an automation, outcomes in a watch | *Development Standards → Facts, follow-ups, and the heartbeat* |
| Watch never fired | Wrong topic, narrowed to the wrong `jobId`, or it expired (default two weeks) | `watchFor` `list` |
| You are in an automation turn and want to create an automation | Refused on purpose - a run may never spawn siblings | Do the task itself |

## Direct messages

Voice can never work in a DM (Discord does not let bots join DM calls). Economy,
music, heartbeat, monologue, and activity counters are guild-only. DM data lives
under the `dm:<userId>` scope, so a DM never sees a server's memories and vice
versa. `/forget-me` works from a DM.

## Music and voice

| Symptom | Cause | Fix |
|---|---|---|
| `spotdl` / `yt-dlp` `CLI not found` | The error lists every path tried; `not found` everywhere means the venv was never created | Operator: `./scripts/ensure-music-cli.sh` (or `install-rpi.sh`) |
| `ModuleNotFoundError` from the music CLI | Venv orphaned by an OS Python upgrade | Rebuild the venv (same scripts) |
| Spotify playlist fails but tracks/albums work | Anonymous client broken for playlists; private/invite links | `spotify.clientId/clientSecret`, or make the playlist public |
| `FFmpeg is required` | System ffmpeg missing | `sudo apt install ffmpeg` |
| No TTS voice | `ELEVENLABS_API_KEY` absent → feature disabled with a warning | Operator |

The full table is in *Raspberry Pi Setup Guide → Troubleshooting*.

## Web portal

| Symptom | Cause | Fix |
|---|---|---|
| `/app` returns `503 WEB_CLIENT_UNBUILT` | React client not built | Operator: `npm run build:web` |
| Login loop / OAuth error | `webapp.publicUrl` missing or does not match the Developer Portal redirect | Operator; *Web App Setup §1-3* |
| Guild panes say `BOT_OFFLINE` | Split deployment and the bot is unreachable from the api process; DM-scoped panes keep working | Operator checks the bot container and `GOOBSTER_INTERNAL_TOKEN` |
| Server scopes / Exchange say `DISCORD_DISABLED`, Exchange missing from the nav | The installation has no Discord adapter (`discord.enabled: false` or no bot token) - by design, not a fault | Nothing to fix; Discord-specific features need a bot token (*Independent runtime*) |
| Exchange says `NO_DISCORD_IDENTITY` | A native (`usr_…`) account with no linked Discord identity on a Discord-connected installation | Settings → Account → Connect Discord |
| A reminder or task result never arrives in Discord DMs | Delivery lands in the **Inbox** first; the Discord echo is skipped when the person has no Discord identity or DMs are closed | Open the Inbox room; `discordStatus` on the item says why the echo was skipped |
| "Works on localhost only" | `webapp.devMode` mints sessions without Discord - never on an internet-exposed server | Operator |

## Sandbox runs and Observatory jobs

| Symptom | Cause | Fix |
|---|---|---|
| `ModuleNotFoundError` in Python | Bare interpreter; the tool description tells you exactly which modules exist | Write against those; suggest `npm run sandbox-python`, or `requestPythonPackages` when approvers exist |
| Network call fails inside a run | Runs have **no network**, ever | Use `observatory` `fetch-data` (host-side, https, allowlist or approval) |
| Run killed at the wall clock | Timeout (`sandbox.timeoutMs`) | Split the work; for long work use a background job with the checkpoint convention |
| Job `INTERRUPTED` after a restart | Normal; it auto-resumes when `$GOOBSTER_RUN_DIR/checkpoint.json` advanced | `observatory` `status` / `resume` |
| Job failed with "timeout with no checkpoint progress" | The script never rewrote its checkpoint | Follow the checkpoint convention in *Projects* |
| Isolation refused | `requireStrongIsolation` and no bubblewrap on the host | Operator installs `bubblewrap` |

## Database and host

- SQLite is the default; `GOOBSTER_DB_URL` selects Postgres. Schema and column
  migrations apply automatically on open - there is no manual migration step.
- `/diagdb` diagnoses connectivity; `/systemstatus` shows CPU, memory,
  temperature (`under-voltage` means the power supply), disk, and bot stats.
- Logs live under `logs/` (`goobster-error.log` for errors); the health endpoint
  is `http://<host>:3000/health`.
- On Postgres, singleton workers skip a tick when another bot process holds the
  lock - two bots pointed at one database is a misconfiguration, not a bug in
  the worker.

## Reporting back

State the finding in one breath, then the fix and who owns it:

> Memory recall is returning nothing here because this deployment has no
> embedding backend - there is no OpenAI key and Ollama is not running, so
> memories are stored but cannot be searched. The operator can set
> `OPENAI_API_KEY` or run Ollama with `nomic-embed-text` (Development
> Standards → Long-term memory).

When it is a genuine fault, gather the exact error, what you were doing, and the
doc section that says it should have worked, then - only if the user agrees -
use `createGithubIssue` (server allowlist) or hand it to a Cursor agent with
`launchCursorAgent`. Both are confirmation-gated; never file silently.

## Do not

- Do not invent a `config.json` key, environment variable, or command. If it is
  not in the docs, it does not exist.
- Do not retry the same failing tool call with the same arguments.
- Do not work around a gate (for example by writing a shell one-liner into a
  sandbox run to reach the network).
- Do not promise a fix that needs a code change - route it to an issue or agent.
- Do not blame the user for a deployment gap; name the gap.
