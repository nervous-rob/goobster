# ADR 0011: Model compatibility is deployment policy

Date: 2026-09-22
Status: Implemented; extended with live provider-default models (2026-10-09), best guesses for unreviewed models and the full Claude effort range (2026-10-10)

## Problem

The provider model lists and Goobster's request builders used separate name
heuristics. GPT-6 appeared in the OpenAI picker, but the adapter recognized only
GPT-5 and o-series reasoning models. It sent sampling parameters that the API
rejected. The same mismatch omitted reasoning effort and thinking-token headroom.

There were further inconsistencies: reasoning controls were provider-wide,
Parlor and research accepted arbitrary model strings, a listing failure looked
like a successful empty list, and a missing provider key could silently send a
provider-specific model ID to the global fallback provider.

## Decision

Keep three separate facts:

1. **Compatibility:** the versioned registry describes the exact model IDs and
   configurations that have received a model-specific review. New chat IDs use
   a minimal provider-default contract when no reviewed entry exists.
2. **Availability:** live discovery reports which IDs the host's provider account
   currently lists. A listing is evidence, not a guarantee of inference access,
   quota, regional availability, or continuing service.
3. **Selection:** a user's saved provider/model/effort choice remains their choice.
   Discovery never rewrites it or substitutes another model.

The registry is in `packages/core/models/catalog.js`. The deterministic resolver
is in `registry.js`; provider discovery and its transient cache are in
`discovery.js`. Provider adapters serialize the resolver's output into their API
formats. Frontend controls consume public descriptors from the same registry.

The picker merges the reviewed registry with live provider chat IDs. A new ID
uses a separate `discovered` descriptor. Originally that meant no explicit
reasoning or sampling parameters, no native search or image-input claims, and
unknown limits; since 2026-10-10 a recognizable name borrows its reviewed
sibling's controls as a labelled best guess, refined by what the listing and
the provider's documentation say (see *Best guesses for unreviewed models*). Standard tool serialization and
streaming use the provider adapter; the provider remains the final authority on
request compatibility and access. Reviewed entries and explicit custom entries
always take precedence. Specialized image, audio, embedding and other non-chat
IDs are excluded. Exact reviewed aliases are declared individually.

The fallback resolver can rebuild a provider-default descriptor from a saved
chat ID after a restart or in another worker. This does not assert availability;
the picker still bases availability on live discovery. Unknown non-chat IDs
continue to fail locally.

## Registry contract

Each descriptor has a provider, exact ID, canonical ID, display name, description,
status, aliases, workflows, input/output modalities, adapter endpoint, capability
flags, reasoning rules, sampling rules, token limits, documentation sources, and
review date. Registry version 1 is exposed by the API.

Profiles reuse serialization behavior; model entries can narrow it. The fields
represent the **Goobster adapter contract**. For example, Haiku's underlying
extended-thinking capability is not exposed as an effort control by this adapter.
The `claude-adaptive` profile exposes all five Claude effort levels (low, medium,
high, xhigh, max), reviewed on 2026-10-10 against Anthropic's effort
documentation, which lists `max` and `xhigh` for every model the catalog
registers on that profile (Sonnet 5, Fable 5, Fable 5.1, Opus 5.5). Each entry
keeps its documented default: high, except medium on Opus 5.5. A future entry
for a model that supports `max` but not `xhigh` (Opus 4.6, Sonnet 4.6) must
narrow the profile per entry rather than widen a shared list. Haiku 4.5 stays on
`claude-standard` with no effort control.
Unknown token limits and pricing are null; they are never represented as zero,
unlimited, free, or an invented estimate.

Thoughtful Mode stays pinned at `high` on every provider, including Claude. The
preset is a chat latency tier, not a maximum-quality tier: `xhigh` and `max`
add 49k and 65k tokens of output allowance per reply and, on Fable, can turn a
single chat turn into a multi-minute wait. A person who wants more can pick
Xhigh or Max explicitly in Settings → Chat & models or `/aisettings`; the
Thoughtful toggle and its detection (`model === thoughtfulModel && effort ===
'high'`) are unchanged.

Reasoning contains allowed levels, the effective default for budget accounting,
and explicit translations of legacy values (such as minimal to low). Sampling is
conditional: always, never, or only when effective reasoning is none. Claude's
standard profile uses one sampling parameter at a time. Native search can also
exclude particular effort levels, such as GPT-5 minimal.

The output allowance is Goobster policy, not a promise of actual reasoning use:
minimal=1024, low=4096, medium=8192, high=24576, xhigh=49152, max=65536. The visible
budget plus allowance is bounded by the reviewed maximum output limit when known.
The allowance is not an API capability and unused room is not billed. Gemini 2.5
receives room for default thinking even though this adapter does not expose its
thinkingBudget control. Context windows are informational in this first version;
this change does not claim exact input-token counting or automatic truncation.

## Selection and request validation

