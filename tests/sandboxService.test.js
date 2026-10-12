process.env.GOOBSTER_DB_PATH = require('node:path').join(require('node:os').tmpdir(), 'goobster-sandbox-service-' + process.pid + '.sqlite');
/**
 * Code sandbox service (services/sandboxService.js).
 *
 * Exercises the real executor against python3/bash/node with tiny limits:
 * output capture + truncation, output-file collection (incl. image
 * detection), the wall-clock timeout, the per-user rate limit, the
 * concurrency cap, environment scrubbing (host secrets must never leak in),
 * and the disabled/bad-input gates. Isolation-agnostic: whatever backend the
 * host offers (bwrap / unshare / none), the observable behavior is the same.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SandboxService, SandboxError, sessionKeyFor } = require('@goobster/core/services/sandboxService');

const SANDBOX_ROOT = path.join(os.tmpdir(), `goobster-sandbox-runs-${process.pid}`);

function makeConfig(overrides = {}) {
    return {
        enabled: true,
        scope: 'everywhere',
        runsDir: SANDBOX_ROOT,
        timeoutMs: 15_000,
        maxCpuSeconds: 15,
        maxMemoryMb: 2048,
        maxWriteMb: 16,
        maxOutputBytes: 64 * 1024,
        maxOutputFiles: 8,
        maxFileSizeBytes: 8 * 1024 * 1024,
        runsPerWindow: 100,
        maxConcurrent: 4,
        retentionHours: 24,
        allowNetwork: false,
        pythonCommand: 'python3',
        extraBinds: [],
        requireStrongIsolation: false,
        ...overrides
    };
}

afterAll(() => {
    try { fs.rmSync(SANDBOX_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(`${SANDBOX_ROOT}-sessions`, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('gates and validation', () => {
    test('run() throws when disabled', async () => {
        const svc = new SandboxService(makeConfig({ enabled: false }));
        expect(svc.enabled).toBe(false);
        await expect(svc.run({ language: 'python', code: 'print(1)' }))
            .rejects.toMatchObject({ name: 'SandboxError', code: 'DISABLED', status: 403 });
    });

    test('rejects unknown language', async () => {
        const svc = new SandboxService(makeConfig());
        await expect(svc.run({ language: 'ruby', code: 'puts 1' }))
            .rejects.toMatchObject({ code: 'BAD_LANGUAGE', status: 400 });
    });

    test('rejects empty code', async () => {
        const svc = new SandboxService(makeConfig());
        await expect(svc.run({ language: 'python', code: '   ' }))
            .rejects.toMatchObject({ code: 'EMPTY_CODE', status: 400 });
    });

    test('language aliases normalize', async () => {
        const svc = new SandboxService(makeConfig());
        const res = await svc.run({ language: 'py', code: 'print("hi")' });
        expect(res.language).toBe('python');
        expect(res.ok).toBe(true);
    });
});

describe('execution', () => {
    test('python: captures stdout and exit 0', async () => {
        const svc = new SandboxService(makeConfig());
        const res = await svc.run({ language: 'python', code: 'print(6 * 7)' });
        expect(res.ok).toBe(true);
        expect(res.exitCode).toBe(0);
        expect(res.timedOut).toBe(false);
        expect(res.stdout.trim()).toBe('42');
        expect(['bwrap', 'unshare', 'none']).toContain(res.isolation);
    });

    test('bash: reads stdin', async () => {
        const svc = new SandboxService(makeConfig());
        const res = await svc.run({ language: 'bash', code: 'read x; echo "got:$x"', stdin: 'hello\n' });
        expect(res.stdout.trim()).toBe('got:hello');
    });

    test('non-zero exit is reported, not thrown', async () => {
        const svc = new SandboxService(makeConfig());
        const res = await svc.run({ language: 'bash', code: 'echo oops >&2; exit 3' });
        expect(res.ok).toBe(false);
        expect(res.exitCode).toBe(3);
        expect(res.stderr).toContain('oops');
    });

    test('collects output files and flags images', async () => {
        const svc = new SandboxService(makeConfig());
        const res = await svc.run({
            language: 'bash',
            code: 'echo hello > notes.txt; printf "PNGDATA" > chart.png'
        });
        expect(res.ok).toBe(true);
        const names = res.files.map(f => f.name).sort();
        expect(names).toEqual(['chart.png', 'notes.txt']);
        const png = res.files.find(f => f.name === 'chart.png');
        const txt = res.files.find(f => f.name === 'notes.txt');
        expect(png.isImage).toBe(true);
        expect(txt.isImage).toBe(false);
        expect(png.size).toBeGreaterThan(0);
        expect(fs.existsSync(png.path)).toBe(true);
    });

    test('the source file is never collected as output', async () => {
        const svc = new SandboxService(makeConfig());
        const res = await svc.run({ language: 'python', code: 'print("noop")' });
        expect(res.files.find(f => f.name === 'main.py')).toBeUndefined();
    });
});

describe('limits', () => {
    test('wall-clock timeout stops a long run', async () => {
        const svc = new SandboxService(makeConfig({ timeoutMs: 1500, maxCpuSeconds: 30 }));
        const res = await svc.run({ language: 'python', code: 'import time; time.sleep(30)' });
        expect(res.timedOut).toBe(true);
        expect(res.ok).toBe(false);
    }, 20_000);

    test('a snippet that ignores SIGTERM is still reported as timed out', async () => {
        // coreutils `timeout -k` escalates to SIGKILL, which can take out the
        // whole process group (`timeout` included) - the run must still be
        // labeled a timeout, not a mystery signal death.
        const svc = new SandboxService(makeConfig({ timeoutMs: 1500, maxCpuSeconds: 30 }));
        const res = await svc.run({
            language: 'python',
            code: 'import signal, time\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\ntime.sleep(30)'
        });
        expect(res.timedOut).toBe(true);
        expect(res.ok).toBe(false);
    }, 20_000);

    test('stdout is truncated at the byte cap', async () => {
        const svc = new SandboxService(makeConfig({ maxOutputBytes: 256 }));
        const res = await svc.run({ language: 'python', code: 'print("x" * 5000)' });
        expect(res.stdoutTruncated).toBe(true);
        expect(res.stdout.length).toBeLessThan(600);
    });

    test('per-user rate limit trips after the window budget', async () => {
        const svc = new SandboxService(makeConfig({ runsPerWindow: 2 }));
        await svc.run({ language: 'python', code: 'print(1)', userId: 'u1' });
        await svc.run({ language: 'python', code: 'print(2)', userId: 'u1' });
        await expect(svc.run({ language: 'python', code: 'print(3)', userId: 'u1' }))
            .rejects.toMatchObject({ code: 'RATE_LIMITED', status: 429 });
        // A different user is unaffected.
        await expect(svc.run({ language: 'python', code: 'print(4)', userId: 'u2' }))
            .resolves.toMatchObject({ ok: true });
    });

    test('concurrency cap rejects when busy', async () => {
        const svc = new SandboxService(makeConfig({ maxConcurrent: 1 }));
        svc._active = 1; // simulate an in-flight run
        await expect(svc.run({ language: 'python', code: 'print(1)' }))
            .rejects.toMatchObject({ code: 'BUSY', status: 429 });
    });
});

describe('environment scrubbing', () => {
    test('host secrets are not visible to the snippet', async () => {
        process.env.SANDBOX_SECRET_TEST = 'super-secret-value';
        process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-openai-key';
        try {
            const svc = new SandboxService(makeConfig());
            const res = await svc.run({
                language: 'python',
                code: 'import os; print("SECRET=" + repr(os.environ.get("SANDBOX_SECRET_TEST")));'
                    + ' print("OPENAI=" + repr(os.environ.get("OPENAI_API_KEY")))'
            });
            expect(res.stdout).toContain('SECRET=None');
            expect(res.stdout).toContain('OPENAI=None');
            expect(res.stdout).not.toContain('super-secret-value');
        } finally {
            delete process.env.SANDBOX_SECRET_TEST;
        }
    });

    test('matplotlib backend is forced headless', async () => {
        const svc = new SandboxService(makeConfig());
        const res = await svc.run({
            language: 'python',
            code: 'import os; print(os.environ.get("MPLBACKEND"))'
        });
        expect(res.stdout.trim()).toBe('Agg');
    });
});

describe('strong isolation', () => {
    const { spawnSync } = require('node:child_process');
    const bwrapOnPath = spawnSync('sh', ['-c', 'command -v bwrap'], { stdio: 'ignore' }).status === 0;
    const bwrapCanRun = bwrapOnPath && spawnSync('bwrap', [
        '--ro-bind-try', '/usr', '/usr',
        '--ro-bind-try', '/lib', '/lib',
        '--ro-bind-try', '/lib64', '/lib64',
        '--ro-bind-try', '/bin', '/bin',
        '--tmpfs', '/tmp', '--die-with-parent', '--', '/usr/bin/true'
    ], { encoding: 'utf8' }).status === 0;

    test('bwrap includes --unshare-net only when the probe succeeds', () => {
        const svc = new SandboxService(makeConfig({ requireStrongIsolation: false }));
        svc._isolation = 'bwrap';
        svc._bwrapCore = [];
        svc._bwrapNetNs = false;
        const built = svc._buildArgv('bwrap', '/tmp/work', 'true');
        expect(built.args.join(' ')).not.toContain('--unshare-net');
        svc._bwrapNetNs = true;
        const withNet = svc._buildArgv('bwrap', '/tmp/work', 'true');
        expect(withNet.args.join(' ')).toContain('--unshare-net');
    });

    test('requireStrongIsolation refuses when the network-namespace probe fails', async () => {
        const svc = new SandboxService(makeConfig({ requireStrongIsolation: true }));
        svc._isolation = 'bwrap';
        svc._bwrapCore = [];
        svc._bwrapNetNs = false;
        await expect(svc.run({ language: 'bash', code: 'echo hi' }))
            .rejects.toMatchObject({ code: 'ISOLATION_UNAVAILABLE', status: 503 });
        expect(() => svc._buildArgv('bwrap', '/tmp/work', 'true')).toThrow(SandboxError);
        try {
            svc._buildArgv('bwrap', '/tmp/work', 'true');
        } catch (error) {
            expect(error.code).toBe('ISOLATION_UNAVAILABLE');
        }
    });

    test('isolated snippet cannot connect to a host listener', async () => {
        const net = require('node:net');
        const svc = new SandboxService(makeConfig({ requireStrongIsolation: true }));
        if (!bwrapCanRun || !svc._bwrapSupportsNetNs()) {
            if (process.env.GOOBSTER_REQUIRE_BWRAP === '1' && bwrapCanRun) {
                throw new Error(
                    'GOOBSTER_REQUIRE_BWRAP=1 but bwrap --unshare-net is unavailable; '
                    + 'strong isolation must refuse rather than leak the host network.'
                );
            }
            svc._isolation = 'bwrap';
            svc._bwrapCore = [];
            svc._bwrapNetNs = false;
            await expect(svc.run({ language: 'python', code: 'print(1)' }))
                .rejects.toMatchObject({ code: 'ISOLATION_UNAVAILABLE' });
            return;
        }

        const server = net.createServer();
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
        });
        const port = server.address().port;
        let gotConn = false;
        server.on('connection', (socket) => {
            gotConn = true;
            socket.destroy();
        });
        try {
            const res = await svc.run({
                language: 'python',
                code: [
                    'import socket',
                    's = socket.socket()',
                    's.settimeout(1)',
                    'try:',
                    `    s.connect(("127.0.0.1", ${port}))`,
                    '    print("CONNECTED")',
                    'except Exception:',
                    '    print("BLOCKED")'
                ].join('\n')
            });
            expect(gotConn).toBe(false);
            expect(res.stdout).toMatch(/BLOCKED/);
            expect(res.stdout).not.toMatch(/CONNECTED/);
        } finally {
            await new Promise(resolve => server.close(resolve));
        }
    });

    test('requireStrongIsolation refuses unshare/none fallbacks', async () => {
        const svc = new SandboxService(makeConfig({ requireStrongIsolation: true }));
        svc._isolation = 'none';
        await expect(svc.run({ language: 'bash', code: 'echo hi' }))
            .rejects.toMatchObject({ code: 'ISOLATION_UNAVAILABLE', status: 503 });
    });

    test('canary: snippet cannot read a planted secret or a sibling project', async () => {
        if (!bwrapCanRun) {
            if (process.env.GOOBSTER_REQUIRE_BWRAP === '1') {
                throw new Error(
                    'GOOBSTER_REQUIRE_BWRAP=1 but bwrap cannot create a sandbox '
                    + `(${bwrapOnPath ? 'installed, uid_map/mount namespace denied' : 'not on PATH'}). `
                    + 'Need a host where bwrap can exec /usr/bin/true with /usr+/lib bound.'
                );
            }
            const svc = new SandboxService(makeConfig({ requireStrongIsolation: true }));
            await expect(svc.run({ language: 'bash', code: 'echo hi' }))
                .rejects.toMatchObject({ code: 'ISOLATION_UNAVAILABLE' });
            return;
        }

        const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-canary-secret-'));
        const secretFile = path.join(secretDir, 'config.json');
        fs.writeFileSync(secretFile, '{"token":"LEAK_ME_BOT_TOKEN"}');

        const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-canary-projects-'));
        const neighbor = path.join(projectsRoot, 'other-user', 'secret-project');
        fs.mkdirSync(neighbor, { recursive: true });
        fs.writeFileSync(path.join(neighbor, 'notes.txt'), 'NEIGHBOR_SECRET');

        const own = path.join(projectsRoot, 'me', 'allowed-project');
        fs.mkdirSync(own, { recursive: true });
        fs.writeFileSync(path.join(own, 'ok.txt'), 'OWN_OK');

        try {
            const svc = new SandboxService(makeConfig({ requireStrongIsolation: true }));
            if (!svc._bwrapSupportsNetNs()) {
                await expect(svc.run({ language: 'bash', code: 'echo hi', projectDir: own }))
                    .rejects.toMatchObject({ code: 'ISOLATION_UNAVAILABLE' });
                return;
            }
            const res = await svc.run({
                language: 'bash',
                projectDir: own,
                code: [
                    `echo "own:$(cat "$GOOBSTER_PROJECT_DIR/ok.txt")"`,
                    `echo "secret:$(cat '${secretFile}' 2>/dev/null || echo BLOCKED)"`,
                    `echo "neighbor:$(cat '${path.join(neighbor, 'notes.txt')}' 2>/dev/null || echo BLOCKED)"`
                ].join('; ')
            });
            expect(res.isolation).toBe('bwrap');
            expect(res.stdout).toContain('own:OWN_OK');
            expect(res.stdout).toContain('secret:BLOCKED');
            expect(res.stdout).toContain('neighbor:BLOCKED');
            expect(res.stdout).not.toContain('LEAK_ME_BOT_TOKEN');
            expect(res.stdout).not.toContain('NEIGHBOR_SECRET');
        } finally {
            try { fs.rmSync(secretDir, { recursive: true, force: true }); } catch { /* ignore */ }
            try { fs.rmSync(projectsRoot, { recursive: true, force: true }); } catch { /* ignore */ }
        }
    });
});

