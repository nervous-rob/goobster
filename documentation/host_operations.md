---
title: Host operations - Features, Connections and Instance Defaults (installer P2.4)
kind: reference
summary: The operator pages in the portal's Host room - Features (turn features on and off, with dependency effects, prerequisites, the Gambling attestation on a shared instance, the Mail guard and "disabling keeps data"), Connections (provider keys and integrations as masked fingerprints with replace, remove and Test connection) and Instance Defaults (what new people inherit, with source badges), the preview then apply then restart flow through the manager, the restart countdown and per-worker outcome, revision conflicts, what to do when the manager is not running, and the audit rows written.
when: Turning a feature on or off from the portal, adding or replacing a provider key, setting what new people inherit, scheduling or cancelling a restart, understanding a revision conflict or a "manager is not running" card, or reading the operator audit rows an applied change leaves.
tags: [installer, host, operator, features, connections, defaults, manager, restart, attestation, gambling, mail, audit]
---

# Host operations

Issue #326, installer plan Phase 2 item 4. The Host room (`/host`, operators
only) has three pages next to the instance panel: **Features**,
**Connections** and **Instance Defaults**. They render from the feature
catalog (`documentation/features.md`) and the manager's field catalog
(`documentation/manager_configuration.md`), show the exact change before it
happens, and apply it **through the manager**. The portal adds no second write
path: `packages/core/web/routes/host.js` is a proxy that calls the manager's
operations API (`documentation/manager.md`) with a short-lived assertion from
the portal bridge. The browser never holds a manager credential, and a secret
you type travels once, in the request body of the preview, over your session.

The address the portal uses for the manager is `manager.baseUrl` in
`config.json` or `GOOBSTER_MANAGER_URL` (default `http://127.0.0.1:3400`). It
must be `http` on this machine or `https`, with no credentials, path or query;
anything else is refused and the Host room says so.

Only operators (`identity.operators`, or the Discord owner) reach any of this.
A member gets `403` and nothing renders; the response does not reveal that a
manager exists.

## The flow every change follows

1. **Preview.** You change a toggle or a field and press Preview. The portal
   asks the manager to plan and validate the change and shows the plan: the
   features or fields that change, dependency effects, warnings, and whether a
   restart is required. Nothing is applied. A refused change (a dependency, a
   missing payload, a stale revision) is shown with the manager's reason.
2. **Apply.** Apply runs exactly the previewed operation. The result says what
   is pending and offers the restart.
3. **Restart.** Changes to features and to settings that are read at start take
   effect when the workers restart. Tick **Schedule the restart (60 second
   countdown)** to schedule it as part of applying (default on when the
   manager is supervising), or schedule it later from the lifecycle panel.
   Until then the change is **pending**: the page shows what the running
   process does now next to what it will do after the restart.

A change you apply from a stale tab never overwrites a newer one: each preview
carries the revision of `features.json` or `config.json` it was planned
against, and apply refuses with `REVISION_CONFLICT` if it moved. The page then
reloads the current state and says "Someone changed this; review again".

## Features

One row per feature in the catalog, with:

- **Status chips**: installed (this payload carries the feature), configured
  (its required keys and system dependencies are present), active (running
  now) and pending (what the running process will do after the next restart,
  with the countdown when one is scheduled), plus a reason sentence when a
  feature is requested but not active (a missing key by name, a missing
  system dependency, a dependency that is off).
- **Dependency effects, up front.** Turning Economy off also turns off the
  features that require it (Exchange and Gambling). The manager never changes a
  feature you did not name, so the page names those dependents in the same
  change, lists them before you preview, and the plan shows each one. It never
  turns a dependency on for you: turning a feature on whose dependency is off
  is stopped up front, and if it were sent the manager refuses it
  (`DEPENDENCY_CONFLICT`); the page names the dependency to turn on first.
- **Prerequisites by name**: the API keys and settings a feature needs, as
  names (never values), linking to Connections, and the system dependencies it
  needs.
- **Not installed.** When this installation's payload does not include a
  feature, the row says so and explains how to add it (see
  `documentation/packaging.md`); the toggle is disabled (`FEATURE_NOT_INSTALLED`).
- **Disabling keeps data.** Every row says it: turning a feature off keeps its
  data in place and it comes back unchanged when turned on again. Removing data
  is a separate maintenance operation, not a toggle.

Per-person hidden rooms (`appearance.hiddenToolRooms`, Settings) are a
personal preference. They are not shown or changed on this page; a host switch
here decides whether a feature exists for the instance at all.

### Host switches (#261)

Economy and exchange, Gambling, Tavern, Music Lab and GBA are host switches
decided by the operator for everyone. The rows carry what each covers and how
an existing install is seeded: Economy and exchange and Gambling start on
where their tables already have rows, Tavern, Music Lab and GBA start on. A new
install follows the catalog's fresh-install default.

