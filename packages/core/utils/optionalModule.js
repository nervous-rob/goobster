'use strict';

/**
 * Load a module that belongs to an optional feature and may be physically
 * absent from a reduced payload (documentation/packaging.md, issue #328).
 *
 *   const requireOptional = require('../utils/optionalModule').forModule(module);
 *   const sandbox = requireOptional('./sandboxService', { feature: 'sandbox' });
 *   if (!sandbox) return unavailable();
 *
 * Returns null only when the requested module itself cannot be found. Any
 * other failure (a syntax error, a throwing top-level, or a dependency
 * missing *inside* a module that is present) rethrows: a broken install is
 * not the same as an uninstalled feature. The first absence of each module
 * is recorded for diagnostics; callers never put the path in a user-facing
 * message.
 *
 * The literal `requireOptional('<spec>', { feature: '<id>' })` form is what
 * scripts/lib/requireGraph.js recognises, so keep both arguments literal.
 */

const Module = require('node:module');

const absences = new Map();

/**
 * True when `error` says `spec` itself could not be found from `filename`,
 * not something `spec` requires. Node names the requiring file first in
 * `requireStack`; Jest's resolver says "from '<file>'" instead.
 */
function isMissing(error, spec, filename) {
    if (!error || error.code !== 'MODULE_NOT_FOUND') return false;
    const message = String(error.message || '');
    if (!message.includes(`'${spec}'`) && !message.includes(`"${spec}"`)) return false;
    if (Array.isArray(error.requireStack) && error.requireStack.length > 0) {
        return error.requireStack[0] === filename;
    }
    const from = /from '([^']+)'/.exec(message);
    return !from || filename.endsWith(from[1].replace(/^\.\//, ''));
}

function record(feature, spec, from) {
    const key = `${feature}\u0000${spec}`;
    if (!absences.has(key)) absences.set(key, { feature, module: spec, from });
}

/**
 * @param {NodeJS.Module} parent  the calling module (pass `module`)
 * @returns {(spec: string, options: { feature: string }) => any}
 */
function forModule(parent) {
    // The module's own require keeps the loader's cache and test mocks;
    // createRequire is only the fallback for an object without one.
    const load = typeof parent.require === 'function'
        ? (spec) => parent.require(spec)
        : Module.createRequire(parent.filename);
    return function requireOptional(spec, { feature } = {}) {
        if (typeof feature !== 'string' || !feature) {
            throw new TypeError('requireOptional needs { feature } naming the owning feature.');
        }
        try {
            return load(spec);
        } catch (error) {
            if (isMissing(error, spec, parent.filename)) {
                record(feature, spec, parent.filename);
                return null;
            }
            throw error;
        }
    };
}

/** Modules found absent so far: `[{ feature, module }]`, first absence first. */
function absentModules() {
    return [...absences.values()].map(({ feature, module }) => ({ feature, module }));
}

/** True when any module of `feature` was found absent in this process. */
function featureAbsent(feature) {
    for (const entry of absences.values()) if (entry.feature === feature) return true;
    return false;
}

function _resetForTests() {
    absences.clear();
}

const requireOwn = forModule(module);

/**
 * discord.js, loaded on first property access (packaging_proof.md B6). Core
 * code that builds embeds, buttons or permission checks for Discord uses
 * `discord.EmbedBuilder` instead of a top-level `require('discord.js')`, so
 * the portal and API path never load the library and a payload without the
 * Discord adapter does not carry it. Reading a property when discord.js is
 * not installed throws GatewayDisabledError (`DISCORD_DISABLED`), the error
 * every Discord delivery path already treats as "not connected to Discord".
 */
const discord = new Proxy({}, {
    get(_target, name) {
        if (typeof name === 'symbol') return undefined;
        const library = requireOwn('discord.js', { feature: 'discord' });
        if (!library) {
            const { GatewayDisabledError } = require('../gateway/errors');
            throw new GatewayDisabledError();
        }
        return library[name];
    },
    has(_target, name) {
        const library = requireOwn('discord.js', { feature: 'discord' });
        return Boolean(library) && name in library;
    }
});

module.exports = { forModule, absentModules, featureAbsent, discord, _resetForTests };
