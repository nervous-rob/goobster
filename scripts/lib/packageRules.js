'use strict';

/**
 * Rules for the standalone runtime payload (scripts/package-runtime.js,
 * documentation/packaging_proof.md). Pure functions over file lists and log
 * text, so the same checks run in the build, in the CI recipe and in Jest.
 */

const path = require('node:path');

const pins = require('../package-node-pins.json');

/**
 * The promised targets. `format` is the executable format the OS loads;
 * `nodeBin` is where the Node binary lives inside the official archive
 * (relative to its single top-level directory).
 */
const TARGETS = {
    'linux-x64': { platform: 'linux', arch: 'x64', format: 'elf', nodeArchive: 'linux-x64', ext: 'tar.gz', nodeBin: 'bin/node' },
    'linux-arm64': { platform: 'linux', arch: 'arm64', format: 'elf', nodeArchive: 'linux-arm64', ext: 'tar.gz', nodeBin: 'bin/node' },
    'darwin-x64': { platform: 'darwin', arch: 'x64', format: 'macho', nodeArchive: 'darwin-x64', ext: 'tar.gz', nodeBin: 'bin/node' },
    'darwin-arm64': { platform: 'darwin', arch: 'arm64', format: 'macho', nodeArchive: 'darwin-arm64', ext: 'tar.gz', nodeBin: 'bin/node' },
    'win32-x64': { platform: 'win32', arch: 'x64', format: 'pe', nodeArchive: 'win-x64', ext: 'zip', nodeBin: 'node.exe' }
};

function hostTargetId(platform = process.platform, arch = process.arch) {
    return `${platform}-${arch}`;
}

function resolveTarget(id) {
    const target = TARGETS[id];
    if (!target) {
        throw new Error(`Unsupported target "${id}". Promised targets: ${Object.keys(TARGETS).join(', ')}.`);
    }
    return { id, ...target };
}

/** Name, URL and pinned SHA-256 of the official Node archive for a target. */
function nodeDownload(target, version = pins.nodeVersion) {
    const file = `node-v${version}-${target.nodeArchive}.${target.ext}`;
    return {
        file,
        url: `${pins.distBase}/v${version}/${file}`,
        sha256: pins.sha256[file] || null,
        topDir: `node-v${version}-${target.nodeArchive}`
    };
}

// ---------------------------------------------------------------------------
// What must never be inside a payload.
// ---------------------------------------------------------------------------

/** Directory names that are runtime state or developer scaffolding, outside node_modules. */
const FORBIDDEN_DIRS = new Set(['data', 'cache', 'logs', 'tests', 'test', 'e2e', 'coverage', '.git', '.github']);
/** File names (or patterns) that are secrets or user data, anywhere including node_modules. */
const FORBIDDEN_FILES = [
    /^config\.json$/i,
    /^\.env(\..*)?$/i,
    /\.(sqlite|sqlite3|db)(-wal|-shm|-journal)?$/i
];

/**
 * Entries are `{ rel, type }` with POSIX-separated paths relative to the
 * payload root and `type` of 'file' | 'dir' | 'symlink'.
 * @returns {Array<{ rule: string, rel: string }>}
 */
function validatePayloadEntries(entries) {
    const violations = [];
    for (const { rel, type } of entries) {
        const segments = rel.split('/');
        const base = segments[segments.length - 1];
        const insideModules = segments.includes('node_modules');
        if (type === 'symlink') violations.push({ rule: 'symlink', rel });
        if (type !== 'dir' && FORBIDDEN_FILES.some(pattern => pattern.test(base))) {
            violations.push({ rule: 'secret-or-user-data-file', rel });
        }
        if (!insideModules) {
            const dirSegments = type === 'dir' ? segments : segments.slice(0, -1);
            const hit = dirSegments.find(segment => FORBIDDEN_DIRS.has(segment));
            if (hit) violations.push({ rule: `forbidden-directory:${hit}`, rel });
        }
    }
    return violations;
}

