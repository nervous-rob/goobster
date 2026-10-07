/**
 * Where a bootstrapped install puts things when nobody said otherwise, and
 * the environment that makes the manager the bootstrapper starts agree with
 * those roots (the install preflight refuses a plan whose data, config and
 * manager-store roots differ from the manager's own settings).
 *
 * Linux
 *   run as root       code   /opt/goobster
 *                     data   /var/lib/goobster/data     config /var/lib/goobster/config/config.json
 *                     store  /var/lib/goobster/data/manager   cache /var/lib/goobster/cache   logs /var/lib/goobster/logs
 *   run as a person   everything under $GOOBSTER_HOME, else $XDG_DATA_HOME/goobster, else ~/.local/share/goobster
 * macOS
 *   machine (root)    everything under /opt/goobster
 *   per user          everything under ~/Library/Application Support/Goobster
 * Windows
 *   elevated          everything under %ProgramData%\Goobster
 *   per user          everything under %LOCALAPPDATA%\Goobster
 *   --base <dir>      everything under <dir> (code/, data/, config/config.json, cache/, logs/)
 *
 * Every default sits under one of the bases the setup pages accept
 * (install/paths.js `allowedBases`), so the wizard's plan passes preflight.
 * The config file sits in its own directory so the service's writable paths
 * never have to open the whole state directory to write one file.
 */

const path = require('node:path');

const SYSTEM_CODE = '/opt/goobster';
const SYSTEM_STATE = '/var/lib/goobster';

function under(base, lib = path) {
    return {
        code: lib.join(base, 'code'),
        data: lib.join(base, 'data'),
        config: lib.join(base, 'config', 'config.json'),
        cache: lib.join(base, 'cache'),
        logs: lib.join(base, 'logs'),
        managerStore: lib.join(base, 'data', 'manager')
    };
}

/**
 * @param {Object} [options]
 * @param {Object} [options.env]
 * @param {number|null} [options.euid]     POSIX: 0 means a machine install
 * @param {boolean} [options.elevated]     the explicit form (Windows has no euid); defaults to `euid === 0`
 * @param {string} [options.home]
 * @param {string|null} [options.base]
 * @param {NodeJS.Platform} [options.platform]
 * @returns {{ code: string, data: string, config: string, cache: string, logs: string, managerStore: string }}
 */
function defaultRoots({ env = process.env, euid = typeof process.geteuid === 'function' ? process.geteuid() : null, elevated = euid === 0, home = null, base = null, platform = process.platform } = {}) {
    if (platform === 'win32') {
        const lib = path.win32;
        if (base) return under(lib.resolve(base), lib);
        const drive = /^[A-Za-z]:$/.test(env.SystemDrive || '') ? env.SystemDrive : 'C:';
        if (elevated) return under(lib.join(env.ProgramData || `${drive}\\ProgramData`, 'Goobster'), lib);
        const local = env.LOCALAPPDATA || lib.join(home || env.USERPROFILE || `${drive}\\Users\\Default`, 'AppData', 'Local');
        return under(lib.join(local, 'Goobster'), lib);
    }
    if (base) return under(path.resolve(base));
    if (platform === 'darwin') {
        if (elevated) return under(SYSTEM_CODE);
        const person = home || env.HOME || '/';
        return under(path.join(person, 'Library', 'Application Support', 'Goobster'));
    }
    if (elevated) {
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
