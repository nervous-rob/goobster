/**
 * Resource identity of a manager-owned Docker Postgres instance
 * (documentation/docker_postgres.md): every container, volume and network name
 * carries the first eight hex digits of the installation id, and every one of
 * them is labelled with the whole id. A mutating command names its target by
 * exact name and re-checks the labels first (`assertOwned`): a resource that
 * lacks them is somebody else's and is never touched (`RESOURCE_FOREIGN`).
 */

const { DockerError } = require('./errors');

const LABEL_INSTALLATION = 'io.goobster.installation';
const LABEL_ROLE = 'io.goobster.role';
const LABEL_MANAGER = 'io.goobster.manager';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLES = Object.freeze({ container: 'postgres', volume: 'postgres-data', network: 'postgres-network' });

function shortId(installationId) {
    if (typeof installationId !== 'string' || !UUID.test(installationId)) {
        throw new DockerError('INVALID_INSTALLATION_ID', 'The installation id is not a UUID, so no Docker resource can be named after it.');
    }
    return installationId.replace(/-/g, '').slice(0, 8).toLowerCase();
}

/** The three resource names and their labels for one installation. */
function resourcesFor(installationId) {
    const id8 = shortId(installationId);
    const labels = (role) => Object.freeze({
        [LABEL_INSTALLATION]: installationId.toLowerCase(),
        [LABEL_ROLE]: role,
        [LABEL_MANAGER]: '1'
    });
    return Object.freeze({
        id8,
        installationId: installationId.toLowerCase(),
        container: Object.freeze({ kind: 'container', name: `goobster-pg-${id8}`, labels: labels(ROLES.container) }),
        volume: Object.freeze({ kind: 'volume', name: `goobster-pgdata-${id8}`, labels: labels(ROLES.volume) }),
        network: Object.freeze({ kind: 'network', name: `goobster-${id8}`, labels: labels(ROLES.network) })
    });
}

/** `--label k=v` arguments for a resource. */
function labelArgs(resource) {
    return Object.entries(resource.labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]);
}

/**
 * Throws `RESOURCE_FOREIGN` unless `labels` (what `docker inspect` returned for
 * the resource named `resource.name`) carry this installation's id and manager marker.
 */
function assertOwned(resource, labels, { installationId }) {
    const found = labels && typeof labels === 'object' ? labels : {};
    const owned = String(found[LABEL_INSTALLATION] || '').toLowerCase() === String(installationId).toLowerCase()
        && found[LABEL_MANAGER] === '1'
        && found[LABEL_ROLE] === resource.labels[LABEL_ROLE];
    if (!owned) {
        throw new DockerError('RESOURCE_FOREIGN', `The ${resource.kind} "${resource.name}" does not carry this installation's labels. It is not touched.`, { kind: resource.kind, name: resource.name });
    }
    return true;
}

/** A resource name this module could have produced for some installation (used to refuse anything else on a command line). */
function isOwnName(name) {
    return /^goobster-(pg|pgdata)-[0-9a-f]{8}$/.test(String(name)) || /^goobster-[0-9a-f]{8}$/.test(String(name));
}

module.exports = { LABEL_INSTALLATION, LABEL_ROLE, LABEL_MANAGER, ROLES, shortId, resourcesFor, labelArgs, assertOwned, isOwnName };
