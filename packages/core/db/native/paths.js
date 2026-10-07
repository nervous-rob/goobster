/**
 * Data-directory rules the planner applies before anything is asked of the
 * privileged helper (documentation/native_postgres.md, "Storage"). The helper
 * applies the same rules again, from its own copy, on the real machine: this
 * module is how a plan and the Host card say "no" early and with a reason.
 */

const nodePath = require('node:path');
const { layoutFor, MAJOR } = require('./packages');

/** Exactly these paths, and everything under the trees below, are never a data directory. */
const SYSTEM_PATHS = Object.freeze(['/', '/bin', '/boot', '/dev', '/etc', '/home', '/lib', '/lib32', '/lib64', '/media', '/mnt', '/opt', '/proc', '/root', '/run', '/sbin', '/srv', '/sys', '/tmp', '/usr', '/var']);
const SYSTEM_TREES = Object.freeze(['/bin', '/boot', '/dev', '/etc', '/lib', '/lib32', '/lib64', '/proc', '/root', '/run', '/sbin', '/sys', '/usr', '/var/lib/systemd', '/var/lib/dpkg', '/var/lib/rpm']);
/** Cleaned by the system or not a place to build in. */
const TRANSIENT_TREES = Object.freeze(['/tmp', '/var/tmp', '/dev', '/run', '/proc', '/sys', '/var/run', '/var/cache', '/var/log', '/var/spool', '/var/mail']);
const PATH_PATTERN = /^\/[A-Za-z0-9._+/-]+$/;

const inside = (parent, child) => child === parent || child.startsWith(parent.endsWith('/') ? parent : `${parent}/`);

/**
 * @param {unknown} value
 * @param {{ allowTransient?: boolean }} [options] tests build under /tmp
 * @returns {{ ok: true, path: string }|{ ok: false, code: string, detail: string }}
 */
function checkDataDirectory(value, { allowTransient = false } = {}) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 200 || value.includes('\0')) return { ok: false, code: 'INVALID_PATH', detail: 'The data directory must be an absolute path of at most 200 characters.' };
    if (!nodePath.posix.isAbsolute(value) || nodePath.posix.normalize(value) !== value || value.endsWith('/') || value.split('/').includes('..')) return { ok: false, code: 'INVALID_PATH', detail: 'The data directory must be an absolute, normalised path without ".." segments.' };
    if (!PATH_PATTERN.test(value)) return { ok: false, code: 'INVALID_PATH', detail: 'The data directory may contain letters, digits and . _ + - / only (no space).' };
    if (SYSTEM_PATHS.includes(value) || SYSTEM_TREES.some(tree => inside(tree, value)) || value.split('/').filter(Boolean).length < 2) {
        return { ok: false, code: 'PATH_NOT_ALLOWED', detail: 'That location belongs to the operating system; a database is not built there.' };
    }
    if (!allowTransient && TRANSIENT_TREES.some(tree => inside(tree, value))) {
        return { ok: false, code: 'PATH_NOT_ALLOWED', detail: 'A database is not built under /tmp, /run or another place the system cleans.' };
    }
    return { ok: true, path: value };
}

/** The directory a fresh install uses when none is chosen. */
function defaultDataDirectory(family, clusterName) {
    return `${layoutFor(family).defaultDataParent}/${clusterName}`;
}

/** Is `value` the data directory of a cluster the distribution creates itself (`.../<major>/main`, `/var/lib/pgsql/<major>/data`)? */
function isDistributionDirectory(family, value) {
    const layout = layoutFor(family);
    return family === 'debian'
        ? new RegExp(`^${layout.mainDataRoot}/\\d{1,2}/main(/|$)`).test(value)
        : new RegExp(`^${layout.mainDataRoot}/(\\d{1,2}/)?data(/|$)`).test(value);
}

module.exports = { SYSTEM_PATHS, SYSTEM_TREES, TRANSIENT_TREES, PATH_PATTERN, MAJOR, inside, checkDataDirectory, defaultDataDirectory, isDistributionDirectory };