/**
 * Evidence that a package was compiled from source instead of fetching a
 * prebuilt binary. prebuild-install extracts `build/Release/*.node` and
 * nothing else; a node-gyp run leaves Makefiles, config.gypi, MSBuild
 * projects and object directories next to it.
 */
const COMPILE_TRACES = [
    /\/build\/(Makefile|config\.gypi|binding\.Makefile|gyp-mac-tool|gyp-win-tool|Release\/(obj|\.deps)\b|Release\/obj\.target\/)/,
    /\/build\/[^/]+\.(vcxproj|vcxproj\.filters|sln)$/,
    /\/build\/(Release|Debug)\/[^/]+\.(o|obj|a|lib|exp|pdb|ilk)$/
];

function findCompileTraces(entries) {
    return entries
        .filter(({ rel }) => COMPILE_TRACES.some(pattern => pattern.test(`/${rel}`)))
        .map(({ rel }) => ({ rule: 'compiled-from-source-trace', rel }));
}

/**
 * Every native binary in the payload must be the target's format and
 * architecture. A foreign-platform binary is dead weight and, worse, a sign
 * that the payload was assembled on the wrong host.
 * @param {Array<{ rel: string, info: { format: string, arch: string[] } }>} binaries
 */
function validateBinaryTargets(binaries, target) {
    const violations = [];
    for (const { rel, info } of binaries) {
        if (info.format !== target.format) {
            violations.push({ rule: `binary-format:${info.format}!=${target.format}`, rel });
        } else if (!info.arch.includes(target.arch)) {
            violations.push({ rule: `binary-arch:${info.arch.join('+')}!=${target.arch}`, rel });
        }
    }
    return violations;
}

/**
 * Digest the output of `npm ci --foreground-scripts` run with
 * `npm_config_loglevel=http`: which prebuilt binaries were fetched, and
 * whether any node-gyp/compiler output appeared. The npm log echoes the
 * *text* of install scripts (which mention node-gyp as a fallback), so only
 * node-gyp's own runtime output counts as a compile.
 */
function analyzeInstallLog(text) {
    const lines = String(text || '').split(/\r?\n/);
    const prebuildFetches = [];
    const libvips = [];
    const compileOutput = [];
    for (const line of lines) {
        const fetched = line.match(/prebuild-install http 200 (\S+)/);
        if (fetched) prebuildFetches.push(fetched[1]);
        if (/^sharp: (Downloading|Using cached) /.test(line) || /^sharp: Integrity check passed/.test(line)) {
            libvips.push(line.replace(/\s+/g, ' ').trim());
        }
        if (/^\s*(npm )?gyp (info|ERR!|WARN|http)\b|make: (Entering|Leaving) directory|MSBuild|^\s*(g\+\+|gcc|cc|c\+\+|clang\+*)\s+-|xcodebuild|\bcl\.exe\b/i.test(line)) {
            compileOutput.push(line.trim().slice(0, 160));
        }
        if (/prebuild-install (warn|ERR!)/.test(line)) compileOutput.push(line.trim().slice(0, 160));
    }
    return {
        prebuildFetches: [...new Set(prebuildFetches)],
        libvips: [...new Set(libvips)],
        compileOutput
    };
}

/** Is a repo-relative path eligible to be copied into the code root? */
function isCodeFileExcluded(rel) {
    const segments = rel.split('/');
    if (segments.includes('node_modules')) return true;
    if (FORBIDDEN_DIRS.has(segments[0]) || segments.some(segment => FORBIDDEN_DIRS.has(segment))) return true;
    return FORBIDDEN_FILES.some(pattern => pattern.test(segments[segments.length - 1]));
}

function toPosix(relPath) {
    return relPath.split(path.sep).join('/');
}

module.exports = {
    pins,
    TARGETS,
    FORBIDDEN_DIRS,
    FORBIDDEN_FILES,
    hostTargetId,
    resolveTarget,
    nodeDownload,
    validatePayloadEntries,
    findCompileTraces,
    validateBinaryTargets,
    analyzeInstallLog,
    isCodeFileExcluded,
    toPosix
};
