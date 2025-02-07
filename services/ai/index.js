const ModelManager = require('./ModelManager');
const PersonalityAdapter = require('./PersonalityAdapter');
const PromptManager = require('./PromptManager');
const ConversationAnalyzer = require('./personality/ConversationAnalyzer');
const SentimentAnalyzer = require('./personality/SentimentAnalyzer');
const PersonalityPresetManager = require('./personality/PersonalityPresetManager');

// AI Providers
const OpenAIProvider = require('./providers/OpenAIProvider');
const AnthropicProvider = require('./providers/AnthropicProvider');
const GoogleAIProvider = require('./providers/GoogleAIProvider');
const BaseProvider = require('./providers/BaseProvider');

module.exports = {
    // Core Services
    ModelManager,
    PersonalityAdapter,
    PromptManager,
    
    // Personality System
    ConversationAnalyzer,
    SentimentAnalyzer,
    PersonalityPresetManager,
    
    // Providers
    providers: {
        OpenAIProvider,
        AnthropicProvider,
        GoogleAIProvider,
        BaseProvider
    },

    // Constants
    constants: {
        DEFAULT_MODEL: 'gemini-2.0-pro',
        FALLBACK_MODEL: 'gemini-2.0-flash',
        EFFICIENT_MODEL: 'gemini-2.0-flash-lite'
    }
}; 