'use strict';

/**
 * Static require graph of the server source (documentation/packaging.md,
 * issue #328). Pure: reads files, never executes them.
 *
 * Edges come from string-literal `require('x')`, `require.resolve('x')`,
 * `requireOptional('x', { feature: 'id' })` and static ESM
 * `import ... from 'x'` / `export ... from 'x'`. A `require(expression)`
 * that is not a literal is reported as **dynamic** with its location; the
 * graph never guesses where it goes.
 *
 * `requireOptional(spec, { feature })` (packages/core/utils/optionalModule.js)
 * is the declared seam: the importer survives the target's absence, so the
 * edge is attributed to the named feature instead of the importing file's
 * owner, and closures that ask "what must be present" do not follow it.
 */

const fs = require('node:fs');
const path = require('node:path');
const { builtinModules } = require('node:module');

const BUILTINS = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
const SOURCE_EXT = /\.(c?js|mjs)$/;
const RESOLVE_SUFFIXES = ['', '.js', '.cjs', '.mjs', '.json', '/index.js', '/index.cjs'];
/** Instance files read through a relative require; never part of a payload (packaging_proof.md B1). */
const RUNTIME_FILES = new Set(['config.json']);

/** Workspace package name to repository directory. */
function workspaceDirs(root) {
    const dirs = {};
    for (const parent of ['packages', 'apps']) {
        const base = path.join(root, parent);
        if (!fs.existsSync(base)) continue;
        for (const name of fs.readdirSync(base).sort()) {
            const manifest = path.join(base, name, 'package.json');
            if (!fs.existsSync(manifest)) continue;
            try {
                const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8'));
                if (parsed.name) dirs[parsed.name] = `${parent}/${name}`;
            } catch { /* not a workspace */ }
        }
    }
    return dirs;
}

/**
 * Remove comments while keeping string, template and regex-free code
 * positions intact (line numbers survive: comment text becomes spaces).
 * Good enough for require scanning; not a JavaScript parser.
 */
function stripComments(source) {
    let out = '';
    let i = 0;
    const n = source.length;
    let quote = null;
    while (i < n) {
        const ch = source[i];
        const next = source[i + 1];
        if (quote) {
            out += ch;
            if (ch === '\\') { out += next || ''; i += 2; continue; }
            if (ch === quote) quote = null;
            else if (ch === '\n' && quote !== '`') quote = null;
            i += 1;
            continue;
        }
        if (ch === '/' && next === '*') {
            const end = source.indexOf('*/', i + 2);
            const stop = end === -1 ? n : end + 2;
            out += source.slice(i, stop).replace(/[^\n]/g, ' ');
            i = stop;
            continue;
        }
        if (ch === '/' && next === '/') {
            const prev = out.replace(/[ \t]+$/, '').slice(-1);
            // `//` after a value is a comment; inside a regex literal it is
            // rare enough in this tree to accept the approximation.
            if (prev !== ':' || /\s/.test(out.slice(-1))) {
                const end = source.indexOf('\n', i);
                const stop = end === -1 ? n : end;
                out += ' '.repeat(stop - i);
                i = stop;
                continue;
            }
        }
        if (ch === '\'' || ch === '"' || ch === '`') quote = ch;
        out += ch;
        i += 1;
    }
    return out;
}

function lineOf(text, index) {
    let line = 1;
    for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) line += 1;
    return line;
}

/**
 * Scan one source text.
 * @returns {{ specs: Array<{ spec, line, kind, feature, eager }>, dynamic: Array<{ line, text }> }}
 */
