/**
 * Jest global teardown: remove the placeholder config.json created by
 * globalSetup (a developer's real config.json is never touched).
 */
const fs = require('node:fs');
const path = require('node:path');

const CONFIG_PATH = path.join(__dirname, '..', '..', 'config.json');

module.exports = async () => {
    if (globalThis.__GOOBSTER_JEST_CREATED_CONFIG__) {
        try {
            fs.unlinkSync(CONFIG_PATH);
        } catch { /* already gone */ }
    }
};
