const { AIService } = require('./index');
const { createLogger } = require('../../utils/logger');
const config = require('../../config.json');

const logger = createLogger('AIServiceInstance');

// Create AI configuration from config.json
const aiConfig = {
    openai: config.openaiKey ? {
        apiKey: config.openaiKey
    } : null,
    anthropic: config.anthropicKey ? {
        apiKey: config.anthropicKey
    } : null,
    google: config.googleAIKey ? {
        apiKey: config.googleAIKey
    } : null,
    perplexity: config.perplexityKey ? {
        apiKey: config.perplexityKey
    } : null,
    defaults: {
        defaultModel: 'openai:o1-mini',
        maxTokens: 1000,
        retryAttempts: 3,
        retryDelay: 1000
    }
};

// Log available API keys (without exposing the actual keys)
const availableProviders = Object.entries(aiConfig)
    .filter(([key, value]) => key !== 'defaults' && value?.apiKey)
    .map(([key]) => key);
logger.info('Available AI providers:', availableProviders);

// Create singleton instance
let aiService;
try {
    aiService = new AIService(aiConfig);
} catch (error) {
    logger.error('Failed to initialize AIService:', error);
    throw error;
}

// Export the singleton instance
module.exports = aiService; 