function scanSource(source) {
    const text = stripComments(source);
    const specs = [];
    const dynamic = [];
    const lineStart = (index) => text.lastIndexOf('\n', index - 1) + 1;
    const eagerAt = (index) => {
        // Column-0 statements run when the module loads; anything indented
        // is inside a function or block and runs later (a heuristic, used
        // only for diagnostics; ownership follows every edge).
        const start = lineStart(index);
        return !/^\s/.test(text.slice(start, start + 1));
    };

    const optional = /\brequireOptional\s*\(\s*(['"])([^'"\n]+)\1\s*,\s*\{\s*feature\s*:\s*(['"])([^'"\n]+)\3/g;
    const optionalAt = new Set();
    for (let match; (match = optional.exec(text));) {
        optionalAt.add(match.index);
        specs.push({ spec: match[2], line: lineOf(text, match.index), kind: 'optional', feature: match[4], eager: eagerAt(match.index) });
    }
    const loose = /\brequireOptional\s*\(/g;
    for (let match; (match = loose.exec(text));) {
        if (optionalAt.has(match.index)) continue;
        if (/function\s+$/.test(text.slice(Math.max(0, match.index - 20), match.index))) continue;
        dynamic.push({ line: lineOf(text, match.index), text: text.slice(match.index, match.index + 80).split('\n')[0].trim(), kind: 'optional-without-feature' });
    }

    const call = /(?<![\w$.])require(\.resolve)?\s*\(/g;
    for (let match; (match = call.exec(text));) {
        const after = text.slice(call.lastIndex);
        if (/^[^()\n]*\)\s*\{/.test(after) && /(?:async\s+|^\s*)$/.test(text.slice(lineStart(match.index), match.index))) continue;
        const literal = /^\s*(['"])([^'"\n]+)\1\s*[,)]/.exec(after) || /^\s*`([^`$\n]+)`\s*[,)]/.exec(after);
        if (literal) {
            const spec = literal.length === 3 ? literal[2] : literal[1];
            specs.push({ spec, line: lineOf(text, match.index), kind: match[1] ? 'resolve' : 'require', feature: null, eager: eagerAt(match.index) });
        } else {
            dynamic.push({ line: lineOf(text, match.index), text: text.slice(match.index, match.index + 80).split('\n')[0].trim(), kind: 'require' });
        }
    }

    const esm = /(?:^|[;\n])\s*(?:import|export)\s+(?:[\w*{}\s,$]+\s+from\s+)?(['"])([^'"\n]+)\1/g;
    for (let match; (match = esm.exec(text));) {
        specs.push({ spec: match[2], line: lineOf(text, match.index + 1), kind: 'import', feature: null, eager: true });
    }
    return { specs, dynamic };
}

/** `lodash/fp` -> `lodash`, `@scope/pkg/x` -> `@scope/pkg`. */
function packageNameOf(spec) {
    const parts = spec.split('/');
    return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/**
 * Build the graph.
 * @param {Object} params
 * @param {string} params.root           repository root (absolute)
 * @param {string[]} params.files        repository-relative POSIX paths to scan (others may be edge targets)
 * @param {string[]} [params.knownFiles] every tracked file (resolution targets); defaults to `files`
 * @returns {{ files: Object<string, { edges: Array }>, dynamic: Array, unresolved: Array, packages: Object<string, string[]> }}
 */
function buildRequireGraph({ root, files, knownFiles = files }) {
    const known = new Set(knownFiles);
    const workspaces = workspaceDirs(root);
    const graph = {};
    const dynamic = [];
    const unresolved = [];
    const importers = {};

    const resolveFile = (base) => {
        for (const suffix of RESOLVE_SUFFIXES) {
            const candidate = path.posix.normalize(base + suffix);
            if (known.has(candidate)) return candidate;
        }
        return null;
    };
    const workspaceEntry = (dir) => {
        const manifest = path.join(root, dir, 'package.json');
        let main = 'index.js';
        try { main = JSON.parse(fs.readFileSync(manifest, 'utf8')).main || main; } catch { /* default */ }
        return resolveFile(path.posix.join(dir, main.replace(/^\.\//, '')));
    };

    for (const file of [...files].sort()) {
        if (!SOURCE_EXT.test(file)) continue;
        let source;
        try { source = fs.readFileSync(path.join(root, file), 'utf8'); } catch { continue; }
        const scanned = scanSource(source);
        const edges = [];
        for (const item of scanned.specs) {
            const edge = { spec: item.spec, line: item.line, kind: item.kind, feature: item.feature, eager: item.eager, file: null, package: null, builtin: false };
            if (BUILTINS.has(item.spec)) {
                edge.builtin = true;
            } else if (item.spec.startsWith('.') || item.spec.startsWith('/')) {
                const joined = path.posix.join(path.posix.dirname(file), item.spec);
                const target = resolveFile(joined);
                if (target) edge.file = target;
                else if (RUNTIME_FILES.has(path.posix.basename(joined))) edge.runtime = path.posix.basename(joined);
                else unresolved.push({ from: file, line: item.line, spec: item.spec });
            } else {
                const name = packageNameOf(item.spec);
                if (workspaces[name]) {
                    const dir = workspaces[name];
                    const rest = item.spec.slice(name.length).replace(/^\//, '');
                    const target = rest ? resolveFile(path.posix.join(dir, rest)) : workspaceEntry(dir);
                    if (target) edge.file = target;
                    else unresolved.push({ from: file, line: item.line, spec: item.spec });
                } else {
                    edge.package = name;
                    (importers[name] = importers[name] || []).push(file);
                }
            }
            edges.push(edge);
        }
        for (const entry of scanned.dynamic) dynamic.push({ from: file, ...entry });
        graph[file] = { edges };
    }
    for (const name of Object.keys(importers)) importers[name] = [...new Set(importers[name])].sort();
    return { files: graph, dynamic, unresolved, packages: importers };
}

/**
 * Files reachable from `entries` along plain (non-optional) edges: what must
 * be present for the entries to load and run every code path.
 * @param {ReturnType<typeof buildRequireGraph>} graph
 * @param {string[]} entries
 * @param {{ followOptional?: boolean }} [options]
 */
function closureOf(graph, entries, { followOptional = false } = {}) {
    const seen = new Set();
    const stack = [...entries];
    while (stack.length) {
        const file = stack.pop();
        if (seen.has(file)) continue;
        seen.add(file);
        const node = graph.files[file];
        if (!node) continue;
        for (const edge of node.edges) {
            if (!edge.file) continue;
            if (edge.kind === 'optional' && !followOptional) continue;
            if (!seen.has(edge.file)) stack.push(edge.file);
        }
    }
    return [...seen].sort();
}

module.exports = { buildRequireGraph, closureOf, scanSource, stripComments, packageNameOf, workspaceDirs, BUILTINS };
