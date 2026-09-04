#!/usr/bin/env node
/**
 * Isolated-execution smoke: plant a secret and a neighboring project,
 * then assert a snippet cannot read either. Requires working Bubblewrap.
 *
 * Used by CI against the host (after apt install bubblewrap) and inside
 * the sandbox deployment image (`deploy/sandbox.Dockerfile`).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { SandboxService } = require('@goobster/core/services/sandboxService');

function fail(message) {
    console.error(`[sandbox-isolation-smoke] ${message}`);
    process.exit(1);
}

const bwrapOnPath = spawnSync('sh', ['-c', 'command -v bwrap'], { stdio: 'ignore' }).status === 0;
const probe = spawnSync('bwrap', [
    '--ro-bind-try', '/usr', '/usr',
    '--ro-bind-try', '/lib', '/lib',
    '--ro-bind-try', '/lib64', '/lib64',
    '--ro-bind-try', '/bin', '/bin',
    '--tmpfs', '/tmp', '--die-with-parent', '--', '/usr/bin/true'
], { encoding: 'utf8' });
if (!bwrapOnPath || probe.status !== 0) {
    fail(
        'working Bubblewrap is required. '
        + (bwrapOnPath
            ? `bwrap probe failed: ${String(probe.stderr || probe.stdout || '').trim()}`
            : 'bwrap is not on PATH.')
    );
}

const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-smoke-secret-'));
const secretFile = path.join(secretDir, 'config.json');
fs.writeFileSync(secretFile, '{"token":"LEAK_ME_BOT_TOKEN"}');

const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-smoke-projects-'));
const neighbor = path.join(projectsRoot, 'other-user', 'secret-project');
fs.mkdirSync(neighbor, { recursive: true });
fs.writeFileSync(path.join(neighbor, 'notes.txt'), 'NEIGHBOR_SECRET');

const own = path.join(projectsRoot, 'me', 'allowed-project');
fs.mkdirSync(own, { recursive: true });
fs.writeFileSync(path.join(own, 'ok.txt'), 'OWN_OK');

const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-smoke-runs-'));

(async () => {
    try {
        const svc = new SandboxService({
            enabled: true,
            requireStrongIsolation: true,
            timeoutMs: 15_000,
            maxCpuSeconds: 15,
            maxMemoryMb: 512,
            maxWriteMb: 8,
            maxOutputBytes: 64 * 1024,
            maxOutputFiles: 8,
            runsPerWindow: 10,
            maxConcurrent: 2,
            allowNetwork: false,
            pythonCommand: 'python3',
            extraBinds: [],
            runsDir
        });
        const res = await svc.run({
            language: 'bash',
            projectDir: own,
            code: [
                `echo "own:$(cat "$GOOBSTER_PROJECT_DIR/ok.txt")"`,
                `echo "secret:$(cat '${secretFile}' 2>/dev/null || echo BLOCKED)"`,
                `echo "neighbor:$(cat '${path.join(neighbor, 'notes.txt')}' 2>/dev/null || echo BLOCKED)"`
            ].join('; ')
        });
        if (res.isolation !== 'bwrap') {
            fail(`expected isolation=bwrap, got ${res.isolation}`);
        }
        if (!res.stdout.includes('own:OWN_OK')) fail(`own project was not readable: ${res.stdout}`);
        if (!res.stdout.includes('secret:BLOCKED')) fail(`planted secret leaked: ${res.stdout}`);
        if (!res.stdout.includes('neighbor:BLOCKED')) fail(`neighbor project leaked: ${res.stdout}`);
        if (res.stdout.includes('LEAK_ME_BOT_TOKEN')) fail('bot token appeared in stdout');
        if (res.stdout.includes('NEIGHBOR_SECRET')) fail('neighbor secret appeared in stdout');

        if (!svc._bwrapSupportsNetNs()) {
            fail('bwrap --unshare-net is required; strong isolation must not fail open');
        }
        const net = require('node:net');
        const listener = net.createServer();
        await new Promise((resolve, reject) => {
            listener.once('error', reject);
            listener.listen(0, '127.0.0.1', resolve);
        });
        const port = listener.address().port;
        let gotConn = false;
        listener.on('connection', (socket) => {
            gotConn = true;
            socket.destroy();
        });
        try {
            const netRes = await svc.run({
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
            if (gotConn) fail('isolated snippet connected to the host listener');
            if (!String(netRes.stdout || '').includes('BLOCKED')) {
                fail(`expected BLOCKED from isolated connect, got: ${netRes.stdout}`);
            }
            if (String(netRes.stdout || '').includes('CONNECTED')) {
                fail('isolated snippet reported CONNECTED');
            }
        } finally {
            await new Promise(resolve => listener.close(resolve));
        }
        console.log('[sandbox-isolation-smoke] ok (bwrap blocked secret, neighbor, and host network)');
    } catch (error) {
        fail(error.stack || error.message || String(error));
    } finally {
        try { fs.rmSync(secretDir, { recursive: true, force: true }); } catch { /* ignore */ }
        try { fs.rmSync(projectsRoot, { recursive: true, force: true }); } catch { /* ignore */ }
        try { fs.rmSync(runsDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
})();
