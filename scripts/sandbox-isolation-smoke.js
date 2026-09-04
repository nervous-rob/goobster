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

const hasBwrap = spawnSync('sh', ['-c', 'command -v bwrap'], { stdio: 'ignore' }).status === 0;
if (!hasBwrap) {
    fail('bwrap is not on PATH; this smoke test requires working Bubblewrap.');
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
        console.log('[sandbox-isolation-smoke] ok (bwrap blocked secret and neighbor)');
    } catch (error) {
        fail(error.stack || error.message || String(error));
    } finally {
        try { fs.rmSync(secretDir, { recursive: true, force: true }); } catch { /* ignore */ }
        try { fs.rmSync(projectsRoot, { recursive: true, force: true }); } catch { /* ignore */ }
        try { fs.rmSync(runsDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
})();
