---
title: "Application identity: principals, accounts, and the actor context"
kind: reference
summary: How Goobster identifies a person independently of Discord - principals, linked external identities, the account entitlement, the actor context every web request carries, the legacy migration report/backfill, and the requireAccount release gate. This is shipped behaviour (shared-instance Increment A).
tags: [identity, accounts, principals, sessions, privacy, shared-instance]
---

# Application identity

**Status: shipped** as Increment A of the
[shared-instance product plan](shared_instance_product_spec.md). What this
document describes exists in the code today; the invitation flow, native
login, and account administration UI are later increments and are *not*
available yet.

## What a principal is

A **principal** is the canonical application identity that every surface
(web session, Discord interaction, automation) resolves to. It lives in the
`principals` table with an opaque text `id`.

| Kind | Id shape | How it comes to exist |
|---|---|---|
| Legacy (Discord) | the Discord snowflake itself, e.g. `100000000000000001` | Provisioned automatically the first time the person chats with the bot (`getOrCreateUser`) or signs in to the portal. Also created in bulk by the migration backfill. |
| Native | `usr_<uuid>`, e.g. `usr_7cb067fd-ce37-4af2-b08a-eef999edb7b5` | Created by `identityService.createNativePrincipal()`. Today only the portal's dev-mode session mints one; the invitation flow is Increment B. |

Reusing the snowflake as the legacy principal id is deliberate: nothing keyed
on `userId`, `dm:<userId>` (the [DM scope](architecture.md)), or
`USER:<userId>` has to be rewritten, and no history moves. **The id format
grants no authority** - see *Accounts* below.

A principal may have zero or more **linked external identities**
(`auth_identities`: provider, issuer, subject). Legacy principals carry one
`discord` identity whose subject is their own id. One external subject
belongs to exactly one principal; `linkExternal` refuses to move a subject
that another principal already owns (`IDENTITY_CONFLICT`) - accounts are
never merged by matching names, emails, or guilds.

## Accounts: the entitlement

Signing in proves *who* someone is. Whether they may *use this installation*
is a separate fact: an `app_accounts` row.

| Column | Meaning |
|---|---|
| `status` | `active` or `disabled`. A disabled account is refused on every authenticated portal route (`403 ACCOUNT_DISABLED`) and its live sessions are deleted when it is disabled. |
| `role` | `member` or `operator`. Discord *Manage Server* does **not** grant `operator`. |
| `entitlement` | Why the account exists: `invite` (accepted invitation - Increment B), `migration` (an existing Discord user explicitly activated), or `bootstrap` (the operator bootstrap). |
| `loginName` | Reserved for native credentials (Increment B); `NULL` today. |
| `credentialVersion`, `sessionVersion` | Bumped on credential and status changes so stale sessions can be invalidated. |

Historical bot users are **not** granted accounts by the backfill. Only
`grantAccount` (explicit) and `bootstrapOperators` write this table, and a
repeated grant never changes an existing account's role.

### The `requireAccount` release gate

By default (`identity.requireAccount: false`) a session is all the portal
needs, exactly as before: a Discord login works whether or not an account
row exists. Turning the gate on makes installation membership explicit:
every authenticated route answers `403 NO_ACCOUNT` until the principal has
an active account. Grant accounts (or bootstrap operators) **before**
enabling it, or you lock yourself out.

## The actor context

`requireAuth` resolves every web session into an **actor context** and puts
it on `req.actor`:

```js
{
  actorId: 'usr_…' | '<snowflake>',   // the principal; never a client-supplied field
  installationId: 'local',           // identity.installationId
  surface: 'web' | 'discord' | 'automation',
  sessionId: '42' | null,
  externalActor: { provider: 'discord', subject: '<snowflake>' } | null,
  account: { role, status, entitlement } | null
}
```

