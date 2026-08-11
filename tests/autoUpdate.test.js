/**
 * Continuous deployment updater (scripts/auto-update.sh): change detection,
 * the stop -> pull -> install -> daemon-reload -> start sequence, and the
 * automatic rollback when a new commit does not come back healthy.
 *
 * The real script runs against a throwaway git remote, with systemd replaced
 * by a fake `systemctl` on PATH and /health served by a local HTTP server that
 * reports the deployed version as broken or healthy.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'auto-update.sh');

// The failure paths wait out a (shortened) health check timeout.
jest.setTimeout(60000);

const GIT_ENV = {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'Deploy Test',
    GIT_AUTHOR_EMAIL: 'deploy@test.local',
    GIT_COMMITTER_NAME: 'Deploy Test',
    GIT_COMMITTER_EMAIL: 'deploy@test.local'
};

// The installer stub the fake repo ships: records the version it installed so
// the test can see how many times (and on which commit) the install step ran.
const INSTALL_STUB = `#!/usr/bin/env bash
set -euo pipefail
echo "install $(cat VERSION)" >> "\${INSTALL_LOG}"
if [[ -f INSTALL_FAILS ]]; then
    echo "simulated install failure" >&2
    exit 1
fi
`;

// Health probe stand-in for the bot's /health endpoint. It lives in its own
// process because the test drives the updater with spawnSync, which blocks
// this process's event loop while the deploy runs.
const HEALTH_SERVER = `
const fs = require('node:fs');
const http = require('node:http');
const broken = (process.env.BROKEN_VERSIONS || '').split(',').filter(Boolean);
const server = http.createServer((req, res) => {
    fs.appendFileSync(process.env.HEALTH_LOG, 'probe\\n');
    let version = '';
    try { version = fs.readFileSync(process.env.VERSION_FILE, 'utf8').trim(); } catch { version = ''; }
    if (!fs.existsSync(process.env.SERVICE_STATE) || broken.includes(version)) {
        res.writeHead(503).end('unhealthy');
        return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'healthy', version }));
});
server.listen(0, '127.0.0.1', () => {
    fs.writeFileSync(process.env.PORT_FILE, String(server.address().port));
});
`;

const SYSTEMCTL_STUB = `#!/usr/bin/env bash
cmd="\${1:-}"
shift || true
echo "\${cmd} $*" >> "\${SYSTEMCTL_LOG}"
case "\${cmd}" in
    start) : > "\${SERVICE_STATE}" ;;
    stop) rm -f "\${SERVICE_STATE}" ;;
    is-active)
        if [[ -f "\${SERVICE_STATE}" ]]; then echo active; else echo inactive; fi
        ;;
esac
exit 0
`;

function run(cmd, args, opts = {}) {
    return spawnSync(cmd, args, {
        encoding: 'utf8',
        ...opts,
        env: { ...process.env, ...(opts.env || {}) }
    });
}

function git(cwd, ...args) {
    const result = run('git', args, { cwd, env: GIT_ENV });
    if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
    }
    return (result.stdout || '').trim();
}

function writeFiles(dir, files) {
    for (const [name, content] of Object.entries(files)) {
        const target = path.join(dir, name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
    }
}

describe('scripts/auto-update.sh', () => {
    let tmp;
    let origin;
    let seed;
    let pi;
    let installLog;
    let systemctlLog;
    let serviceState;
    let systemctlStub;
    let health;

    /** Health probe: 503 while the service is stopped or the version is broken. */
    async function startHealthServer(brokenVersions = []) {
        const portFile = path.join(tmp, `port-${Date.now()}`);
        const healthLog = path.join(tmp, 'health.log');
        const child = spawn(process.execPath, ['-e', HEALTH_SERVER], {
            stdio: 'ignore',
            env: {
                ...process.env,
                PORT_FILE: portFile,
                HEALTH_LOG: healthLog,
                SERVICE_STATE: serviceState,
                VERSION_FILE: path.join(pi, 'VERSION'),
                BROKEN_VERSIONS: brokenVersions.join(',')
            }
        });
        for (let i = 0; i < 100 && !fs.existsSync(portFile); i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        if (!fs.existsSync(portFile)) throw new Error('health server did not start');
        return {
            url: `http://127.0.0.1:${fs.readFileSync(portFile, 'utf8').trim()}/health`,
            probes: () => logLines(healthLog).length,
            close: () => new Promise((resolve) => {
                child.once('exit', resolve);
                child.kill();
            })
        };
    }

    function updater(...args) {
        return run('bash', [SCRIPT, '--repo-dir', pi, '--user', os.userInfo().username, ...args], {
            env: {
                ...GIT_ENV,
                GOOBSTER_UPDATE_CONF: path.join(tmp, 'absent.conf'),
                GOOBSTER_SYSTEMCTL: systemctlStub,
                GOOBSTER_SERVICE: 'goobster',
                GOOBSTER_HEALTH_URL: health.url,
                GOOBSTER_HEALTH_TIMEOUT: '6',
                GOOBSTER_HEALTH_INTERVAL: '1',
                GOOBSTER_LOCK_FILE: path.join(tmp, 'update.lock'),
                GOOBSTER_LOG_FILE: path.join(tmp, 'auto-update.log'),
                INSTALL_LOG: installLog,
                SYSTEMCTL_LOG: systemctlLog,
                SERVICE_STATE: serviceState
            }
        });
    }

    /** Push a new commit to the remote, optionally one whose install fails. */
    function pushVersion(version, { installFails = false } = {}) {
        writeFiles(seed, { VERSION: `${version}\n` });
        if (installFails) {
            writeFiles(seed, { INSTALL_FAILS: 'yes\n' });
            git(seed, 'add', 'INSTALL_FAILS');
        }
        git(seed, 'add', 'VERSION');
        git(seed, 'commit', '-m', `Release ${version}`);
        git(seed, 'push', 'origin', 'main');
        return git(seed, 'rev-parse', 'HEAD');
    }

    function logLines(file) {
        if (!fs.existsSync(file)) return [];
        return fs.readFileSync(file, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean);
    }

    beforeEach(async () => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-cd-'));
        origin = path.join(tmp, 'origin.git');
        seed = path.join(tmp, 'seed');
        pi = path.join(tmp, 'pi');
        installLog = path.join(tmp, 'install.log');
        systemctlLog = path.join(tmp, 'systemctl.log');
        serviceState = path.join(tmp, 'service.active');
        systemctlStub = path.join(tmp, 'bin', 'systemctl');

        writeFiles(tmp, { 'bin/systemctl': SYSTEMCTL_STUB });
        fs.chmodSync(systemctlStub, 0o755);

        git(tmp, 'init', '--bare', '-b', 'main', origin);
        git(tmp, 'clone', origin, seed);
        writeFiles(seed, {
            VERSION: 'v1\n',
            '.gitignore': 'config.json\nlogs/\n',
            'scripts/install-rpi.sh': INSTALL_STUB
        });
        fs.chmodSync(path.join(seed, 'scripts', 'install-rpi.sh'), 0o755);
        git(seed, 'add', '.');
        git(seed, 'commit', '-m', 'Release v1');
        git(seed, 'push', '-u', 'origin', 'main');

        git(tmp, 'clone', origin, pi);
        // Untracked, gitignored runtime state that must survive every deploy.
        writeFiles(pi, { 'config.json': '{"token":"local"}' });
        fs.writeFileSync(serviceState, '');

        health = await startHealthServer();
    });

    afterEach(async () => {
        if (health) await health.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    test('does nothing while the working copy matches the remote branch', () => {
        const result = updater();

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Already up to date');
        expect(logLines(systemctlLog)).toEqual([]);
        expect(logLines(installLog)).toEqual([]);
    });

    test('--check reports a pending deploy without touching the service', () => {
        pushVersion('v2');

        const result = updater('--check');

        expect(result.status).toBe(10);
        expect(result.stdout).toContain('Update available');
        expect(result.stdout).toContain('Release v2');
        expect(logLines(systemctlLog)).toEqual([]);
        expect(logLines(installLog)).toEqual([]);
    });

    test('deploys a new commit: stop, pull, install, daemon-reload, start, health check', () => {
        const target = pushVersion('v2');

        const result = updater();

        expect(result.status).toBe(0);
        expect(git(pi, 'rev-parse', 'HEAD')).toBe(target);
        expect(fs.readFileSync(path.join(pi, 'VERSION'), 'utf8').trim()).toBe('v2');
        expect(logLines(installLog)).toEqual(['install v2']);

        const calls = logLines(systemctlLog);
        expect(calls[0]).toBe('stop goobster');
        expect(calls).toContain('daemon-reload');
        expect(calls.indexOf('daemon-reload')).toBeLessThan(calls.indexOf('start goobster'));
        expect(calls).toContain('start goobster');

        expect(health.probes()).toBeGreaterThan(0);
        expect(result.stdout).toContain('Deployed');
        // Gitignored runtime state is never reset by a deploy.
        expect(fs.readFileSync(path.join(pi, 'config.json'), 'utf8')).toBe('{"token":"local"}');
    });

    test('rolls back to the previous commit when the new one is unhealthy', async () => {
        const before = git(pi, 'rev-parse', 'HEAD');
        await health.close();
        health = await startHealthServer(['v2']);
        pushVersion('v2');

        const result = updater();

        expect(result.status).toBe(1);
        expect(git(pi, 'rev-parse', 'HEAD')).toBe(before);
        expect(fs.readFileSync(path.join(pi, 'VERSION'), 'utf8').trim()).toBe('v1');
        expect(logLines(installLog)).toEqual(['install v2', 'install v1']);
        expect(logLines(systemctlLog).filter((line) => line === 'start goobster')).toHaveLength(2);
        expect(fs.existsSync(serviceState)).toBe(true);
        expect(result.stdout).toContain('Rolled back');
    });

    test('rolls back when the install step itself fails', () => {
        const before = git(pi, 'rev-parse', 'HEAD');
        pushVersion('v2', { installFails: true });

        const result = updater();

        expect(result.status).toBe(1);
        expect(git(pi, 'rev-parse', 'HEAD')).toBe(before);
        expect(logLines(installLog)).toEqual(['install v2', 'install v1']);
        expect(fs.existsSync(serviceState)).toBe(true);
        expect(result.stdout).toContain('Install step failed');
    });

    test('--no-rollback leaves a failed deploy in place for inspection', async () => {
        await health.close();
        health = await startHealthServer(['v2']);
        const target = pushVersion('v2');

        const result = updater('--no-rollback');

        expect(result.status).toBe(2);
        expect(git(pi, 'rev-parse', 'HEAD')).toBe(target);
        expect(logLines(installLog)).toEqual(['install v2']);
    });
});
