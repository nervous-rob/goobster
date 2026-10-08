/**
 * Path rules for the installation roots: sanity (absolute, no traversal,
 * not nested the wrong way), containment, symlink escapes, and the guard
 * every deletion goes through. Nothing here reads a file's content.
 */

const nodeFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ManagerError } = require('../errors');

function isInside(parent, child) {
    const rel = path.relative(parent, child);
    if (rel === '' || path.isAbsolute(rel)) return false;
    return rel.split(path.sep)[0] !== '..';
}

const isSameOrInside = (parent, child) => parent === child || isInside(parent, child);

/** Why a raw root value is unusable, or null. */
function rawProblem(value) {
    if (typeof value !== 'string' || value.length === 0) return 'PATH_INVALID';
    if (value.includes('\0') || value.length > 4096) return 'PATH_INVALID';
    if (!path.isAbsolute(value)) return 'PATH_NOT_ABSOLUTE';
    if (value.split(/[\\/]+/).includes('..')) return 'PATH_TRAVERSAL';
    return null;
}

/** The real path of `target`, or of its nearest existing ancestor plus the remainder. */
function realish(target, fs = nodeFs) {
    let current = path.resolve(target);
    const rest = [];
    for (;;) {
        try {
            return path.join(fs.realpathSync(current), ...rest.reverse());
        } catch (error) {
            const parent = path.dirname(current);
            if (parent === current) return path.resolve(target);
            rest.push(path.basename(current));
            current = parent;
            if (error && error.code === 'ELOOP') return path.resolve(target);
        }
    }
}

function isSymlink(target, fs = nodeFs) {
    try {
        return fs.lstatSync(target).isSymbolicLink();
    } catch {
        return false;
    }
}

/**
 * Throw PATH_ESCAPE when `child`, lexically inside `parent`, resolves
 * outside it (a symlinked directory, or a symlink root).
 */
function assertContained(parent, child, fs = nodeFs) {
    if (isSymlink(child, fs) && !isPayloadLink(path.resolve(child), parent, fs)) {
        throw new ManagerError(409, 'PATH_ESCAPE', 'A recorded root is a symbolic link; the installer will not operate through it.');
    }
    const realParent = realish(parent, fs);
    const realChild = realish(child, fs);
    if (!isSameOrInside(realParent, realChild)) {
        throw new ManagerError(409, 'PATH_ESCAPE', 'A path resolves outside the installation root through a symbolic link.');
    }
}

/**
 * Throw when removing `target` could take more than the installation:
 * a filesystem root, the home directory or a parent of it, a path of fewer
 * than two components, the code root itself or a parent of it.
 */
function assertRemovable(target, { codeRoot = null, home = os.homedir(), fs = nodeFs, payloadRoot = null } = {}) {
    const resolved = path.resolve(target);
    const problem = rawProblem(target);
    if (problem) throw new ManagerError(409, 'PATH_ESCAPE', 'A recorded root is not a usable absolute path.');
    if (path.parse(resolved).root === resolved || resolved.split(path.sep).filter(Boolean).length < 2) {
        throw new ManagerError(409, 'PATH_ESCAPE', 'Refusing to remove a filesystem root or a top-level directory.');
    }
    if (home && isSameOrInside(resolved, path.resolve(home))) {
        throw new ManagerError(409, 'PATH_ESCAPE', 'Refusing to remove the home directory or one of its parents.');
    }
    if (codeRoot && isSameOrInside(resolved, path.resolve(codeRoot))) {
        throw new ManagerError(409, 'PATH_ESCAPE', 'Refusing to remove the code root or a directory that contains it.');
    }
    if (isSymlink(resolved, fs) && !isPayloadLink(resolved, payloadRoot, fs)) {
        throw new ManagerError(409, 'PATH_ESCAPE', 'A recorded root is a symbolic link; the installer will not operate through it.');
    }
    return resolved;
}

/**
 * A `current`/`previous` entry of the linked payload layout (Windows; `activationLayout` in
 * scripts/lib/payloadStage.js): a directory link that sits directly in `payloadRoot` and names a
 * payload under `<payloadRoot>/live`. The one link the installer made itself and will remove;
 * any other link is still refused.
 */
function isPayloadLink(resolved, payloadRoot, fs = nodeFs) {
    if (!payloadRoot || !isSymlink(resolved, fs)) return false;
    const root = path.resolve(payloadRoot);
    if (path.dirname(resolved) !== root) return false;
    let target;
    try {
        target = path.resolve(root, fs.readlinkSync(resolved));
    } catch {
        return false;
    }
    const live = path.join(root, 'live');
    return target !== live && isInside(live, target);
}