Core code keys data on `actorId`. Anything that talks to Discord - guild
membership checks, mentions, DMs - uses the Discord **subject**
(`identityService.discordSubjectFor(actor)`), which is the legacy id for a
legacy principal, the linked identity for a native one, or `null` when there
is none. A `null` subject means *degrade*: `webDashboardService.listScopes`
returns only the private DM scope and never asks the gateway. Callers must
never invent a Discord id for a native principal.

On the bot, `identityService.discordActor(interaction.user.id)` builds the
same shape synchronously - the message path does no identity database work.

`GET /api/app/me` exposes the parts the client may need:

```json
"identity": { "installationId": "local", "account": null, "discordLinked": true }
```

## Signing in

- **Discord OAuth** (`/api/app/auth/callback`): the Discord subject resolves
  to the principal that owns it - a native account that linked Discord, or
  the legacy principal (created on the spot if missing). The session is
  minted for that principal.
- **Dev mode** (`webapp.devMode`, never in production): `POST
  /api/app/auth/dev-session` accepts any principal id. A `usr_<uuid>` that
  does not exist yet is created, which is how the Discord-free path is
  exercised before the invitation flow lands.
- `webSessionService.create` accepts a snowflake (provisions the legacy
  principal) or an **existing** native id; anything else is rejected.

## Migration report, backfill, and operator bootstrap

```bash
npm run identity:report                          # read-only
npm run identity:report -- --json                # machine-readable
npm run identity:report -- --backfill            # principals for every legacy owner (idempotent)
npm run identity:report -- --bootstrap-operators # operator accounts for identity.operators
npm run identity:report -- --bootstrap-operators 1234567890123  # ...or ids on the command line
```

The report walks every identity-bearing table (`identityService.OWNER_COLUMNS`:
`users.discordId`, `UserPreferences`, `user_settings`, `web_sessions`,
`web_conversations`, `web_share_links`, `web_applets`,
`web_generated_files`, `memory_embeddings` author and `dm:` scope,
`guild_settings` `dm:` scope, `kg_nodes` `USER:` scope, `kg_artifacts`,
`followups`, `automations`, `observatory_projects`, `project_members`,
`parlor_personas`, `parlor_members`, `user_friends`, `user_integrations`,
`attention_policies`, `spitball_expeditions`) and reports distinct owners,
how many already have a principal or an account, and which ids are neither
Discord-shaped nor native (**unresolved** - shown with the tables they
appear in so the operator can decide what they are).

`--backfill` creates a principal plus `discord` identity for every
Discord-shaped owner, taking the display name from `users` when known.
Running it twice creates nothing the second time. It never grants accounts.

`--bootstrap-operators` is the explicit one-time operator bootstrap: the ids
in `identity.operators` (config.json) or `GOOBSTER_IDENTITY_OPERATORS` get a
`bootstrap` account with the `operator` role (an existing account is
promoted). There is no "first visitor becomes admin" path.

## Configuration

`config.json` `identity` block (environment variable overrides in brackets):

| Key | Default | Meaning |
|---|---|---|
| `installationId` [`GOOBSTER_INSTALLATION_ID`] | `local` | Label carried on every actor context. |
| `requireAccount` [`GOOBSTER_IDENTITY_REQUIRE_ACCOUNT`] | `false` | The release gate described above. |
| `operators` [`GOOBSTER_IDENTITY_OPERATORS`] | `[]` | Discord ids eligible for `--bootstrap-operators`. |

## Privacy

Principals, linked identities, and accounts are per-user data:
`/forget-me` (`privacyService.forgetUser`) deletes all three inside its
transaction, `privacyService.auditUser` counts them (`principals`,
`auth_identities`, `app_accounts`) so a clean audit stays provable, and
`/what-do-you-know-about-me` reports the principal, the account
(role/status/entitlement - never credentials), and linked providers. A
forgotten person has to be invited again.

## Not yet here

Invitations, username/password login, recovery, account and device
administration, native people discovery, and an assistant identity that
works with the Discord adapter disabled are Increments B and C of the
[plan](shared_instance_product_spec.md#9-implementation-sequence). Until
then a native principal can only be minted in dev mode, and chat still needs
the bot connected.
