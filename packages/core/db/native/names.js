/**
 * Names of the resources of a native install, derived from the installation id
 * (documentation/native_postgres.md). Only a name this module could have produced
 * is ever put on a command line; a cluster, unit or directory that merely looks
 * similar is "foreign" and is never touched.
 */

const { NativeError } = require('./errors');
const { MAJOR, layoutFor } = require('./packages');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLUSTER_NAME = /^goobster(-[0-9a-f]{8})?$/;
const MARKER_FILE = 'goobster-installation';
const RELOCATING_FILE = 'goobster-relocating';

function shortId(installationId) {
    if (typeof installationId !== 'string' || !UUID.test(installationId)) {
        throw new NativeError('INVALID_INSTALLATION_ID', 'The installation id is not a UUID, so no native database resource can be named after it.');
    }
    return installationId.replace(/-/g, '').slice(0, 8).toLowerCase();
}

/**
 * The cluster is called `goobster`; when a cluster of that name exists and is not
 * ours, `goobster-<id8>`.
 * @param {string} installationId
 * @param {Iterable<string>} [taken] cluster names that exist on this machine
 */
function clusterNameFor(installationId, taken = []) {
    const used = new Set(taken);
    return used.has('goobster') ? `goobster-${shortId(installationId)}` : 'goobster';
}

/** Everything a family derives from a cluster name. */
function resourcesFor({ family, installationId, clusterName, dataDirectory = null }) {
    if (!CLUSTER_NAME.test(clusterName)) throw new NativeError('INVALID_CLUSTER_NAME', 'The cluster name is not one this installer creates.');
    const layout = layoutFor(family);
    const data = dataDirectory || `${layout.defaultDataParent}/${clusterName}`;
    const base = {
        family,
        major: MAJOR,
        installationId: installationId ? String(installationId).toLowerCase() : null,
        clusterName,
        dataDirectory: data,
        markerFile: `${data}/${MARKER_FILE}`
    };
    if (family === 'debian') {
        return { ...base, service: `postgresql@${MAJOR}-${clusterName}.service`, configDirectory: `${layout.configRoot}/${MAJOR}/${clusterName}`, dropIn: `/etc/systemd/system/postgresql@${MAJOR}-${clusterName}.service.d/goobster.conf` };
    }
    return { ...base, service: `postgresql${MAJOR}-${clusterName}.service`, configDirectory: data, unitFile: `/etc/systemd/system/postgresql${MAJOR}-${clusterName}.service` };
}

module.exports = { UUID, CLUSTER_NAME, MARKER_FILE, RELOCATING_FILE, shortId, clusterNameFor, resourcesFor };
