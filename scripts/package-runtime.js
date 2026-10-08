#!/usr/bin/env node
'use strict';

/**
 * Build the standalone (no-Discord) runtime payload for the host platform.
 *
 * This is the packaging-proof recipe from documentation/packaging_proof.md
 * (issue #327, ADR 0013 decisions 9 and 13). The result is a self-contained
 * directory an end user could unzip and run with no Node, npm, git or
 * compiler on the machine:
 *
 *   <payload>/
 *     bin/goobster-api[.cmd]   launcher: sets the relocatable roots, execs the bundled Node
 *     bin/goobster-manager[.cmd] launcher of the installation manager (apps/manager): serves
 *                              or, with a command word (install, repair, ...), runs its CLI
 *     runtime/                 official Node.js (checksum-pinned), nothing else
 *     app/                     the CODE root (GOOBSTER_WORKSPACE_ROOT), read-only at run time
 *       node_modules/          production dependencies with prebuilt native binaries
 *         @goobster/core/      real directory (no workspace symlink)
 *       apps/api, apps/manager, apps/web/dist, [apps/sandbox], documentation/, campaigns/, clients/
 *       scripts/package-smoke.js
 *     payload-manifest.json    the signed release catalogue: every file with its SHA-256 and
 *                              owner, dependencies, chunks, native binaries, licences
 *     payload-manifest.sig     Ed25519 signature (only with --dev-sign or scripts/package-sign.js)
 *     payload-selection.json   the profile and the features this copy carries
 *
 * Mutable state (data, cache, logs, config.json) is NOT in the payload; the
 * launcher points GOOBSTER_DATA_DIR / _CACHE_DIR / _LOG_DIR / _CONFIG_PATH at
 * a separate instance root.
 *
 * Usage:
 *   node scripts/package-runtime.js [--target <id>] [--out <dir>] [--force]
 *        [--with-sandbox] [--build-web] [--node-binary <path>] [--cache-dir <dir>]
 *        [--report-dir <dir>] [--keep-staging]
 *        [--profile minimal|full | --features <id,id,...>] [--dev-sign]
 *
 *   --target       host only (linux-x64, linux-arm64, darwin-x64, darwin-arm64,
 *                  win32-x64). Native modules are fetched for the machine that
 *                  runs npm, so a payload built for another target would be
 *                  untested cross-assembly; build each target on its own host.
 *   --out          payload directory (default dist/payload/<target>)
 *   --with-sandbox include apps/sandbox (the code-execution runner)
 *   --build-web    run `npm run build:web` first when apps/web/dist is missing
 *   --node-binary  OFFLINE FALLBACK: bundle this node binary instead of
 *                  downloading. The payload is marked runtimeVerified=false.
 *   --profile      `full` (default: every feature) or `minimal` (core only)
 *   --features     a custom selection; each feature's `dependsOn` is added.
 *                  The release catalogue is built from the whole tree, then the
 *                  files, dependency directories and portal chunks of every
 *                  unselected feature are deleted (documentation/packaging.md).
 *                  A selection with `sandbox` includes apps/sandbox.
 *   --dev-sign     sign the manifest with a throwaway development key (made in a
 *                  0700 temp directory and deleted after signing); the public key
 *                  is written to the report directory for the smoke check.
 *
 * The recipe is deterministic given the lockfile, the Node pin
 * (scripts/package-node-pins.json) and the upstream prebuilt binaries: the
 * file list, the order and every checksum are recorded; there are no
 * timestamps in the manifest.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');

const rules = require('./lib/packageRules');
const stage = require('./lib/payloadStage');
const { computeOwnership, buildReleaseManifest, payloadDirOfLockKey } = require('./lib/payloadManifest');
const { readFeatureChunks, pruneDist, INSTALLED_FILE } = require('./lib/frontendChunks');
const catalog = require('../packages/core/features/catalog');
const { download } = require('./lib/download');
const { inspectBinary, looksLikeBinary, compareVersions } = require('./lib/nativeBinaryInfo');

const REPO_ROOT = path.resolve(__dirname, '..');
const SERVER_WORKSPACES = [
    { name: '@goobster/core', dir: 'packages/core', mode: 'module' },
    { name: '@goobster/api', dir: 'apps/api', mode: 'app' },
    { name: '@goobster/manager', dir: 'apps/manager', mode: 'app' }
];
const SANDBOX_WORKSPACE = { name: '@goobster/sandbox', dir: 'apps/sandbox', mode: 'app' };
const STATIC_TREES = ['documentation', 'campaigns', 'clients'];
const STATIC_FILES = ['README.md', 'LICENSE', 'changelog.md'];
const SMOKE_FILES = ['scripts/package-smoke.js', 'scripts/lib/nativeBinaryInfo.js', 'scripts/lib/payloadStage.js', 'scripts/lib/releaseIndex.js', 'scripts/release-keys.json'];
const PROFILES = ['minimal', 'full'];
const PERMISSIVE_LICENSE = /^(MIT|ISC|BSD-[23]-Clause|Apache-2\.0|0BSD|BlueOak-1\.0\.0|CC0-1\.0|CC-BY-4\.0|Unlicense|Python-2\.0|MIT-0|WTFPL|Zlib)$/i;

// --------------------------------------------------------------------------
// small helpers
// --------------------------------------------------------------------------

function parseArgs(argv) {
    const options = { force: false, withSandbox: false, buildWeb: false, keepStaging: false, devSign: false };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        const value = () => {
            i += 1;
            if (i >= argv.length) throw new Error(`${arg} needs a value`);
            return argv[i];
        };
        if (arg === '--target') options.target = value();
        else if (arg === '--out') options.out = path.resolve(value());
        else if (arg === '--report-dir') options.reportDir = path.resolve(value());
        else if (arg === '--cache-dir') options.cacheDir = path.resolve(value());
        else if (arg === '--node-binary') options.nodeBinary = path.resolve(value());
        else if (arg === '--force') options.force = true;
        else if (arg === '--with-sandbox') options.withSandbox = true;
        else if (arg === '--build-web') options.buildWeb = true;
        else if (arg === '--keep-staging') options.keepStaging = true;
        else if (arg === '--profile') options.profile = value();
        else if (arg === '--features') options.features = value().split(',').map(id => id.trim()).filter(Boolean);
        else if (arg === '--dev-sign') options.devSign = true;
        else if (arg === '-h' || arg === '--help') options.help = true;
        else throw new Error(`Unknown option: ${arg}`);
    }
    if (options.profile !== undefined && !PROFILES.includes(options.profile)) throw new Error(`--profile must be one of ${PROFILES.join(', ')}`);
    if (options.profile !== undefined && options.features) throw new Error('--profile and --features are alternatives; pass one');
    return options;
}

/** `{ name, features }` for the requested selection; features are catalog ids without core, dependsOn included. */
function resolveSelection(options) {
    const optional = catalog.FEATURE_IDS.filter(id => id !== 'core');
    if (options.features) {
        const unknown = options.features.filter(id => !optional.includes(id));
        if (unknown.length) throw new Error(`Unknown feature(s) for --features: ${unknown.join(', ')} (known: ${optional.join(', ')})`);
        return { name: 'custom', features: catalog.closure(options.features).filter(id => id !== 'core') };
    }
    if (options.profile === 'minimal') return { name: 'minimal', features: [] };
    return { name: 'full', features: optional };
}

