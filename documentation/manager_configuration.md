---
title: Manager configuration (installer P2.2)
kind: reference
summary: How the manager describes, shows and changes installation settings - the field catalog, the effective report (source, env-controlled, masked secrets), config.set and defaults.set (allow-lists, masks, env and database control, revisions, dependency checks, restart-required), the explicit provider connection checks and what each one sends where, and the difference between instance defaults (fallbacks) and enforced policy (limits).
when: Changing config.json or an API key through the manager, understanding why a setting shows a given source, testing a provider key before saving it, setting what new people inherit, or adding a setting to the catalog.
tags: [installer, manager, configuration, secrets, providers, probes, defaults, limits, config.json]
---

# Manager configuration

Issue #324, installer plan Phase 2 item 2. The manager (`documentation/manager.md`)
answers without the application database, so it is also where an operator
fixes a broken or half-configured installation: which settings are in effect,
where each one comes from, a new key, and whether the key works. Everything
here goes through the manager's operation engine (plan, validate, apply,
one audit record), and no secret value appears in a plan, the journal, an
audit record, a log line or a response.

The complete list of settings, with environment names, defaults and whether a
change needs a restart, is the generated `documentation/config_reference.md`.
The general setup guide is `documentation/configuration.md`.

## The field catalog

`packages/core/config/fieldCatalog.js` describes every installation setting
once: its id (the dotted `config.json` path), type, environment variable
names, legacy `config.json` paths still read at run time, default, validation
rules, whether it is a secret, the feature that needs it, whether a change is
**hot** (read per request) or **restart** (read when a process starts), a help
link and a one-line description. The effective report, `config.set`, the
probes and the generated reference all read it, so there is no second list to
keep in step. Tests pin it to the runtime: every environment variable the
`config/*` modules read must be catalogued, every catalogued default must
equal what the runtime module resolves with nothing set, and every key
`config.example.json` documents must be a catalogued setting.

The catalog covers installation settings only. Per-account keys are #269 and
are out of scope; the feature switches (`GOOBSTER_FEATURE_<ID>`) belong to
`documentation/feature_state.md`.

## The effective report

`GET /manager/api/config` (assertion or session, claimed installation) returns
every setting grouped by section, each with:

| Field | Meaning |
| --- | --- |
| `source` | `env`, `config` (config.json), `db`, `default`, `unset`, or `unknown-db` |
| `envControlled` | the environment sets it, so a config.json value has no effect |
| `controlledBy` | `env` or `db` when something outranks config.json |
| `present` | for a secret: whether a usable value exists (a `YOUR_...` placeholder counts as unset) |
| `masked`, `fingerprint` | a secret has no `value`; `fingerprint` is its last four characters, and only when it is at least 12 characters long |
| `value` | every non-secret setting's effective value |
| `apply`, `feature`, `featureActive`, `help`, `description`, `default`, `options`, `min`, `max`, `editable` | what the UI needs to edit it |

The top level also carries `revision` (the content revision of `config.json`,
the first 16 hex characters of its SHA-256, `null` when the file does not
exist), `file` (`present`, `readable`), `appDatabase` (`reachable`, `engine`,
`reason`), `defaults.revision` and the `probes` table.

Precedence follows the runtime modules, not a wish: environment variable,
then `config.json`, then the default. The two exceptions are the fields kept in
the database (the host `limits.*` and the instance `defaults.*`), where the
database value wins, exactly as `usageBudgetService.policy()` does.

The database-backed fields are read only when the manager's own probe says the
application database is reachable. Otherwise the report says
`appDatabase.reachable: false` and those fields report `source: "unknown-db"`:
the manager never guesses, never creates a database to look, and never blocks
on one. The environment it resolves against is the manager's own, plus a
`.env` file next to `config.json` (process environment wins, as with dotenv).
If the bot is started with a different environment than the manager, the report
shows the manager's view.

A field's `envControlled: true` is the answer to "why did my change do
nothing": a value saved to `config.json` is shadowed by the variable.

## `config.set`

Plan, validate and apply through `POST /manager/api/operations`
(`{ "kind": "config.set", "input": { ... } }`) like `features.set`.

