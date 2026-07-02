function validateAzureSpeechKey(key) {
    // Basic validation - just check if it's a non-empty string with alphanumeric chars
    if (!key || typeof key !== 'string') {
        return false;
    }

    // Should only contain alphanumeric characters
    return /^[a-zA-Z0-9]+$/.test(key);
}

function validateReplicateApiKey(key) {
    // Basic validation for Replicate API key
    if (!key || typeof key !== 'string') {
        return false;
    }
    
    // Replicate API keys typically start with "r8_" followed by alphanumeric characters
    return /^r8_[a-zA-Z0-9]+$/.test(key);
}

/**
 * Validate the runtime configuration.
 *
 * Only the Discord credentials are required. Cloud integrations (Azure Speech,
 * Replicate, Perplexity, ...) are optional and merely produce warnings when
 * absent, so the bot can run fully self-hosted (e.g. on a Raspberry Pi).
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

    // Azure Speech (optional): validate format only when configured
    const rawSpeechKey = config.azure?.speech?.key || config.azureSpeech?.key;
    const speechKey = isPlaceholder(rawSpeechKey) ? '' : rawSpeechKey;
    const speechRegion = config.azure?.speech?.region || config.azureSpeech?.region;

    if (speechKey) {
        if (!validateAzureSpeechKey(speechKey)) {
            errors.push('Invalid Azure Speech key format');
        }
        if (!speechRegion) {
            errors.push('Azure Speech region is missing (required when a speech key is set)');
        }
    } else {
        warnings.push('Azure Speech not configured - cloud TTS/voice recognition disabled');
    }

    // Validate language setting when present
    const language = config.azure?.speech?.language || config.azureSpeech?.language || 'en-US';
    if (!language.match(/^[a-z]{2}-[A-Z]{2}$/)) {
        errors.push('Invalid speech language format. Expected format: en-US');
    }

    // Replicate (optional): validate format only when configured
    const rawReplicateKey = config.replicate?.apiKey;
    const replicateApiKey = isPlaceholder(rawReplicateKey) ? '' : rawReplicateKey;
    if (replicateApiKey && !validateReplicateApiKey(replicateApiKey)) {
        errors.push('Invalid Replicate API key format - should start with "r8_"');
    } else if (!replicateApiKey) {
        warnings.push('Replicate not configured - music/ambience generation disabled');
    }

    if (!config.perplexity?.apiKey) {
        warnings.push('Perplexity not configured - web search disabled');
    }

    return {
        isValid: errors.length === 0,
        errors,
        warnings
    };
}

module.exports = {
    validateConfig,
    validateAzureSpeechKey,
    validateReplicateApiKey
};
