/**
 * A module that is required on first use. The manager must boot with no
 * database, no keys and none of the application's config or services
 * loaded (tests/managerBoot.test.js enforces it), so the configuration
 * kinds and routes reach the field catalog and the probes through this.
 */

function lazy(id) {
    let loaded = null;
    const load = () => {
        if (!loaded) loaded = require(id);
        return loaded;
    };
    return new Proxy({}, {
        get: (_target, key) => load()[key],
        has: (_target, key) => key in load()
    });
}

module.exports = { lazy };