describe('conversation workspaces', () => {
    const key = (channelId, userId = 'u-session') => sessionKeyFor({ userId, channelId });

    test('sessionKeyFor is stable, per user and per channel, and hides both ids', () => {
        expect(key('web:u-session:a')).toBe(key('web:u-session:a'));
        expect(key('web:u-session:a')).not.toBe(key('web:u-session:b'));
        expect(key('chan', 'u1')).not.toBe(key('chan', 'u2'));
        expect(key('chan', 'u1').split('/')[0]).toBe(key('other', 'u1').split('/')[0]);
        expect(key('web:u-session:a')).not.toMatch(/u-session/);
        expect(sessionKeyFor({ userId: 'u1' })).toBeNull();
        expect(sessionKeyFor({ channelId: 'c' })).toBeNull();
    });

    test('files and $TMPDIR survive between runs with the same key only', async () => {
        const svc = new SandboxService(makeConfig());
        const sessionKey = key('web:u-session:persist');
        const first = await svc.run({
            language: 'bash', sessionKey,
            code: 'mkdir -p repo && echo built > repo/state.txt && echo scratch > "$TMPDIR/cache.txt"'
        });
        expect(first.ok).toBe(true);
        expect(first.persistent).toBe(true);
        const second = await svc.run({
            language: 'bash', sessionKey,
            code: 'cat repo/state.txt "$TMPDIR/cache.txt"'
        });
        expect(second.stdout).toBe('built\nscratch\n');
        const other = await svc.run({
            language: 'bash', sessionKey: key('web:u-session:elsewhere'),
            code: 'test -e repo/state.txt && echo leaked || echo clean'
        });
        expect(other.stdout.trim()).toBe('clean');
        const oneOff = await svc.run({ language: 'bash', code: 'test -e repo/state.txt && echo leaked || echo clean' });
        expect(oneOff.stdout.trim()).toBe('clean');
        expect(oneOff.persistent).toBe(false);
    });

    test('only new or changed files are attached, from a stable per-run copy', async () => {
        const svc = new SandboxService(makeConfig());
        const sessionKey = key('web:u-session:outputs');
        const first = await svc.run({ language: 'bash', sessionKey, code: 'echo v1 > chart.png; echo keep > notes.txt' });
        expect(first.files.map(f => f.name).sort()).toEqual(['chart.png', 'notes.txt']);
        const firstChart = first.files.find(f => f.name === 'chart.png');

        const second = await svc.run({ language: 'bash', sessionKey, code: 'sleep 0.05; echo v2-longer > chart.png' });
        expect(second.files.map(f => f.name)).toEqual(['chart.png']);
        // The earlier attachment is untouched by the overwrite.
        expect(fs.readFileSync(firstChart.path, 'utf8')).toBe('v1\n');
        expect(fs.readFileSync(second.files[0].path, 'utf8')).toBe('v2-longer\n');
        expect(path.dirname(second.files[0].path)).toBe(path.join(SANDBOX_ROOT, second.runId));

        const quiet = await svc.run({ language: 'bash', sessionKey, code: 'cat notes.txt' });
        expect(quiet.files).toEqual([]);
    });

    test('the snippet source never clobbers or shows up beside the user\'s files', async () => {
        const svc = new SandboxService(makeConfig());
        const sessionKey = key('web:u-session:source');
        await svc.run({ language: 'bash', sessionKey, code: 'echo "print(\'mine\')" > main.py' });
        const res = await svc.run({ language: 'python', sessionKey, code: 'import os; print(open("main.py").read().strip()); print(sorted(os.listdir(".")))' });
        expect(res.ok).toBe(true);
        expect(res.stdout).toContain("print('mine')");
        expect(res.files).toEqual([]);
        const after = await svc.run({ language: 'bash', sessionKey, code: 'ls -A' });
        // Only this run's own script; the previous run's source was removed.
        expect(after.stdout).not.toMatch(/goobster-run\.py/);
    });

    test('symlinks planted in a workspace are replaced, never followed', async () => {
        const svc = new SandboxService(makeConfig());
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-host-secret-'));
        fs.writeFileSync(path.join(outside, 'config.json'), 'TOKEN');
        try {
            const sessionKey = key('web:u-session:symlinks');
            const plant = await svc.run({
                language: 'bash', sessionKey,
                code: `rm -rf tmp && ln -s '${outside}' tmp && ln -s '${outside}/config.json' .goobster-run.py`
            });
            expect(plant.ok).toBe(true);
            const next = await svc.run({ language: 'python', sessionKey, code: 'import os; print(os.listdir(os.environ["TMPDIR"]))' });
            expect(next.ok).toBe(true);
            expect(next.stdout).not.toContain('config.json');
            expect(fs.readFileSync(path.join(outside, 'config.json'), 'utf8')).toBe('TOKEN');
            const dir = path.join(`${SANDBOX_ROOT}-sessions`, ...sessionKey.split('/'));
            expect(fs.lstatSync(path.join(dir, 'tmp')).isDirectory()).toBe(true);

            const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-scratch-link-'));
            try {
                fs.symlinkSync(outside, path.join(projectDir, 'scratch'));
                const res = await svc.run({
                    language: 'bash', projectDir, scratchDir: path.join(projectDir, 'scratch'), code: 'ls -A'
                });
                expect(res.stdout).not.toContain('config.json');
                expect(fs.lstatSync(path.join(projectDir, 'scratch')).isDirectory()).toBe(true);
                expect(fs.readFileSync(path.join(outside, 'config.json'), 'utf8')).toBe('TOKEN');
            } finally {
                fs.rmSync(projectDir, { recursive: true, force: true });
            }
        } finally {
            fs.rmSync(outside, { recursive: true, force: true });
        }
    });

    test('a forged session key is refused', async () => {
        const svc = new SandboxService(makeConfig());
        await expect(svc.run({ language: 'bash', code: 'true', sessionKey: '../../etc' }))
            .rejects.toMatchObject({ code: 'BAD_SESSION', status: 400 });
    });

    test('discardSession and forgetUser remove workspaces; idle ones are pruned', async () => {
        const svc = new SandboxService(makeConfig({ sessionRetentionHours: 1 }));
        const root = `${SANDBOX_ROOT}-sessions`;
        const dirOf = (k) => path.join(root, ...k.split('/'));

        await svc.run({ language: 'bash', sessionKey: key('c1', 'u-erase'), code: 'echo x > f' });
        await svc.run({ language: 'bash', sessionKey: key('c2', 'u-erase'), code: 'echo x > f' });
        expect(svc.discardSession({ userId: 'u-erase', channelId: 'c1' })).toBe(true);
        expect(fs.existsSync(dirOf(key('c1', 'u-erase')))).toBe(false);
        expect(fs.existsSync(dirOf(key('c2', 'u-erase')))).toBe(true);
        expect(svc.forgetUser('u-erase')).toBe(1);
        expect(fs.existsSync(dirOf(key('c2', 'u-erase')))).toBe(false);

        await svc.run({ language: 'bash', sessionKey: key('idle', 'u-prune'), code: 'echo x > f' });
        const stale = new Date(Date.now() - 2 * 60 * 60 * 1000);
        fs.utimesSync(dirOf(key('idle', 'u-prune')), stale, stale);
        await svc.run({ language: 'bash', sessionKey: key('busy', 'u-prune'), code: 'true' });
        expect(fs.existsSync(dirOf(key('idle', 'u-prune')))).toBe(false);
        expect(fs.existsSync(dirOf(key('busy', 'u-prune')))).toBe(true);
    });

    test('a project scratchDir persists cwd and $TMPDIR, inside the project, never pruned', async () => {
        const svc = new SandboxService(makeConfig({ sessionRetentionHours: 1 }));
        const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-scratch-project-'));
        try {
            const scratchDir = path.join(projectDir, 'scratch');
            const first = await svc.run({
                language: 'bash', projectDir, scratchDir,
                code: 'echo cloned > repo.txt; echo cached > "$TMPDIR/c"; pwd'
            });
            expect(first.ok).toBe(true);
            expect(first.persistent).toBe(true);
            expect(first.stdout.trim()).toBe(scratchDir);
            expect(first.files.map(f => f.name)).toEqual(['repo.txt']);
            expect(path.dirname(first.files[0].path)).toBe(path.join(SANDBOX_ROOT, first.runId));

            const stale = new Date(Date.now() - 48 * 60 * 60 * 1000);
            fs.utimesSync(scratchDir, stale, stale);
            const second = await svc.run({
                language: 'bash', projectDir, scratchDir,
                code: 'cat repo.txt "$TMPDIR/c"; ls -A'
            });
            expect(second.stdout).toContain('cloned\ncached\n');
            expect(second.stdout).not.toMatch(/goobster-run\.(py|js)/);
            expect(second.files).toEqual([]);
            expect(fs.existsSync(path.join(scratchDir, 'repo.txt'))).toBe(true);
        } finally {
            fs.rmSync(projectDir, { recursive: true, force: true });
        }
    });

    test('scratchDir must sit inside projectDir and excludes a sessionKey', async () => {
        const svc = new SandboxService(makeConfig());
        const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-scratch-guard-'));
        try {
            for (const params of [
                { scratchDir: path.join(projectDir, 'scratch') },
                { projectDir, scratchDir: projectDir },
                { projectDir, scratchDir: path.join(projectDir, '..', 'elsewhere') },
                { projectDir, scratchDir: 'scratch' },
                { projectDir, scratchDir: path.join(projectDir, 'scratch'), sessionKey: key('both') }
            ]) {
                await expect(svc.run({ language: 'bash', code: 'true', ...params }))
                    .rejects.toMatchObject({ code: 'BAD_SCRATCH_DIR', status: 400 });
            }
        } finally {
            fs.rmSync(projectDir, { recursive: true, force: true });
        }
    });

    test('bwrap mounts the workspace tmp over /tmp instead of a tmpfs', () => {
        const svc = new SandboxService(makeConfig({ allowNetwork: true }));
        const throwaway = svc._buildArgv('bwrap', '/tmp/work', 'true').args;
        expect(throwaway.join(' ')).toContain('--tmpfs /tmp');
        const kept = svc._buildArgv('bwrap', '/data/s/w', 'true', null, null, '/data/s/w/tmp').args;
        expect(kept.join(' ')).toContain('--bind /data/s/w/tmp /tmp');
        expect(kept).not.toContain('--tmpfs');
    });
});

test('SandboxError is exported', () => {
    expect(new SandboxError(400, 'X', 'msg')).toBeInstanceOf(Error);
});
