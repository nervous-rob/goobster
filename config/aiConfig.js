require('dotenv').config();

// config.json is optional (e.g. env-only deployments); never crash at import time.
let fileConfig = {};
try {
    fileConfig = require('../config.json');
} catch {
    // config.json optional at load time
}

/**
 * Centralized AI configuration.
 *
 * Resolution order for every value: environment variable first, then
 * config.json, then a hardcoded default. All model IDs live here so no
 * service hardcodes them.
 */
module.exports = {
    /** Raw parsed config.json (or {} when absent) for services that need other keys. */
    fileConfig,

    /** Requested provider: 'openai' | 'gemini' | 'ollama' (null = auto-detect). */
    provider: process.env.AI_PROVIDER || fileConfig.ai?.provider || null,

    openai: {
        apiKey: process.env.OPENAI_API_KEY || fileConfig.openaiKey || null,
        chatModel: process.env.OPENAI_CHAT_MODEL || fileConfig.ai?.openai?.chatModel || 'gpt-5.4-mini',
        thoughtfulModel: process.env.OPENAI_THOUGHTFUL_MODEL || fileConfig.ai?.openai?.thoughtfulModel || 'gpt-5.5',
        imageModel: process.env.OPENAI_IMAGE_MODEL || fileConfig.ai?.openai?.imageModel || 'gpt-image-2'
    },

    gemini: {
        apiKey: process.env.GEMINI_API_KEY || fileConfig.googleAIKey || null,
        model: process.env.GEMINI_MODEL || fileConfig.ai?.gemini?.model || 'gemini-3.5-flash'
    },

    ollama: {
        host: (process.env.OLLAMA_HOST || fileConfig.ollama?.host || 'http://127.0.0.1:11434').replace(/\/$/, ''),
        model: process.env.OLLAMA_MODEL || fileConfig.ollama?.model || 'llama3.2:3b'
    },

    perplexity: {
        apiKey: process.env.PERPLEXITY_API_KEY || fileConfig.perplexity?.apiKey || null,
        model: process.env.PERPLEXITY_MODEL || fileConfig.perplexity?.model || 'sonar-pro'
    }
};
