# AI Provider Tool Integration

This document explains how Goobster integrates tools across its AI providers: OpenAI, Google Gemini, and Ollama.

## Overview

OpenAI and Gemini both use **native function calling**. Ollama (local models) uses a **prompt-based tool protocol** since many local models lack reliable native tool support.

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

## Available Tools

All tools from `utils/toolsRegistry.js` are available on every provider:

- **performSearch**: Web search using Perplexity API
- **generateImage**: Image generation with various styles
- **playTrack**: Music playback and playlist management
- **setNickname**: Bot and user nickname management
- **speakMessage**: Text-to-speech conversion
- **echoMessage**: Returns the provided text
- **createDevOpsWorkItem / queryDevOpsWorkItems / updateDevOpsWorkItem / addCommentToDevOpsWorkItem / setDevOpsParent**: Azure DevOps operations
- **executePlan**: Runs multiple tools sequentially and aggregates results

## Provider Capabilities

| Capability | OpenAI (gpt-5.4-mini / gpt-5.5) | Gemini (gemini-3.5-flash) | Ollama (local) |
|---|---|---|---|
| Function calling | Native | Native | Prompt-based |
| Streaming (`onDelta`) | Yes | Yes | Yes (text-only requests) |
| Reasoning effort | Yes | No | No |
| Model switching | Yes | Yes | Yes |

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
