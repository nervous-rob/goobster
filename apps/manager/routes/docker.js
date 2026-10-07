/**
 * The Docker database route of the manager API (documentation/docker_postgres.md),
 * under /manager/api:
 *
 *   GET /docker/status   readAuth   the daemon check (CLI, daemon, socket permission, Docker
 *                                   Desktop or Engine, platform, the pinned image and whether
 *                                   it is pulled, the host's pg_dump and the verdict, free space
 *                                   under `?storage=<absolute path>`) and, once an installation
 *                                   exists, what this manager owns (container, health, port,
 *                                   storage, image). Read only: it never pulls, creates or
 *                                   starts anything, and carries no password, URL or
 *                                   environment value.
 *
 * Changing anything is an operation kind (`database.docker.*`).
 */

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { ManagerError } = require('../errors');
const { createDockerService, mapDocker } = require('../docker/service');

function mountDockerRoutes(api, { route, readAuth, manager, now = () => new Date() }) {
    const settings = manager.settings;
    const fs = manager.fs || nodeFs;

    api.get('/docker/status', route(async (req) => {
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
            return await createDockerService({ settings, fs, now, logger: { info() {}, warn() {}, error() {} } }).status({ installationId, storagePath });
        } catch (error) {
            throw mapDocker(error);
        }
    }));
}

module.exports = { mountDockerRoutes };