function help() {
    const source = fs.readFileSync(__filename, 'utf8');
    const match = source.match(/\/\*\*([\s\S]*?)\*\//);
    process.stdout.write(match[1].replace(/^ ?\* ?/gm, '').trim() + '\n');
}

const SECRET_LINE = /(_authToken|authToken|_password|npm_[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|Bearer\s+\S+|api[_-]?key\s*[=:]\s*\S+)/i;
function redact(text) {
    return String(text).split(/\r?\n/).map(line => (SECRET_LINE.test(line) ? '[line redacted: possible secret]' : line)).join('\n');
}

let buildLog = null;
function log(message) {
    const line = `[package-runtime] ${message}`;
    process.stdout.write(`${line}\n`);
    if (buildLog) fs.appendFileSync(buildLog, `${line}\n`);
}

function sha256File(file) {
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(file, 'r');
    try {
        const buffer = Buffer.allocUnsafe(1 << 20);
        for (;;) {
            const read = fs.readSync(fd, buffer, 0, buffer.length, null);
            if (!read) break;
            hash.update(buffer.subarray(0, read));
        }
    } finally {
        fs.closeSync(fd);
    }
    return hash.digest('hex');
}

function removeTree(target) {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

function copyFile(from, to) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
}

function moveDir(from, to) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    try {
        fs.renameSync(from, to);
    } catch (error) {
        if (error.code !== 'EXDEV') throw error;
        fs.cpSync(from, to, { recursive: true, dereference: false, verbatimSymlinks: true });
        removeTree(from);
    }
}

/** Depth-first listing that never follows symlinks; sorted for determinism. */
function walk(root) {
    const entries = [];
    const visit = (dir) => {
        const names = fs.readdirSync(dir).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        for (const name of names) {
            const full = path.join(dir, name);
            const stat = fs.lstatSync(full);
            const rel = rules.toPosix(path.relative(root, full));
            if (stat.isSymbolicLink()) entries.push({ rel, full, type: 'symlink', size: 0 });
            else if (stat.isDirectory()) {
                entries.push({ rel, full, type: 'dir', size: 0 });
                visit(full);
            } else entries.push({ rel, full, type: 'file', size: stat.size });
        }
    };
    visit(root);
    return entries;
}

function run(command, args, { cwd, env, label, allowFailure = false } = {}) {
    log(`$ ${label || [command, ...args].join(' ')}`);
    const result = childProcess.spawnSync(command, args, {
        cwd,
        env: env || process.env,
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024
    });
    const output = redact(`${result.stdout || ''}${result.stderr || ''}`);
    if (buildLog) fs.appendFileSync(buildLog, `${output}\n`);
    if (result.error) throw result.error;
    if (result.status !== 0 && !allowFailure) {
        throw new Error(`${label || command} exited with ${result.status}\n${output.split('\n').slice(-25).join('\n')}`);
    }
    return { status: result.status, output };
}

function resolveNpmCli() {
    const fromEnv = process.env.npm_execpath;
    if (fromEnv && /npm-cli\.js$/.test(fromEnv) && fs.existsSync(fromEnv)) return fromEnv;
    const bin = path.dirname(process.execPath);
    for (const candidate of [
        path.join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        path.join(bin, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
    ]) {
        if (fs.existsSync(candidate)) return candidate;
    }
    for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
        for (const candidate of [path.join(dir, 'npm'), path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js')]) {
            try {
                const real = fs.realpathSync(candidate);
                if (/npm-cli\.js$/.test(real)) return real;
            } catch { /* not here */ }
        }
    }
    throw new Error('Could not locate npm-cli.js (looked next to the running Node and on PATH).');
}

function gitOutput(args) {
    const result = childProcess.spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return result.status === 0 ? result.stdout : null;
}

// --------------------------------------------------------------------------
// Node runtime
// --------------------------------------------------------------------------

async function fetchNodeRuntime(target, cacheDir) {
    const info = rules.nodeDownload(target);
    if (!info.sha256) throw new Error(`No pinned SHA-256 for ${info.file} in scripts/package-node-pins.json`);
    fs.mkdirSync(cacheDir, { recursive: true });
    const archive = path.join(cacheDir, info.file);
    if (!fs.existsSync(archive) || sha256File(archive) !== info.sha256) {
        log(`downloading ${info.url}`);
        await download(info.url, archive);
    } else {
        log(`using cached ${info.file}`);
    }
    const actual = sha256File(archive);
    if (actual !== info.sha256) {
        fs.rmSync(archive, { force: true });
        throw new Error(`Checksum mismatch for ${info.file}: expected ${info.sha256}, got ${actual}. The download was discarded.`);
    }
    log(`verified ${info.file} sha256=${actual}`);
    return { ...info, archive, verified: true };
}

/**
 * .tar.gz on unix; the Windows runtime is a .zip, which Git for Windows' GNU
 * tar cannot read, so use the system bsdtar (System32\tar.exe) or PowerShell.
 */
function extractArchive(archive, destination) {
    if (process.platform !== 'win32') {
        run('tar', ['-xzf', archive, '-C', destination], { label: `tar -xzf ${path.basename(archive)}` });
        return;
    }
    const systemTar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    if (fs.existsSync(systemTar)) {
        run(systemTar, ['-xf', archive, '-C', destination], { label: `tar.exe -xf ${path.basename(archive)}` });
        return;
    }
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force', archive, destination], {
        label: `Expand-Archive ${path.basename(archive)}`
    });
}

