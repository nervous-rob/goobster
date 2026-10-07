/**
 * Where a bootstrapped install puts things when nobody said otherwise, and
 * the environment that makes the manager the bootstrapper starts agree with
 * those roots (the install preflight refuses a plan whose data, config and
 * manager-store roots differ from the manager's own settings).
 *
 *   run as root       code   /opt/goobster
 *                     data   /var/lib/goobster/data     config /var/lib/goobster/config/config.json
 *                     store  /var/lib/goobster/data/manager   cache /var/lib/goobster/cache   logs /var/lib/goobster/logs
 *   run as a person   everything under $GOOBSTER_HOME, else $XDG_DATA_HOME/goobster, else ~/.local/share/goobster
 *   --base <dir>      everything under <dir> (code/, data/, config/config.json, cache/, logs/)
 *
 * The config file sits in its own directory so the service's ReadWritePaths
 * never has to open the whole state directory to write one file.
 */

const path = require('node:path');

const SYSTEM_CODE = '/opt/goobster';
const SYSTEM_STATE = '/var/lib/goobster';

function under(base) {
    return {
        code: path.join(base, 'code'),
        data: path.join(base, 'data'),
        config: path.join(base, 'config', 'config.json'),
        cache: path.join(base, 'cache'),
        logs: path.join(base, 'logs'),
        managerStore: path.join(base, 'data', 'manager')
    };
}

/**
 * @param {{ env?: Object, euid?: number|null, home?: string, base?: string|null }} options
 * @returns {{ code: string, data: string, config: string, cache: string, logs: string, managerStore: string }}
 */
function defaultRoots({ env = process.env, euid = typeof process.geteuid === 'function' ? process.geteuid() : null, home = null, base = null } = {}) {
    if (base) return under(path.resolve(base));
    if (euid === 0) {
        return {
            code: SYSTEM_CODE,
            data: path.join(SYSTEM_STATE, 'data'),
            config: path.join(SYSTEM_STATE, 'config', 'config.json'),
            cache: path.join(SYSTEM_STATE, 'cache'),
            logs: path.join(SYSTEM_STATE, 'logs'),
            managerStore: path.join(SYSTEM_STATE, 'data', 'manager')
        };
    }
    const person = home || env.HOME || '/';
    const goobsterHome = env.GOOBSTER_HOME || path.join(env.XDG_DATA_HOME || path.join(person, '.local', 'share'), 'goobster');
    return under(goobsterHome);
}

/** The environment the manager and the install CLI read their roots from. */
function rootsEnvironment(roots) {
    return {
        GOOBSTER_INSTALL_ROOT: roots.code,
        GOOBSTER_DATA_DIR: roots.data,
        GOOBSTER_CONFIG_PATH: roots.config,
        GOOBSTER_MANAGER_STATE_DIR: roots.managerStore,
        GOOBSTER_CACHE_DIR: roots.cache,
        GOOBSTER_LOG_DIR: roots.logs
    };
}

module.exports = { SYSTEM_CODE, SYSTEM_STATE, defaultRoots, rootsEnvironment };
