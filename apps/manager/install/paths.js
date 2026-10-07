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
    if (isSymlink(child, fs)) {
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
 * than two components, or a parent of the code root.
 */
function assertRemovable(target, { codeRoot = null, home = os.homedir(), fs = nodeFs } = {}) {
    const resolved = path.resolve(target);
    const problem = rawProblem(target);
    if (problem) throw new ManagerError(409, 'PATH_ESCAPE', 'A recorded root is not a usable absolute path.');
    if (path.parse(resolved).root === resolved || resolved.split(path.sep).filter(Boolean).length < 2) {
        throw new ManagerError(409, 'PATH_ESCAPE', 'Refusing to remove a filesystem root or a top-level directory.');
    }
    if (home && isSameOrInside(resolved, path.resolve(home))) {
        throw new ManagerError(409, 'PATH_ESCAPE', 'Refusing to remove the home directory or one of its parents.');
    }
    if (codeRoot && isInside(resolved, path.resolve(codeRoot))) {
        throw new ManagerError(409, 'PATH_ESCAPE', 'Refusing to remove a directory that contains the code root.');
    }
    if (isSymlink(resolved, fs)) {
        throw new ManagerError(409, 'PATH_ESCAPE', 'A recorded root is a symbolic link; the installer will not operate through it.');
    }
    return resolved;
}

/** Remove one owned directory or file. Never follows a link out of it. Returns whether anything was removed. */
function removeOwned(target, options = {}) {
    const fs = options.fs || nodeFs;
    const resolved = assertRemovable(target, options);
    try {
        fs.lstatSync(resolved);
    } catch (error) {
        if (error && error.code === 'ENOENT') return false;
        throw error;
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
    const payload = ['current', 'previous', 'staging', 'releases'].map(name => path.join(roots.code, name));
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

module.exports = {
    isInside,
    isSameOrInside,
    rawProblem,
    realish,
    isSymlink,
    assertContained,
    assertRemovable,
    removeOwned,
    removeIfEmpty,
    nestingProblems
};