- Model options use a reviewed/custom entry or a minimal provider-default chat
  descriptor for the selected workflow.
- New settings are validated against the effective provider and model after
  merging partial updates. A provider change clears the previous model and
  effort unless replacements were explicitly supplied. A model change clears
  inherited effort unless an effort was explicitly supplied.
- Chat, Parlor, research, Discord AI settings, and the guild panel use the same
  selection validator. Thoughtful presets must refer to registered models with
  a high-effort control.
- Provider adapters validate each request, including calls from existing jobs
  and callers that bypass settings. Unknown IDs and unsupported image/search
  requests fail before provider inference. Supported sampling controls are
  bounded; inapplicable saved sampling fields are omitted.
- Existing saved effort on a model with no effort control is omitted at runtime.
  New explicit effort settings for that model are rejected. Known legacy effort
  aliases are translated. Other invalid effort values produce a local error.
- Missing provider credentials do not cause a cross-provider fallback. The
  selected provider fails clearly without sending the prompt to another service.
- Unrelated settings edits do not revalidate or overwrite a legacy model. Reset
  remains possible, including when the host default itself needs repair.
- Discovery is not called on every turn or settings save. A temporary provider
  listing failure must not make the bot unusable. The provider remains the final
  authority on request access.

Model selection is checked before section writes in the personal settings
transaction. No database schema migration is required. Existing research job
snapshots keep their model IDs and pass through request-time validation when run.
This PR does not rewrite shared personas, historical records, or job snapshots.

## Discovery and API behavior

`GET /api/app/chat/model-catalog?provider=openai&workflow=chat` is authenticated and
returns `{version, provider, workflow, models, discovery, unregisteredCount}`.
`models` contains reviewed/custom descriptors and discovered chat descriptors
with `availability` and `selectable`. `unregisteredCount` counts excluded IDs.
The existing `/api/app/chat/models` endpoint remains an ID-only compatibility view.

| Discovery result | Availability and picker behavior |
| --- | --- |
| Successful complete listing | Reviewed and newly discovered chat models are listed/selectable. Other registry entries are not-listed. |
| Successful empty listing | No models claimed available. This is distinct from an error. |
| Failure without a snapshot | Availability unknown. Registered models can still be selected. |
| Failure with a snapshot | Keep the snapshot and its last successful timestamp; mark availability unknown/stale. |
| Provider not configured | Registry descriptions remain available, but model options are disabled. |

Listings are cached in memory for ten minutes, concurrent refreshes are coalesced,
and failures have a thirty-second retry delay. The picker refreshes while open
every ten minutes and offers **Refresh models**. `refresh=true` bypasses the normal
TTL with a thirty-second provider cooldown; it never rewrites a saved choice. Anthropic and Gemini pagination
must finish before the result is accepted. An eight-second deadline covers the
whole listing. Malformed, cyclic, or excessively long pagination is a failed
refresh, never a partial authoritative list. Raw provider errors and credentials
are not exposed in catalog responses. Gemini discovery uses the API-key header.

Declared aliases share availability evidence. This is appropriate only for aliases
explicitly reviewed as the same supported model; it is not inferred from dates.

## UI

Chat, Parlor, and research use the shared model picker. It shows only selectable
options plus the existing saved choice, even if that choice is missing or
unsupported. A provider change cannot briefly display options from the previous
provider while a request is pending. Failure notices preserve the saved selection.

Reasoning options come from the selected model. Sampling controls reflect the
selected model and effective effort. Existing unsupported values remain visible
and can be reset; metadata explains the effective setting. The model-details
panel opens on hover, keyboard focus, or tap and dismisses with Escape. It shows
input support, tools, native search, reasoning levels, verified limits, availability,
review date, and the official documentation link.

## Best guesses for unreviewed models

Added 2026-10-10. A newly listed chat id without a reviewed entry no longer
gets the bare provider-default contract when its name is recognizable. Three
layers fill it in, each applied only to `status: 'discovered'` descriptors and
each labelled in the picker (`guess` on the public descriptor):

1. **Name heuristics** (`models/inference.js`, keyless and deterministic). The
   id's family picks the nearest reviewed sibling - `claude-sonnet-6` borrows
   Claude Sonnet 5, `gpt-7` borrows GPT-6 Sol, `gemini-4-flash` borrows Gemini
   3.5 Flash, a local Ollama pull borrows the Ollama text profile - and the
   descriptor takes that sibling's reasoning levels, sampling rule and
   capability flags, a readable display name and a description that says it
   is a guess. Token limits are never guessed from a name. An id that matches
   no family (`claude-x`, `gemini-exp-1206`) keeps the minimal contract.
   Because the registry's fallback resolver uses the same function, request
   validation in every process agrees with the picker.
