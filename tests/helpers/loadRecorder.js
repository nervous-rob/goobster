/**
 * `node --require` preload for the reduced-payload children (#328). Records
 * every module that failed to resolve (the innermost request only, with the
 * file that asked) and, at exit, every file in `require.cache`, as JSON to
 * GOOBSTER_LOAD_LOG. Paths only; no module contents, no environment.
 */
'use strict';

const fs = require('node:fs');
const Module = require('node:module');

const out = process.env.GOOBSTER_LOAD_LOG;
const missing = [];
const seen = new WeakSet();
const original = Module._load;

Module._load = function recordingLoad(request, parent, isMain) {
    try {
        return original.call(this, request, parent, isMain);
    } catch (error) {
        if (error && typeof error === 'object' && error.code === 'MODULE_NOT_FOUND' && !seen.has(error)) {
            seen.add(error);
            missing.push({ request, from: parent?.filename || null });
        }
        throw error;
    }
};

if (out) {
    process.on('exit', () => {
        fs.writeFileSync(out, JSON.stringify({ loaded: Object.keys(require.cache).sort(), missing }));
    });
}
