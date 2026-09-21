---
title: "Application identity: principals, accounts, and the actor context"
kind: reference
summary: How Goobster identifies a person independently of Discord - principals, linked external identities, the account entitlement, the actor context every web request carries, invitations, login name + password sign-in, a verified email address (sign in by email, self-service password reset, open sign-up), outbound mail configuration, recovery, Discord connect/disconnect, session revocation, the operator Host room, and the requireAccount / nativeLogin release gates. Shipped behaviour (shared-instance Increments A, B, and B.1).
tags: [identity, accounts, principals, sessions, privacy, shared-instance, invitations, password, login, email, mail, smtp, registration, operator]
---

# Application identity

**Status: shipped** as Increments A, B, and B.1 of the
[shared-instance product plan](shared_instance_product_spec.md). What this
document describes exists in the code today. Native sign-in is installed but
**off by default** - the host turns on `identity.nativeLogin` when ready;
until then Discord OAuth is the only way in. Email (verification, reset by
email, open sign-up) additionally needs an outbound [mail
provider](#outbound-mail) and `webapp.publicUrl`; without them nothing
email-related is shown.

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

Three ways into the portal mint the same kind of session (`web_sessions`):

- **Discord OAuth** (`/api/app/auth/login` → `/api/app/auth/callback`): the
  Discord subject resolves to the principal that owns it - a native account
  that connected Discord, or the legacy principal (created on the spot if
  missing). The session is minted for that principal.
- **Login name + password** (`POST /api/app/auth/native-login`): the native
  sign-in described below. Only available while `identity.nativeLogin` is on.
  The identifier may also be the account's **verified** email address.
- **Dev mode** (`webapp.devMode`, never in production): `POST
  /api/app/auth/dev-session` accepts any principal id. A `usr_<uuid>` that
  does not exist yet is created.

`webSessionService.create` accepts a snowflake (provisions the legacy
principal) or an **existing** native id; anything else is rejected. Every
session records `authenticatedAt` (when the person last proved who they
are on it) and a snapshot of the account's `sessionVersion`.

## Native sign-in (Increment B)

Everything in this section sits behind the **`identity.nativeLogin`**
release gate (default off): invitations, registration, login, recovery,
re-authentication, and credential enrollment answer `503
NATIVE_LOGIN_DISABLED` until the host turns it on. Connecting and
disconnecting Discord are not behind it. Service:
`services/nativeAuthService.js`; routes: `web/routes/auth.js`,
`web/routes/account.js`, `web/routes/admin.js`.

### Invitations

An operator issues an invitation from the **Host** room (or `POST
/api/app/admin/invites` with `role`, optional `note`, optional `ttlHours`).
The response carries the raw token **once**, inside a ready-to-share URL
(`/app/invite?token=…`); the database keeps only its SHA-256
(`account_invites.tokenHash`), the role it grants, who issued it, when it
expires, and later when and by whom it was redeemed or revoked.

- `GET /api/app/auth/invite/:token` is what the landing page shows before
  the person commits: the role, the expiry, and the installation's name.
  It never consumes.
- `POST /api/app/auth/register` `{ token, loginName, password, displayName? }`
  redeems it. Redemption is one conditional `UPDATE … WHERE consumedAt IS
  NULL AND revokedAt IS NULL AND expiresAt > now`; if it did not change
  exactly one row the link is dead (`404 INVITE_INVALID`). A race for the
  same token therefore admits exactly one person on both engines. A taken
  login name (`409 LOGIN_NAME_TAKEN`) or a weak password rolls the
  transaction back and leaves the invitation open.
- Success creates a `usr_<uuid>` principal, an `app_accounts` row with
  `entitlement = 'invite'` and the invitation's role, the credential, and a
  session. An invitation is never itself a login credential.
- `DELETE /api/app/admin/invites/:id` revokes an open invitation
  (redeemed ones cannot be revoked - the account already exists).

### Login names and passwords

- Login names are lower-cased, 3-32 characters of `[a-z0-9._-]`, must
  start with a letter or digit, and may not look like a principal id (all
  digits or `usr_…`). They are unique across the installation
  (`app_accounts.loginName`).
- Passwords: at least `identity.passwordMinLength` (default **15**, floor
  12) and at most 256 characters, no composition rules, not the login
  name, and not on a short built-in list of long-but-common choices
  (`WEAK_PASSWORD`). Breach-corpus checks need the network and are not
  performed.
- Storage: **scrypt** from `node:crypto` (`utils/passwordHashing.js`), 32-byte
  key, 16-byte random salt, `r = 8`, `p = 1`, `N = 2^identity.passwordCostLog2`
  (default 2^15 = 32 MiB, ~60-120 ms on a Raspberry Pi 4). The parameters are
  stored with every hash, so raising the cost re-hashes on the next
  successful login instead of invalidating anyone. Verification runs behind a
  two-wide in-process semaphore so a burst cannot pin a small host's memory.
  This is the "vetted implementation" the plan asked for: no native addon to
  prebuild for ARM64, and no hand-rolled cryptography (KDF, salt and the
  timing-safe compare all come from Node).
- Login (`POST /api/app/auth/native-login`) returns the same `401
  BAD_CREDENTIALS` for an unknown name and a wrong password, spends
  comparable time on both, and reveals `403 ACCOUNT_DISABLED` only after a
  correct password. Attempts are throttled through the shared
  `web_rate_events` window - 10 per login name and 40 per client address
  per 15 minutes (`429 TOO_MANY_ATTEMPTS`); a successful login clears the
  name's bucket so people are not locked out by their own typos. Behind the
  nginx/tunnel profiles the private/loopback proxy suffix of
  `X-Forwarded-For` is traversed from right to left. The first public address
  is the client; any earlier client-supplied prefix is ignored. A public
  direct peer's header is ignored, and malformed chains use the direct peer.
- Every login mints a fresh session (rotation); the previous cookie is
  replaced.

### Enrollment for Discord users, and changing a password

`PUT /api/app/account/credentials` `{ loginName?, currentPassword?,
newPassword }` sets or changes native credentials on the signed-in
principal. It needs an account (`403 NO_ACCOUNT` otherwise) and proof of
identity: the **current password** when one exists, otherwise - the
enrollment case for a Discord-only account - a **recent authentication**
(see below). A legacy principal that enrolls keeps its snowflake id; it just
gains a second way in. Settings → *Account & sign-in* is the UI.

### Recent authentication and re-auth

Sensitive changes (credentials, connecting or disconnecting Discord) require
that `web_sessions.authenticatedAt` is within `identity.recentAuthMinutes`
(default 15) - otherwise `403 REAUTH_REQUIRED`. `POST /api/app/auth/reauth`
`{ password }` refreshes the timestamp on the current session; a person
without a password signs in again instead. `GET /api/app/account` reports
`recentAuth` so the client can offer the right step.

### Recovery

Two paths mint the same single-use reset token. Without mail, the host
issues an **audited reset link** from the Host room (`POST
/api/app/admin/accounts/:principalId/recovery`). With mail, the person asks
for one themselves ([forgot password](#forgot-password-by-email) below).
For the host's link the raw token is shown once
(`/app/recover?token=…`); `recovery_tokens` keeps its hash, the account,
`purpose = 'password_reset'`, who issued it, and the expiry
(`identity.recoveryTtlMinutes`, default 60). `POST /api/app/auth/recover`
`{ token, password, loginName? }` consumes it atomically (replay is `404
RECOVERY_INVALID`), stores the new credential, bumps the account's
`credentialVersion` **and** `sessionVersion`, deletes every session of the
account, and mints a new one. An account with no login name yet (a Discord
user being recovered into native sign-in) supplies one.

Changing a password or completing recovery invalidates every outstanding
reset link for the account. Replacing or removing the recovery email does
the same. Issuance and redemption serialize with those changes, so a reset
already in flight cannot restore an older credential or recovery address.

### Session revocation

`app_accounts.sessionVersion` is the kill switch. It is bumped by a password
reset and by disabling an account; `requireAuth` compares it with the
snapshot the session was created with and answers `401 SESSION_REVOKED`
(clearing the cookie) on a mismatch. Sessions created before this column
existed carry `NULL` and are exempt. Disabling also deletes the sessions
outright; role changes take effect on the next request because the role is
read from `app_accounts` every time, so they need no rotation.

### Connecting and disconnecting Discord

- **Connect** (`GET /api/app/auth/link/discord`, signed in, recent auth):
  starts the normal OAuth redirect but first stores the state nonce
  (hashed) in `oauth_link_states`, bound to the principal and session that
  started it, for ten minutes. The callback consumes the intent, checks that
  the cookie session is the same one, and then `linkExternal`s the Discord
  subject instead of logging in. Outcomes come back to Settings as
  `?link=ok`, `?link=conflict` (the Discord account already belongs to
  another principal - nothing changes), `?link=link_expired`, or
  `?link=link_session_mismatch`. Legacy principals cannot connect (they
  already are their Discord identity).
- **Disconnect** (`DELETE /api/app/account/identities/discord`, recent
  auth): only for native principals, and only while a login name **and** a
  password exist (`409 LAST_SIGN_IN_METHOD` otherwise) so the person can
  still sign in. Data and credentials stay; Discord DMs and guild-derived
  access stop with the next request. A legacy principal gets `409
  LEGACY_IDENTITY`: its id *is* the Discord subject.

## Email (Increment B.1)

An account may carry **one email address**. It is optional, it is never
required to sign in, and it does nothing until it is **verified** by
following a link mailed to it. A verified address is a second login
identifier and the channel for self-service password reset; with
`identity.registration = "open"` it is also how strangers create accounts.
Everything here needs `identity.nativeLogin`, a configured [mail
provider](#outbound-mail), and `webapp.publicUrl` (the absolute origin put
into emailed links - never taken from the request's `Host` header, so a
forged header cannot redirect a reset link). When any of the three is
missing the routes answer `503 MAIL_DISABLED`, `GET /api/app/config`
reports `emailRecovery: false`, and the client hides the flows.

Tables: `account_emails` (one row per principal; `address` as typed,
`normalized` lower-cased and unique across the installation, `verifiedAt`),
`email_tokens` (hashed single-use verification links pinned to the address
they were sent to), and `pending_registrations` (open sign-ups waiting to
be verified - see below). Normalisation lower-cases and trims; dots and
plus-tags are **not** stripped, so `a.b+x@example.org` and `ab@example.org`
are different addresses.

### Adding and verifying an address

Settings → Account → **Email**. `PUT /api/app/account/email { email }`
(recent authentication required) stores the address **unverified**, deletes
any earlier verification links for the account, and mails a new one
(`/app/verify-email?token=…`, lifetime `identity.emailVerifyTtlMinutes`,
default 24 h). Until the link is followed the address is neither a login
identifier nor a recovery channel. `POST /api/app/account/email/resend`
mails a fresh link (five an hour per account); `DELETE /api/app/account/email`
(recent authentication) removes the address and its links.

Uniqueness: an address that is **verified** on another account is refused
(`409 EMAIL_TAKEN`). An address another account has claimed but never
verified is **taken over** - an unproven claim reserves nothing, so nobody
can squat someone else's address by typing it first. This applies to both
Account settings and open sign-up; the displaced claim's verification links
are invalidated atomically, and concurrent verification preserves one owner.

`POST /api/app/auth/verify-email { token }` is public (the token is the
capability). For an existing account it consumes the token and marks the
address verified - **no session is minted**, because proving you can read
an inbox is not a login. If the account moved to a different address in
the meantime the old link is `404 VERIFY_INVALID`.

### Forgot password by email

`POST /api/app/auth/forgot { email }` answers `200 { ok: true }` whether or
not the address is known, verified, or belongs to an active account, so it
cannot be used to enumerate accounts; when it is the verified address of an
active account a reset token (`recovery_tokens`, `issuedBy` = the person
themselves) is mailed as `/app/recover?token=…`. Finishing the reset is the
same `POST /api/app/auth/recover` as the host's link: every other session
of the account is revoked. Throttles: five requests an hour per client
address, three mails an hour per recipient.

### Open sign-up

`identity.registration` is `invite` (default) or `open`. With `open`, the
login screen shows **Create an account** (`/app/register`) and `POST
/api/app/auth/signup { email, loginName, password, displayName? }` parks
the request in `pending_registrations`: the login name, display name,
address, and the **already-hashed** password, keyed by the address (one
pending row per address - signing up again replaces the earlier attempt)
and by a hashed token mailed as `/app/verify-email?token=…`. Nothing is an
account yet: no principal, no `app_accounts` row, no credential. A sign-up
that is never verified expires with its link and is pruned on the next
sign-up.

Following the link (`POST /api/app/auth/verify-email`) consumes the pending
row atomically - a race admits exactly one - and creates the principal, the
account (`entitlement = 'open'`, role `member`), the credential, and the
verified address in one transaction, then mints a session. If the login
name was taken while the mail was in flight the person is told to sign up
again (`409 LOGIN_NAME_TAKEN`).

Policy is applied before anything is parked (login-name shape, password
floor and deny list, address shape). A **taken login name** is refused
openly (`409 LOGIN_NAME_TAKEN` - login names are identifiers, not secrets).
A **taken address** is not revealed: the response is the same `200` and the
address's owner receives a note saying they already have an account, with a
link to the reset page. Throttles: five sign-ups an hour per client
address, three mails an hour per recipient.

`open` is only *effective* when mail and `publicUrl` are configured;
otherwise the effective mode stays `invite`, the log carries one warning,
and the Host room's **Sign-up & mail** panel shows the configured value,
the effective value, and the reason they differ.

### Outbound mail

`services/mailService.js` sends plain-text messages through one configured
provider. `config.json` `mail` block (environment overrides in brackets):

| Key | Default | Meaning |
|---|---|---|
| `provider` [`GOOBSTER_MAIL_PROVIDER`] | auto | `smtp` or `resend`. Empty = the first provider whose credentials are present (SMTP, then Resend). |
| `from` [`GOOBSTER_MAIL_FROM`] | - | Sender, e.g. `"Goobster <goobster@example.org>"`. **Required.** |
| `replyTo` [`GOOBSTER_MAIL_REPLY_TO`] | - | Optional Reply-To. |
| `smtp.url` [`GOOBSTER_SMTP_URL`] | - | `smtp://user:pass@host:587` or `smtps://…:465`; wins over the discrete fields. |
| `smtp.host` / `smtp.port` / `smtp.secure` / `smtp.user` / `smtp.pass` [`GOOBSTER_SMTP_HOST`, `GOOBSTER_SMTP_PORT`, `GOOBSTER_SMTP_SECURE`, `GOOBSTER_SMTP_USER`, `GOOBSTER_SMTP_PASS`] | port `587`, `secure` false | Discrete SMTP settings (STARTTLS on 587, implicit TLS with `secure` on 465). |
| `resend.apiKey` [`RESEND_API_KEY`] | - | Resend HTTP API key. |
| `timeoutMs` [`GOOBSTER_MAIL_TIMEOUT_MS`] | `15000` | Connection / request timeout. |

Every transactional mail provider (Postmark, Mailgun, SES, Gmail, Fastmail,
…) offers SMTP, so `smtp` covers all of them; `resend` is the HTTP route for
hosts whose network blocks outbound SMTP. Deliverability is the operator's
job: publish SPF and DKIM for the `from` domain or the messages land in
spam. Recipient addresses and message bodies are never logged; a failed send
logs the provider's status and message only. The Host room's **Send test**
mails one message to an address of the operator's choosing (three an hour).
Tests and embedding apps replace the transport with
`mailService.setTransport(async ({ to, subject, text }) => …)`.

### Operator surface

The **Host** room (sidebar, operators only; every route is behind
`requireOperator`, which reads the role from the actor context):

| Route | Purpose |
|---|---|
| `GET/POST /api/app/admin/invites`, `DELETE …/:id` | Invitations (list, issue, revoke). |
| `GET /api/app/admin/accounts` | Roster: principal, login name, role, status, entitlement, Discord linked, has password. |
| `POST /api/app/admin/accounts` `{ principalId, role? }` | Grant an existing (Discord) principal an account - the `migration` entitlement. |
| `PATCH /api/app/admin/accounts/:principalId` `{ status?, role? }` | Disable/enable, promote/demote. Refuses to disable or demote yourself (`409 SELF_LOCKOUT`). |
| `POST /api/app/admin/accounts/:principalId/recovery` | Audited reset link. |
| `GET /api/app/admin/installation` | Sign-up policy (configured and effective), mail status and the reason it is off, `publicUrl`, link lifetimes. |
| `POST /api/app/admin/mail/test` `{ to }` | One test message. |
| `GET /api/app/admin/identity/report` | The same numbers as `npm run identity:report`. |

The roster also shows each account's email address and whether it is
verified. `GET /api/app/config` tells the client whether native login is on
(`nativeLogin`), the effective `registration` mode, whether `emailRecovery`
is available, the installation's name, and the password floor; `GET
/api/app/me` adds `identity.operator`, `identity.nativeLogin`,
`identity.registration`, and `identity.mail`.

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
| `installationName` [`GOOBSTER_INSTALLATION_NAME`] | `Goobster` | Shown on the login screen and invitation page, and as "member of …" in the People picker. |
| `assistantName` [`GOOBSTER_ASSISTANT_NAME`] | `Goobster` | The assistant's own name where no Discord bot account supplies one (see [independent_runtime.md](independent_runtime.md)). |
| `nativeLogin` [`GOOBSTER_IDENTITY_NATIVE_LOGIN`] | `false` | Release gate for invitations, registration, login, recovery, and credential enrollment. |
| `passwordMinLength` [`GOOBSTER_IDENTITY_PASSWORD_MIN_LENGTH`] | `15` | Password floor (12-128). |
| `passwordCostLog2` [`GOOBSTER_IDENTITY_PASSWORD_COST`] | `15` | scrypt `log2(N)` (14-18); stored per hash, re-hashed on next login when raised. |
| `recentAuthMinutes` [`GOOBSTER_IDENTITY_RECENT_AUTH_MINUTES`] | `15` | How long a login or re-auth unlocks sensitive account changes. |
| `inviteTtlHours` [`GOOBSTER_IDENTITY_INVITE_TTL_HOURS`] | `72` | Default invitation lifetime. |
| `recoveryTtlMinutes` [`GOOBSTER_IDENTITY_RECOVERY_TTL_MINUTES`] | `60` | Reset-link lifetime (host-issued and emailed alike). |
| `registration` [`GOOBSTER_IDENTITY_REGISTRATION`] | `invite` | `invite` or `open`. Open sign-up is effective only with mail and `webapp.publicUrl` configured. |
| `emailVerifyTtlMinutes` [`GOOBSTER_IDENTITY_EMAIL_VERIFY_TTL_MINUTES`] | `1440` | Lifetime of a verification link and of an unverified open sign-up (5 min - 7 days). |

Outbound mail has its own `mail` block, described under [Outbound
mail](#outbound-mail).

## Privacy

Principals, linked identities, accounts, credentials, reset tokens, link
intents, invitations, and email addresses are per-user data. `/forget-me`
(`privacyService.forgetUser` → `identityService.erasePrincipal`) deletes the
principal, `auth_identities`, `app_accounts`, `password_credentials`,
`recovery_tokens` (issued for or by the person), `oauth_link_states`,
`account_emails`, `email_tokens`, any `pending_registrations` row parked
under the person's address, and the invitations the person **issued**;
invitations the person **redeemed** stay as the issuing operator's audit
row with `consumedBy` cleared. `privacyService.auditUser` counts every one
of those tables so a clean audit stays provable, and
`/what-do-you-know-about-me` reports the principal, the account
(role/status/entitlement/login name - never a hash), linked providers,
whether a password exists and when it last changed, open reset links,
invitations issued, when the person joined by invitation, and the email
address with its verification state and open verification links. A
forgotten person has to be invited (or sign up) again. Pending sign-ups
that are never verified hold only what the person typed, expire with their
link, and are pruned.

## People discovery (Increment C)

Members of an installation can find each other by name without Discord.
`identityService.searchPeople({ actorId, q })` matches the start of a
display name or login name among active accounts, never lists the roster
(a query is required), and returns `{ id, name }` only;
`identityService.describeMember(id)` resolves one principal id for an
invite confirmation. `friendService.listInvitable` merges these members
(source `member`) with Discord friends and shared-server mates when Discord
is connected, and the Observatory / Parlor People pickers show them with a
`member` badge. Invitations accept any principal id. The rest of
operation without Discord - the adapter switch, the assistant identity, the
Inbox, runtime modes - is in [independent_runtime.md](independent_runtime.md).

## Not yet here

Passkeys and an operator-selected OIDC provider remain later additions; a
hosted identity service (Supabase Auth, Auth0, …) would plug in as such a
provider, not as the account store. Profile detail and presence for native
members beyond name-and-id are separate permissions that do not exist yet.
