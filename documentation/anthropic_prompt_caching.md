# Anthropic prompt caching

Goobster enables five-minute automatic caching on `AnthropicService.chat`,
with explicit checkpoints on the last tool definition and the system block.
There are at most three checkpoints. Stable tools can be reused even when
system context changes; the automatic checkpoint follows the conversation,
including tool results. Streaming and non-streaming requests use the same policy.

`generateText` defaults to uncached requests: most background prompts are used
once. It can opt in for deliberate reuse. No prewarming or additional API calls
are made. Request text, tool ordering, and provider selection are unchanged.

## Controls

- `ANTHROPIC_PROMPT_CACHING=false` disables chat caching by default.
- The equivalent config is `ai.anthropic.promptCaching: false` in `config.json`.
- A caller can override either default with `opts.promptCaching: true | false`.
- Only the default five-minute lifetime is requested; no one-hour cache is enabled.

## What to expect

Anthropic charges 1.25× normal input price for five-minute writes; cache reads
cost less, with a model-dependent rate. A prefix must match exactly and meet
the model's minimum length. Smaller prompts run normally without caching.
The TTL refreshes on reuse. These rules and current rates are in
[Anthropic's prompt-caching guide](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

Goobster's clock, retrieved notes, and other system context vary between turns.
A change can prevent reuse of the conversation prefix. Explicit tool checkpoints
still help when the tool definitions stay identical; repeated calls within a
tool loop are another likely source of reuse. Savings depend on actual traffic.

## Measurement

Usage shows cache-read and cache-write token counts. They are already included
in the input total, not additional tokens. Database columns `cacheReadTokens`
and `cacheWriteTokens` retain the breakdown; summaries expose both. Old rows
receive zero defaults and keep their historical totals.

Anthropic reports uncached input, cache reads, and cache writes separately;
Goobster adds them once to obtain total input. Streaming usage updates replace
cumulative counters rather than adding them. See the
[streaming usage contract](https://platform.claude.com/docs/en/build-with-claude/streaming).

Compare read and write counts by model over representative traffic before
changing defaults. Usage remains a token report, not a dollar estimate.
