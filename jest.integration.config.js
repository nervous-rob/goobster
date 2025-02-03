const config = require('./config.json');

process.env.AZURE_SPEECH_KEY = config.azureSpeech.key;
process.env.AZURE_SPEECH_REGION = config.azureSpeech.region;


module.exports = {
    testMatch: ['**/__tests__/integration/**/*.test.js'],
    testTimeout: 10000,
    setupFilesAfterEnv: ['<rootDir>/__tests__/setup.js'],
    testEnvironment: 'node',
    verbose: true,
    detectOpenHandles: true,
    forceExit: true,
    globals: {
        discordToken: config.token,
        discordClientId: config.clientId,
        discordGuildIds: config.guildIds,
        openaiKey: config.openaiKey,
        azureSql: config.azureSql,
        azureSpeech: config.azureSpeech
    }
}; 