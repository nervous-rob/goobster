# ADR 0011: Model compatibility is deployment policy

Date: 2026-09-22
Status: Implemented initial contract

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
   configurations that Goobster's current adapter can use.
2. **Availability:** live discovery reports which IDs the host's provider account
   currently lists. A listing is evidence, not a guarantee of inference access,
   quota, regional availability, or continuing service.
3. **Selection:** a user's saved provider/model/effort choice remains their choice.
   Discovery never rewrites it or substitutes another model.

The registry is in `packages/core/models/catalog.js`. The deterministic resolver
is in `registry.js`; provider discovery and its transient cache are in
`discovery.js`. Provider adapters serialize the resolver's output into their API
formats. Frontend controls consume public descriptors from the same registry.

Adding support is an explicit code review or host configuration change. A new
name returned by a provider cannot promote itself into a supported model. Exact
aliases are declared individually. Future snapshots never inherit compatibility
solely because they have a familiar prefix.

## Registry contract

Each descriptor has a provider, exact ID, canonical ID, display name, description,
status, aliases, workflows, input/output modalities, adapter endpoint, capability
flags, reasoning rules, sampling rules, token limits, documentation sources, and
review date. Registry version 1 is exposed by the API.

Profiles reuse serialization behavior; model entries can narrow it. The fields
represent the **Goobster adapter contract**. For example, Haiku's underlying
extended-thinking capability is not exposed as an effort control by this adapter.
Claude's initial effort controls are the low/medium/high subset implemented here.
Unknown token limits and pricing are null; they are never represented as zero,
unlimited, free, or an invented estimate.

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

- Normal model options require a registry entry for the selected workflow.
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
`models` contains registry descriptors with `availability` and `selectable`.
The existing `/api/app/chat/models` endpoint remains an ID-only compatibility view.

| Discovery result | Availability and picker behavior |
| --- | --- |
| Successful complete listing | Matching registered models are listed/selectable. Other registry entries are not-listed. |
| Successful empty listing | No models claimed available. This is distinct from an error. |
| Failure without a snapshot | Availability unknown. Registered models can still be selected. |
| Failure with a snapshot | Keep the snapshot and its last successful timestamp; mark availability unknown/stale. |
| Provider not configured | Registry descriptions remain available, but model options are disabled. |

Listings are cached in memory for ten minutes, concurrent refreshes are coalesced,
and failures have a thirty-second retry delay. Anthropic and Gemini pagination
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

The shipped default IDs are registered. Hosts using other IDs (including dated
snapshots) must add an explicit matching entry or select a registered model before
those calls run. The error points to ai.customModels; no automatic model migration
is performed. Image, embedding, transcription, and realtime APIs keep their existing
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
