const config = require('./config.json');

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
        elevenlabs: config.elevenlabs
    }
}; 