```json
{
  "expectedRevision": "3f9a0c2b17d4e5a6",
  "changes": [
    { "id": "ai.provider", "action": "set", "value": "anthropic" },
    { "id": "ai.openai.apiKey", "action": "set", "value": "sk-..." },
    { "id": "github.token", "action": "remove" }
  ],
  "force": false
}
```

The input is an allow-list: only `changes`, `expectedRevision` and `force`,
and per change only `id`, `action` (`set` or `remove`) and `value`. No kind
takes a path, a command or a field the catalog does not describe.

- **Revisions.** `expectedRevision` is required: the `revision` the report
  returned, or `null` when `config.json` does not exist yet. A different file
  is `409 REVISION_CONFLICT` at plan, again at validate, again inside the
  mutation lock before the write, and once more inside `configFile.write()`
  (the content hash is compared under its own lock file). Nothing is merged
  behind the operator's back: reload and plan again.
- **Secrets travel only in private input.** The plan and the journal carry
  `{ "id": "ai.openai.apiKey", "action": "set", "secret": true }`. The value is
  held in memory for that operation only, so a manager restart between plan and
  apply is `409 PLAN_INPUT_LOST`: plan again. A secret needs a value; clearing
  one is `remove`.
- **A mask is never a value.** `••••`, `••••abcd` (the fingerprint
  presentation), `[redacted]`, `sk-…[redacted]` and any value containing a mask
  glyph are refused with `400 MASK_IS_NOT_A_VALUE`, because saving what the
  report displayed would overwrite a key with its own mask.
- **Environment control.** Setting a field the environment controls is
  `409 ENV_CONTROLLED` (the details name the variable, never its value) unless
  `force: true`; the plan then marks the change `ineffective` with
  `controlledBy: "env"`, and the result lists it under `ineffective` and not
  under `restartRequired`. A host limit that is set in the database
  (`limits.*`) is `409 DB_CONTROLLED` in the same way. Removing a setting from
  `config.json` is always allowed.
- **Validation.** Each value is checked by the catalog (enum, range, pattern,
  custom validators such as Discord token shape or an `smtp(s)://` URL), and the
  resulting document is validated as a whole by `configFile.validate()` before
  anything is written (`400 INVALID_VALUE`, `409 INVALID_CONFIG`). Error bodies
  name the setting and the rule, never the value.
- **The write.** `packages/core/config/configFile.js`: validate first, write a
  temporary file with mode `0600` in the same directory, `fsync`, rename over
  `config.json`, `fsync` the directory. A failure at any point leaves the
  previous file exactly as it was. Keys the catalog does not know are preserved,
  and the file is written with four-space indentation and a trailing newline.
  Removing a setting also removes its legacy `config.json` paths and prunes
  parent objects that become empty. On Windows the mode bits do not restrict
  access; the file inherits the directory's ACL, so keep the installation
  directory private (the manager does not set ACLs).
