/**
 * `{ owned: 'native' }` in place of a connection (documentation/native_postgres.md):
 * "the native PostgreSQL cluster this manager provisioned". The generated
 * application password was staged in the overlay (environment.js STAGED_KEYS)
 * when the role was created, so `database.connect` and the migration can use it
 * without anyone typing or seeing it. The reference is expanded into an ordinary
 * connection object in memory; everything after that is the #338 path unchanged.
 */

const { ManagerError } = require('../errors');
const environment = require('../environment');
const { connectionLib } = require('../database/input');

const STAGED = 'GOOBSTER_NATIVE_DB_URL';
const REF_KEYS = ['owned'];

function isRef(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).length === REF_KEYS.length && value.owned === 'native';
}

function missing(message) {
    return new ManagerError(409, 'NO_NATIVE_DATABASE', message);
}

/** The staged application URL itself, for the migration's `target.url`. */
function stagedUrl(settings, fs) {
    const { values } = environment.read(settings.storeDir, fs);
    if (!values[STAGED]) throw missing('There is no native database waiting to be connected: provision one first (database native provision), or give a target URL.');
    return values[STAGED];
}

/** The raw connection input for the staged URL, with the password in it (in memory only). */
function resolve(settings, fs) {
    const { values } = environment.read(settings.storeDir, fs);
    const url = values[STAGED];
    if (!url) throw missing('There is no native database waiting to be connected: provision one first (database native provision), or give a connection.');
    let password;
    try {
        password = decodeURIComponent(new URL(url).password);
    } catch {
        throw missing('The staged native connection cannot be read; provision the database again.');
    }
    const of = connectionLib.connectionOfUrl(url);
    return { ...of, password, tls: { mode: of.tls.mode } };
}

/** `value` unchanged unless it is the owned reference. */
function expand(value, settings, fs) {
    return isRef(value) ? resolve(settings, fs) : value;
}

module.exports = { STAGED, isRef, resolve, expand, stagedUrl };
