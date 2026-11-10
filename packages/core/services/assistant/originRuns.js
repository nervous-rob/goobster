/**
 * Which module handles the run side of an initiative, by the `origin.kind`
 * its adapter stored: conversationRequestRun (ADR 0021: a message in a
 * project conversation or a discussion) or opportunityRun (ADR 0026: the
 * DA-8 sources). Each exports `load`, `messages` and `origins`.
 */

const conversation = require('./conversationRequestRun');
const opportunity = require('./opportunityRun');

const MODULES = [
    { kinds: ['parlor_message'], run: conversation },
    { kinds: opportunity.KINDS, run: opportunity }
];

/** The run module for an origin kind, or null (an initiative with no conversation or source origin). */
function forKind(kind) {
    return MODULES.find(entry => entry.kinds.includes(kind))?.run || null;
}

/** Origins of every presented initiative the viewer may see, by initiative id. */
async function origins({ userId, initiatives }) {
    const out = new Map();
    for (const { run } of MODULES) {
        for (const [id, value] of await run.origins({ userId, initiatives })) out.set(id, value);
    }
    return out;
}

module.exports = { forKind, origins };