function installRuntime({ target, runtimeDir, download: archiveInfo, nodeBinary }) {
    fs.mkdirSync(runtimeDir, { recursive: true });
    const destination = path.join(runtimeDir, target.platform === 'win32' ? 'node.exe' : path.join('bin', 'node'));
    if (nodeBinary) {
        copyFile(nodeBinary, destination);
        fs.chmodSync(destination, 0o755);
        return { destination, verified: false, source: `host binary ${path.basename(nodeBinary)} (offline fallback, not checksum-verified)` };
    }
    const extractTo = path.join(path.dirname(runtimeDir), `.node-extract-${target.id}`);
    removeTree(extractTo);
    fs.mkdirSync(extractTo, { recursive: true });
    extractArchive(archiveInfo.archive, extractTo);
    const top = path.join(extractTo, archiveInfo.topDir);
    const source = path.join(top, ...target.nodeBin.split('/'));
    if (!fs.existsSync(source)) throw new Error(`${target.nodeBin} not found in ${archiveInfo.file}`);
    copyFile(source, destination);
    fs.chmodSync(destination, 0o755);
    copyFile(path.join(top, 'LICENSE'), path.join(runtimeDir, 'LICENSE'));
    removeTree(extractTo);
    return { destination, verified: true, source: archiveInfo.url };
}

// --------------------------------------------------------------------------
// repository files
// --------------------------------------------------------------------------

/** Tracked files under `relPath`; falls back to a filtered walk outside a git checkout. */
function trackedFiles(relPath) {
    const listed = gitOutput(['ls-files', '-z', '--', relPath]);
    if (listed !== null) return listed.split('\0').filter(Boolean);
    const base = path.join(REPO_ROOT, relPath);
    if (!fs.existsSync(base)) return [];
    const stat = fs.statSync(base);
    if (stat.isFile()) return [relPath];
    return walk(base).filter(entry => entry.type === 'file').map(entry => `${relPath}/${entry.rel}`);
}

function copyTracked(relPath, destinationRoot, mapTo = (rel) => rel) {
    const copied = [];
    const excluded = [];
    for (const rel of trackedFiles(relPath)) {
        if (rules.isCodeFileExcluded(rel)) {
            excluded.push(rel);
            continue;
        }
        if (!fs.existsSync(path.join(REPO_ROOT, rel))) continue;
        copyFile(path.join(REPO_ROOT, rel), path.join(destinationRoot, mapTo(rel)));
        copied.push(rel);
    }
    return { copied, excluded };
}

// --------------------------------------------------------------------------
// dependencies
// --------------------------------------------------------------------------

function stageManifests(stagingDir, workspaces) {
    removeTree(stagingDir);
    fs.mkdirSync(stagingDir, { recursive: true });
    const rootManifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    // npm ci checks the lockfile against EVERY workspace manifest, so all of
    // them are staged (manifest only, no code); only the selected workspaces'
    // dependency trees are installed.
    for (const glob of rootManifest.workspaces) {
        const parent = glob.replace(/\/\*$/, '');
        for (const name of fs.readdirSync(path.join(REPO_ROOT, parent))) {
            const manifest = path.join(REPO_ROOT, parent, name, 'package.json');
            if (fs.existsSync(manifest)) copyFile(manifest, path.join(stagingDir, parent, name, 'package.json'));
        }
    }
    copyFile(path.join(REPO_ROOT, 'package.json'), path.join(stagingDir, 'package.json'));
    copyFile(path.join(REPO_ROOT, 'package-lock.json'), path.join(stagingDir, 'package-lock.json'));
    return workspaces.map(workspace => `--workspace=${workspace.name}`);
}

function installDependencies({ stagingDir, workspaceFlags }) {
    const npmCli = resolveNpmCli();
    const env = { ...process.env, npm_config_loglevel: 'http', npm_config_update_notifier: 'false' };
    // These would turn "fetch the prebuilt binary" into "compile it".
    delete env.npm_config_build_from_source;
    delete env.npm_config_ignore_scripts;
    // Compile guard: if a prebuilt binary cannot be fetched, the install
    // scripts fall back to `node-gyp rebuild`. Pointing Python and the C/C++
    // compilers at a path that does not exist turns that fallback into a hard
    // failure, so a payload can never be "proven" by a quiet local compile.
    const noCompiler = path.join(stagingDir, 'no-compiler-allowed');
    env.npm_config_python = noCompiler;
    env.PYTHON = noCompiler;
    if (process.platform !== 'win32') {
        env.CC = noCompiler;
        env.CXX = noCompiler;
    }
    const args = [
        npmCli, 'ci', '--omit=dev', '--no-audit', '--no-fund', '--foreground-scripts',
        `--cache=${path.join(stagingDir, '.npm-cache')}`,
        ...workspaceFlags
    ];
    const result = run(process.execPath, args, {
        cwd: stagingDir,
        env,
        label: `npm ci --omit=dev ${workspaceFlags.join(' ')} (cold cache, scripts visible)`
    });
    return result.output;
}

/** Remove everything npm created that is a symlink or only useful to developers. */
function removeNpmLinks(nodeModules) {
    removeTree(path.join(nodeModules, '.package-lock.json'));
    const stack = [nodeModules];
    while (stack.length) {
        const dir = stack.pop();
        for (const name of fs.readdirSync(dir)) {
            const full = path.join(dir, name);
            const stat = fs.lstatSync(full);
            if (name === '.bin') removeTree(full);
            else if (stat.isSymbolicLink()) fs.rmSync(full, { force: true });
            else if (stat.isDirectory()) stack.push(full);
        }
    }
}

function pruneForTarget(nodeModules, target) {
    const removed = [];
    const drop = (rel) => {
        const full = path.join(nodeModules, ...rel.split('/'));
        if (fs.existsSync(full)) {
            removeTree(full);
            removed.push(`node_modules/${rel}`);
        }
    };

    // sodium-native ships every platform's prebuild in one package.
    const sodium = path.join(nodeModules, 'sodium-native', 'prebuilds');
    const keep = `${target.platform}-${target.arch}`;
    if (!fs.existsSync(path.join(sodium, keep))) {
        throw new Error(`sodium-native has no prebuild for ${keep} (found: ${fs.existsSync(sodium) ? fs.readdirSync(sodium).join(', ') : 'none'})`);
    }
    for (const name of fs.readdirSync(sodium)) if (name !== keep) drop(`sodium-native/prebuilds/${name}`);

    // npm installs both libc variants of napi-rs packages (no `libc` in the lockfile).
    if (target.platform === 'linux') {
        for (const scope of ['', ...fs.readdirSync(nodeModules).filter(name => name.startsWith('@'))]) {
            const dir = path.join(nodeModules, scope);
            for (const name of fs.readdirSync(dir)) if (/-musl$/.test(name)) drop(path.posix.join(scope, name));
        }
    }

    // Sources used only to compile from scratch, which an end user never does.
    drop('better-sqlite3/deps');
    drop('better-sqlite3/src');
    drop('better-sqlite3/binding.gyp');
    drop('sharp/src');
    drop('sharp/binding.gyp');
    return removed;
}

