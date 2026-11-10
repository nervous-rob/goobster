/**
 * What the DA-8 adapters ask before they read anything for a responsibility
 * (ADR 0026): is the source named in its scopes, and does a grant cover it?
 * The grant check is the responsibility service's own `permits()` - the same
 * code `authorize()` runs at dispatch, minus the ledger note - so a source
 * is read exactly as far as a run could read it, and not a row further.
 */

function parse(text, fallback) {
    try { const value = JSON.parse(text); return value ?? fallback; } catch { return fallback; }
}

const responsibilities = () => require('../../assistantResponsibilityService');

/** The responsibility's actor: the person whose access every read uses. */
const actorOf = (responsibility) => responsibility.actingUserId || responsibility.ownerUserId;

/** Does `scopes.sources` name this source scope? */
function scoped(responsibility, name) {
    const sources = parse(responsibility.scopesJson, {}).sources;
    return Array.isArray(sources) && sources.includes(name);
}

/** The granted resources of one operation and resource kind. */
function grants(responsibility, operation, kind) {
    return parse(responsibility.operationsJson, [])
        .filter(entry => entry?.operation === operation && entry.resource?.kind === kind)
        .map(entry => entry.resource);
}

/** `permits()` for the responsibility's own current revision, as its actor. `preview` also answers for a draft. */
async function permits(responsibility, operation, resource, { preview = false } = {}) {
    const result = await responsibilities().permits({
        responsibilityId: responsibility.id,
        revision: responsibility.revision,
        operation,
        resource,
        actorUserId: actorOf(responsibility),
        preview
    });
    return result.ok === true;
}

/** An origin as an object, from the JSON column or an already parsed value. */
function originOf(value) {
    return typeof value === 'string' ? parse(value, null) : (value || null);
}

/** The open attempts of one kind, for a `stale()` hook. */
async function openAttempts(db, responsibility, kind) {
    const rows = await db.all(
        `SELECT id, originJson FROM assistant_initiatives
         WHERE responsibilityId = @rid AND sourceKind = @kind AND status IN ('CANDIDATE', 'QUEUED', 'WAITING')`,
        { rid: responsibility.id, kind }
    );
    return rows.map(row => ({ id: Number(row.id), origin: originOf(row.originJson) }));
}

module.exports = { parse, actorOf, scoped, grants, permits, originOf, openAttempts };
