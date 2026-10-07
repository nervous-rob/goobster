'use strict';

/**
 * The small glob dialect of descriptor `payload.files` (documentation/packaging.md):
 * `**` any number of path segments, `*` and `?` within one segment,
 * `{a,b}` alternatives. Paths are repository-relative and POSIX.
 *
 * When several groups' globs match one file, the most specific glob wins:
 * the one with the longest literal prefix before its first wildcard (an
 * exact path beats any wildcard). Two different groups tied for the most
 * specific match is an ownership conflict, never a silent choice.
 */

function escape(text) {
    return text.replace(/[.+^$()|[\]\\]/g, '\\$&');
}

function compileGlob(glob) {
    if (typeof glob !== 'string' || !glob || glob.startsWith('/') || glob.includes('..') || glob.includes('\\')) {
        throw new Error(`Invalid payload glob ${JSON.stringify(glob)}: use a repository-relative POSIX pattern.`);
    }
    let source = '';
    for (let i = 0; i < glob.length; i += 1) {
        const ch = glob[i];
        if (ch === '*' && glob[i + 1] === '*') {
            const slash = glob[i + 2] === '/';
            source += slash ? '(?:.*/)?' : '.*';
            i += slash ? 2 : 1;
        } else if (ch === '*') {
            source += '[^/]*';
        } else if (ch === '?') {
            source += '[^/]';
        } else if (ch === '{') {
            const end = glob.indexOf('}', i);
            if (end === -1) throw new Error(`Unclosed "{" in payload glob ${JSON.stringify(glob)}.`);
            source += `(?:${glob.slice(i + 1, end).split(',').map(escape).join('|')})`;
            i = end;
        } else {
            source += escape(ch);
        }
    }
    const wildcard = glob.search(/[*?{]/);
    return {
        glob,
        regex: new RegExp(`^${source}$`),
        specificity: wildcard === -1 ? Number.MAX_SAFE_INTEGER : wildcard
    };
}

/**
 * @param {Object<string, string[]>} globsByOwner  owner id -> globs
 * @returns {(file: string) => { owner: string|null, glob: string|null, conflict: string[]|null }}
 */
function createOwnerMatcher(globsByOwner) {
    const compiled = [];
    for (const [owner, globs] of Object.entries(globsByOwner)) {
        for (const glob of globs || []) compiled.push({ owner, ...compileGlob(glob) });
    }
    return function match(file) {
        let best = null;
        let tied = new Set();
        for (const entry of compiled) {
            if (!entry.regex.test(file)) continue;
            if (!best || entry.specificity > best.specificity) {
                best = entry;
                tied = new Set([entry.owner]);
            } else if (entry.specificity === best.specificity) {
                tied.add(entry.owner);
            }
        }
        if (!best) return { owner: null, glob: null, conflict: null };
        if (tied.size > 1) return { owner: null, glob: best.glob, conflict: [...tied].sort() };
        return { owner: best.owner, glob: best.glob, conflict: null };
    };
}

module.exports = { compileGlob, createOwnerMatcher };
