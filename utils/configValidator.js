function validateAzureSpeechKey(key) {
    // Basic validation - just check if it's a non-empty string with alphanumeric chars
    if (!key || typeof key !== 'string') {
        return false;
    }

    // Should only contain alphanumeric characters
    return /^[a-zA-Z0-9]+$/.test(key);
}

function validateConfig(config) {
    const errors = [];
    
    // Check Azure Speech config
    const speechKey = config.azure?.speech?.key || config.azureSpeech?.key;
    const speechRegion = config.azure?.speech?.region || config.azureSpeech?.region;

    if (!speechKey) {
        errors.push('Azure Speech key is missing');
    } else if (!validateAzureSpeechKey(speechKey)) {
        errors.push('Invalid Azure Speech key format');
    }

    if (!speechRegion) {
        errors.push('Azure Speech region is missing');
    }

    // Validate language setting
    const language = config.azure?.speech?.language || config.azureSpeech?.language || 'en-US';
    if (!language.match(/^[a-z]{2}-[A-Z]{2}$/)) {
        errors.push('Invalid speech language format. Expected format: en-US');
    }

    return {
        isValid: errors.length === 0,
        errors
    };
}

module.exports = {
    validateConfig,
    validateAzureSpeechKey
}; 