// --------------------------------------------------------------------------
// launchers
// --------------------------------------------------------------------------

const POSIX_LAUNCHER = `#!/bin/sh
# Goobster standalone API launcher (generated by scripts/package-runtime.js).
# Code lives under <payload>/app and is read-only; everything mutable lives
# under GOOBSTER_HOME (or the individual GOOBSTER_*_DIR/_PATH overrides).
set -eu

SELF=$0
case "$SELF" in /*) ;; *) SELF="$PWD/$SELF" ;; esac
while [ -h "$SELF" ]; do
    link=$(readlink "$SELF")
    case "$link" in /*) SELF=$link ;; *) SELF="$(dirname "$SELF")/$link" ;; esac
done
PAYLOAD=$(CDPATH= cd -- "$(dirname -- "$SELF")/.." && pwd -P)

if [ -z "\${GOOBSTER_HOME:-}" ]; then
    case "$(uname -s)" in
        Darwin) GOOBSTER_HOME="$HOME/Library/Application Support/Goobster" ;;
        *) GOOBSTER_HOME="\${XDG_DATA_HOME:-$HOME/.local/share}/goobster" ;;
    esac
fi

export GOOBSTER_WORKSPACE_ROOT="$PAYLOAD/app"
export GOOBSTER_DATA_DIR="\${GOOBSTER_DATA_DIR:-$GOOBSTER_HOME/data}"
export GOOBSTER_CACHE_DIR="\${GOOBSTER_CACHE_DIR:-$GOOBSTER_HOME/cache}"
export GOOBSTER_LOG_DIR="\${GOOBSTER_LOG_DIR:-$GOOBSTER_HOME/logs}"
export GOOBSTER_CONFIG_PATH="\${GOOBSTER_CONFIG_PATH:-$GOOBSTER_HOME/config/config.json}"
export GOOBSTER_RUNTIME_MODE="\${GOOBSTER_RUNTIME_MODE:-standalone}"
unset NODE_PATH

mkdir -p "$GOOBSTER_DATA_DIR" "$GOOBSTER_CACHE_DIR" "$GOOBSTER_LOG_DIR" "$(dirname "$GOOBSTER_CONFIG_PATH")" || {
    echo "goobster-api: cannot create the instance directories under: $GOOBSTER_HOME" >&2
    exit 73
}

exec "$PAYLOAD/runtime/bin/node" "$PAYLOAD/app/apps/api/index.js" "$@"
`;

const WINDOWS_LAUNCHER = [
    '@echo off',
    'rem Goobster standalone API launcher (generated by scripts/package-runtime.js).',
    'rem Code lives under <payload>\\app and is read-only; everything mutable lives',
    'rem under GOOBSTER_HOME (or the individual GOOBSTER_*_DIR / _PATH overrides).',
    'chcp 65001 >nul',
    'setlocal',
    'for %%I in ("%~dp0..") do set "PAYLOAD=%%~fI"',
    'if not defined GOOBSTER_HOME set "GOOBSTER_HOME=%LOCALAPPDATA%\\Goobster"',
    'set "GOOBSTER_WORKSPACE_ROOT=%PAYLOAD%\\app"',
    'if not defined GOOBSTER_DATA_DIR set "GOOBSTER_DATA_DIR=%GOOBSTER_HOME%\\data"',
    'if not defined GOOBSTER_CACHE_DIR set "GOOBSTER_CACHE_DIR=%GOOBSTER_HOME%\\cache"',
    'if not defined GOOBSTER_LOG_DIR set "GOOBSTER_LOG_DIR=%GOOBSTER_HOME%\\logs"',
    'if not defined GOOBSTER_CONFIG_PATH set "GOOBSTER_CONFIG_PATH=%GOOBSTER_HOME%\\config\\config.json"',
    'if not defined GOOBSTER_RUNTIME_MODE set "GOOBSTER_RUNTIME_MODE=standalone"',
    'set "NODE_PATH="',
    'if not exist "%GOOBSTER_DATA_DIR%" mkdir "%GOOBSTER_DATA_DIR%"',
    'if not exist "%GOOBSTER_CACHE_DIR%" mkdir "%GOOBSTER_CACHE_DIR%"',
    'if not exist "%GOOBSTER_LOG_DIR%" mkdir "%GOOBSTER_LOG_DIR%"',
    'for %%I in ("%GOOBSTER_CONFIG_PATH%") do if not exist "%%~dpI" mkdir "%%~dpI"',
    '"%PAYLOAD%\\runtime\\node.exe" "%PAYLOAD%\\app\\apps\\api\\index.js" %*',
    'exit /b %ERRORLEVEL%',
    ''
].join('\r\n');

