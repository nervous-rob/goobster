/**
 * The sandbox package overlay inventory (`sandbox_packages`).
 *
 * When an approved package-install request lands in data/sandbox/overlay,
 * every installed distribution is recorded here — requested packages with
 * their import name (so the probe can advertise them), transitive
 * dependencies with module NULL — along with the exact hash-pinned pip
 * requirement line. That makes the overlay reproducible: `npm run
 * sandbox-python` replays the recorded lines with --require-hashes, so a
 * rebuilt host ends up with byte-for-byte the set an approver actually saw.
 *
 * Kept as its own tiny module so the three consumers (sandboxService's
 * probe, sandboxRequestService's installer, the setup script) don't have to
 * know about each other.
 */

const db = require('../db');

/** Every recorded package, requested ones first. */
async function list() {
    return await db.all(
        `SELECT pip, module, version, requirement, requestedBy, approvedBy, installedAt
         FROM sandbox_packages ORDER BY module IS NULL, pip`
    );
}

/** Import names worth probing (requested packages only, deps have none). */
async function modules() {
    return (await db.all(
        'SELECT DISTINCT module FROM sandbox_packages WHERE module IS NOT NULL ORDER BY module'
    )).map(row => row.module);
}

/** The exact pip requirement lines for rebuilding the overlay. */
async function requirements() {
    return (await db.all('SELECT requirement FROM sandbox_packages ORDER BY pip'))
        .map(row => row.requirement);
}

/**
 * Record one installed distribution (idempotent: a re-install of the same
 * pip name replaces the row, e.g. an approved version bump).
 * @param {{pip:string, module:string|null, version:string, requirement:string,
 *          requestedBy?:string|null, approvedBy?:string|null}} entry
 */
async function record({ pip, module = null, version, requirement, requestedBy = null, approvedBy = null }) {
    await db.run(
        `INSERT INTO sandbox_packages (pip, module, version, requirement, requestedBy, approvedBy)
         VALUES (@pip, @module, @version, @requirement, @requestedBy, @approvedBy)
         ON CONFLICT (pip) DO UPDATE SET
             module = COALESCE(excluded.module, sandbox_packages.module),
             version = excluded.version,
             requirement = excluded.requirement,
             requestedBy = excluded.requestedBy,
             approvedBy = excluded.approvedBy,
             installedAt = CURRENT_TIMESTAMP`,
        { pip, module, version, requirement, requestedBy, approvedBy }
    );
}

/** True when this pip name is already in the overlay inventory. */
async function has(pip) {
    return Boolean(await db.get('SELECT 1 AS x FROM sandbox_packages WHERE pip = @pip', { pip }));
}

/**
 * /forget-me: the packages stay (they are host state every user shares),
 * but the requester/approver attribution goes.
 * @returns {number} rows anonymized
 */
async function anonymizeUser(userId) {
    return (await db.run(
        `UPDATE sandbox_packages SET
             requestedBy = CASE WHEN requestedBy = @userId THEN NULL ELSE requestedBy END,
             approvedBy = CASE WHEN approvedBy = @userId THEN NULL ELSE approvedBy END
         WHERE requestedBy = @userId OR approvedBy = @userId`,
        { userId }
    )).changes;
}

module.exports = { list, modules, requirements, record, has, anonymizeUser };
