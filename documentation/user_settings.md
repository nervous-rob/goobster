# User settings

One searchable destination for every supported **personal** setting, with an
accurate scope label. Server administration and shared project/persona
configuration stay in their own surfaces (spec §4).

The inventory IDs below come from `Goobster-User-Settings-Inventory-and-Spec_0035.md`.

## Facade contract

`packages/core/services/userSettingsService.js` is the only writer of personal
settings. The portal (`GET/PATCH /api/app/settings…`), Discord DM commands
(`/aisettings`, `/setvoice`, `/instructions`, `/nickname`, `/mememode`,
`/personalitydirective`), and compatibility wrappers (`webChatService`,
`webVoiceService`, `webAttentionService`, `webDashboardService.setRetention`)
all go through it.

| Method | Role |
| --- | --- |
| `getSettings({ userId, voice })` | Aggregate non-secret values, revisions, defaults/effective, capabilities |
| `getPreference(userId, key)` / `getPreferences(userId)` | Narrow read of synced `preferencesJson` fields |
| `updateSection({ userId, section, changes, expectedRevision })` | Atomic validated write + revision bump |
| `resetPreview` / `resetSection` | Reviewable reset; never reconnects integrations, enrolls attention, or erases content |
| `retentionPreview` / `applyRetention` | Destructive memory window; separate from a normal Save |
| `chatHistoryPreview` / `applyChatHistoryRetention` | Destructive Study-chat window; separate from PR01 |
| `exportUserData` | Explicitly labeled settings + transparency report export; no secrets or session tokens |
| `listSessions` / `revokeSession` / `revokeOtherSessions` | Safe session metadata only |
| `listOwnedShares` / `revokeOwnedShare` | Conversation and Observatory share links |
| `listOwnedApplets` / `revokeAppletGrants` | Owner-authorized applet grants |

**Sections:** `profile`, `chat`, `voice`, `initiative`, `memory`, `appearance`,
`connections`, `account`. Editable: the first seven. Account actions and
connect/disconnect still use dedicated endpoints; Connections now also saves
resource allowlists through `updateSection`.

**Scopes:** `private` (Study + Discord DMs), `account` (follows the person),
`device` (this browser / hardware). Product copy: Private chats & DMs / Your
account / This device.

**Revisions:** one row per user per section in `user_setting_revisions`.
`expectedRevision` mismatch → `409 SETTINGS_CONFLICT`. Missing keys mean
unchanged. `null` clears a nullable override. Booleans must be booleans;
out-of-range numbers are rejected, not clamped.

**Events:** after commit, `settings-changed` on `eventBusService` carries
`userId`, `section`, `revision`. No instructions, names, transcripts, or
credentials. Bot and API startup explicitly start the Postgres listener before any browser
connects. Every process clears `guild_settings` / meme-mode caches from that event.

**Storage:** existing AI/voice/instructions/attention values stay in their
authoritative tables. New synced prefs live in `user_settings.preferencesJson`
(`schemaVersion` 1). Additive keys resolve to defaults at read time. An
incompatible reshape bumps `schemaVersion` and upgrades in `getSettings` —
never a one-off migration script.

**Privacy:** `forgetUser` / `auditUser` cover `user_settings` and
`user_setting_revisions`. `hiddenToolRooms` is a key in that same
`preferencesJson`, so the transparency report (`settingsPreferences`) and
erasure already include it. New per-user stores must stay on that path.

## Inventory

### Phase 1 (V1, shipped)

| ID | Control | Store |
| --- | --- | --- |
| ID01 | Private nickname | `user_nicknames` under `dm:<userId>` |
| ID02 | Per-server nickname | `user_nicknames` (caller’s own) |
| ID04 | What you call Goobster | DM `bot_nickname` |
| ID05 | Custom instructions | `UserPreferences` |
| ID06 | Private personality directive | DM `guild_settings` |
| ID07 | Meme mode | `UserPreferences` |
| AI01–AI05 | Provider, model, reasoning, Thoughtful, reset | DM `guild_settings` |
| VO01–VO02, VO13 | Speaking voice, speed, availability | DM TTS row + capability API |
| AT01–AT05, AT07–AT09 | Attention enrollment, initiative, budgets, UTC quiet hours, category matrix | `attention_policies` |
| PR01–PR05 | Retention, memories, facts, report, forget-me | existing privacy/memory paths |
| CN01–CN02 | GitHub, Notion | `user_integrations` |
| AC01 | Identity + this-device logout | Discord session |
| UI01 V1 / UI08 V1 | Theme + link-by-tag discoverability | device + `preferencesJson` |

