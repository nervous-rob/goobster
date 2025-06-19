# Gemini Tool Integration

This document explains how Goobster integrates tools with Google's Gemini AI model, which doesn't natively support function calling like OpenAI.

## Overview

Since Gemini doesn't support native function calling, we've implemented a **prompt-based tool integration system** that provides the same capabilities through enhanced prompting and response parsing.

## How It Works

### 1. Enhanced Prompt Engineering

When tools are requested, the Gemini service automatically injects a system message that:

- Documents all available tools with their parameters
- Provides a specific JSON format for tool calls
- Instructs the model on when and how to use tools

Example system message:
```
You have access to the following tools. When you need to use a tool, respond with a JSON object in this exact format:

```json
{
  "tool_call": {
    "name": "tool_name",
    "arguments": {
      "param1": "value1",
      "param2": "value2"
    }
  }
}
```

Available tools:
**performSearch**: Run a web search and return a concise text summary of the results.
Parameters:
  - query: string (Search query to pass to the external search API.)

**generateImage**: Generate an image with the bot's image service and return a CDN URL or local path.
Parameters:
  - prompt: string (Detailed description of what to generate.)
  - type: string (Image category)
  - style: string (Artistic style to apply (e.g. fantasy, realistic, anime))

If you don't need to use any tools, respond normally with text.
```

### 2. Response Parsing

The service parses Gemini's response to detect tool calls:

```javascript
_parseToolCall(responseText) {
    try {
        // Look for JSON blocks in the response
        const jsonMatch = responseText.match(/```json\s*(\{[\s\S]*?\})\s*```/);
        if (!jsonMatch) return null;

        const parsed = JSON.parse(jsonMatch[1]);
        if (parsed.tool_call && parsed.tool_call.name && parsed.tool_call.arguments) {
            return {
                name: parsed.tool_call.name,
                arguments: parsed.tool_call.arguments
            };
        }
    } catch (error) {
        console.warn('Failed to parse tool call from Gemini response:', error.message);
    }
    return null;
}
```

### 3. OpenAI-Compatible Interface

The service returns responses in OpenAI-compatible format:

```javascript
// With tool call
{
    choices: [{
        message: {
            content: responseText,
            function_call: {
                name: toolCall.name,
                arguments: JSON.stringify(toolCall.arguments)
            }
        },
        finish_reason: 'function_call'
    }]
}

// Without tool call
{
    choices: [{
        message: {
            content: responseText,
            function_call: null
        },
        finish_reason: 'stop'
    }]
}
```

## Available Tools

All tools from the `toolsRegistry.js` are available:

- **performSearch**: Web search using Perplexity API
- **generateImage**: Image generation with various styles
- **playTrack**: Music playback and playlist management
- **setNickname**: Bot and user nickname management
- **speakMessage**: Text-to-speech conversion

## Provider Capabilities

The system provides different capabilities based on the AI provider:

### OpenAI (GPT-4o)
- ✅ Native function calling
- ✅ Streaming responses
- ✅ Reasoning effort control
- ✅ Model switching

### Gemini (2.5 Pro Preview)
- 🔄 Prompt-based tool integration
- ❌ No streaming
- ❌ No reasoning effort control
- ❌ No model switching

## Usage Examples

### Enabling Thoughtful Mode (Gemini)
```javascript
aiService.setProvider('gemini');
const capabilities = aiService.getProviderCapabilities();
// capabilities.functionCalling = false
// capabilities.streaming = false
```

### Using Tools with Gemini
```javascript
const response = await aiService.chat([
    { role: 'user', content: 'Search for information about JavaScript closures' }
], {
    functions: toolsRegistry.getDefinitions()
});

if (response.choices[0].finish_reason === 'function_call') {
    // Tool call detected and will be executed
    const toolCall = response.choices[0].message.function_call;
    const result = await toolsRegistry.execute(toolCall.name, JSON.parse(toolCall.arguments));
}
```

## Advantages and Limitations

### Advantages
- **Seamless Integration**: Works with existing tool registry
- **Full Tool Access**: All tools available regardless of provider
- **Consistent Interface**: Same API for both providers
- **Fallback Support**: Graceful degradation when tools aren't needed

### Limitations
- **Reliability**: Prompt-based approach may be less reliable than native function calling
- **Complexity**: More complex prompts may reduce response quality
- **Parsing**: JSON parsing can fail if model doesn't follow format exactly
- **Performance**: Larger prompts consume more tokens

## Testing

Run the integration test:
```bash
node tests/testGeminiToolIntegration.js
```

This will verify:
1. Basic chat functionality
2. Tool-aware responses
3. Tool call parsing
4. OpenAI-compatible response format

## Future Improvements

1. **Structured Output**: Use Gemini's structured output features when available
2. **Better Parsing**: Implement more robust JSON extraction
3. **Tool Validation**: Add parameter validation before execution
4. **Fallback Strategies**: Implement multiple parsing strategies
5. **Performance Optimization**: Cache tool definitions and reduce prompt size

## References

- [Functional Programming in JavaScript](https://medium.com/@AlexanderObregon/functional-programming-tricks-that-work-well-in-javascript-3655b4a40a9a)
- [JavaScript Execution Context](https://sarathkumarrs.medium.com/namaste-javascript-the-god-guide-to-mastering-javascript-part-1-1af77ea2b662)
- [Google Gemini API Documentation](https://ai.google.dev/)
- [OpenAI Function Calling](https://platform.openai.com/docs/guides/function-calling) 