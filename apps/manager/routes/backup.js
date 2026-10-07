/**
 * The backup routes of the manager API (documentation/backup_and_restore.md),
 * under /manager/api:
 *
 *   GET /backup/inspect?dir=<absolute path>   readAuth   what an archive holds and whether
 *                                                        this installation can restore it: counts, file
 *                                                        sets, whether config.json is included (and that
 *                                                        only it is encrypted), the engine and schema
 *                                                        verdicts, the secrets to re-enter. Reads the
 *                                                        archive only; echoes only the path it was given.
 *   GET /backup/status                        readAuth   the suggested destination, the engine, and the
 *                                                        state of the last restore (sub-steps, what is
 *                                                        retained, what failed)
 *
 * Writing a backup and restoring one are operation kinds (`backup.create`,
 * `backup.restore`) through the operations API: they take a passphrase and
 * a typed confirmation, which stay in memory.
 */

const { ManagerError } = require('../errors');
const { inspectArchive, backupStatus } = require('../backup/view');

function mountBackupRoutes(api, { route, readAuth, manager }) {
    api.get('/backup/inspect', route((req) => {
        readAuth(req);
        for (const key of Object.keys(req.query || {})) {
            if (key !== 'dir') throw new ManagerError(400, 'INVALID_INPUT', 'The query has a parameter the inspection does not accept.');
        }
        const { dir } = req.query || {};
        if (typeof dir !== 'string' || dir.length === 0 || dir.length > 4096) {
            throw new ManagerError(400, 'INVALID_INPUT', '"dir" must be an absolute path to an archive directory.');
        }
        return inspectArchive({ settings: manager.settings, dir });
    }));

    api.get('/backup/status', route((req) => {
        readAuth(req);
        return backupStatus({ settings: manager.settings });
    }));
}

module.exports = { mountBackupRoutes };