### Phase 2 (V2, this document)

| ID | Control | Store / consumer |
| --- | --- | --- |
| ID03 | Account-wide preferred-name fallback | `preferencesJson` → `getPreferredUserName` |
| ID09–ID12 | Answer length, tone, humor/emoji, response language | `preferencesJson` → `buildUserStyleBlock` (meme mode wins humor) |
| ID13–ID14 | Timezone, units, 12/24 clock, date locale | `preferencesJson` → style block + quiet-hours evaluator |
| VO03–VO05, VO10–VO12 | Voice send mode, capture engine, pause, start muted, captions, auto-read | `preferencesJson` → `useVoiceChat` / overlay / Study |
| VO07, VO09 | Preferred mic, volume | device-local only |
| AT06 | Quiet hours in your IANA timezone | `quietHoursTzMode` + timezone; legacy UTC rows stay UTC until explicit conversion |
| AT10–AT12 | Notification channels/sounds, presence visibility, default snooze | prefs → attention contact, friends `online`, mention banners, `actOnNotice` |
| PR06 | Default new-chat privacy | prefs → Study `newChat` |
| PR10–PR12 | Export, revoke shares, revoke applet grants | dedicated settings routes |
| AC02–AC03 | Sessions / sign out other devices; clear device-local prefs | `web_sessions` + browser keys |
| UI01 V2–UI09, UI12 | System theme + account sync, text size, motion, density, Enter-to-send, detail expansion, start page (room ids from `portal_navigation.md`; older saved values such as `study` or `noticed` stay valid and map onto the current destination), hidden tools (`appearance.hiddenToolRooms`: the tool-room ids `music`, `trading`, `decks` from `TOOL_ROOM_IDS`, the same list as the web registry; an unknown id is rejected; hiding removes the tool from Tools and from navigation, leaves host availability alone, and does not block the tool's own URL), Exchange server, Music Lab link | prefs + device paint |

### Phase 3 (Later runtime policies)

| ID | Control | Store / consumer |
| --- | --- | --- |
| ID08 | Personality presets | `preferencesJson.personalityPreset` bakes `answerLength` / `tone` / `humor`; style block is the consumer |
| AI06 | Reply-length token budget | `replyMaxTokens` → `chatHandler` `max_tokens` (thinking headroom still added separately) |
| AI07 | Sampling | `temperature` / `topP` → chat options; providers drop incompatible params |
| AI08 | Per-feature model defaults | `parlorProvider`/`parlorModel` → new private conversation model snapshot; `researchProvider`/`researchModel` → new personal expedition snapshot |
| AI09 | Optional tool preferences | `disabledTools` filters personal turn definitions and is enforced again at execution; search also gates native provider search |
| AI10 | Usage alert | `usageAlertTokens` → Usage payload `overAlert` (informational) |
| AI11 | Personal AI keys | Not stored. Settings explains host-key-only; missing keys stay disabled |
| PR07 | Learn new long-term memories | `learnMemories` gates private embeddings, model facts, durable-memory tools and consolidation; manual data editors remain explicit user actions |
| PR08 | Use existing memories | `useMemories` gates private graph/artifact/vector retrieval and recall tools |
| PR09 | Study chat-history retention | two-step preview/apply + hourly purge + access-time expiry across history, search, shares and file URLs |
| CN03 | Connected-resource allowlists | `githubAllowlist` / canonical Notion page IDs enforced on tools; policy lookup fails closed; empty = no extra restriction |
| UI10 | New-expedition defaults | `expeditionDefaultDepth` / `expeditionDefaultLens` snapshotted at create |
| UI11 | New-persona defaults | `parlorDefaultEmoji` / `parlorDefaultCharter` used only when create omits them |

Reset still cannot reconnect integrations, enroll attention, re-enable disabled tools, turn learning/recall back on, or erase content. Guild settings stay in spec §4.

**Still later (not this phase):** VO06 microphone sensitivity, VO08 preferred audio output.

## Portal

`/settings/:section#field`. Search synonyms live in
`apps/web/src/rooms/settings/sectionMeta.ts`. Every control has a
`ScopeBadge`. Destructive flows (retention, forget-me, revoke, sign-out)
never ride a normal section Save. Chat-history retention uses the same
preview → confirm pattern as memory retention.

## Runtime policy and upgrade notes

- Private token/sampling and memory preferences never change guild behavior.
- Newly created personal expeditions and private Parlor discussions snapshot provider
  and model in `modelConfigJson`. Existing rows with no snapshot retain host behavior;
  current account choices are never injected into existing/shared objects. A discussion
  later shared with others keeps its original snapshot. Project expeditions use host
  choices. Creation defaults are visible and editable in the portal forms.
- Notion allowlists now require full page IDs or URLs, normalized to IDs. Existing title
  entries remain stored but grant no access; replace them in Connections. Resetting a
  connection policy must not broaden access.
- Retention uses the conversation's last activity, not each message's age. Active turns
  are skipped until they settle. Deletion clears transcript, summary, queue and shares,
  revokes orphan file registrations, and deletes unreferenced user-upload bytes.
  Saved knowledge artifacts and project files retain their independent lifecycles.
- Preferred microphone selection applies to batch and live capture. A removed device
  retries with the system mic and reports the fallback; permission denial does not retry.
- The small settings + transparency report JSON download remains available alongside
  the portable account archive described below.

## Portable account export

In **Settings → Memory & privacy → Export your account**, choose **Create account
export**. Preparation runs in the background; you can leave the page. Inbox tells
you when the archive is ready, or when preparation fails. Return to this section
to download or delete it. Exporting does not run models or restart saved work.

The download is a `.tar.gz` archive. Extract it with your archive utility (or
`tar -xzf goobster-account-YYYY-MM-DD.tar.gz`), then open `README.md`.

| Location | Contents |
| --- | --- |
| `notes/`, `tags/` | Markdown notes with tags, curation, sources, provenance and links to related notes |
| `chats/` | Retained private chats and owned discussions, with author attribution and attachment links |
| `projects/` | Owned project plans, workspace files, saved asset versions and run outputs retained in the workspace |
| `research/` | Ready research briefs as Markdown, preserving citations, edits and review status |
| `data/` | JSON records for the above plus personal memory text, facts, settings, tasks, automations, research evidence, followed sources, Inbox, applets and tutorial progress |
| `attachments/` | Available local files referenced by included chats, Inbox items and knowledge artifacts |
| `manifest.json` | Original IDs, JSON pointers, relationships, file sizes and SHA-256 hashes, plus unavailable-file warnings |
| `settings-and-report.json` | The existing settings and transparency report |

The account archive includes private data and owned projects/discussions. Published
copies retain their publisher attribution; another person's private original and
its audience are excluded. Joined projects, server transcripts, credentials,
integration secrets, login/share tokens, caches, vector indexes and optional
game/trading/deck stores are outside this archive. External URLs remain references;
exporting never downloads them. This is not an instance backup. Import is a separate
future feature; the manifest preserves IDs and relationships for that work.

Database records come from one consistent snapshot. Files are copied afterwards;
a file changing during its copy fails the export so you can retry when work is
idle. A missing file, link, or unsafe path is explicitly recorded in the manifest
and shown as a warning count in Settings. Check these warnings before treating
the archive as a complete copy of your attachments. Symlinked files/directories
and hard-linked files are excluded.

Archives are private, **unencrypted**, and available only to the signed-in owner.
They expire 24 hours after the request. Delete removes an archive or cancels its
generation without deleting the source content. Forget-me also removes export
jobs and files. Already downloaded copies remain your responsibility. Restoring
an instance backup invalidates temporary export jobs; request a fresh archive.

The worker handles one export at a time, including while autonomous work is
paused. Each account may have one active request and two available archives,
with a one-minute interval between requests. Preparation is bounded to 15 minutes,
100,000 database records / 64 MiB of record text, 50,000 archive entries and 5 GiB
of uncompressed content. Exceeding a limit fails visibly instead of publishing
truncated records. Expired/failed job metadata is retained for up to seven days.