### Gambling on a shared instance

Enabling Gambling on a shared instance needs an attestation: a checkbox reading
"I confirm this instance is private, or that gambling is permitted for its
members." Without it the preview is refused with `409 ATTESTATION_REQUIRED`.
With it the plan carries `attestation: { by, at, text }` and the audit row
records `attested: true` (never the text). An apply that no attested preview
preceded (for example, the portal restarted in between) is refused again on a
shared instance; preview again.

An instance is **shared** when either holds:

- more than one distinct portal account has an unexpired session
  (an account that is suspended or removed does not count), or
- the instance serves more than one Discord guild: the guilds in
  `config.json` `guildIds` together with the guilds the acting operator shares
  with the bot.

A single person's private instance is therefore not interrupted; the rule
becomes active as soon as a second person signs in or a second guild is added.
The Features page shows whether the instance is currently treated as shared
and why.

### The Mail guard

Open registration verifies email addresses by mail, so turning Mail off while
`identity.nativeLogin` is on and `identity.registration` is `open` is refused
in the preview with `409 MAIL_REQUIRED_FOR_REGISTRATION`; the message names
`identity.registration` as the setting to change to `invite` first. When
verified addresses exist, turning Mail off is allowed with a warning that those
people lose email sign-in and self-service recovery (the operator reset link
keeps working).

## Connections

The operator's provider keys and integrations (OpenAI, Anthropic, Gemini,
Perplexity, ElevenLabs, GitHub, Cursor, Ollama, Mail), from the catalog's
secret fields. This is different from **Settings, Connections**, which holds a
person's own accounts and is untouched.

Each field shows:

- **State**: a fingerprint when set (the manager's fingerprint, never the
  value), or "not set", with its source badge (`env`, `config`, `unset`).
- **Environment-controlled fields are read-only.** When an environment
  variable supplies the value, the field says which variable and cannot be
  edited here; change the environment and restart.
- **Replace** (type a new value; it is cleared from the page as soon as the
  preview succeeds) and **Remove** (`config.set` with `null`).
- **Test connection**: the manager's explicit provider probe (a real call to the
  provider; see `documentation/manager_configuration.md`). It is a check, not
  a save, is never journaled, and tests the typed value, or the saved one when
  the field is empty.
- The field's help hint from the catalog.

Changing a key is previewed and applied like any other change; whether it needs
a restart is part of the plan.

## Instance Defaults

What new people inherit when they have not chosen for themselves: chat
provider and model, theme and start page, chat-history retention and the usage
alert threshold (`defaults.set`). Each field carries a source badge: `env`,
`config`, `db` or `default`.

Defaults are fallbacks, not rules. They never block, cap or overwrite a
person's own choice. **Limits** (the host token cap and its window and
retention) and the registration mode are enforced policy, shown read-only here
and changed where they always were (the Host room's instance panel and
`config.set` respectively); see "Instance defaults versus enforced policy" in
`documentation/manager_configuration.md`. This page changes no user preference
default of anyone's.

## The restart countdown

The lifecycle panel in the Host room reads `GET /lifecycle` from the manager:

- the countdown (`secondsLeft` from the manager, re-synced on every poll rather
  than counted on the page alone), with **Restart now** and **Cancel** (cancel
  only before the workers were told to stop taking new work);
- each worker's state, revision and `ackedRevision`, with crash-loop and
  conflict codes, and **Restart workers** (restart at the current revision and
  clear a crash loop);
- the last outcome (`applied`, `rolled_back` with its code, or `failed`) and
  recent events.

While workers restart, the panel polls with backoff and shows "reconnecting";
when the portal itself is one of the workers (the lite layout), it resumes by
itself when the portal answers again. No page reload is needed. The countdown
and result are announced to assistive technology (`aria-live`).

## Manager unavailable

The Host pages need the manager. When it cannot be used, the page shows a card
(`GET /api/app/admin/host/manager` answers `200`, never `500`) with one of these
conditions and its remedy:

| Code | Meaning | Remedy |
| --- | --- | --- |
| `MANAGER_UNREACHABLE` | Nothing answered at the configured address. | Start the manager (`documentation/manager.md`, "Running it") or correct `manager.baseUrl`. |
| `MANAGER_URL_REFUSED` | The address is not `http` on this machine or `https`, or carries credentials or a path. | Set `manager.baseUrl` or `GOOBSTER_MANAGER_URL` to the manager's origin. |
| `MANAGER_NOT_CLAIMED` | The manager is running but unclaimed. | Claim it with the bootstrap credential (`documentation/manager.md`, "First-time setup"). |
| `MANAGER_RECOVERY` | The manager is in recovery and accepts local recovery only. | Finish local recovery (`documentation/manager.md`, "Local recovery"). |
| `MANAGER_BRIDGE_UNAVAILABLE` / `MANAGER_BRIDGE_REFUSED` | The portal has no key for the manager, or the manager refused it (the key changed, for example after an adoption). | Restart the portal so it reads the manager's current bridge key. |

