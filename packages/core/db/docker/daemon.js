/**
 * The daemon check (documentation/docker_postgres.md): read-only, run before
 * Docker is offered as a database option and again before provisioning.
 *
 * It asks the `docker` CLI four questions (`docker version`, `docker info`,
 * `docker image inspect <pinned digest>`) and the host two (`pg_dump --version`,
 * free space) and turns the answers into blocks (the option stays disabled, each
 * with its remedy), warnings and notes. It never installs or starts Docker or
 * Docker Desktop, never pulls an image, never creates a container, and never
 * returns anything but names, versions, counts and booleans: no environment
 * value, no credential, no registry login.
 */

const nodeFs = require('node:fs');
const os = require('node:os');
const childProcess = require('node:child_process');
const image = require('./image');
const { createRunner } = require('./runner');

const SOCKET_DEFAULT = '/var/run/docker.sock';
const PG_DUMP_TIMEOUT_MS = 8000;
const ENGINE_MIN_MAJOR = 20;

const find = (code, detail, remedy = '', extra = {}) => ({ code, detail, remedy, ...extra });

/** Where the CLI will talk to: `DOCKER_HOST`, or the platform default. */
function hostOf({ env, platform }) {
    const raw = String(env.DOCKER_HOST || '').trim();
    if (!raw) return platform === 'win32' ? { kind: 'npipe', path: '//./pipe/docker_engine', remote: false, explicit: false } : { kind: 'unix', path: SOCKET_DEFAULT, remote: false, explicit: false };
    if (raw.startsWith('unix://')) return { kind: 'unix', path: raw.slice('unix://'.length), remote: false, explicit: true };
    if (raw.startsWith('npipe://')) return { kind: 'npipe', path: raw.slice('npipe://'.length), remote: false, explicit: true };
    if (/^(tcp|ssh|http|https):\/\//.test(raw)) return { kind: raw.split(':')[0], path: null, remote: true, explicit: true };
    return { kind: 'unknown', path: null, remote: false, explicit: true };
}

function classifyFailure(result, host, fs) {
    if (result.missing) return 'DOCKER_CLI_MISSING';
    const text = `${result.stderr}\n${result.stdout}`.toLowerCase();
    if (/permission denied|got permission denied|access is denied/.test(text)) return 'DOCKER_PERMISSION_DENIED';
    if (host.kind === 'unix' && host.path) {
        try {
            fs.accessSync(host.path, nodeFs.constants.R_OK | nodeFs.constants.W_OK);
        } catch (error) {
            if (error && error.code === 'EACCES') return 'DOCKER_PERMISSION_DENIED';
        }
    }
    if (result.timedOut) return 'DOCKER_DAEMON_TIMEOUT';
    return 'DOCKER_DAEMON_UNREACHABLE';
}

const REMEDY = Object.freeze({
    DOCKER_CLI_MISSING: 'The docker command was not found. Install Docker Engine (https://docs.docker.com/engine/install/) or Docker Desktop yourself and run this check again; this installer does not install Docker.',
    DOCKER_PERMISSION_DENIED: 'Your user may not use the Docker socket. Add the user that runs the manager to the "docker" group (then sign in again), or use rootless Docker for that user. Do not run the manager with sudo.',
    DOCKER_DAEMON_UNREACHABLE: 'The Docker daemon is not answering. Start it (systemctl start docker, or open Docker Desktop yourself) and run this check again; this installer never starts Docker Desktop.',
    DOCKER_DAEMON_TIMEOUT: 'The Docker daemon did not answer in time. Check that it is running and not stuck, then run this check again.',
    DOCKER_HOST_REMOTE: 'DOCKER_HOST points at a daemon on another machine. A database the installer owns must run on this machine, because Goobster connects to it on 127.0.0.1: unset DOCKER_HOST or choose another database option.',
    DOCKER_ENGINE_TOO_OLD: `This Docker Engine is older than ${ENGINE_MIN_MAJOR}. Update it: the installer relies on health checks and label inspection that older engines do not provide.`,
    ARCH_UNSUPPORTED: 'The pinned image is published for linux/amd64 and linux/arm64 only. A 32-bit Raspberry Pi OS or another architecture cannot run it; use an existing PostgreSQL server or SQLite.',
    OS_UNSUPPORTED: 'Docker is supported here on Linux, and on macOS and Windows through Docker Desktop with file sharing. Another host cannot run a database the installer owns.',
    CONTAINER_OS_UNSUPPORTED: 'The daemon runs Windows containers. Switch Docker Desktop to Linux containers and run this check again.'
});

/** Run `pg_dump --version` through `GOOBSTER_PG_BIN` the way the backup service does. */
function defaultPgDump({ env }) {
    const bin = env.GOOBSTER_PG_BIN ? require('node:path').join(env.GOOBSTER_PG_BIN, 'pg_dump') : 'pg_dump';
    return new Promise((resolve) => {
        childProcess.execFile(bin, ['--version'], { env, timeout: PG_DUMP_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
            if (error) resolve({ present: false, text: '' });
            else resolve({ present: true, text: String(stdout) });
        });
    });
}

function freeBytes(fs, target) {
    if (!target || typeof fs.statfsSync !== 'function') return null;
    try {
        const stat = fs.statfsSync(target);
        return Number(stat.bavail) * Number(stat.bsize);
    } catch {
        return null;
    }
}

/** The nearest existing ancestor of a path that does not exist yet (where free space is measured). */
function nearestExisting(fs, target) {
    let current = require('node:path').resolve(target);
    for (let depth = 0; depth < 64; depth++) {
        try {
            fs.statSync(current);
            return current;
        } catch {
            const parent = require('node:path').dirname(current);
            if (parent === current) return null;
            current = parent;
        }
    }
    return null;
}

/**
 * @param {Object} [options]
 * @param {{ run: Function }} [options.docker] a runner (tests pass one over a fake `docker`)
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string} [options.platform] `process.platform`
 * @param {Object} [options.fs]
 * @param {() => Promise<{ present: boolean, text: string }>} [options.pgDump]
 * @param {string|null} [options.storagePath] a host directory the operator chose; free space is read there
 * @param {number|null} [options.requiredBytes] free space the plan wants under the storage path
 * @param {string} [options.hostArch] `os.arch()`
 */
async function checkDaemon({ docker, env = process.env, platform = process.platform, fs = nodeFs, pgDump, storagePath = null, requiredBytes = null, hostArch = os.arch() } = {}) {
    const runner = docker || createRunner({ env });
    const host = hostOf({ env, platform });
    const blocks = [];
    const warnings = [];
    const notes = [];
    const pinned = image.pinned();
    const report = {
        cli: { present: false, version: null },
        daemon: { reachable: false, code: null, serverVersion: null, flavor: null, rootless: false, host: { kind: host.kind, path: host.path, explicit: host.explicit, remote: host.remote }, socket: null },
        platform: { os: platform, arch: hostArch, daemonOs: null, daemonArch: null, platform: null, supported: false, pullBytes: null },
        image: { reference: pinned.reference, humanReference: pinned.humanReference, digest: pinned.digest, postgresMajor: pinned.postgresMajor, postgresMinor: pinned.postgresMinor, pulled: null, pullBytes: null },
        backupTools: null,
        storage: { path: storagePath, freeBytes: null, requiredBytes },
        compatibility: image.compatibilityTable(),
        verdict: null
    };

    const version = await runner.run(['version', '--format', '{{json .Client}}'], { timeoutMs: 10_000 });
    let client = null;
    try { client = JSON.parse(version.stdout.trim().split('\n')[0]); } catch { /* the CLI printed nothing usable */ }
    if (version.missing || (!client && version.code !== 0 && /not found|no such file/i.test(version.stderr))) {
        report.daemon.code = 'DOCKER_CLI_MISSING';
        blocks.push(find('DOCKER_CLI_MISSING', 'The docker command is not installed or not on PATH.', REMEDY.DOCKER_CLI_MISSING));
        return finish(report, { blocks, warnings, notes, pgDump, env, fs });
    }
    report.cli = { present: true, version: client && typeof client.Version === 'string' ? client.Version.slice(0, 40) : null };

    if (host.remote) {
        report.daemon.code = 'DOCKER_HOST_REMOTE';
        blocks.push(find('DOCKER_HOST_REMOTE', `DOCKER_HOST selects a ${host.kind} daemon.`, REMEDY.DOCKER_HOST_REMOTE));
        return finish(report, { blocks, warnings, notes, pgDump, env, fs });
    }

    if (host.kind === 'unix' && host.path) {
        let exists = false;
        let usable = false;
        try { fs.statSync(host.path); exists = true; } catch { /* no socket there */ }
        if (exists) {
            try { fs.accessSync(host.path, nodeFs.constants.R_OK | nodeFs.constants.W_OK); usable = true; } catch { /* not permitted */ }
        }
        report.daemon.socket = { path: host.path, exists, usable };
    }

    const infoResult = await runner.run(['info', '--format', '{{json .}}'], { timeoutMs: 15_000 });
    let info = null;
    if (infoResult.code === 0) {
        try { info = JSON.parse(infoResult.stdout.trim().split('\n')[0]); } catch { /* unparsable */ }
    }
    if (!info || typeof info !== 'object') {
        const code = classifyFailure(infoResult, host, fs);
        report.daemon.code = code;
        blocks.push(find(code, code === 'DOCKER_PERMISSION_DENIED' ? 'The Docker socket refused this user.' : 'The Docker daemon is not reachable.', REMEDY[code]));
        return finish(report, { blocks, warnings, notes, pgDump, env, fs });
    }

    const operatingSystem = String(info.OperatingSystem || '');
    const desktop = /docker desktop/i.test(operatingSystem) || String(info.Name || '') === 'docker-desktop' || platform === 'darwin' || platform === 'win32';
    const securityOptions = Array.isArray(info.SecurityOptions) ? info.SecurityOptions.map(String) : [];
    const serverVersion = typeof info.ServerVersion === 'string' ? info.ServerVersion.slice(0, 40) : null;
    report.daemon = {
        ...report.daemon,
        reachable: true,
        serverVersion,
        flavor: desktop ? 'desktop' : 'engine',
        rootless: securityOptions.some(item => item.includes('rootless')),
        rootDir: typeof info.DockerRootDir === 'string' ? info.DockerRootDir : null
    };
    report.platform.daemonOs = String(info.OSType || '').toLowerCase() || null;
    report.platform.daemonArch = String(info.Architecture || '') || null;

    const major = Number(String(serverVersion || '').split('.')[0]);
    if (Number.isInteger(major) && major > 0 && major < ENGINE_MIN_MAJOR) {
        blocks.push(find('DOCKER_ENGINE_TOO_OLD', `Docker Engine ${serverVersion} is too old.`, REMEDY.DOCKER_ENGINE_TOO_OLD));
    }

    const hostSupported = platform === 'linux' || (desktop && (platform === 'darwin' || platform === 'win32'));
    if (!hostSupported) blocks.push(find('OS_UNSUPPORTED', `Docker on ${platform} is not supported for a database the installer owns.`, REMEDY.OS_UNSUPPORTED));
    if (report.platform.daemonOs && report.platform.daemonOs !== 'linux') {
        blocks.push(find('CONTAINER_OS_UNSUPPORTED', 'The daemon runs Windows containers.', REMEDY.CONTAINER_OS_UNSUPPORTED));
    }
    const target = image.platformOf(info.Architecture, info.OSType || 'linux');
    if (!target) {
        blocks.push(find('ARCH_UNSUPPORTED', `The daemon's architecture (${report.platform.daemonArch || 'unknown'}) has no published image.`, REMEDY.ARCH_UNSUPPORTED));
    } else {
        report.platform.platform = target.platform;
        report.platform.pullBytes = target.pullBytes;
        report.image.pullBytes = target.pullBytes;
    }
    report.platform.supported = hostSupported && Boolean(target) && report.platform.daemonOs !== 'windows';

    if (desktop) {
        notes.push(find('DOCKER_DESKTOP', 'This is Docker Desktop.', 'Containers run inside a virtual machine. A data directory you choose on this computer is shared with that machine through Docker Desktop\'s file sharing: performance and file permissions differ from a native directory, and the folder must be in Docker Desktop\'s shared paths. The default Docker volume lives inside the VM and is faster and safer.'));
    }
    if (report.daemon.rootless) {
        notes.push(find('DOCKER_ROOTLESS', 'The daemon is rootless.', 'Ports below 1024 cannot be published, and files in a host data directory are owned by a mapped user id.'));
    }

    if (target) {
        const inspected = await runner.run(['image', 'inspect', '--format', '{{.Id}}', pinned.reference], { timeoutMs: 10_000 });
        report.image.pulled = inspected.code === 0;
        if (!report.image.pulled) {
            notes.push(find('IMAGE_NOT_PULLED', `The pinned image (${pinned.humanReference}) is not on this machine.`, `Provisioning pulls it by digest (about ${Math.round((report.image.pullBytes || image.PULL_BYTES.amd64) / 1e6)} MB); this check never pulls.`));
        }
    }

    if (storagePath) {
        const existing = nearestExisting(fs, storagePath);
        report.storage.freeBytes = existing ? freeBytes(fs, existing) : null;
    } else if (!desktop && report.daemon.rootDir) {
        report.storage.freeBytes = freeBytes(fs, report.daemon.rootDir);
    }
    return finish(report, { blocks, warnings, notes, pgDump, env, fs });
}

async function finish(report, { blocks, warnings, notes, pgDump, env }) {
    const probe = await (pgDump || defaultPgDump)({ env });
    const clientMajor = probe.present ? image.parseClientMajor(probe.text) : null;
    report.backupTools = { ...image.backupCompatibility(probe.present ? clientMajor : null), version: probe.present ? String(probe.text).trim().slice(0, 80) : null };
    if (!report.backupTools.ok) {
        warnings.push(find(report.backupTools.code, report.backupTools.code === 'BACKUP_TOOLS_MISSING' ? 'pg_dump is not installed on this machine.' : `pg_dump ${clientMajor} cannot back up PostgreSQL ${image.POSTGRES_MAJOR}.`, report.backupTools.remedy));
    }
    if (report.storage.requiredBytes && report.storage.freeBytes !== null && report.storage.freeBytes < report.storage.requiredBytes) {
        blocks.push(find('STORAGE_FULL', 'There is not enough free space for the database and the image.', 'Free some space, or choose another storage location.', { freeBytes: report.storage.freeBytes, requiredBytes: report.storage.requiredBytes }));
    }
    report.verdict = { ok: blocks.length === 0, blocks, warnings, notes, next: blocks.length === 0 ? 'configure' : 'fix' };
    return report;
}

module.exports = { checkDaemon, hostOf, classifyFailure, REMEDY, freeBytes, nearestExisting, ENGINE_MIN_MAJOR };
