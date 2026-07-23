/**
 * Jest global setup: some modules require config.json at load time (e.g.
 * commands/music/playtrack.js via toolsRegistry). config.json is gitignored,
 * so provide a minimal one BEFORE workers start - creating it mid-run (in a
 * beforeAll) races Jest's module resolver and flakes. Mirrors the approach
 * of scripts/smoke-require.js.
 */
const fs = require('node:fs');
const path = require('node:path');

const CONFIG_PATH = path.join(__dirname, '..', '..', 'config.json');

module.exports = async () => {
    if (!fs.existsSync(CONFIG_PATH)) {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify({
            clientId: '0',
            guildIds: ['0'],
            token: 'jest-test-placeholder'
        }, null, 2));
        // globalSetup and globalTeardown share the main Jest process
        globalThis.__GOOBSTER_JEST_CREATED_CONFIG__ = true;
    }
};
