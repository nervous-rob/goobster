/**
 * Start-up reconciliation of a cutover that was interrupted between its
 * steps (documentation/db_migration.md, "The cutover and its order").
 *
 * The cutover writes, in this order: the intent (`cutover.phase =
 * 'switching'`, in migration.json), then the connection switch (the one
 * atomic rename of the environment overlay), then the installation record's
 * `database`, then `status = 'switched'`. A crash after the overlay rename
 * and before the record leaves the overlay as the truth: this brings the
 * record and the state into line with it. A crash before the rename left the
 * source configuration as it was: nothing to bring in line.
 */

const nodeFs = require('node:fs');
const environment = require('../environment');
const { createMigrationState } = require('./state');
const { lazy } = require('../lazy');

const targetLib = lazy('@goobster/core/db/migration/target');

function overlayMatches(storeDir, fs, state) {
    const { values } = environment.read(storeDir, fs);
    if (!values.GOOBSTER_DB_URL) return false;
    try {
        return targetLib.describeTarget(values.GOOBSTER_DB_URL).fingerprint === state.target.fingerprint;
    } catch {
        return false;
    }
}

/**
 * @param {Object} params
 * @param {Object} params.settings
 * @param {Object} params.store the manager store (readInstallation / updateInstallation)
 * @returns {{ reconciled: boolean, action: string|null }} never throws
 */
function reconcileMigration({ settings, store, fs = nodeFs, now = () => new Date(), logger = console }) {
    try {
        const state = createMigrationState({ storeDir: settings.storeDir, fs, now });
        const { doc } = state.read();
        if (!doc || !['running', 'failed'].includes(doc.status) || !doc.cutover || doc.cutover.phase !== 'switching') return { reconciled: false, action: null };
        if (!overlayMatches(settings.storeDir, fs, doc)) {
            state.update(next => ({ ...next, status: 'failed', cutover: { ...next.cutover, phase: 'not-written' }, failure: { step: 'cutover', code: 'INTERRUPTED', at: now().toISOString() } }));
            return { reconciled: true, action: 'switch-not-written' };
        }
        const current = store.readInstallation();
        if (current.status === 'ok' && current.doc.database && current.doc.database.engine !== 'postgres') {
            store.updateInstallation(draft => ({ ...draft, database: { engine: 'postgres', external: true } }));
        }
        const { values } = environment.read(settings.storeDir, fs);
        environment.apply(settings, values);
        state.update(next => ({ ...next, status: 'switched', switchedAt: next.switchedAt || now().toISOString(), cutover: { ...next.cutover, phase: 'done', reconciled: true }, failure: null }));
        return { reconciled: true, action: 'completed-cutover' };
    } catch (error) {
        logger.warn?.(`[manager] migration reconciliation failed: ${error && (error.code || error.name)}`);
        return { reconciled: false, action: 'failed' };
    }
}

module.exports = { reconcileMigration };