/**
 * Remove one owned directory or file. Never follows a link out of it: a payload link of the linked
 * layout is unlinked (its payload goes with `live`, a payload directory of its own), anything else
 * is removed whole. Returns whether anything was removed.
 */
function removeOwned(target, options = {}) {
    const fs = options.fs || nodeFs;
    const resolved = assertRemovable(target, options);
    try {
        fs.lstatSync(resolved);
    } catch (error) {
        if (error && error.code === 'ENOENT') return false;
        throw error;
    }
    if (isPayloadLink(resolved, options.payloadRoot, fs)) {
        fs.unlinkSync(resolved);
        return true;
    }
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    return true;
}

/** rmdir that only succeeds on an empty directory. */
function removeIfEmpty(target, fs = nodeFs) {
    try {
        fs.rmdirSync(target);
        return true;
    } catch {
        return false;
    }
}

/** Findings for a set of roots: nesting that would let one root's removal take another's data. */
function nestingProblems(roots) {
    const out = [];
    const payload = ['current', 'previous', 'staging', 'releases', 'live'].map(name => path.join(roots.code, name));
    const names = ['data', 'config', 'cache', 'logs', 'uploads', 'managerStore'];
    for (const name of names) {
        for (const dir of payload) {
            if (isSameOrInside(dir, roots[name])) out.push({ code: 'ROOT_INSIDE_PAYLOAD', detail: `${name} is inside the payload directory ${path.basename(dir)}` });
        }
        if (roots[name] === roots.code) out.push({ code: 'ROOT_NESTED', detail: `${name} is the code root` });
    }
    for (const name of ['data', 'cache', 'logs']) {
        if (isInside(roots[name], roots.code)) out.push({ code: 'ROOT_NESTED', detail: `the code root is inside ${name}` });
    }
    const seen = new Map();
    for (const name of ['code', 'data', 'cache', 'logs']) {
        const key = roots[name];
        if (seen.has(key)) out.push({ code: 'ROOT_NESTED', detail: `${name} and ${seen.get(key)} are the same directory` });
        seen.set(key, name);
    }
    for (const [a, b] of [['cache', 'data'], ['logs', 'data'], ['cache', 'logs']]) {
        if (isInside(roots[a], roots[b]) || isInside(roots[b], roots[a])) out.push({ code: 'ROOT_NESTED', detail: `${a} and ${b} are nested` });
    }
    return out;
}

/**
 * The folders the setup pages (every caller that is not the local command
 * line) may install into, per platform. Anything else needs the CLI.
 * @param {{ home?: string, platform?: NodeJS.Platform, env?: Object }} [params]
 * @returns {string[]}
 */
function allowedBases({ home = os.homedir(), platform = process.platform, env = process.env } = {}) {
    if (platform === 'win32') {
        const lib = path.win32;
        const out = [];
        if (env.LOCALAPPDATA) out.push(lib.join(env.LOCALAPPDATA, 'Goobster'));
        if (env.ProgramData) out.push(lib.join(env.ProgramData, 'Goobster'));
        out.push(lib.join(`${/^[A-Za-z]:$/.test(env.SystemDrive || '') ? env.SystemDrive : 'C:'}\\`, 'Goobster'));
        return out;
    }
    if (platform === 'darwin') return [path.posix.join(home, 'Library', 'Application Support', 'Goobster'), '/opt/goobster'];
    return [home, '/opt/goobster', '/srv/goobster', '/var/lib/goobster', '/usr/local/goobster'];
}

/** A Windows drive-root `Goobster` folder on any drive. */
const WINDOWS_DRIVE_BASE = /^[A-Za-z]:\\Goobster(\\|$)/i;

/**
 * Whether `target` is one of `bases` or inside one, after resolving the part
 * of it that exists (a symlink out of a base does not count as inside it).
 */
function isUnderAllowedBase(target, bases, { platform = process.platform, fs = nodeFs } = {}) {
    if (platform === 'win32') {
        const lib = path.win32;
        const resolved = lib.resolve(String(target));
        if (WINDOWS_DRIVE_BASE.test(resolved)) return true;
        const key = (value) => lib.resolve(value).toLowerCase();
        return bases.some(base => key(resolved) === key(base) || key(resolved).startsWith(`${key(base)}\\`));
    }
    const resolved = realish(target, fs);
    return bases.some(base => isSameOrInside(realish(base, fs), resolved));
}

module.exports = {
    allowedBases,
    isUnderAllowedBase,
    isInside,
    isSameOrInside,
    rawProblem,
    realish,
    isSymlink,
    assertContained,
    assertRemovable,
    isPayloadLink,
    removeOwned,
    removeIfEmpty,
    nestingProblems
};
