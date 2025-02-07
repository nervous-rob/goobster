# AI Services

## Overview
The AI services module provides a robust, multi-model AI integration system with advanced personality adaptation and conversation analysis capabilities. It supports multiple providers including Google's Gemini 2.0, OpenAI, and Anthropic.

## Core Components

### Model Manager
Handles model selection, load balancing, and fallback logic across different AI providers.

```javascript
const { ModelManager } = require('./services/ai');

// Example: Generate response with specific requirements
await ModelManager.generateResponse({
    prompt: "Your prompt here",
    capability: "code", // or "chat", "search", "analysis"
    options: {
        requireLowLatency: true,
        model: "gemini-2.0-flash"
    }
});
```

### Personality Adapter
Manages conversation personality and adapts responses based on user interaction patterns.

```javascript
const { PersonalityAdapter } = require('./services/ai');

// Example: Enhance prompt with personality
const enhanced = await PersonalityAdapter.enhancePrompt(
    basePrompt,
    userId,
    recentMessages
);
```

### Prompt Manager
Handles prompt construction, caching, and personality integration.

```javascript
const { PromptManager } = require('./services/ai');

// Example: Get personalized prompt
const prompt = await PromptManager.getEnhancedPrompt(
    userId,
    modelId,
    recentMessages
);
```

## Supported Models

### Gemini 2.0 Family
- **Gemini 2.0 Pro**
  - 2M token context window
  - Best for: Code generation, complex analysis, search integration
  - Capabilities: chat, search, code, analysis

- **Gemini 2.0 Flash**
  - 1M token context window
  - Best for: Fast responses, general chat
  - Capabilities: chat, search

- **Gemini 2.0 Flash-Lite**
  - 128K token context window
  - Best for: Efficient, cost-effective deployments
  - Capabilities: chat

### Model Selection
The system automatically selects the best model based on:
- Required capabilities
- Latency requirements
- Context length needs
- Rate limit status

## Personality System

### Conversation Analysis
```javascript
const { ConversationAnalyzer } = require('./services/ai');

// Example: Analyze conversation
const analysis = await ConversationAnalyzer.analyzeConversation(messages);
```

### Sentiment Analysis
```javascript
const { SentimentAnalyzer } = require('./services/ai');

// Example: Get sentiment analysis
const sentiment = await SentimentAnalyzer.analyzeSentiment(messages);
```

### Personality Presets
```javascript
const { PersonalityPresetManager } = require('./services/ai');

// Example: Get user's personality settings
const settings = await PersonalityPresetManager.getUserSettings(userId);
```

## Provider Integration

### Available Providers
- GoogleAIProvider (Gemini 2.0)
- OpenAIProvider
- AnthropicProvider

```javascript
const { providers } = require('./services/ai');

// Example: Direct provider usage
const googleProvider = new providers.GoogleAIProvider({
    apiKey: 'your-api-key',
    defaultModel: 'gemini-2.0-pro'
});
```

## Constants
```javascript
const { constants } = require('./services/ai');

// Available constants
constants.DEFAULT_MODEL    // 'gemini-2.0-pro'
constants.FALLBACK_MODEL  // 'gemini-2.0-flash'
constants.EFFICIENT_MODEL // 'gemini-2.0-flash-lite'
```

## Best Practices

### Model Selection
1. Use `gemini-2.0-pro` for:
   - Complex code generation
   - Detailed analysis tasks
   - Tasks requiring large context windows

2. Use `gemini-2.0-flash` for:
   - Quick chat responses
   - Search-related tasks
   - When low latency is priority

3. Use `gemini-2.0-flash-lite` for:
   - Cost-efficient deployments
   - Simple chat interactions
   - High-volume, basic tasks

### Personality Integration
1. Always provide recent messages for better context
2. Use personality presets for consistent behavior
3. Monitor and adapt to user interaction patterns

### Error Handling
1. Implement proper fallback chains
2. Monitor rate limits
3. Handle token limits appropriately

## Configuration

### Required Environment Variables
- `GOOGLE_AI_KEY`: Gemini API key
- `OPENAI_KEY`: OpenAI API key
- `ANTHROPIC_KEY`: Anthropic API key

### Database Configuration
Ensure the following tables are properly configured:
- `model_configs`
- `model_responses`
- `conversation_analysis`
- `user_preferences`

## Performance Considerations

### Rate Limits
- Gemini 2.0 Pro: 120 requests/minute
- Gemini 2.0 Flash: 180 requests/minute
- Gemini 2.0 Flash-Lite: 240 requests/minute

### Token Management
- Monitor token usage
- Use appropriate context windows
- Implement proper cleanup

### Caching
- Prompt caching: 1 hour TTL
- Response caching: Based on configuration
- User preferences: Regular updates

## Monitoring and Logging
The system automatically logs:
- Model performance metrics
- Response quality
- Error rates
- Token usage
- Latency statistics 