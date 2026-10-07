/**
 * Shared gate helper for the execution surfaces (#318 commands and steps,
 * #319 tools and MCP, #320 routes and sockets). One place turns a surface
 * identifier into "is its owner, and everything it also requires, active".
 *
 * Requires only ./inventory and ./featureState. A surface with no inventory
 * row throws GateError('UNCLAIMED_SURFACE') instead of being allowed or
 * denied quietly, so a missing claim is loud in tests; the inventory spec
 * normally catches it first.
 */

const inventory = require('./inventory');
const { features } = require('./featureState');

const FEATURE_UNAVAILABLE = 'FEATURE_UNAVAILABLE';

class GateError extends Error {
    constructor(code, message, extra = {}) {
        super(message);
        this.name = 'GateError';
        this.code = code;
        Object.assign(this, extra);
    }
}

function claim(kind, identifier, method) {
    const found = inventory.ownerOf(kind, identifier, method);
    if (!found) {
        throw new GateError(
            'UNCLAIMED_SURFACE',
            `No feature owns ${kind} "${identifier}"${method ? ` (${method})` : ''}; add it to packages/core/features/inventory.js.`,
            { kind, identifier, method: method || null }
        );
    }
    return found;
}

/**
 * The first of owner, then alsoRequires, that is enforced off; null when
 * the surface is available. Enforcement (not raw `isActive`) is the rule at
 * every surface: with no usable `features.json` nothing new is refused and
 * the legacy switches keep deciding exactly as before; see
 * `featureState.enforcedOff`.
 */
function blockingFeature(kind, identifier, method) {
    const { owner, alsoRequires } = claim(kind, identifier, method);
    return blockingAmong([owner, ...alsoRequires]);
}

/** The first id in the list that is enforced off; null when all are available. */
function blockingAmong(ids) {
    for (const id of ids) {
        if (features.enforcedOff(id)) return id;
    }
    return null;
}

function surfaceActive(kind, identifier, method) {
    return blockingFeature(kind, identifier, method) === null;
}

function unavailableResult(featureId) {
    return {
        ok: false,
        code: FEATURE_UNAVAILABLE,
        feature: featureId,
        reasons: features.availability(featureId).reasons
    };
}

/**
 * null when the surface is available; otherwise the unavailable result for
 * the feature that blocks it (the owner, or the owner's first inactive
 * `alsoRequires` feature, so the reasons are never empty).
 */
function requireSurface(kind, identifier, method) {
    const blocking = blockingFeature(kind, identifier, method);
    return blocking === null ? null : unavailableResult(blocking);
}

module.exports = {
    FEATURE_UNAVAILABLE,
    GateError,
    surfaceActive,
    requireSurface,
    unavailableResult,
    blockingAmong
};
