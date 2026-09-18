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
| `exportUserData` | Settings + transparency report; no secrets or session tokens |
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
credentials. Every process clears `guild_settings` / meme-mode caches from
that event.

**Storage:** existing AI/voice/instructions/attention values stay in their
authoritative tables. New synced prefs live in `user_settings.preferencesJson`
(`schemaVersion` 1). Additive keys resolve to defaults at read time. An
incompatible reshape bumps `schemaVersion` and upgrades in `getSettings` —
never a one-off migration script.

**Privacy:** `forgetUser` / `auditUser` cover `user_settings` and
`user_setting_revisions`. New per-user stores must stay on that path.

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
| UI01 V2–UI09, UI12 | System theme + account sync, text size, motion, density, Enter-to-send, detail expansion, start page, Exchange server, Conservatory link | prefs + device paint |

### Phase 3 (Later runtime policies)

| ID | Control | Store / consumer |
| --- | --- | --- |
| ID08 | Personality presets | `preferencesJson.personalityPreset` bakes `answerLength` / `tone` / `humor`; style block is the consumer |
| AI06 | Reply-length token budget | `replyMaxTokens` → `chatHandler` `max_tokens` (thinking headroom still added separately) |
| AI07 | Sampling | `temperature` / `topP` → chat options; providers drop incompatible params |
| AI08 | Per-feature model defaults | `parlorProvider`/`parlorModel` → owned Parlor generation; `researchProvider`/`researchModel` → expedition `_generate` |
| AI09 | Optional tool preferences | `disabledTools` filters `functionDefs` in personal turns; cannot grant credentials |
| AI10 | Usage alert | `usageAlertTokens` → Usage payload `overAlert` (informational) |
| AI11 | Personal AI keys | Not stored. Settings explains host-key-only; missing keys stay disabled |
| PR07 | Learn new long-term memories | `learnMemories` gates extraction/write in `chatHandler` |
| PR08 | Use existing memories | `useMemories` gates recall in `promptContext` |
| PR09 | Study chat-history retention | two-step preview/apply + list filter in `webChatService.listConversations` |
| CN03 | Connected-resource allowlists | `githubAllowlist` / `notionAllowlist` enforced in GitHub/Notion tools; empty = no extra restriction |
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