- **Result.** `apply` returns `{ revision, restartRequired: [ids], ineffective: [ids] }`.
  `restartRequired` lists the changed settings whose `apply` is `restart`. The
  manager does not restart anything; the supervisor does (#325).

### Dependency validation

Validate recomputes the effective settings before and after the change and
checks what depends on what. Conflicts are in the plan under
`dependencies.conflicts` and refuse at validate (`409 DEPENDENCY_CONFLICT`);
warnings are in `dependencies.warnings` and do not refuse.

| Check | Outcome |
| --- | --- |
| The change turns outbound mail from usable to unusable while `identity.nativeLogin` is on and `identity.registration` is `open` | conflict `MAIL_REQUIRED_FOR_OPEN_REGISTRATION`. Open sign-up verifies addresses by mail, so mail cannot go away underneath it. Switch registration to `invite`, or do both in one request. |
| The same change, and accounts have verified email addresses | warning `VERIFIED_ADDRESSES_EXIST` with the count (they lose email sign-in and self-service recovery); `VERIFIED_ADDRESSES_UNKNOWN` when the database cannot be counted |
| A removed credential belongs to an active non-core feature and nothing else (environment, another config.json key) still provides it | warning `WOULD_UNCONFIGURE` with `wouldUnconfigure: [feature]` |
| A host limit may override the field and the database is unreachable | warning `DB_STATE_UNKNOWN` |

Mail counts as usable when a provider is resolved (explicit `mail.provider`, or
SMTP when a URL or host exists, otherwise Resend when a key exists), a sender
(`mail.from`) is set, and that provider's credentials are present - the same
rule `mailConfig` applies.

## Provider connection checks

`POST /manager/api/config/probe` with `{ "target": "openai", "useSaved": true }`
or `{ "target": "openai", "credential": "sk-..." }` (exactly one). It needs a
session or assertion; a session also needs a fresh nonce. It runs one bounded
(8 s default, 30 s cap) authentication check and answers
`{ target, ok, code, latencyMs, detail, whatItDoes, usedSaved }` with `code`
one of `OK`, `AUTH_FAILED`, `UNREACHABLE`, `TIMEOUT`, `RATE_LIMITED`, `UNKNOWN`.

Nothing here runs by itself: not on status, not on the report, not on a page
load. The request body is never journaled, audited or logged; the credential
you type to try before saving is used for that one request and not stored. The
`detail` is a fixed sentence per outcome and never repeats anything the
provider said. At most 20 checks a minute.

Where a credential goes, and what each check does:

| Target | What it does | Credential goes to |
| --- | --- | --- |
| `openai` | `GET /v1/models` | `api.openai.com` |
| `anthropic` | `GET /v1/models?limit=1` | `api.anthropic.com` |
| `gemini` | `GET /v1beta/models?pageSize=1` (key in the `x-goog-api-key` header, never the URL) | `generativelanguage.googleapis.com` |
| `perplexity` | `GET /async/chat/completions`, a list of your own queued requests; Perplexity has no model-list endpoint, so this authenticated read is the closest unbilled call (verify it against your account) | `api.perplexity.ai` |
| `elevenlabs` | `GET /v1/user` | `api.elevenlabs.io` |
| `github` | `GET /user` | `api.github.com` |
| `cursor` | `GET /v1/models` | `api.cursor.com` |
| `ollama` | `GET /api/tags` at the configured `ollama.host` | nowhere: no credential exists or is sent |
| `mail` | SMTP: connect to the configured host, `EHLO`, `QUIT`. No login, no message, so SMTP credentials are not tested. Resend: `GET /domains` | SMTP: nowhere. Resend: `api.resend.com` |

The three cloud chat providers share one request shape and one outcome table
(cloud-provider parity); a new capability is added to all three. Credentials
go only to the canonical hosts above, requests use `redirect: manual` so a
redirect is reported (`UNREACHABLE`) and never followed with the key, a body is
never sent, and a credential that is not 8 to 4096 printable ASCII characters is
refused before anything is sent. The hosts you control (the Ollama host, the
SMTP host) are read from the saved configuration only, never from the request,
and receive no credential. 429, and GitHub's exhausted rate limit, are
`RATE_LIMITED` (the key was not rejected); 401 and 403 are `AUTH_FAILED`; 502,
503 and 504 are `UNREACHABLE`.

## Instance defaults versus enforced policy

Two different things are kept in the database, and they are changed in
different places.

An **instance default** is a fallback a person inherits for a preference they
have not set themselves. It never blocks, caps or overwrites anything. There
are six, changed with `defaults.set`:

| Default | Applies to |
| --- | --- |
| `defaults.chat.provider`, `defaults.chat.model` | a person with no chat provider or model of their own (the provider only if it is configured on this host; the model only when it belongs to the provider that wins) |
| `defaults.appearance.theme`, `defaults.appearance.startPage` | the portal theme and start page |
| `defaults.memory.chatHistoryRetentionDays` | the Study chat-history window |
| `defaults.budget.usageAlertTokens` | the personal usage-alert threshold, a notice only |

A **policy** is enforced whatever a person prefers: the host token cap
(`limits.dailyTokens`, `limits.windowHours`, `limits.retentionDays`, kept in
`instance_state` under `limits` and changed in the portal's Host room; a
`config.json` value of the same name is only a fallback the database
outranks), the registration
mode, the account gate. `defaults.set` cannot name a limit, and no default
changes what `usageBudgetService` enforces. Registration is a policy:
it is changed with `config.set` and the mail dependency rule above, not as a
default.

How a default applies, precisely:

- "Not set" means the key is absent from the person's stored preferences.
  `userSettingsService` now stores only the keys a person actually saved
  (before, it stored every key, which made a default impossible to tell from a
  choice). Rows written before this change hold every key and therefore count as
  explicit: people who have already saved a setting keep what they have; people
  who never did, and new accounts, inherit.
- Choosing the factory value is still a choice: a person who picks `dark`
  explicitly keeps `dark` when the instance default becomes `light`. Resetting a
  section writes the factory values explicitly, so it detaches that person from
  the instance default; clearing a stored value is not a feature today.
- The settings view reports `instance-default` as the source of an inherited
  value, and `user-preference` / `user-override` for a person's own.
- `defaults.chat.provider` and `.model` are applied by `getSettings` (the
  settings view) and by `guildSettings.getEffectiveAI()`, which the chat turn
  (`chatHandler`) and the web `effective` view (`webChatService.getAiSettings`)
  use: a scope with no choice of its own answers with the default provider and
  model, while `getGuildAI()` keeps returning the raw override so a settings
  screen can tell "chosen" from "inherited". The defaults document is read
  through a 15-second cache (`getCached()`), so a change made in the manager
  reaches the next chat turn within that window without a read per message.
- A retention default is **destructive**: everyone without their own window has
  Study conversations older than the window purged at their next retention
  sweep. `defaults.set` therefore refuses a retention default without
  `acknowledgeRetention: true` (`400 ACKNOWLEDGEMENT_REQUIRED`), and the plan
  carries `RETENTION_DEFAULT_PURGES` either way.

### `defaults.set`

```json
{ "changes": [ { "id": "defaults.appearance.theme", "action": "set", "value": "light" } ],
  "expectedRevision": 123456789, "acknowledgeRetention": false }
```

It is available only in the claimed state with a reachable application
database; otherwise `409 APP_DB_UNAVAILABLE` and nothing is queued. Input is an
allow-list (`changes`, `expectedRevision`, `acknowledgeRetention`);
`expectedRevision` is the report's `defaults.revision` and a stale one is
`409 REVISION_CONFLICT` (checked again at validate and apply). It takes effect
immediately (hot). Warnings: a default provider with no credential
(`DEFAULT_PROVIDER_NOT_CONFIGURED`, the default is ignored until one exists),
a default model with no default provider (`DEFAULT_MODEL_WITHOUT_PROVIDER`).
The manager opens the application database for these calls only and closes it
again.

## API summary

| Route / kind | Auth | Notes |
| --- | --- | --- |
| `GET /manager/api/config` | assertion or session | effective report; reads database fields only when reachable |
| `POST /manager/api/config/probe` | assertion or session, nonce for a session | body never journaled |
| `config.set` | operations API | `manager.config.set` audit record |
| `defaults.set` | operations API | `manager.defaults.set` audit record |

Both audit actions are written to the manager's pending audit log and
reconciled into `operator_audit` (`target` is the operation id) like the other
manager actions.

## Seams

- **#325 (supervisor):** `config.set` returns `restartRequired`; the restart is
  the supervisor's. Nothing here promotes, restarts or verifies a process.
- **#326 (operator pages):** the configuration page renders the report and calls
  the two kinds and the probe through the portal's manager bridge; it needs no
  new core API.
- **B1 modules:** the `config/*` modules still read `config.json` through
  `require('../../../config.json')` at load time. They keep working, because
  `configFile.write()` produces the same file, but they would adopt
  `configFile.read()` (and its revision) to see an edit without a restart.
- **#269 (per-account keys):** out of scope; every field here is an
  installation setting.

## Tests

`tests/configFieldCatalog.test.js`, `tests/effectiveConfig.test.js`,
`tests/configFile.test.js`, `tests/providerProbes.test.js` (fake `fetch` and a
loopback SMTP server, no network), `tests/instanceDefaults.test.js` and
`tests/managerConfig.test.js` (real HTTP against a claimed manager, planted
secrets, revision conflicts, dependency rules, reconciliation). They run in the
`core` CI group on SQLite and on Postgres.