const POSIX_MANAGER_LAUNCHER = `#!/bin/sh
# Goobster manager launcher (generated by scripts/package-runtime.js).
#   goobster-manager [--supervise | --status | --help | ...]   serve the manager (apps/manager/index.js)
#   goobster-manager <command> [...]                           the manager CLI (install, repair, uninstall, status, ...)
# Code lives under <payload>/app and is read-only. An installed payload
# (<code root>/current) takes its roots from <code root>/goobster.env, written
# by the installer: GOOBSTER_* lines only, read as plain text, never run. The
# environment wins over that file, and both win over the GOOBSTER_HOME defaults.
set -eu

SELF=$0
case "$SELF" in /*) ;; *) SELF="$PWD/$SELF" ;; esac
while [ -h "$SELF" ]; do
    link=$(readlink "$SELF")
    case "$link" in /*) SELF=$link ;; *) SELF="$(dirname "$SELF")/$link" ;; esac
done
PAYLOAD=$(CDPATH= cd -- "$(dirname -- "$SELF")/.." && pwd -P)
# The name this launcher was reached by, links in the path kept: an installation's \`current\`
# may be a link to the payload (the linked layout, documentation/packaging.md), and it is that
# name, not the directory it resolves to, that says whether goobster.env applies.
REACHED=$(CDPATH= cd -- "$(dirname -- "$SELF")/.." && pwd -L)

ENV_FILE="$(dirname -- "$REACHED")/goobster.env"
if [ "$(basename -- "$REACHED")" = "current" ] && [ -r "$ENV_FILE" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in
            GOOBSTER_[A-Z0-9_]*=*)
                key=\${line%%=*}
                value=\${line#*=}
                if ! printenv "$key" >/dev/null 2>&1; then
                    export "$key=$value"
                fi
                ;;
        esac
    done < "$ENV_FILE"
fi

if [ -z "\${GOOBSTER_HOME:-}" ]; then
    case "$(uname -s)" in
        Darwin) GOOBSTER_HOME="$HOME/Library/Application Support/Goobster" ;;
        *) GOOBSTER_HOME="\${XDG_DATA_HOME:-$HOME/.local/share}/goobster" ;;
    esac
fi

export GOOBSTER_WORKSPACE_ROOT="$PAYLOAD/app"
export GOOBSTER_DATA_DIR="\${GOOBSTER_DATA_DIR:-$GOOBSTER_HOME/data}"
export GOOBSTER_CACHE_DIR="\${GOOBSTER_CACHE_DIR:-$GOOBSTER_HOME/cache}"
export GOOBSTER_LOG_DIR="\${GOOBSTER_LOG_DIR:-$GOOBSTER_HOME/logs}"
export GOOBSTER_CONFIG_PATH="\${GOOBSTER_CONFIG_PATH:-$GOOBSTER_HOME/config/config.json}"
export GOOBSTER_RUNTIME_MODE="\${GOOBSTER_RUNTIME_MODE:-standalone}"
unset NODE_PATH

case "\${1:-}" in
    ""|-*) ENTRY="$PAYLOAD/app/apps/manager/index.js" ;;
    *) ENTRY="$PAYLOAD/app/apps/manager/cli.js" ;;
esac

exec "$PAYLOAD/runtime/bin/node" "$ENTRY" "$@"
`;

const WINDOWS_MANAGER_LAUNCHER = [
    '@echo off',
    'rem Goobster manager launcher (generated by scripts/package-runtime.js).',
    'rem goobster-manager [--supervise | --status | --help | ...]   serve the manager',
    'rem goobster-manager <command> [...]                           the manager CLI',
    'rem An installed payload (<code root>\\current) takes its roots from <code root>\\goobster.env,',
    'rem written by the installer: GOOBSTER_* lines only, read as text, never run. The environment',
    'rem wins over that file, and both win over the %LOCALAPPDATA%\\Goobster defaults.',
    'chcp 65001 >nul',
    'setlocal EnableExtensions DisableDelayedExpansion',
    'for %%I in ("%~dp0..") do set "PAYLOAD=%%~fI"',
    'for %%I in ("%PAYLOAD%") do set "PAYLOAD_NAME=%%~nxI"',
    'for %%I in ("%PAYLOAD%\\..") do set "CODE=%%~fI"',
    'if /i "%PAYLOAD_NAME%"=="current" if exist "%CODE%\\goobster.env" (',
    '    for /f "usebackq eol=# tokens=1* delims==" %%A in ("%CODE%\\goobster.env") do (',
    '        echo %%A| findstr /b /c:"GOOBSTER_" >nul && if not defined %%A set "%%A=%%B"',
    '    )',
    ')',
    'if not defined GOOBSTER_HOME set "GOOBSTER_HOME=%LOCALAPPDATA%\\Goobster"',
    'set "GOOBSTER_WORKSPACE_ROOT=%PAYLOAD%\\app"',
    'if not defined GOOBSTER_DATA_DIR set "GOOBSTER_DATA_DIR=%GOOBSTER_HOME%\\data"',
    'if not defined GOOBSTER_CACHE_DIR set "GOOBSTER_CACHE_DIR=%GOOBSTER_HOME%\\cache"',
    'if not defined GOOBSTER_LOG_DIR set "GOOBSTER_LOG_DIR=%GOOBSTER_HOME%\\logs"',
    'if not defined GOOBSTER_CONFIG_PATH set "GOOBSTER_CONFIG_PATH=%GOOBSTER_HOME%\\config\\config.json"',
    'if not defined GOOBSTER_RUNTIME_MODE set "GOOBSTER_RUNTIME_MODE=standalone"',
    'set "NODE_PATH="',
    'set "ENTRY=%PAYLOAD%\\app\\apps\\manager\\cli.js"',
    'rem FIRST always starts with an x: taking a substring of an undefined variable (no argument given)',
    'rem is not empty in a batch file, cmd drops the name and reads on, and the line fails with',
    'rem "The syntax of the command is incorrect" (exit 255) before node runs.',
    'set "FIRST=x%~1"',
    'if "%FIRST%"=="x" set "ENTRY=%PAYLOAD%\\app\\apps\\manager\\index.js"',
    'if "%FIRST:~1,1%"=="-" set "ENTRY=%PAYLOAD%\\app\\apps\\manager\\index.js"',
    '"%PAYLOAD%\\runtime\\node.exe" "%ENTRY%" %*',
    'exit /b %ERRORLEVEL%',
    ''
].join('\r\n');

