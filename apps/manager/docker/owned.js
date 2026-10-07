/**
 * `{ owned: 'docker' }` in place of a connection (documentation/docker_postgres.md):
 * "the Docker database this manager provisioned". The generated application
 * password was staged in the overlay (environment.js STAGED_KEYS) when the role
 * was created, so `database.connect` and the migration can use it without anyone
 * typing or seeing it. The reference is expanded into an ordinary connection
 * object in memory; everything after that is the #338 path unchanged.
 */

const { ManagerError } = require('../errors');
const environment = require('../environment');
const { connectionLib } = require('../database/input');

const REF_KEYS = ['owned'];

function isRef(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).length === REF_KEYS.length && value.owned === 'docker';
}

/** The staged application URL itself, for the migration's `target.url`. */
function stagedUrl(settings, fs) {
    const { values } = environment.read(settings.storeDir, fs);
    if (!values.GOOBSTER_DOCKER_DB_URL) {
        throw new ManagerError(409, 'NO_DOCKER_DATABASE', 'There is no Docker database waiting to be connected: provision one first (database docker provision), or give a target URL.');
    }
    return values.GOOBSTER_DOCKER_DB_URL;
}

/** The raw connection input for the staged URL, with the password in it (in memory only). */
function resolve(settings, fs) {
    const { values } = environment.read(settings.storeDir, fs);
    const url = values.GOOBSTER_DOCKER_DB_URL;
    if (!url) {
        throw new ManagerError(409, 'NO_DOCKER_DATABASE', 'There is no Docker database waiting to be connected: provision one first (database docker provision), or give a connection.');
    }
    let password;
    try {
        password = decodeURIComponent(new URL(url).password);
    } catch {
        throw new ManagerError(409, 'NO_DOCKER_DATABASE', 'The staged Docker connection cannot be read; provision the database again.');
    }
    const of = connectionLib.connectionOfUrl(url);
    return { ...of, password, tls: { mode: of.tls.mode } };
}

/** `value` unchanged unless it is the owned reference. */
function expand(value, settings, fs) {
    return isRef(value) ? resolve(settings, fs) : value;
}

module.exports = { isRef, resolve, expand, stagedUrl };
