# AI Provider Tool Integration

This document explains how Goobster integrates tools across its AI providers: OpenAI, Anthropic, Google Gemini, and Ollama.

## Overview

OpenAI, Anthropic and Gemini use **native function calling**. Ollama (local models) uses a **prompt-based tool protocol** since many local models lack reliable native tool support.

All providers return the same normalized shape from `chat(messages, opts)`:

```javascript
{
    content: string,                       // assistant text (may be empty when calling tools)
    toolCalls: [{
        id: string,                        // opaque call id, round-tripped in tool results
        name: string,                      // tool name from toolsRegistry
        arguments: string                  // JSON-encoded arguments
    }]
}
```

Tool results are fed back as messages with `{ role: 'tool', toolCallId, name, content }`, and the assistant turn that requested them is replayed as `{ role: 'assistant', content, toolCalls }`.

## Provider mechanics

### OpenAI (Responses API)

- Tool definitions from `toolsRegistry.getDefinitions()` are passed as Responses API `tools` (`{ type: 'function', name, description, parameters }`).
- Tool calls come back as `function_call` output items; results are sent as `function_call_output` input items.
- Shared usage guidance (`utils/toolPromptBuilder.js` → `buildNativeToolGuidance()`) is prepended to the instructions.

### Gemini (native function calling)

- Definitions are converted to `functionDeclarations` using `parametersJsonSchema` (standard JSON Schema).
- Tool calls come back as `functionCall` parts; results are sent as `functionResponse` parts.
- System prompts are passed via `systemInstruction` (Gemini has no system role in `contents`).
- Gemini does not assign call IDs, so the service synthesizes them.

### Ollama (prompt-based protocol)

When tools are requested, `utils/toolPromptBuilder.js` injects a system prompt that:

- Documents all available tools with their parameters
- Instructs the model to respond with ONLY a JSON object when calling a tool:

```json
{
  "tool_call": {
    "name": "tool_name",
    "arguments": {
      "param1": "value1"
    }
  }
}
```

`parseToolCall()` extracts the call from the response text (fenced JSON preferred, bare JSON as fallback) and the service returns it in the same normalized `toolCalls` shape.

## Shared prompt builder

All tool prompt text lives in `utils/toolPromptBuilder.js`:

- `buildNativeToolGuidance()` — concise usage guidance (including `executePlan` patterns) for native-tool providers.
- `buildPromptBasedToolPrompt(functions)` — full JSON protocol prompt for prompt-based providers.
- `parseToolCall(text)` — parser for the JSON protocol.

Never duplicate tool documentation inside a provider service.

## Available tools and routing

All providers use the shared registry. Actual availability is filtered by
installed/enabled features, scope and personal settings; model contracts can
also refuse unsupported tools or inputs. Native providers receive JSON schemas;
prompt-based providers receive the same schemas, including enums, required
fields and nested structures. Do not maintain an abbreviated tool inventory
here: see the generated [feature reference](features.md) and runtime definitions.

Prefer specific tools directly. `projectAssets` saves/reads/files project apps,
scripts and notes without execution. `observatory` handles project execution,
workspace files, repos, triggers and missions. `executePlan` is optional batching,
not a default wrapper, a save API, or a Project Mission. Read the
[Project tool guide](skills/project-tools.md) for exact examples and gates.

### Anthropic

Anthropic uses native tool-use blocks, converted to the same normalized chat
contract by `anthropicService`. Shared guidance applies on this provider too.

## Provider Capabilities

Provider/model capabilities are defined in `packages/core/models/catalog.js`
and resolved by `models/registry.js`, including reasoning, tool use, search,
streaming, sampling and token limits. Consult those contracts and the model
catalog UI rather than assuming one capability for every model on a provider.

## Usage Example

```javascript
const aiService = require('../services/aiService');
const toolsRegistry = require('../utils/toolsRegistry');

const { content, toolCalls } = await aiService.chat([
    { role: 'user', content: 'Search for information about JavaScript closures' }
], {
    functions: toolsRegistry.getDefinitions()
});

for (const call of toolCalls) {
    const result = await toolsRegistry.execute(call.name, JSON.parse(call.arguments));
    // Feed back: { role: 'tool', toolCallId: call.id, name: call.name, content: result }
}
```

## Testing

Run the integration test (requires a configured Gemini API key):

```bash
node tests/testGeminiToolIntegration.js
```

## References

- [OpenAI Responses API](https://developers.openai.com/api/docs/guides/migrate-to-responses)
- [Google Gemini Function Calling](https://ai.google.dev/gemini-api/docs/function-calling)