function writeLaunchers(payloadDir, target) {
    const bin = path.join(payloadDir, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    if (target.platform === 'win32') {
        fs.writeFileSync(path.join(bin, 'goobster-api.cmd'), WINDOWS_LAUNCHER);
        fs.writeFileSync(path.join(bin, 'goobster-manager.cmd'), WINDOWS_MANAGER_LAUNCHER);
    } else {
        for (const [name, text] of [['goobster-api', POSIX_LAUNCHER], ['goobster-manager', POSIX_MANAGER_LAUNCHER]]) {
            fs.writeFileSync(path.join(bin, name), text, { mode: 0o755 });
            fs.chmodSync(path.join(bin, name), 0o755);
        }
    }
}

// --------------------------------------------------------------------------
// inspection and manifest
// --------------------------------------------------------------------------

function collectLicenses(nodeModules) {
    const found = [];
    const stack = [nodeModules];
    while (stack.length) {
        const dir = stack.pop();
        for (const name of fs.readdirSync(dir)) {
            const full = path.join(dir, name);
            const stat = fs.lstatSync(full);
            if (!stat.isDirectory()) continue;
            if (name.startsWith('@') && path.dirname(full) === nodeModules) { stack.push(full); continue; }
            const manifestPath = path.join(full, 'package.json');
            if (fs.existsSync(manifestPath)) {
                try {
                    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
                    const license = typeof manifest.license === 'string' ? manifest.license
                        : manifest.license?.type || (Array.isArray(manifest.licenses) ? manifest.licenses.map(l => l.type).join(' OR ') : 'UNKNOWN');
                    found.push({ name: manifest.name || name, version: manifest.version || '0.0.0', license });
                } catch { /* unreadable manifest: surfaced as UNKNOWN by omission */ }
            }
            const nested = path.join(full, 'node_modules');
            if (fs.existsSync(nested)) stack.push(nested);
        }
    }
    return found.sort((a, b) => (a.name + a.version < b.name + b.version ? -1 : 1));
}

function inspectBinaries(payloadDir, entries) {
    const binaries = [];
    for (const entry of entries) {
        const isRuntime = entry.rel === 'runtime/bin/node' || entry.rel === 'runtime/node.exe';
        if (entry.type !== 'file' || !(isRuntime || looksLikeBinary(entry.rel))) continue;
        let info;
        try {
            info = inspectBinary(entry.full);
        } catch (error) {
            info = { format: 'unreadable', arch: ['unknown'], error: error.code || error.message };
        }
        if (info.format === 'unknown') continue; // e.g. a text file that happens to be named .node
        binaries.push({ rel: entry.rel, size: entry.size, info });
    }
    return binaries;
}

function summarizeBaselines(binaries) {
    const highest = (key) => {
        let best = null;
        for (const { rel, info } of binaries) {
            const value = info[key];
            if (value && (!best || compareVersions(value, best.value) > 0)) best = { value, requiredBy: rel };
        }
        return best;
    };
    const imports = new Set();
    for (const { info } of binaries) if (info.format === 'pe') for (const name of info.needed || []) imports.add(name.toLowerCase());
    return {
        glibcMin: highest('glibcMin'),
        glibcxxMin: highest('glibcxxMin'),
        cxxabiMin: highest('cxxabiMin'),
        minMacos: highest('minMacos'),
        windowsImports: [...imports].sort()
    };
}

function treeSize(entries, prefix) {
    return entries.filter(entry => entry.type === 'file' && (entry.rel === prefix || entry.rel.startsWith(`${prefix}/`)))
        .reduce((sum, entry) => sum + entry.size, 0);
}

// --------------------------------------------------------------------------
// main
// --------------------------------------------------------------------------

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) return help();

    const targetId = options.target || rules.hostTargetId();
    const target = rules.resolveTarget(targetId);
    if (targetId !== rules.hostTargetId()) {
        throw new Error(`Refusing to build ${targetId} on ${rules.hostTargetId()}: native modules are fetched for the machine that runs npm, `
            + 'so a cross-assembled payload would carry no execution evidence. Run this script on a host of the target platform.');
    }
    if (process.versions.modules !== rules.pins.moduleVersion) {
        throw new Error(`This Node reports module ABI ${process.versions.modules} but the bundled runtime is ABI ${rules.pins.moduleVersion} (Node ${rules.pins.nodeVersion}). `
            + `Run the build with a Node ${rules.pins.nodeVersion.split('.')[0]}.x so better-sqlite3's prebuilt binary matches the runtime that will load it.`);
    }

    const outDir = options.out || path.join(REPO_ROOT, 'dist', 'payload', targetId);
    const stagingDir = path.join(path.dirname(outDir), `.staging-${targetId}`);
    const reportDir = options.reportDir || path.join(REPO_ROOT, 'dist', 'reports');
    const cacheDir = options.cacheDir || path.join(os.tmpdir(), 'goobster-package-cache');
    fs.mkdirSync(reportDir, { recursive: true });
    buildLog = path.join(reportDir, `package-build-${targetId}.log`);
    fs.writeFileSync(buildLog, '');

    if (fs.existsSync(outDir)) {
        if (!options.force) throw new Error(`${outDir} already exists; pass --force to rebuild it.`);
        removeTree(outDir);
    }
    const started = Date.now();
    log(`target ${targetId} | host Node ${process.version} (ABI ${process.versions.modules}) | npm ${childProcess.spawnSync(process.execPath, [resolveNpmCli(), '--version'], { encoding: 'utf8' }).stdout.trim()}`);
    log(`payload: ${outDir}`);

    const selection = resolveSelection(options);
    const withSandbox = options.withSandbox || (Boolean(options.features) && selection.features.includes('sandbox'));
    const workspaces = withSandbox ? [...SERVER_WORKSPACES, SANDBOX_WORKSPACE] : SERVER_WORKSPACES;
    log(`profile ${selection.name}: ${selection.features.length ? selection.features.join(', ') : 'core only'}`);

    // 1. Bundled Node runtime.
    const runtimeDir = path.join(outDir, 'runtime');
    let archiveInfo = null;
    if (!options.nodeBinary) archiveInfo = await fetchNodeRuntime(target, cacheDir);
    const runtime = installRuntime({ target, runtimeDir, download: archiveInfo, nodeBinary: options.nodeBinary });
    const bundledVersion = childProcess.spawnSync(runtime.destination, ['-p', 'process.version + " " + process.versions.modules'], { encoding: 'utf8' });
    if (bundledVersion.status !== 0) throw new Error(`The bundled Node does not run: ${bundledVersion.stderr}`);
    log(`bundled runtime reports: ${bundledVersion.stdout.trim()}`);
    if (!options.nodeBinary && !bundledVersion.stdout.startsWith(`v${rules.pins.nodeVersion} `)) {
        throw new Error(`Bundled runtime reports ${bundledVersion.stdout.trim()}, expected v${rules.pins.nodeVersion}`);
    }

    // 2. Production dependencies, installed from the lockfile on this host.
    const workspaceFlags = stageManifests(stagingDir, workspaces);
    const npmOutput = installDependencies({ stagingDir, workspaceFlags });
    fs.writeFileSync(path.join(reportDir, `npm-ci-${targetId}.log`), redact(npmOutput));
    const installLog = rules.analyzeInstallLog(npmOutput);
    log(`prebuilt binaries fetched: ${installLog.prebuildFetches.length}; compiler/node-gyp output lines: ${installLog.compileOutput.length}`);

    // 3. Assemble the code root.
    const appDir = path.join(outDir, 'app');
    const nodeModules = path.join(appDir, 'node_modules');
    fs.mkdirSync(appDir, { recursive: true });
    moveDir(path.join(stagingDir, 'node_modules'), nodeModules);
    removeNpmLinks(nodeModules);
    const excludedTracked = [];
    for (const workspace of workspaces) {
        const stagedDeps = path.join(stagingDir, workspace.dir, 'node_modules');
        const destination = workspace.mode === 'module'
            ? path.join(nodeModules, ...workspace.name.split('/'))
            : path.join(appDir, workspace.dir);
        const mapTo = (rel) => rel.slice(workspace.dir.length + 1);
        const { excluded } = copyTracked(workspace.dir, destination, mapTo);
        excludedTracked.push(...excluded);
        if (fs.existsSync(stagedDeps)) {
            removeNpmLinks(stagedDeps);
            moveDir(stagedDeps, path.join(destination, 'node_modules'));
        }
    }
    const webDist = path.join(REPO_ROOT, 'apps', 'web', 'dist');
    if (!fs.existsSync(path.join(webDist, 'index.html'))) {
        if (!options.buildWeb) throw new Error('apps/web/dist is not built. Run `npm run build:web` first or pass --build-web.');
        run(process.execPath, [resolveNpmCli(), 'run', 'build:web'], { cwd: REPO_ROOT, label: 'npm run build:web' });
    }
    const payloadDist = path.join(appDir, 'apps', 'web', 'dist');
    fs.cpSync(webDist, payloadDist, { recursive: true, dereference: false, verbatimSymlinks: true });
    removeTree(path.join(payloadDist, INSTALLED_FILE));
    const chunkMap = readFeatureChunks(payloadDist);
    if (!chunkMap) throw new Error('apps/web/dist has no feature-chunks.json: rebuild it with `npm run build:web`.');
    for (const tree of STATIC_TREES) excludedTracked.push(...copyTracked(tree, appDir).excluded);
    for (const file of STATIC_FILES) if (fs.existsSync(path.join(REPO_ROOT, file))) copyFile(path.join(REPO_ROOT, file), path.join(appDir, file));
    for (const file of SMOKE_FILES) copyFile(path.join(REPO_ROOT, file), path.join(appDir, file));
    const rootManifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    fs.writeFileSync(path.join(appDir, 'package.json'), `${JSON.stringify({
        name: 'goobster-runtime',
        version: rootManifest.version,
        private: true,
        license: rootManifest.license,
        description: 'Goobster standalone runtime payload. Generated by scripts/package-runtime.js; do not run npm in this directory.'
    }, null, 2)}\n`);
    const pruned = pruneForTarget(nodeModules, target);
    log(`pruned ${pruned.length} entries (other platforms' binaries, compile-only sources)`);
    const ownership = computeOwnership({ root: REPO_ROOT, catalog, target, withSandbox });
    const unreferencedDirs = ownership.unreferenced
        .map(entry => payloadDirOfLockKey(entry.path))
        .filter(dir => dir && fs.existsSync(path.join(outDir, dir)));
    for (const dir of unreferencedDirs) removeTree(path.join(outDir, dir));
    if (ownership.unreferenced.length) log(`left out ${ownership.unreferenced.length} unreferenced production dependencies: ${ownership.unreferenced.map(entry => entry.name).join(', ')}`);
    writeLaunchers(outDir, target);
    removeTree(path.join(stagingDir, 'node_modules'));
    if (!options.keepStaging) removeTree(stagingDir);

    // 4. Verify what was produced.
    const entries = walk(outDir);
    const binaries = inspectBinaries(outDir, entries);
    const violations = [
        ...rules.validatePayloadEntries(entries),
        ...rules.findCompileTraces(entries),
        ...rules.validateBinaryTargets(binaries, target),
        ...installLog.compileOutput.map(line => ({ rule: 'compiler-output-in-npm-log', rel: line }))
    ];
    for (const must of ['better-sqlite3', 'sharp']) {
        if (!installLog.prebuildFetches.some(url => url.includes(must))) {
            violations.push({ rule: 'no-prebuild-download-logged', rel: must });
        }
    }
    const licenses = collectLicenses(nodeModules);
    const nonPermissive = licenses.filter(entry => !PERMISSIVE_LICENSE.test(entry.license));

    const files = entries.filter(entry => entry.type === 'file').map(entry => ({
        path: entry.rel, size: entry.size, sha256: sha256File(entry.full)
    }));
    const payloadDigest = crypto.createHash('sha256').update(files.map(file => `${file.sha256}  ${file.path}\n`).join('')).digest('hex');
    const lockfileSha256 = sha256File(path.join(REPO_ROOT, 'package-lock.json'));

    // 5. The release catalogue: every file of the whole tree with its owner.
    for (const conflict of ownership.conflicts) violations.push({ rule: 'ownership-conflict', rel: `${conflict.file} (${conflict.owners.join(', ')})` });
    for (const missing of ownership.missingPackages) violations.push({ rule: 'import-not-in-lockfile', rel: `${missing.from} -> ${missing.package}` });
    const corePackage = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'packages', 'core', 'package.json'), 'utf8'));
    const release = buildReleaseManifest({
        ownership,
        catalog,
        coreVersion: corePackage.version,
        target: { id: targetId, platform: target.platform, arch: target.arch },
        node: { version: rules.pins.nodeVersion, abi: rules.pins.moduleVersion },
        files,
        chunks: chunkMap.chunks,
        nativeBinaries: binaries.map(({ rel }) => ({ path: rel }))
    });
    let manifest = {
        ...release,
        schema: 1,
        goobsterVersion: rootManifest.version,
        commit: (gitOutput(['rev-parse', 'HEAD']) || '').trim() || null,
        lockfileSha256,
        node: {
            ...release.node,
            moduleVersion: rules.pins.moduleVersion,
            archive: archiveInfo ? archiveInfo.file : null,
            archiveSha256: archiveInfo ? archiveInfo.sha256 : null,
            source: runtime.source,
            runtimeVerified: runtime.verified
        },
        workspaces: workspaces.map(workspace => workspace.name),
        layout: { codeRoot: 'app', runtime: 'runtime', launcher: target.platform === 'win32' ? 'bin/goobster-api.cmd' : 'bin/goobster-api', managerLauncher: target.platform === 'win32' ? 'bin/goobster-manager.cmd' : 'bin/goobster-manager' },
        payloadDigest,
        prebuiltBinariesFetched: installLog.prebuildFetches,
        libvips: installLog.libvips,
        baselines: summarizeBaselines(binaries),
        nativeBinaries: binaries.map(({ rel, size, info }) => {
            const { symbolVersions, ...summary } = info; // eslint-disable-line no-unused-vars
            return { path: rel, size, ...summary };
        }),
        licenses: { total: licenses.length, nonPermissive }
    };
    let signature = null;
    let publicKeyPath = null;
    if (options.devSign) {
        const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-payload-dev-key-'));
        try {
            const key = stage.generateDevKeyPair(path.join(keyDir, 'key'));
            ({ manifest, signature } = stage.signManifest(manifest, fs.readFileSync(key.privateKeyPath, 'utf8')));
            publicKeyPath = path.join(reportDir, `payload-dev-key-${targetId}.pub.pem`);
            fs.copyFileSync(key.publicKeyPath, publicKeyPath);
        } finally {
            removeTree(keyDir);
        }
        log(`signed with a throwaway development key ${manifest.signing.keyId} (private key deleted); public key: ${publicKeyPath}`);
    }
    stage.writeManifest(outDir, manifest, signature);

    // 6. Apply the selection: what an unselected feature owns is deleted, not hidden.
    const selected = stage.selectPayload(manifest, { features: selection.features });
    const emptied = new Set();
    for (const rel of selected.excluded.files) {
        fs.rmSync(path.join(outDir, ...rel.split('/')), { force: true });
        emptied.add(path.dirname(path.join(outDir, ...rel.split('/'))));
    }
    for (const dir of [...emptied].sort((a, b) => b.length - a.length)) {
        let current = dir;
        while (current.startsWith(`${outDir}${path.sep}`) && fs.existsSync(current) && fs.readdirSync(current).length === 0) {
            fs.rmdirSync(current);
            current = path.dirname(current);
        }
    }
    const prunedDist = pruneDist(payloadDist, { installed: selected.features.filter(id => id !== 'core') });
    fs.writeFileSync(path.join(outDir, stage.SELECTION_FILE), stage.canonicalJson(stage.selectionDocument(selected, selection.name)));
    for (const dir of selected.excluded.dependencies) {
        if (fs.existsSync(path.join(outDir, ...dir.split('/')))) violations.push({ rule: 'excluded-dependency-present', rel: dir });
    }
    for (const chunk of selected.excluded.chunks) {
        if (fs.existsSync(path.join(payloadDist, ...chunk.split('/')))) violations.push({ rule: 'excluded-chunk-present', rel: chunk });
    }
    for (const file of prunedDist.removed) violations.push({ rule: 'chunk-outside-the-catalogue', rel: file });
    let verified = null;
    try {
        verified = stage.verifyPayload(outDir, {
            expectedTarget: targetId,
            nodeAbi: rules.pins.moduleVersion,
            coreVersion: corePackage.version,
            publicKey: publicKeyPath ? fs.readFileSync(publicKeyPath, 'utf8') : undefined,
            devMode: !signature
        });
        log(`verifyPayload: ${verified.signed ? `signature verified (key ${verified.keyId})` : 'UNSIGNED development payload (signature not checked)'}; ${verified.files} files, release ${verified.releaseId}`);
    } catch (error) {
        violations.push({ rule: `payload-verify:${error.code || 'ERROR'}`, rel: error.message });
    }
    const exclusiveAbsent = manifest.dependencies.filter(dep => dep.exclusive && selected.excluded.dependencies.includes(dep.path)).map(dep => dep.name);
    log(`selection: ${selected.features.length} feature group(s) kept; removed ${selected.excluded.files.length} files, ${selected.excluded.dependencies.length} dependency directories (${exclusiveAbsent.length} exclusive), ${selected.excluded.chunks.length} portal chunks`);
    const finalEntries = walk(outDir);
    const finalFiles = finalEntries.filter(entry => entry.type === 'file');

    const report = {
        target: targetId,
        payload: outDir,
        durationSeconds: Math.round((Date.now() - started) / 1000),
        hostNode: process.version,
        bundledNode: bundledVersion.stdout.trim(),
        runtimeVerified: runtime.verified,
        payloadDigest,
        profile: selection.name,
        features: selected.features,
        excluded: {
            features: selected.excluded.features,
            files: selected.excluded.files.length,
            dependencies: selected.excluded.dependencies.length,
            exclusiveDependencies: exclusiveAbsent,
            chunks: selected.excluded.chunks.length
        },
        unreferencedDependencies: manifest.unreferenced,
        unreferencedRemoved: unreferencedDirs,
        signed: Boolean(signature),
        keyId: manifest.signing ? manifest.signing.keyId : null,
        devPublicKey: publicKeyPath,
        releaseId: verified ? verified.releaseId : null,
        sizeBytes: {
            total: finalFiles.reduce((sum, file) => sum + file.size, 0),
            runtime: treeSize(finalEntries, 'runtime'),
            nodeModules: treeSize(finalEntries, 'app/node_modules'),
            webDist: treeSize(finalEntries, 'app/apps/web/dist'),
            documentation: treeSize(finalEntries, 'app/documentation'),
            catalogue: files.reduce((sum, file) => sum + file.size, 0)
        },
        fileCount: finalFiles.length,
        catalogueFileCount: files.length,
        symlinks: finalEntries.filter(entry => entry.type === 'symlink').length,
        prebuiltBinariesFetched: installLog.prebuildFetches,
        compilerOutputLines: installLog.compileOutput.length,
        prunedEntries: pruned.length,
        excludedTrackedFiles: excludedTracked,
        nativeBinaryCount: binaries.length,
        baselines: manifest.baselines,
        nonPermissiveLicenses: nonPermissive,
        violations
    };
    fs.writeFileSync(path.join(reportDir, `package-build-${targetId}.json`), `${JSON.stringify(report, null, 2)}\n`);

    log(`payload size ${(report.sizeBytes.total / 1048576).toFixed(1)} MiB in ${report.fileCount} files; symlinks=${report.symlinks}; native binaries=${report.nativeBinaryCount}`);
    log(`payload digest ${payloadDigest}`);
    if (violations.length) {
        log(`FAILED: ${violations.length} payload rule violation(s):`);
        for (const violation of violations.slice(0, 40)) log(`  - ${violation.rule}: ${violation.rel}`);
        process.exitCode = 1;
        return;
    }
    log('payload rules passed (no symlinks, no config/data/cache/logs/tests/.env, no compile traces, all binaries match the target)');
    log(`next: ${path.join(runtimeDir, target.platform === 'win32' ? 'node.exe' : 'bin/node')} ${path.join(appDir, 'scripts', 'package-smoke.js')}`);
}

if (require.main === module) {
    main().catch((error) => {
        const message = redact(error && error.stack ? error.stack : String(error));
        process.stderr.write(`[package-runtime] ERROR: ${message}\n`);
        if (buildLog) fs.appendFileSync(buildLog, `ERROR: ${message}\n`);
        process.exit(1);
    });
}

module.exports = {
    parseArgs,
    resolveSelection,
    redact,
    launchers: { posixManager: POSIX_MANAGER_LAUNCHER, windowsManager: WINDOWS_MANAGER_LAUNCHER }
};
