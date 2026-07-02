function validateElevenLabsApiKey(key) {
    // ElevenLabs keys are alphanumeric, optionally prefixed with "sk_"
    if (!key || typeof key !== 'string') {
        return false;
    }

    return /^(sk_)?[a-zA-Z0-9]+$/.test(key);
}

/**
 * Validate the runtime configuration.
 *
 * Only the Discord credentials are required. Cloud integrations (ElevenLabs,
 * Perplexity, ...) are optional and merely produce warnings when absent, so
 * the bot can run fully self-hosted (e.g. on a Raspberry Pi).
 */
function validateConfig(config) {
    const errors = [];
    const warnings = [];

    if (!config.token) {
        errors.push('Discord bot token is missing');
    } else if (config.token.startsWith('YOUR_')) {
        errors.push('Discord bot token is still the placeholder - edit config.json with your real token');
    }

    if (!config.clientId) {
        warnings.push('Discord clientId is missing - command deployment will not work');
    } else if (config.clientId.startsWith('YOUR_')) {
        errors.push('Discord clientId is still the placeholder - edit config.json with your application ID');
    }

    // Optional integrations left as template placeholders should be treated as
    // unconfigured rather than failing format validation below.
    const isPlaceholder = (value) => typeof value === 'string' && value.includes('YOUR_');

    // ElevenLabs (optional): validate format only when configured
    const rawElevenLabsKey = config.elevenlabs?.apiKey || process.env.ELEVENLABS_API_KEY;
    const elevenLabsKey = isPlaceholder(rawElevenLabsKey) ? '' : rawElevenLabsKey;
    if (elevenLabsKey && !validateElevenLabsApiKey(elevenLabsKey)) {
        errors.push('Invalid ElevenLabs API key format');
    } else if (!elevenLabsKey) {
        warnings.push('ElevenLabs not configured - TTS, music generation, and ambience disabled');
    }

    if (!config.perplexity?.apiKey && !process.env.PERPLEXITY_API_KEY) {
        warnings.push('Perplexity not configured - web search disabled');
    }

    // Chat AI providers (optional): warn when no cloud provider is configured,
    // since the bot will then depend entirely on a local Ollama server.
    const hasOpenAI = Boolean(process.env.OPENAI_API_KEY || config.openaiKey);
    const hasGemini = Boolean(process.env.GEMINI_API_KEY || config.googleAIKey);
    if (!hasOpenAI && !hasGemini) {
        warnings.push('No cloud AI provider configured (OpenAI/Gemini) - chat will fall back to the local Ollama server');
    }
    if (!hasOpenAI) {
        warnings.push('OpenAI not configured - image generation disabled');
    }

    return {
        isValid: errors.length === 0,
        errors,
        warnings
    };
}

module.exports = {
    validateConfig,
    validateElevenLabsApiKey
};
