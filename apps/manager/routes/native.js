/**
 * The native database route of the manager API (documentation/native_postgres.md),
 * under /manager/api:
 *
 *   GET /native/status   readAuth   the host check (distribution and architecture, whether a
 *                                   managed native PostgreSQL is supported here, the
 *                                   packages, the clusters that exist and which of them
 *                                   this manager owns, systemd, SELinux, the host's pg_dump
 *                                   and the verdict, free space and mount facts under
 *                                   `?storage=<absolute path>`, and whether a privileged helper
 *                                   can run) and, once an installation exists, what this
 *                                   manager owns (cluster, port, data directory, step).
 *                                   Read only: it never installs, creates, starts or elevates
 *                                   anything, and carries no password, URL or environment value.
 *
 * Changing anything is an operation kind (`database.native.*`).
 */

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { ManagerError } = require('../errors');
const { createNativeService, mapNative } = require('../native/service');

function mountNativeRoutes(api, { route, readAuth, manager, now = () => new Date() }) {
    const settings = manager.settings;
    const fs = manager.fs || nodeFs;

    api.get('/native/status', route(async (req) => {
        readAuth(req);
        let storagePath = null;
        if (req.query && req.query.storage !== undefined) {
            const asked = req.query.storage;
            if (typeof asked !== 'string' || !nodePath.isAbsolute(asked) || asked.includes('\0') || asked.split(/[\\/]/).includes('..') || asked.length > 1024) {
                throw new ManagerError(400, 'INVALID_INPUT', '"storage" must be an absolute directory path without ".." segments.');
            }
            storagePath = nodePath.normalize(asked);
        }
        const read = manager.store.readInstallation();
        const installationId = read.status === 'ok' ? read.doc.installationId : null;
        try {
            return await createNativeService({ settings, fs, now, logger: { info() {}, warn() {}, error() {} } }).status({ installationId, storagePath });
        } catch (error) {
            throw mapNative(error);
        }
    }));
}

module.exports = { mountNativeRoutes };
