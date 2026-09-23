---
title: "Planned: shared-instance product design and rollout"
kind: decision
summary: Planned invitation-only multi-user release covering product organization, native login, identity migration, isolation, resource controls, and implementation gates. These changes are not implemented by this document.
tags: [planning, shared-instance, native-auth, identity, product, rollout]
---

# Planned: shared-instance product design and rollout

**Status: increments A, B, B.1, C and E are shipped; D, F and G are pending.** Native login, verified email, the independent runtime and the Inbox exist today - see the [implementation status](#implementation-status) table, which is the authority on what has landed, and the shipped behaviour guides ([identity.md](identity.md), [independent_runtime.md](independent_runtime.md), [portal_navigation.md](portal_navigation.md)). The remaining sections describe the agreed design; a feature described here is not available merely because this document exists.

Updated: 21 September 2026.

Code observations: `main` at `dac192b298661070304efe2883e13e7fefa1231c` (19 September 2026), re-audited at `ec49dd3872379e95da86c7e5188c3f9c041ec5fd` (21 September 2026, the merge of PR #233). The §2 table is a *baseline*: several rows describe the state before A–C and E1 landed and are annotated where that is so. Recheck the observations against current main before implementing each increment.

Initial rollout: invited people on the operator's hosted instance, with private accounts and explicit sharing.

This is an implementation plan, not a setup guide. Detailed credential choices and visible names remain proposals where marked. No product rename is selected.

Related planning documents:

- [Guided tutorial specification and curriculum](guided_tutorials_spec.md)
- [Product naming exploration](product_naming_exploration.md)

Current behavior is documented in [architecture](architecture.md), [web portal setup](webapp_setup.md), [projects](projects.md), [user settings](user_settings.md), and [Spitball Expeditions](spitball_expeditions.md).

## 1. Product direction

**A self-hosted workspace where people think with AI, build reusable knowledge, and carry projects through to results.**

The initial experience should make five things legible:

1. **Chat** is where you work through an immediate question.
2. **Knowledge** is what you deliberately keep and reuse, with sources where available.
3. **Projects** bring conversations, selected knowledge, plans, files, and work together around an outcome.
4. **Discussions** bring people and AI personas into a shared conversation.
5. **Activity** shows what is running, what happened, and what needs your attention.

The assistant can retain personal memory according to the user's settings. That memory has its own inspection and deletion controls. A chat transcript, a saved note, an inferred personal fact, and a project output are distinct objects. Presenting all four as “knowledge” obscures what is stored and who can use it.

Keep the exploratory personality. Put descriptive names first and room names second during the transition. Avoid renaming every subsystem, database table, tool, and route at once.

### Scope of the first release

- Invitation-only registration on one installation; account administration for the host.
- Native login with no Discord account requirement.
- Private chat, notes, projects, settings, and tutorial progress.
- Deliberate collaboration on projects and discussions.
- Per-account and per-instance resource controls.
- Tutorials for every available room/service, with independent skip, resume, and reset.
- Optional specialist tools behind a Tools destination.

Public signup, billing, organizations, cross-instance federation, and a final brand change are later decisions. This release does not need an enterprise tenancy model. An installation is the operating boundary; accounts and resource memberships provide isolation within it.

### Proposed defaults for a newly invited account

Keep new content private. Make retained chat history and its deletion controls visible. Offer long-term personal-memory learning as an explicit choice; leave proactive outreach and unattended recurring work off until enabled. Select a host-approved default model and explain whose usage allowance it consumes. A tutorial never changes these permissions or enrollment settings implicitly. Preserve existing users' deliberate preferences during migration.

## 2. Baseline observations

These are code observations, not results of a deployed penetration or load test. Paths below refer to the pinned baseline. The existing application already has private scopes, resource membership checks, hashed browser sessions, durable chat coordination, and background-job claims. Preserve and extend them.

| Observation | Evidence at the pinned baseline | Consequence for this work |
|---|---|---|
| The primary navigation exposes eleven rooms, plus Settings, using the house/grounds metaphor. *(Superseded by E1: seven destinations from `apps/web/src/lib/rooms.cjs`; old paths are aliases - [portal_navigation.md](portal_navigation.md).)* | `apps/web/src/shell/AppShell.tsx`, `apps/web/src/main.tsx` | Simplify the first navigation level and retain old deep links. |
| Spitball combines maps, notes, research expeditions, personal facts, memories, and reports. *(Superseded by E2: `apps/web/src/rooms/knowledge/` holds Notes/Map/Research; About you, Facts and Memories live in Settings → Memory & privacy - [knowledge_and_memory.md](knowledge_and_memory.md).)* | `apps/web/src/rooms/SpitballRoom.tsx` (at the baseline) | Separate reusable knowledge from personal-memory controls. |
| Observatory contains projects, generated apps, files, jobs, knowledge, people, and missions. *(Superseded by E3: `apps/web/src/rooms/projects/` holds the list, the resolver and a per-project shell at `/projects/:ownerId/:slug/:view` with Plan / Run / Files vocabulary; organizing no longer needs execution - [ADR 0009](adr/0009-project-organization-contract.md).)* | `apps/web/src/rooms/ObservatoryRoom.tsx` (at the baseline), `documentation/projects.md` | Make Projects the visible organizing concept. Keep advanced execution details inside each project. |
| Production browser authentication is Discord OAuth. Session creation rejects IDs that are not 5–20 digits. *(Superseded by A/B: principals, accounts and native sign-in - [identity.md](identity.md).)* | `packages/core/web/routes/authChat.js`, `packages/core/services/webSessionService.js` | Introduce application identities and credentials; changing the Login component alone is insufficient. |
| Private chat/memory use `dm:<userId>` as a storage scope. Guild access is checked separately. | `packages/core/utils/dmScope.js`, `packages/core/services/webDashboardService.js` | Preserve existing private data through a scope adapter. Do not equate installation access with guild access. |
| Chat startup needs a bot identity. The split API also requires Postgres and an internal gateway token at startup. | `packages/core/services/webChatService.js` → `startTurn`; `apps/api/index.js` | Separate assistant identity from Discord identity and make the Discord adapter optional. |
| Project and discussion invitations expect Discord-shaped IDs; people discovery uses Discord friends or mutual guilds. | `projectService.js` → `invite`; `parlorService.js` → `invite`; `friendService.js` | Add native account discovery/invitations and map optional Discord identities at the adapter boundary. |
| Tasks explicitly describe delivery through Discord DMs. *(Superseded by C: the Inbox is the system of record - [independent_runtime.md](independent_runtime.md).)* | `apps/web/src/rooms/TasksRoom.tsx` | Make durable in-app delivery the baseline. Otherwise native users can create work whose result has no destination. |
| Music Lab local storage has a global prefix, and samples use one global IndexedDB database. | `apps/web/src/music-lab/lib/storage.ts`, `sampleStore.ts` | Namespace content by installation and account; handle unowned legacy browser content explicitly. |
| Many query keys do not include the account. Logout currently reloads the page. | `apps/web/src/lib/query.ts`, `apps/web/src/shell/AppShell.tsx` | Do not claim an observed leak from query keys alone. Make account changes, session expiry, streams, and cache clearing explicit and test them. |
| Chat has a durable rate limiter and per-user turn coordination; expeditions use durable claims. Sandbox concurrency uses a process-local counter. | `webChatService.js`, `spitballExpeditionRunner.js`, `sandboxService.js` | Existing coordination is useful, but a process-local cap is not an installation-wide budget. Define admission across services and processes. |
| Strong sandbox isolation defaults on. Operators can override it for a single-user host. | `packages/core/config/sandboxConfig.js` | Preserve the default and disallow weak isolation for invited accounts. Verify actual host capabilities before enabling execution. |
| Self-documentation includes shipped repository docs and operator-authored documents. | `documentation/self_knowledge.md`, `selfDocsService.js` | Give user help and operator documentation distinct audiences before exposing help to new accounts. |
| No guided-onboarding implementation was found in the inspected frontend, services, or docs. | Search for `tutorial`/`onboard` plus inspection of routes and Settings | Add an explicit tutorial subsystem instead of scattered local flags. |

Observation baseline: [pinned main](https://github.com/nervous-rob/goobster/tree/dac192b298661070304efe2883e13e7fefa1231c).

## 3. Information architecture and vocabulary

### Navigation

The main destinations are **Home, Chat, Knowledge, Projects, Discussions, Activity**, and **Tools**. Settings stays in the account area. Activity combines related entry points, but its underlying services and tutorial progress remain distinct.

| Current label | Proposed visible label | Location and behavior |
|---|---|---|
| Home | Home | Continue recent work; create a chat, note, or project; show pending approvals. |
| Study | Chat | Private conversations, history search, uploads, voice, branching, and explicit sharing. |
| Spitball | Knowledge · Spitball | Notes, tags, source evidence, graph, and Research. Lead with the note list; make the graph another view. |
| Spitball facts/memories/report | Personal memory | Settings → Memory & privacy, with a shortcut from Chat and Knowledge. |
| Expeditions | Research runs | Inside Knowledge; can optionally target a project. “Expedition” may remain a secondary term. |
| Observatory | Projects | Goal, conversation, plan, knowledge, files/apps, runs, and people. |
| Mission | Project plan | Goal, acceptance criteria, steps, approvals, and evidence. Retain `mission` internally during transition. |
| Job | Run | A particular execution with status, outputs, logs, and retry/cancel controls. |
| Workshop inbox / discoveries | Unfiled outputs | A clearly labeled section under Projects, with “Add to project.” |
| Parlor | Discussions · Parlor | People and AI personas, with participant and knowledge-source visibility. |
| Noticed | Inbox | Activity → Inbox; explain why an item appeared and what can be done about it. |
| Tasks | Scheduled tasks | Activity → Scheduled; distinguish reminders from recurring AI work. |
| Usage | Usage & limits | Account area and Settings; also reachable from a quota notice. |
| Conservatory / Interval Labs | Music Lab | Optional tool; keep mode names such as Rhythm, Harmony, and Studio. |
| Exchange | Trading game | Optional tool, explicitly tied to a connected Discord server and game currency. |
| Decks | Card decks | Optional tool; subtitle identifies Magic: The Gathering so this is not confused with presentations. |

Keep existing URLs operational as aliases. For example, `/study` and `/observatory` continue to work while `/chat` and `/projects` become canonical. Add route-contract tests for bookmarks, notification links, public shares, and settings return links. Do not run blanket replacements over persisted tool names or historical message content. *Shipped as package E1 - the registry, canonical routes, aliases and tests are documented in [portal_navigation.md](portal_navigation.md). Two refinements over the table above: the original "Noticed → Inbox" mapping predates the durable Inbox, so Activity keeps **Inbox**, **Attention** (Noticed) and **Scheduled** (Tasks) as three views with their own actions and never sums their counts; and Workshop content is labelled "Unfiled apps" until a typed output listing exists, because `WorkshopInbox` organises generated apps, not every output.*

### The object model users should see

| Object | What it means | What happens across features |
|---|---|---|
| Conversation | A transcript of an exchange with people or AI. | Can be associated with a project. It does not automatically become a curated note. |
| Note | A reusable unit of knowledge with tags and optional evidence. | Can be searched, edited, and explicitly made available to a project or discussion. |
| Personal memory | Information retained about the person or from their private interactions. | Used according to memory settings. Never automatically injected into a shared conversation. |
| Project | An outcome with its own members, selected context, plan, and outputs. | Selects which knowledge and conversations belong to the work. It does not clone the user's entire private memory. |
| Plan | A project's proposed steps and success conditions. | Human approval gates precede consequential execution. |
| Run | A concrete research, model, or code-execution attempt. | Produces results with provenance and a status. A successful process is not proof that the project goal was met. |
| Output | A generated file, app, report, or other result. | Lives with its producing conversation/project, or appears in Unfiled outputs until organized. |
| Activity item | A notice, result, reminder, invitation, or request for input. | Links back to its owning object. It is not another copy of that object. |

A useful first journey is: **ask a question → save a useful answer as a note → add it to a project → run a small task → inspect the output and evidence**. The UI should make each transition explicit.

### Retrieval and provenance contract

- Every result includes its kind, stable resource ID, scope, source/provenance, and permitted next actions.
- Search and model retrieval apply authorization before ranking and before creating snippets. Mixed-scope results cannot expose names, counts, titles, or vector hits from denied scopes.
- A no-match result is typed: `no_match`, `unavailable`, `forbidden`, or `needs_input`. An empty authorized search must not silently expand to other users or all guilds.
- Product help uses the documentation corpus. User knowledge uses the selected authorized knowledge sources. The assistant must not present an instruction manual as a fact learned about a user.
- Notes in Spitball keep their existing model: typed note-to-note **Connections** (`kg_edges`, written by the `weave` pass and by explicit edits) plus shared **Tags** as implicit clustering. The product redesign must not add a second, untyped link model beside them; any new graph type must identify its relationship semantics.
- “Used these sources” should link to inspectable, authorized evidence. Source citations do not by themselves guarantee a generated claim is true.
- Product verbs such as **Save note**, **Add to project**, and **Use in discussion** should map to deterministic service actions. No extra model call is needed for routing an already selected object.

## 4. Shared-instance authorization

### Access rules

Installation membership permits use of the application; it does not grant access to everyone else's data.

| Resource | Default access | Grant mechanism | Revocation behavior |
|---|---|---|---|
| Private chats, notes, memory, credentials, integrations | Owning account | No blanket sharing | Deny other accounts, including other project members. |
| Project | Owner | Explicit accepted invitation; roles such as viewer/editor with owner-only management | Recheck reads, writes, queued work, downloads, and streams. Remove access immediately on revocation. |
| Shared discussion | Explicit members | Accepted invitation, or inherited project membership for project-linked discussions | Stop delivery and further retrieval when membership ends. |
| Discord guild content | Linked identity plus actual guild/resource permission | Discord membership and permission checks | Losing guild access removes it even if application membership remains. |
| Public share | Anyone holding the explicitly created share link | Narrow capability for that resource | Revocation blocks future access. Previously downloaded copies cannot be recalled. |
| User documentation | All accounts, with only public help possibly anonymous | Build-time audience allowlist | Never include operator notes by default. |
| Installation settings and invites | Host/operator | Explicit application role | Discord Manage Server does not grant installation administration. |

Application privacy is separation between app accounts. A person who controls the host can access its database and files. New-user copy should state who hosts the instance and which external model providers may process requests. Do not promise end-to-end confidentiality from the host.

### Private knowledge entering shared work

Use two explicit operations:

1. **Reference in my private project:** store a reference to the existing note and recheck the note's authorization at read time.
2. **Publish a copy to a shared project/discussion:** show the content being shared, create a scoped snapshot, retain provenance, and identify its audience.

Adding a private note to a project that later becomes shared must not expose that note automatically. Show unresolved private references and let the owner publish selected copies. Removing the original note does not silently delete a previously published copy; the deletion UI identifies both scopes and lets the owner act on each permitted copy.

Personas must follow the same rule. Private persona knowledge stays private. A shared persona receives only knowledge explicitly published to that discussion/project or otherwise authorized for every intended audience. Mixed-audience retrieval needs an explicit policy, not the creator's broad permissions.

### Required identity in a service call

Use one request/job context through HTTP, Discord, tools, queues, and events:

```ts
type ActorContext = {
  actorId: string;              // application principal, never a client override
  installationId: string;
  surface: 'web' | 'discord' | 'automation';
  sessionId?: string;
  externalActor?: { provider: 'discord'; subject: string };
};

type ResourceScope =
  | { kind: 'personal'; ownerId: string }
  | { kind: 'project'; projectId: number }
  | { kind: 'discussion'; discussionId: number }
  | { kind: 'discordGuild'; guildId: string };
```

An authenticated actor and a selected scope are separate facts. Resource authorization derives from server-side membership. The model may request an action; it never chooses or overrides its actor identity. Worker jobs store the initiating actor and target scope, then revalidate current authority before execution and delivery. Public-share requests use a narrow capability context, not a synthetic privileged user.

## 5. Native login and identity migration

### Recommended first authentication method

Use invitation-based **username and password** accounts. Offer a verified recovery email when mail is configured. Discord becomes an optional linked identity and optional sign-in method. This supports a self-hosted installation without requiring an external identity provider or email service just to register.

Passkeys and an operator-selected OIDC provider are useful later additions. Select a maintained implementation during the authentication PR after checking runtime and deployment compatibility. Do not hand-roll password cryptography or build a new token protocol.

The exact login-method choice is a proposal, not a finalized authentication decision.

### User flows

**New invited user**

1. The host creates a single-use invitation with an expiry and initial member role.
2. The user opens it and sees the installation name, host identity, privacy summary, and enabled capabilities.
3. The user chooses a display name, unique login name, and password. Recovery email is optional if mail is unavailable.
4. The server atomically consumes the invitation, creates the account, and starts a fresh session. Concurrent redemption has exactly one successful outcome.
5. A short orientation opens in Home. The user can skip immediately. No Discord prompt blocks progress.
6. Connections offers “Connect Discord” as an optional action with an explanation of the added capabilities.

The host shares the invitation through their chosen channel. The app can copy a link; automatic email delivery is optional. Creating the link and sending it are separate operations.

**Returning user:** login name + password → intended authorized destination. Only accept same-origin return paths. Invalid credentials use a generic response. Session expiry preserves an unsent draft locally under the account identity; it does not leak that draft to the next account.

**Existing Discord user:** sign in through the existing verified Discord flow → activate an explicitly authorized application account → add native credentials → reauthenticate once → verify existing chats, notes, settings, and projects are unchanged. The existing operator account gets the operator role through an explicit one-time bootstrap command or configured allowlist, never by “first public visitor.”

**Recovery:** verified email can receive a short-lived, single-use reset link. Without mail, the UI clearly says to contact the host; the host can issue an audited reset link after independently verifying the requester. Reset completes with session revocation and a new login. Do not use display name or knowledge of a Discord ID as proof of ownership.

**Connect Discord:** begin from a recently authenticated session; bind OAuth state to that session, link intent, expiry, and redirect. Prove control of the Discord identity. Reject conflicts when that external identity already belongs to another account. Do not merge accounts by matching email, name, or guild membership.

**Disconnect Discord:** require a working native sign-in method before removing the last usable identity. Keep application data and local credentials. Stop optional Discord delivery and remove guild-derived access; do not delete shared project memberships that were independently granted in the app.

### Data model and compatibility

Introduce a canonical principal/account layer. The existing `users` table and every field called `userId` must be inventoried before choosing a migration; many fields currently mean a Discord identity in a guild context.

| Proposed record | Essential fields and invariants |
|---|---|
| `principals` | Opaque text `id`, display profile, created time. A principal does not automatically have portal access. |
| `app_accounts` | Principal ID, normalized unique login name, status, role, invite/migration entitlement, credential/session version. Disabled accounts cannot authenticate or launch work. |
| `auth_identities` | Principal ID, provider, issuer when relevant, external subject; unique provider/issuer/subject. Store credential material separately. |
| `password_credentials` | Principal ID, salted adaptive hash, parameters/version, updated time. Never store reversible passwords. |
| `account_invites` | Hashed random token, issuing operator, role, expiry, consumed/revoked time. Token is not a permanent login credential. |
| `recovery_tokens` | Hashed token, account, purpose, expiry, consumed time. Distinct from invitation and OAuth state. |
| Existing `web_sessions` | Reference the canonical account; retain hashed opaque tokens; add authentication time and revocation/version semantics as needed. |
| Scope mapping | Canonical principal and resource scope → existing storage scope, so old private data can keep its `dm:<legacyId>` key initially. |

**Low-risk migration strategy:** treat current IDs as opaque internal IDs for migrated principals; preserve existing IDs and private-scope keys. New native accounts receive a non-Discord-shaped random ID, such as `usr_<uuid>`. The ID format grants no authority. Existing Discord subject mappings resolve to the migrated principal. This avoids rewriting all history and project directories in the first release.

This is a compatibility boundary, not permission to send application IDs to Discord APIs. Bot ingress resolves the principal and retains the actual Discord subject for guild checks, mentions, DMs, and gateway calls. Do not overwrite `interaction.user.id` globally. Core code consumes `actorId`; transport adapters retain external IDs.

Backfill principals for referenced owners as necessary, but **do not grant portal accounts to every person found in bot history**. Only accepted invitations and explicit migration entitlements allow entry. Retaining optional Discord login must not bypass the invitation gate.

For account-link conflicts involving two existing data owners, decline linking and provide a clear explanation. A deliberate account-merge workflow is out of scope for the first release; redirect the person to sign into the existing account and add native credentials there. Never silently split or combine histories.

### Migration procedure and acceptance

1. Inventory identity-bearing columns, embedded IDs in JSON, filesystem paths, vector ownership, cache keys, scheduled-job owners, tokens, integration secrets, and share records.
2. Back up the database and project files together. Produce a read-only migration report with counts and unresolved owners.
3. Add tables and mappings. Keep legacy reads operational; new authentication remains disabled behind a release flag.
4. Backfill deterministically and idempotently. Run twice in a fixture and verify stable ownership and counts.
5. Update web, Discord, tools, workers, presence, invitation search, and delivery adapters to resolve the same principal.
6. Exercise the existing operator's migrated account and two native accounts against SQLite and Postgres fixtures.
7. Enable native authentication only after migration checks and isolation tests pass.

Rollback disables new account creation and the new UI while preserving additive tables and all data. Once native accounts have written data, an old binary that rejects their IDs is not a valid rollback target. Use a compatibility release or restore a coordinated backup during a planned outage; do not casually drop new tables.

### Authentication controls

Use Argon2id through a vetted implementation; OWASP's current minimum is 19 MiB memory, two iterations, and one parallel lane. Benchmark hashing on the actual host and bound concurrent verification work. For password-only accounts, propose a 15-character minimum, support long passphrases and password managers, and reject common compromised choices. Avoid composition puzzles and periodic forced changes. [Password storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html), [authentication guidance](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html).

Reuse the existing opaque server-side session approach. Set `Secure`, `HttpOnly`, and explicit `SameSite` attributes; use a host-scoped cookie in production. Rotate sessions on login and privilege changes. Revoke sessions after credential recovery, account disablement, or explicit device revocation. Protect unsafe requests with CSRF tokens and trusted-origin checks; SameSite is an additional layer. Apply both account and IP throttles without creating an easy permanent-lockout attack. [Session guidance](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html).

Return neutral errors for bad credentials and recovery requests. Never log passwords, invite/reset tokens, OAuth secrets, or full credential-bearing URLs. Require recent authentication for linking, recovery changes, credential removal, operator actions, and account deletion. An enabled development-session bypass is a release blocker on the shared instance.

## 6. Operation without Discord

Native authentication must lead to a usable product.

- Provide an installation-scoped assistant identity for chat and generated messages. Discord's bot ID is a transport identity, not a prerequisite for inference.
- The API/core runtime starts without a Discord token, client ID, or internal gateway secret when that adapter is disabled.
- Run required schedulers, job recovery, retention, docs seeding, and event delivery in an explicitly designated core worker/runtime. Avoid accidentally depending on `apps/bot/index.js` to start them.
- Keep one authoritative worker arrangement for the pilot. Postgres remains the supported database for split processes; retain SQLite support for the supported single-process mode. SQLite is not inherently incompatible with several users.
- Native people search uses eligible installation accounts and explicit invitations. It never enumerates all private account details. Profile discovery and presence are separate permissions.
- Task and research results persist to an in-app inbox. Optional Discord delivery references the same result and has a separate delivery status. A failed DM must not lose the result or duplicate execution.
- A disconnected integration shows a specific unavailable action with a next step. It must not make Chat or Projects report “bot offline.”
- Trading game remains an optional Discord-guild feature in this release. Show a clear connection requirement; do not invent a fake guild for native accounts.

## 7. Multiple people using the instance at once

### Resource admission

Create a shared admission service that existing executors call; do not replace every executor with a new generic engine. Track both the requesting actor and the owning/billed scope for collaborative work.

| Resource | Required controls | User-visible state |
|---|---|---|
| Model requests, research and persona turns | Allowed models; per-user and installation budgets; reservations for concurrent spend; bounded queues; timeouts and cancellation | Queued/running/paused; why it is waiting; which limit applies. |
| Code runs | Strong isolation; installation-wide concurrency lease; per-user/project caps; CPU/memory/time/output limits | Place in queue; cancel; clear failure reason; accessible output/logs. |
| Persistent files and uploads | Account/project storage allowance; maximum item size; ownership-checked download; cleanup/retention policy | Used/available storage and a useful remediation. |
| Scheduled work | Per-account schedule count and frequency limits; current authorization on every run; retry budgets | Last run, next run, delivery destination, pause and cancel. |
| Streams and presence | Per-session connection limits; account-scoped topics; reauthorization on revocation | Connection state without disclosing unrelated activity. |

Budget values are host policy, not guessed capacity claims. The pilot must measure the current host with representative models and workloads before setting invitation volume. Usage estimates and provider invoices may differ; do not label an estimate as a settled bill.

Use fair scheduling among accounts, with bounded background work so one recursive research run cannot monopolize capacity. Do not preempt an external model stream arbitrarily; admit the next eligible task fairly when capacity frees. Preserve the existing per-user chat rule unless deliberately changed. One user waiting on their own turn must not lock other users out.

Persist leases and idempotency keys for operations that span processes. A worker crash expires a lease and exposes recoverable state. Retrying a delivery must not rerun the underlying research. Unknown outcomes from external providers need reconciliation or an explicit retry decision; database claims alone do not guarantee exactly-once external effects.

### Concurrent edits

- Version mutable notes, settings, plans, and assets. Reject stale writes with a conflict response and reload/compare options.
- Derive project identity from immutable ID plus authorized owner; a slug is only a label.
- Use atomic accept/invite/role-change operations and recheck role at commit time.
- On membership revocation, invalidate subscriptions and block queued writes. Already delivered copies remain outside the application's control.
- Separate usage attribution from authorization: a project owner's budget does not grant every member their integration credentials.

### Browser and session isolation

Namespace private local drafts, Music Lab compositions, voice presets, sample clips, and tutorial caches by installation/account. Neutral device preferences, such as theme, can remain device-scoped if labeled that way.

Unowned legacy Music Lab data needs an explicit import to a verified existing account. It must never be silently adopted by whichever invited account logs in next. Retain a recoverable legacy export until ownership is resolved.

Cancel queries, abort private streams, clear account data, release audio buffers, and recreate account-scoped providers on login/logout/account change. Use cross-tab notification for logout and revocation. Never service-worker-cache authenticated API responses. Test the transition from account A to B, including late responses that arrive after logout and a second tab whose session has expired.

### Deployment gate

Keep strong sandbox isolation required. Test failure when the host cannot supply the required filesystem/network isolation; do not silently enable the single-user fallback. Installation-wide package approval and extra host mounts remain operator controls. A normal account, project owner, or Discord guild administrator must not acquire them implicitly.

## 8. Planned guided tutorials

Every available room/service gets an independently tracked tutorial. The first successful login opens a short Home orientation; each room then introduces itself on first entry. Steps and whole tutorials can be skipped. Users can pause, resume, replay, reset one tour, or reset all tours in Settings.

Progress belongs to the application account and persists across devices. Reset generations prevent an old tab from restoring obsolete progress. Demonstrations use isolated sample content, with no real provider costs, invitations, schedules, or writes into user knowledge. Major features require demonstrated actions; advanced topics link to version-matched user documentation.

The [guided tutorial specification](guided_tutorials_spec.md) is the authoritative contract. **F1** (framework: state machine, API, Settings, provider shell) and **F2** (authored demonstration tours for Home / Chat / Knowledge / Apps, with isolated Weekend field notebook samples) are shipped; remaining catalog entries stay empty until a later package. The release gates in this document also apply.


## 9. Implementation sequence

Each increment should be reviewable on its own. Account creation stays gated until identity, isolation, delivery, and the initial guided path work together.

| Increment | Changes | Main implementation seams | Exit evidence |
|---|---|---|---|
| A — Identity compatibility | Principal/account schema; external identity mapping; entitlement policy; legacy migration report; context resolver | DB schema/migrations, `dmScope`, sessions, bot ingress, gateway adapters | Idempotent fixture migration on both engines; legacy data and owners unchanged; native ID passes core boundaries; `privacyService.forgetUser`/`auditUser`/`buildUserReport` cover every new table. |
| B — Invitations and native authentication | Invite administration, register/login, recovery, local credential enrollment, account/device management, optional Discord linking | `authChat.js` split into focused routes; `Login.tsx`; Account/Connections settings | Invitation replay/races, link conflicts, revocation, throttles, CSRF, recovery tests. Registration remains release-gated. Credentials, invites, and recovery tokens reachable by the erasure path. |
| C — Independent runtime and delivery | Assistant identity, optional Discord adapter, core scheduler lifecycle, native people discovery, durable in-app results | `apps/api`, web chat, task/attention delivery, presence, project/Parlor invite services | Full user journey with no Discord config; scheduled result arrives in app; disabled integrations degrade locally. |
| D — Shared-instance readiness | Scope tests, browser content isolation, cross-process admission/budgets, edit conflicts, stream revocation | Shared access helpers, retrieval, event subscriptions, sandbox, client caches/Music Lab storage | Adversarial two-account tests and representative concurrency tests pass; strong isolation confirmed. |
| E — Product organization | Navigation/labels, Knowledge versus Memory separation, project tabs, Activity tabs, Tools catalog, scope badges | App shell, room routing, Home, Spitball/Observatory components, settings metadata | Old deep links work; note→project journey is clear; disabled tools are understandable. |
| F — Guided onboarding | Tutorial state service, catalog, fixtures, UI anchors, docs viewer, Settings reset/replay, feedback | New tutorial service/routes/provider; room components; user docs | Every enabled room has coverage; skip/reset/reload/device/account cases and mobile keyboard journeys pass. Tutorial progress and feedback rows are erased by `/forget-me` and listed by the transparency report. |
| G — Small invited pilot | Staged invitations, host limits, logs without content capture, observed first-use sessions | Deployment policy and operator UI | Native users finish the core journey; no cross-account access; resource waits remain understandable. |

Do not combine the full identity migration, navigation rewrite, tutorial framework, and rebrand in one PR. A–D establish correctness; E–F establish comprehension. Implement a representative E/F vertical slice early to test the design, while keeping public admission gated.

## 10. Validation plan

Extend the existing suites and add new tests only for meaningful behaviors. Current CI requires every new `tests/*.test.js` file to belong to exactly one `tests/ciGroups.js` group. Use deterministic providers for normal CI; live model checks remain optional and credential-gated. Both SQLite and Postgres need migration/service coverage.

| Area | Required scenarios |
|---|---|
| Identity migration | Existing operator data preserved; rerun migration; missing owner; rollback-compatible release; native non-snowflake ID; old Discord principal resolution; no accidental portal entitlement for historical users. |
| Authentication | Invite success/expired/revoked/duplicate/concurrent use; unauthenticated and disabled account; failed login throttling; reset replay; session rotation; device revocation; OAuth state mismatch; identity conflict; unlink last method; native-only login with no Discord config. |
| Authorization | A cannot list/read/search/export/change/delete B's chats, notes, memory, files, jobs, settings or tutorials. Guessed IDs and owner/actor fields in request bodies grant no authority. Denied searches reveal no snippets/counts. |
| Collaboration | Explicit acceptance; viewer/editor/owner behavior; revoked membership; concurrent invite acceptance; private knowledge in shared projects; project-linked discussion inheritance; persona memory audience. |
| Retrieval | Authorized no-match remains empty; service failure is not a wider search; self-help versus user notes; mixed lexical/vector results enforce the same scope. |
| Runtime and delivery | Discord absent/down; model absent; queue survives restart; one result with multiple delivery attempts; revocation while queued; account disabled during execution; graceful cancellation. |
| Concurrency | Different users chat simultaneously; one account's turn lock does not block another; two processes respect shared execution limits; crash lease expiry; atomic spend reservations; same-project conflicting edits. |
| Browser | A signs out/B signs in on same device; expired second tab; late A response; account-scoped local/IndexedDB data; no authenticated response in service-worker cache; legacy content import. |
| Tutorials | First login once; first visit independently; skip every step; skip one tour; pause/reload/resume; one-tour reset; reset all; stale-tab write after reset; multi-device progress; feature unavailable; missing anchor; new catalog version; no real side effects; no sample content in retrieval. |
| Accessibility | Keyboard-only path; focus restoration; screen reader labels/progress; 320px width; 200% zoom; reduced motion; dialog within tutorial; mobile target remains visible. |
| Documentation | Every `docId` resolves; anchors exist; deployed docs match version; operator documents unavailable to ordinary accounts and model retrieval. |

Start a representative load experiment with synthetic identities and mocked provider timing, then repeat a bounded subset with the real host/providers. Suggested fixture: ten accounts, three simultaneous chats, two research runs, and one sandbox run. These are test inputs, not a supported-capacity claim. Measure admission delay, API latency, memory, CPU, DB wait time, queue fairness, retries, cancellation latency and budget accuracy.

Pilot success criteria: two independent native accounts can finish the core journey without Discord; a shared project works through explicit membership; another account cannot access it; tutorials remain optional and recoverable; one user's long research does not prevent another from ordinary navigation and queued chat; the host can suspend an account and revoke its active sessions/work.

## 11. Naming: decided for the pilot

**Decided in [ADR 0012](adr/0012-name-and-license.md):** the product and the assistant both stay **Goobster** through the pilot, the license stays MIT, and a trademark and domain search is done before any public listing. Nothing is renamed: packages, configuration keys, stored data, and public APIs are unchanged. Jimbucks and the exchange remain inside the optional economy, off by default on new installs.

The [product naming exploration](product_naming_exploration.md) stays as the record of candidates and the checks a rename would need, should the search or the pilot's exit decision reopen the question.


## 12. Standards amendments on adoption

`documentation/development_standards_and_project_goals.md` is authoritative; nothing in this plan changes an engineering rule until it is written there. Each increment below names the invariant it touches so the amendment can land in the same PR as the code.

| Invariant today | Increment | Amendment |
|---|---|---|
| A user id is a Discord snowflake stored as TEXT. | A | A user id is a **principal id**: a snowflake for legacy users or `usr_<uuid>` for native ones. Both are TEXT; the shape grants no authority. Shipped - see the *Application identity* section of the standards. |
| Portal access = a valid web session. | A (gate), B (accounts) | Access = session **and**, once `identity.requireAccount` is on, an active `app_accounts` row. Operator role comes from the explicit bootstrap or an operator invitation, never from Manage Server. Shipped. |
| A session is valid until it expires or is deleted. | B | A session also dies when its `sessionVersion` snapshot no longer matches the account (`401 SESSION_REVOKED`), and sensitive account changes need `authenticatedAt` within `identity.recentAuthMinutes` (`403 REAUTH_REQUIRED`). Shipped. |
| Discord OAuth is the only sign-in. | B | Login name + password behind `identity.nativeLogin`; invitations, reset links and OAuth link state are stored **hashed**, redeemed by one conditional `UPDATE`, and the raw value is returned once. Password hashing is Node's scrypt with per-hash parameters - hash *before* opening a transaction. Shipped. |
| Guild-scoped features check membership through the gateway with the user id. | A | Membership is checked with the **Discord subject** from the actor context; a principal without one gets the private scope only and never a fabricated id. |
| Web-reachable core throws `GatewayUnavailableError` / `BOT_OFFLINE` when the bot is unreachable. | C | Chat and Projects must work with the Discord adapter disabled; only Discord-specific actions report the integration as unavailable. Shipped: `BOT_OFFLINE` is the *transient* case (adapter on, bot unreachable) and `DISCORD_DISABLED` the *permanent* one (`DisabledGateway`); the assistant identity authors turns with no bot; results deliver to the Inbox with Discord as the echo - see the *Independent runtime* section of the standards. |
| `webapp.devMode` mints a session for any id. | B/G | Dev mode is a release blocker on a shared instance; the operator checklist verifies it is off. |
| New per-user stores must be reachable by `privacyService`. | A, B, F | Unchanged, and made an explicit exit gate for every increment that adds a table. |
| The Inbox unread count is the delivery count, and a tool card that cannot run explains why. | E | A notice that `_contact` also delivered is named from both Activity views and counted once. `appearance.hiddenToolRooms` hides a tool from the catalog without changing host availability or blocking the tool's own URL. Shipped. |
| Tutorial progress is not yet a first-class store. | F | Per-account, versioned `tutorial_progress` (generation + revision) with idempotent events; `tutorial_preferences.autoStart`; optional `tutorial_feedback`. Tour events mutate only those tables — never a provider call, invitation, or knowledge write. Catalog ids live in `packages/core/config/tutorialCatalog.js` pinned to `rooms.cjs`. F1 framework + F2 sample tours (`home.orientation`, `chat.basics`, `knowledge.basics`, `projects.apps`) shipped; **Keep this example** is the only knowledge write. |
| The `self_docs` corpus is public documentation offered on every surface. | D | Operator notes under `data/self-docs/` are excluded from public retrieval, list and direct resolution. `consultDocs` exposes them only to a freshly checked active operator in their private Study. Implemented in D; see the shared-instance safety reference. |

## 13. Decisions and remaining choices

Agreed direction: invited people on the operator's instance; private application accounts; explicit sharing; no Discord requirement for core use; independent room tutorials; per-step and per-tour skipping; reset in Settings; exploratory naming only.

Proposed defaults for implementation review: native username/password with optional verified recovery email; descriptive primary labels; one primary workspace with optional specialist tools; additive identity migration; in-app delivery first; tutorial examples that incur no provider cost; gradual pilot after the shared-instance gates pass.

Resolve during the relevant increment: host budget values, role granularity for collaborative resources, and migration of historical browser-only content. None requires choosing a new brand first.

Resolved in Increment B: the password KDF is Node's built-in **scrypt** (`utils/passwordHashing.js`) rather than an Argon2id addon - no native prebuild to carry for ARM64, parameters stored per hash so the cost can rise later, verification bounded by a small semaphore. Without a mail provider the host issues audited reset links from the Host room, and the login screen says to ask the host.

Resolved in Increment B.1: the "optional verified recovery email" is a first-class attribute of the account rather than a hosted identity service. Outbound mail goes through one configured provider (`services/mailService.js`: SMTP via nodemailer, or Resend's HTTP API - every transactional provider offers SMTP, so this covers them all) and stays optional; emailed links use `webapp.publicUrl`, never the request's Host header. Open sign-up (`identity.registration = "open"`) creates nothing until the address is verified - a parked, hashed `pending_registrations` row becomes principal + account + credential + verified address in one transaction - and is effective only when mail is configured. Every path that mails someone answers identically whether or not the address is known. A hosted identity service (Supabase Auth, Auth0, …) would be an OIDC provider under this model, not a replacement for the account store; that decision is deferred to the increment that adds OIDC.

Resolved in Increment C: Discord is a **transport**, switched by `discord.enabled` / `GOOBSTER_DISCORD_ENABLED` and otherwise inferred from the presence of a bot token. The assistant's own identity is installation-scoped (`asst_<installationId>`, `identity.assistantName`) and a connected bot account overrides only its Discord-facing name. The in-app inbox (`inbox_items`) is the system of record for every result addressed to a person; the Discord DM is an echo with its own status on the item, so a closed DM or an absent adapter cannot lose or re-run work. Unattended agent turns addressed to a person run through one service (`unattendedTurnService`) whatever produced them. Schedulers belong to the core runtime (`runtime/coreRuntime.js`), which every process entry point calls; `apps/api` gained a *standalone* mode for the whole assistant without Discord, while the split deployment's *paired* mode is unchanged. Native people discovery is query-only over active accounts and returns name + id, nothing more; the roster is never browsable. The Exchange stays a Discord-guild feature and says so specifically rather than inventing a guild.

Implementation status must be updated here as increments land, with links to their PRs and the validated exit evidence. Do not mark an increment complete solely because its documentation or UI shell exists.

### Implementation status

The handoff note for whoever picks the roadmap up next - what shipped, which seams the next steps use, and a brief per step - is [shared_instance_handoff.md](shared_instance_handoff.md).

| Increment | Status | Evidence |
|---|---|---|
| A — Identity compatibility | **Shipped** in [PR #229](https://github.com/nervous-rob/goobster/pull/229) (`principals`, `app_accounts`, `auth_identities`; `identityService`; `requireAccount` gate; `npm run identity:report`; actor context on `req.actor`). Behaviour: [identity.md](identity.md). | `tests/identityService.test.js` on SQLite and Postgres: idempotent backfill (second run creates 0), legacy owners unchanged, native `usr_` id through dev session → `/me` → DM-only scopes, gate on/off, disabled account, `/forget-me` audit clean. |
| B — Invitations and native authentication | **Shipped** in [PR #230](https://github.com/nervous-rob/goobster/pull/230) (`account_invites`, `password_credentials`, `recovery_tokens`, `oauth_link_states`; `nativeAuthService`; `identity.nativeLogin` gate; Host room; Settings → *Account & sign-in*; `/app/invite`, `/app/recover`). Behaviour: [identity.md](identity.md#native-sign-in-increment-b). | `tests/nativeAuth.test.js` on SQLite and Postgres: invitation replay and a 5-way redemption race (one winner), taken name leaves the invite open, neutral login errors, per-name throttle, `BAD_ORIGIN` on cross-origin POST, enrollment behind `REAUTH_REQUIRED`, reset replay + every session revoked, `SESSION_REVOKED` on version bump, link-intent binding/expiry, `IDENTITY_CONFLICT` on link, disconnect rules, operator gating and self-lockout guards, `/forget-me` audit clean across the new tables. Browser walkthrough: invite → register → sign out → native login → dead link. |
| B.1 — Verified email, open sign-up, self-service recovery | **Shipped** in [PR #231](https://github.com/nervous-rob/goobster/pull/231) (`account_emails`, `email_tokens`, `pending_registrations`; `mailService` + `mail.*` config; `identity.registration`; `app_accounts.entitlement = 'open'`; `/app/register`, `/app/forgot`, `/app/verify-email`; Settings → *Account* → Email; Host → *Sign-up & mail*). Behaviour: [identity.md](identity.md#email-increment-b1). | `tests/emailAuth.test.js` on SQLite and Postgres: nothing is an account before verification, 4-way verification race (one winner), pending replacement and name reservation, expiry pruning, mail failure rolls back, neutral `200` for a taken address (owner notified) and for unknown/unverified/disabled addresses on forgot, unverified address is neither login nor recovery, address change kills old links, verified address exclusive / unproven claim taken over, `REAUTH_REQUIRED` on set/remove, per-address and per-recipient throttles, `BAD_ORIGIN`, host panel and test mail gating, `/forget-me` audit clean incl. parked sign-ups; `tests/dbSchemaUpgrade.test.js`: pre-`open` `app_accounts` rebuilt on both engines. Browser walkthrough: create account → inbox link → signed in with `open` entitlement → sign in by email → forgot → inbox reset link → new passphrase (old refused) → Host panel. |
| C — Independent runtime and delivery | **Shipped** (`config/discordConfig.js`; `services/assistantIdentity.js`; `gateway/disabledGateway.js` + `GatewayDisabledError`; `inbox_items` + `services/inboxService.js`; `services/unattendedTurnService.js`; `services/followupDeliveryService.js`; `runtime/coreRuntime.js`; `apps/api` paired/standalone modes; `identityService.searchPeople` / `describeMember`; Inbox room; `/api/app/inbox/*`, `/api/app/people`). Behaviour: [independent_runtime.md](independent_runtime.md). | `tests/independentRuntime.test.js` on SQLite and Postgres: `DisabledGateway` refuses with `DISCORD_DISABLED` while `sendDm` reports instead of throwing, assistant identity authors a web turn with no client, `deliver()` echo statuses (`skipped` without a Discord subject, `sent`, `failed` on a closed DM) + dedupe + list/read/archive + `/forget-me` audit clean, a due follow-up lands in the inbox with no client, `searchPeople` is query-only and excludes the caller / inactive accounts, `listInvitable` merges the `member` source, a project invitation by `usr_` id files an inbox item, `/me` reports `assistant` + `discord.enabled=false` + unread count, inbox routes never cross users, Exchange and guild scopes answer `DISCORD_DISABLED` / `NO_DISCORD_IDENTITY`, web tasks target `inbox:<userId>`, `startCoreRuntime` skips Discord-bound workers without a client and stops cleanly, api mode resolution + standalone `/health`. Browser walkthrough with no Discord token (`apps/api` standalone, SQLite): sign in → Home without Exchange → Inbox holds the reminder the ticker delivered → Tasks show `→ Inbox` → Parlor People finds a member by name → invite → Settings says not connected to Discord → the invitee signs in, sees the invitation in her Inbox, opens and accepts it. |
| D — Shared-instance readiness | **Implemented; validation and actual-host gate pending.** | Re-audit against main `42be241`, implementation boundaries, regression suites, shared admission policy and the required deployment canary: [shared-instance safety evidence](shared_instance_safety.md). Spending limits remain #248 and the invited pilot remains #265; do not open shared admission solely on this status. |
| E — Product organization | **Shipped (E1–E5).** E1 (navigation contract) shipped in [PR #234](https://github.com/nervous-rob/goobster/pull/234): `apps/web/src/lib/rooms.cjs` room registry; canonical `/chat`, `/knowledge`, `/projects`, `/discussions`, `/activity/{inbox,attention,scheduled}`, `/tools`; typed alias routes for every older path preserving id, query and hash; Activity shell around the existing Inbox/Noticed/Tasks rooms; Tools landing page with locally explained unavailability; `startPage` accepts new room ids and every saved legacy value; server-written Inbox links use canonical paths (the old `/attention` link had no route). Behaviour: [portal_navigation.md](portal_navigation.md). E2 (Knowledge and Memory) shipped in [PR #235](https://github.com/nervous-rob/goobster/pull/235): `kg_nodes.curation` (`saved` / `memory` / `unclassified`, [ADR 0008](adr/0008-knowledge-curation-contract.md)) separates what a person kept from who wrote it; one server-side projection (`view = knowledge | memory | all`) behind `listUserNotes`, the constellation and the per-scope counts; a conservative once-per-process backfill that classifies only evidenced legacy rows and never deletes or rescopes; Knowledge opens on `/knowledge/notes` with `/knowledge/map` and `/knowledge/research` registered as room views; About you / Facts / Memories moved into Settings → Memory & privacy (`PersonalMemoryPanel`, private scope plus an explicitly labelled server-scope inspector) with shortcuts from Chat and Knowledge; note, fact, memory and transcript deletion stay distinct and are explained in place. Behaviour: [knowledge_and_memory.md](knowledge_and_memory.md). E3 (project organization, [ADR 0009](adr/0009-project-organization-contract.md)): projects addressed by owner and slug at `/projects/:ownerId/:slug/:view` with nine registered views (Overview, Plan, Conversation, Knowledge, Files, Apps, Runs, People, Automations) under a `detail` pattern in the room registry, so refresh, Back, bookmarks and Inbox links land on the same project and view; `/projects/:slug` resolves a unique match and shows a chooser for two owners with one slug; `ObservatoryService.organizationEnabled` (`projects.enabled`, default on) separated from `executionEnabled` (`observatory.enabled` + sandbox), reported as `me.features.projects` / `me.features.observatory`, so the room organizes with code execution off and explains it locally; `POST /api/app/projects { name, goal? }` creates directly with no model call (goal in the existing `description` column, shown on Overview); visible vocabulary Plan / Run / Files / Outputs / Unfiled apps with identifiers unchanged; `🔭 <name>` title routing kept. Behaviour: [projects.md](projects.md#the-portal-pane). E4 (explicit transfers, [ADR 0010](adr/0010-explicit-transfers.md)): one per-user ledger `knowledge_transfers` (who moved what where, how, to whom - on the erasure, audit and transparency paths); **Save as note** on every assistant answer in a saved chat creates a `curation = 'saved'` personal note with provenance back to the message (`POST /api/app/spitball/notes/from-message`), so it appears under Knowledge → Notes and on the Map through the unchanged projection and never under Personal memory, and incognito chats do not offer it; **Add to project…** / **Use in discussion…** on a kept note (`POST /api/app/spitball/notes/:nodeId/transfers`) with an owner-qualified picker and a server-side refusal of memory rows; **reference** mode only into a private project the caller owns, resolved at read time for them alone so sharing the project later cannot expose it; **publish a copy** for shared projects and discussions with what-will-be-shared and the named audience shown first, a snapshot in the `PROJECT:` scope (or a transcript message with no persona turn) that republishes in place and is removable by owner or publisher; deleting the original drops references, keeps copies, and the dialog names every scope; `StudyRoom` gates Save to project on `me.features.projects` (organization), not `me.features.observatory`; Unfiled apps stays the one list of outputs without a project with owner-qualified links; conversation identity left on the `🔭 <name>` title (ADR 0009 §6). Behaviour: [knowledge_and_memory.md](knowledge_and_memory.md#moving-a-note-into-shared-work), [projects.md](projects.md#moving-knowledge-into-a-project). E5 (Activity correlation and tool visibility) shipped: one `_contact` delivery is named from the Inbox row and from each Attention notice (`services/activityCorrelation.js`); the stores and their actions stay separate and the sidebar badge stays the Inbox unread count; `appearance.hiddenToolRooms` hides tool-room ids from the Tools catalog without the unavailable-card treatment, rejects an unknown id, and still lets the tool's own URL open. Behaviour: [portal_navigation.md](portal_navigation.md). | E1: `tests/portalRooms.test.js` (registry: seven primary rooms, 28 tutorial ids once, alias matrix, server share excluded, room/display-name resolution, availability, start-page parity with `userSettingsSchema.START_PAGES`, legacy hash) and `e2e/navigation.spec.js` (real router: legacy→canonical with query+hash, active entry, `#room/id`, sidebar contents with Host hidden from a member, Activity views + Back, Tools cards with the trading game explained as unavailable without Discord, Home creation choices and Personal memory → Settings, settings return from a legacy path, start page saved as `study`, Inbox row stored with `/tasks`, both public share families anonymously). Existing journeys updated to the new labels. E2: `tests/knowledgeCuration.test.js` on SQLite and Postgres (writers declare intent at creation; automated content writes never reclassify while a human edit saves; `setUserNoteCuration` changes intent only — no `source` rebrand, revision or timestamp bump; a reflection merge keeps a deliberate save; Notes, Map and facet counts agree in every view with legacy rows still visible; retrieval ignores curation; the backfill classifies only decisive rows and leaves an already-classified scope alone; deleting a note removes its mirrored fact but not the raw memory; deleting a memory leaves distilled notes; the transparency report breaks the graph down by curation and `/forget-me` erases all of it), `tests/portalRooms.test.js` (Knowledge views and their aliases) and `e2e/knowledge.spec.js` (Knowledge lands on Notes with Map/Research as views and `/spitball/<view>` aliases; Notes and Map share one projection; **Keep** reclassifies a legacy note without touching its source; note deletion copy says what stays; Personal memory in Settings reachable from Chat and Knowledge; forgetting a fact removes its Map copy but leaves raw memories). E3: `tests/projectOrganization.test.js` on SQLite and Postgres (the service separates organization from execution; `/me` reports both; direct creation with a goal, name required, session required; members and share links work with execution off while run, render and the command turn are refused with `DISABLED`; two owners with one slug are both listed with `ownerId` and named from their principal; a bare slug prefers the caller's own project and is ambiguous only between memberships), `tests/portalRooms.test.js` (the Projects detail pattern: every view's path round-trips, legacy `mission` / `explorer` / `jobs` segments, unknown segment → null view, list and resolver paths → no view, `Projects · Runs` display name) and `e2e/projects.spec.js` (list cards link to owner-qualified addresses and say who owns each; tabs, refresh, Back/Forward and deep links agree on the view; the same-slug chooser and a missing slug; the create form opens the new project and the unique slug resolves straight through; Conversation and People as views with the dock and modal secondary; Unfiled apps on the list). Journeys updated to Plan / Run / Outputs / Files. E4: `tests/knowledgeTransfers.test.js` on SQLite and Postgres with execution off (an answer becomes a `saved` personal note with provenance and shows in the knowledge view and constellation but not the memory view; user turns, strangers and unknown messages refused; long answers trimmed with notice; pre-existing notes and memory rows untouched; the list marks private projects and the audience route names readers; a memory row is `NOT_KNOWLEDGE`; a reference is refused for a shared project with `PROJECT_SHARED`, writes nothing into the project scope, is idempotent, is read by its owner alone and stays invisible to a collaborator added later while the manifest names it only to the actor; a copy lands in the `PROJECT:` scope with `publishedBy`, is invisible in the publisher's personal space to others, removable by owner or publisher only, republishes in place, clashes on an unrelated title, and the command turn is still `DISABLED`; a collaborator publishes and removes their own copy; Use in discussion posts a user message with no persona turn; deleting the original keeps copies and transcript messages with the title snapshot; report, audit and erasure) and `e2e/transfers.spec.js` (Save as note from a seeded chat with the app fence still offering Save to project; the note under Your notes, absent from the memory view, on the constellation; the owner-qualified picker with no actions on a distilled row and a direct refusal; reference into the private project, read only by its owner, surviving refresh; published copy into the collaborator's project with the audience and preview shown first, refresh and Back on the project's Knowledge view, the collaborator seeing the copy and the publisher's name but never the original; Use in discussion; the delete dialog naming the reference, the copy and the transcript message, and the copy staying). E5: `tests/activityCorrelation.test.js` on SQLite and Postgres (one `_contact` is one unread inbox row naming every notice, and each notice names that row; archive stays an inbox action and shows on the notice; dismiss, snooze and act stay attention actions and show on the row; a forged source id cannot read another person's notice; `hiddenToolRooms` rejects an unknown id, is on the transparency report, and leaves with `forgetUser`) and `e2e/activityTools.spec.js` (the seeded `_contact` row and its notices point at each other, the sidebar badge matches `me.inbox.unread`, refresh and Back keep the view, archive and attention actions reflect without moving, a hidden tool leaves the grid without the unavailable treatment while a host-unavailable tool still explains itself, and the hidden tool's own URL still opens). |
| F — Guided onboarding | **F1 + F2 sample tours shipped.** Framework: `tutorialCatalog.js`, `tutorialService.js`, `tutorial_*` tables, `/api/app/tutorials*`, Settings → Tutorials, `TutorialProvider` / `TutorialPanel`. F2 authors `home.orientation`, `chat.basics`, `knowledge.basics`, and `projects.apps` with Weekend field notebook samples (`tutorialSamples.js`) and **Keep this example**; other catalog entries remain empty. Behaviour: [guided_tutorials_spec.md](guided_tutorials_spec.md). | F1+F2: `tests/tutorialFramework.test.js` on SQLite and Postgres (unknown id rejected; stale generation after reset; skip_step ≠ complete_step; skip one leaves another not_started; unavailable steps recorded not completed; reset one / reset all leave notes and `hiddenToolRooms` alone; auto-start preference only; `/forget-me` / audit / transparency; tour events never write knowledge; Keep copies an allow-listed note once; authored tours v2 with demos); `tests/portalRooms.test.js` catalog parity with `rooms.cjs`; `e2e/tutorials.spec.js` (Settings Resume / Replay / Reset, demos, skip step, Keep this example, Finish — no provider; public share never starts a tour). |
| Launch blocker — Backup and tested restore ([#249](https://github.com/nervous-rob/goobster/issues/249)) | **Shipped.** `npm run backup` / `npm run restore` (`services/backupService.js`): database snapshot (SQLite online backup / `pg_dump`), file sets, `config.json` encrypted under a passphrase, environment secret names only; engine and schema-fingerprint gates; in-flight work failed as `interrupted by restore` into `work_failures` (#256 groundwork), never retried; the instance comes back **paused** (`instance_state`, `runtime/coreRuntime.js`) and the Host room resumes it after skipping every missed schedule. Runbook: [backup_and_restore.md](backup_and_restore.md). | `tests/backupRestore.test.js` on SQLite and Postgres: the archive never holds the token in plaintext, wrong passphrase writes nothing, `ENGINE_MISMATCH` / `SCHEMA_MISMATCH` / `TARGET_NOT_EMPTY`, restore into a fresh installation with matching counts and a pre-backup session still valid, every in-flight kind failed with one `work_failures` row and nothing left for auto-resume, the paused runtime starting its workers on resume, missed automations / triggers / reminders skipped (one-shot ones cancelled with an Inbox notice), `/forget-me` nulls the actor, `/me` and the operator-only admin routes, both CLIs end to end. The dated recovery test on the actual host (runbook §"The recovery test") is the pilot's remaining step. |
| Gap — Pilot diagnostics and cost ([#256](https://github.com/nervous-rob/goobster/issues/256)) | **Shipped.** Three tables keyed by the work reference `(workKind, workId)`: `work_failures` (every listed kind - chat turns, expeditions, jobs, sandbox runs, automations, trigger deliveries, reminders, watches, Inbox echoes - writes kind, work id, phase, code, a short reason and actor; never a prompt or body), `resource_events` (search calls, sandbox seconds, retries, under `utils/workContext.js`), and `operator_audit` (every Host-room action, pause / restore / resume, one-year retention). `usage_reservations` is created here for the cost join; its writer lands with #248. `services/costReportService.costPerResult` joins settled tokens with resource events per accepted result. The person sees own rows in Usage → *What went wrong* and on the Inbox item that reports the failure; the operator sees any account's usage + resources + failures (Host → Accounts → *Support*) and the audit (Host → *Operator audit*). Retention 30 / 90 / 365 days (`ledgerRetentionService`, coreRuntime); erasure nulls the actor and keeps the row. Guide: [work_ledger.md](work_ledger.md). | `tests/workLedger.test.js` on SQLite and Postgres: every kind writes a row with no marker text; a failed expedition, scheduled task, sandbox run, job and Discord echo each through the real path (expedition and automation with a linked Inbox item); per-provider search calls under the expedition; per-person totals; the seeded cost-per-result join (1500 tokens, 3 searches, 12.5 sandbox seconds, 1 retry over 1 accepted result); own rows only; the operator's per-account view and roster counts; 30 / 90 / 365-day sweeps and runtime registration; erasure nulls and keeps (reservations paid by the person deleted); nine operator actions in the Host room each write one audit row with no token or link stored; paging, filters, secret keys stripped. |
| G — Small invited pilot | Not started | — |