2. **Listing evidence** (`models/discovery.js`). Every listing, including a
   manual **Refresh models**, keeps what the provider publishes per id and hands
   it to `providerDefaults.setListingEvidence`: Anthropic's display name, token
   limits and web-search capability; Gemini's display name, description, token
   limits, `thinking` flag and temperature ceiling. OpenAI and Ollama listings
   carry nothing beyond the id. A listing that says a model does not think
   removes the effort control and turns sampling on. Listing evidence beats
   every other layer for an unreviewed id.
3. **Goobster reads the documentation** (`services/modelProfileGuessService.js`,
   `ai.modelGuesses`, on by default). After a listing, each new unreviewed model
   is queued (six per listing, sequential, one hour back-off after a failure).
   Goobster fetches the provider's documentation page for the model through the
   `safeFetch` stages (Anthropic's docs as Markdown, OpenAI, Gemini and the
   Ollama library as HTML), keeps the passages that name the model, and asks the
   host's default provider for a one-sentence description, what the model is
   probably good for, what is uncertain, and - only when a page was read - the
   controls the page states: context window, output limit, image input, web
   search, effort support and levels, sampling. Effort levels are clamped to
   what the adapter implements for that provider (Claude: low/medium/high);
   a page cannot widen the adapter contract. The row in `model_profile_guesses`
   (`evidence` `docs` or `name`, `sourceUrl`, `controlsJson`) is written once,
   decorates every later listing, and its controls overlay the registry fallback
   under the listing evidence. Other processes load the rows on their next
   listing or model call (`ensureLoaded()` in `aiService._admit`), so the
   window in which two processes disagree is one request. With no readable page
   the text is name-only and no control is claimed. No prompt, page or reply is
   stored. The corpus is public model ids, so there is no privacy path.

Reviewed and custom entries are never touched by any layer. The picker shows
the selected model's description under the select, marks an unreviewed model
**Best guess** (or **Goobster's guess** once he has written it), says in the
details panel which facts came from the listing, which from the documentation
and which from the family, and polls the cached listing for a few seconds while
descriptions are pending. The deterministic resolver remains the only source of
request parameters; the provider stays the final authority.

## Explicit custom models

An operator can register another exact ID in root `config.json` without modifying
application code. Pick a profile whose request behavior actually matches the model;
this is an operator assertion, not automatic verification. Restart after editing.

```json
{
  "ai": {
    "customModels": [
      {
        "provider": "ollama",
        "id": "my-local-model:latest",
        "profile": "ollama-text",
        "displayName": "My local model",
        "description": "Local text model maintained by this host.",
        "maxOutputTokens": 4096
      }
    ]
  }
}
```

Profiles initially include openai-chat, openai-reasoning, openai-gpt5, openai-o3,
claude-adaptive, claude-standard, gemini-thinking, gemini-legacy, and ollama-text.
Provider/profile mismatches, invalid limits, and duplicate IDs fail configuration
validation. Custom entries cannot replace built-in entries or inject API options.
They are marked Custom and have no official review date. Custom local models still
need to be installed on the configured Ollama server.

The shipped default IDs are registered. Newly listed chat IDs, including dated
snapshots, work with provider defaults without a commit, redeploy or restart.
An explicit `ai.customModels` entry remains useful to expose reviewed advanced
controls for an additional ID. No automatic model migration is performed. Image, embedding, transcription, and realtime APIs keep their existing
configuration and are outside this chat-model registry.

## Verification and evolution

Unit tests exercise independent request expectations, exact aliases, unknown/future
IDs, model-specific effort, sampling, budgets, discovery failures and pagination,
partial settings changes, legacy settings, and cross-provider isolation. Each
provider's outgoing wire request remains covered by adapter tests. Browser journeys
cover the controls, details panel, provider changes, and saved-choice behavior.
Optional live provider checks remain gated on credentials; mocked tests do not
certify that every provider account can invoke every registered model.

Next extensions should have separate tests and review:

- Additional model profiles/IDs and explicit deprecation dates.
- Provider capability drift reports against reviewed entries. Discovery can flag a
  mismatch but must never silently overwrite deployment policy.
- Dated, tier-aware pricing with units, cache charges, and long-context rules before
  displaying cost estimates or using the catalog for accounting.
- Exact context-budget enforcement and richer model-specific tool combinations.
- A host-facing view of unknown installed IDs and invalid configured defaults.

## Primary references

- [OpenAI model guidance](https://developers.openai.com/api/docs/guides/latest-model)
- [OpenAI web search constraints](https://developers.openai.com/api/docs/guides/tools-web-search)
- [Claude model capabilities](https://platform.claude.com/docs/en/models/overview)
- [Claude effort](https://platform.claude.com/docs/en/build-with-claude/effort)
- [Gemini thinking](https://ai.google.dev/gemini-api/docs/thinking)
- [Ollama chat API](https://docs.ollama.com/api/chat)

Each built-in model also carries its source links in the catalog. Review date
means documentation/adapter review, not a production inference certification.
