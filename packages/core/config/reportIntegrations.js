/**
 * One-shot integration inventory. Providers must not warn during
 * construction — Jest loads them in every suite. Call this from the bot
 * and api entrypoints after config is loaded.
 */

const aiConfig = require('./aiConfig');

let reported = false;

function elevenLabsConfigured(config = aiConfig.fileConfig) {
    return Boolean(process.env.ELEVENLABS_API_KEY || config.elevenlabs?.apiKey);
}

function spotifyConfigured(config = aiConfig.fileConfig) {
    return Boolean(
        (process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET)
        || (config.spotify?.clientId && config.spotify?.clientSecret)
    );
}

function cloudProviders() {
    const present = [];
    if (aiConfig.openai.apiKey) present.push('openai');
    if (aiConfig.anthropic.apiKey) present.push('anthropic');
    if (aiConfig.gemini.apiKey) present.push('gemini');
    return present;
}

/**
 * @param {Object} [opts]
 * @param {Pick<Console, 'info'|'warn'>} [opts.logger]
 * @param {boolean} [opts.force] - report again (tests)
 */
function reportIntegrations({ logger = console, force = false } = {}) {
    if (reported && !force) return;
    reported = true;

    const cloud = cloudProviders();
    const flags = [
        `OpenAI=${aiConfig.openai.apiKey ? 'on' : 'off'}`,
        `Anthropic=${aiConfig.anthropic.apiKey ? 'on' : 'off'}`,
        `Gemini=${aiConfig.gemini.apiKey ? 'on' : 'off'}`,
        `Perplexity=${aiConfig.perplexity.apiKey ? 'on' : 'off'}`,
        `ElevenLabs=${elevenLabsConfigured() ? 'on' : 'off'}`,
        `Spotify=${spotifyConfigured() ? 'on' : 'off'}`
    ];
    logger.info?.(`[integrations] ${flags.join(' ')}`);

    if (cloud.length === 0) {
        logger.warn?.('[integrations] No cloud AI provider configured — defaulting to local Ollama.');
    }
}

function _resetForTests() {
    reported = false;
}

module.exports = {
    reportIntegrations,
    cloudProviders,
    elevenLabsConfigured,
    spotifyConfigured,
    _resetForTests
};