The features list still renders from what this process sees while the manager
is down, read-only; every control that needs the manager is disabled.

## Audit rows

Every applying request writes one `operator_audit` row after the manager
answered success. The manager writes its own `manager.*` row for the same
operation, so an applied change appears twice, once as the portal's request
and once as the manager's work, with the **operation id as `target`** in both.

| Action | When |
| --- | --- |
| `host.features.apply` | A `features.set` operation was applied. `detail` names the features and their new state, the resulting revision, and `attested: true` for Gambling on a shared instance. |
| `host.config.apply` | A `config.set` operation was applied. `detail` names field ids and actions (`set`, `remove`), whether each is a secret, and which need a restart. Never a value. |
| `host.defaults.apply` | A `defaults.set` operation was applied. Field ids and actions only. |
| `host.lifecycle.apply` | A restart was scheduled. `changeRef`, grace seconds and the target revision. |
| `host.lifecycle.restart_now` | The countdown was skipped. |
| `host.lifecycle.cancel` | A scheduled restart was cancelled. |
| `host.lifecycle.restart` | The workers were restarted. |

No row carries a secret, a prompt, a path or the attestation text. Previews
and probes write no row.

## API (portal)

All routes are under `/api/app/admin/host` (the admin prefix the feature inventory already claims for core), behind sign-in and the operator check.

| Route | Purpose |
| --- | --- |
| `GET /manager` | Manager status; unavailability is a status, not an error. |
| `GET /features` | Catalog merged with this process's state and the manager's pending state and revision, the shared-instance verdict and the host-switch text. |
| `GET /config` | The manager's effective configuration report; secrets are fingerprints only. |
| `POST /config/probe` | The explicit provider check. |
| `POST /operations` `{ kind, input }` | Plan and validate `features.set`, `config.set`, `defaults.set` or `lifecycle.apply`; returns the plan without applying. |
| `POST /operations/:id/apply` | Apply the previewed operation. |
| `GET /install/suggest`, `/install/record`, `/install/source?dir=`, `GET /operations/:id` | Read-only feeds for the Installation page and for polling an operation after a reload. |
| `GET /lifecycle` | The restart panel's model. |
| `POST /lifecycle/restart-now`, `/cancel`, `/restart` | The three buttons. |

A manager `4xx` is passed through with its own `code` (`REVISION_CONFLICT`,
`DEPENDENCY_CONFLICT`, `FEATURE_NOT_INSTALLED`, `RESTART_PENDING`,
`NOTHING_PENDING`, `ALREADY_COMMITTED`, and so on). A manager `5xx` or a
refused assertion becomes `502` with `MANAGER_ERROR` or `MANAGER_BRIDGE_REFUSED`.
An unreachable manager is `503 MANAGER_UNAVAILABLE`.

## Installation: reconfigure, repair, uninstall (#330)

The **Installation** page (`/host/installation`, and a card on the Overview)
offers **Reconfigure…**, **Repair…** and **Uninstall…** for an operator. They
are the setup wizard's maintenance journeys (`documentation/setup_wizard.md`)
over the same Host routes: `POST /operations` accepts `install.new`,
`install.reconfigure`, `install.repair` and `install.uninstall` and returns
the manager's plan with its preflight findings (a refusal carries the plan it
was refused with), and applying one writes the audit row
`host.install.apply` with the operation, layout, feature ids and whether data
was kept. The browser holds no manager credential. Uninstall cannot finish
from here while the portal runs, because the portal is one of the programs it
removes; the page says so and points at the manager's own page.

## Database (#338)

The **Database** page (`/host/database`, and a card on the Overview) shows
which engine the installation uses and the connection in effect without its
password, and offers **Connect to a PostgreSQL server…** and **Update the
schema…** over the same journey the manager's own page runs
(`documentation/database_connection.md`). The Host routes:

- `GET /api/app/admin/host/database/status`: the manager's status (no URL, no
  password, no path).
- `POST /api/app/admin/host/database/test`: `{ connection }`, the read-only
  probe. The password is in this request only; it is forwarded to the manager
  and never kept. The manager's route allows 12 tests a minute.
- `POST /operations` also accepts `database.provision`,
  `database.schema.apply` and `database.connect`; applying one writes the
  audit row `host.database.apply` with counts and names (the action ids, the
  database and schema), never a connection, a password or an elevated
  credential.

## Seams

- Reset and restore controls, tour authoring and per-account provider keys are
  out of scope here.
- The Phase 3 payload tools add or remove features through the same manager
  (`payload.*`); the Features page shows an uninstalled feature but does not
  install it.
