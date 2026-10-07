/**
 * The one synchronous reader for config.json.
 *
 * Every module that used to require config.json by a path relative to the
 * package goes through `load()` instead, so the file is found where the
 * installation put it (`GOOBSTER_CONFIG_PATH`, else
 * `<workspace root>/config.json`) rather than relative to the package, which
 * is wrong in a payload layout.
 *
 * Absent file -> `{}` (every cloud integration is optional). A file that
 * exists but is not JSON throws `ConfigJsonError` (`CONFIG_INVALID_JSON`),
 * exactly as the old `require` did; a corrupt file is never swallowed.
 * Pure fs: nothing here logs, and error messages carry no path or value.
 */

const fs = require('node:fs');
const runtimePaths = require('../runtimePaths');

class ConfigJsonError extends Error {
    constructor(message = 'config.json is not valid JSON') {
        super(message);
        this.name = 'ConfigJsonError';
        this.code = 'CONFIG_INVALID_JSON';
    }
}

const cache = new Map();

function configJsonPath() {
    return runtimePaths.configJsonPath;
}

function readFile(file) {
    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch (err) {
        if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return {};
        throw err;
    }
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    try {
        return JSON.parse(text);
    } catch {
        throw new ConfigJsonError();
    }
}

/**
 * @param {{ fresh?: boolean }} [opts] `fresh` re-reads the file instead of
 *   returning the per-path cached object.
 * @returns {object}
 */
function load({ fresh = false } = {}) {
    const file = configJsonPath();
    if (!fresh && cache.has(file)) return cache.get(file);
    const parsed = readFile(file);
    cache.set(file, parsed);
    return parsed;
}

module.exports = { load, configJsonPath, ConfigJsonError };
