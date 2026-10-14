/**
 * Live run output (utils/liveOutput.js): display-ready bounded tails,
 * throttled writes, and a real background job whose output is readable
 * while it runs and settles into the recorded tails.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const TEST_DB = path.join(os.tmpdir(), `goobster-live-output-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const { JobLiveOutput, LiveTail, displayText } = require('@goobster/core/utils/liveOutput');
const { ObservatoryService, PROJECTS_ROOT } = require('@goobster/core/services/projectService');
const { SandboxService } = require('@goobster/core/services/sandboxService');

const SANDBOX_ROOT = path.join(os.tmpdir(), `goobster-live-output-runs-${process.pid}`);
const USER = `${400_000_000_000_000_000n + BigInt(process.pid)}`;

afterAll(async () => {
    await db.closeConnection();
    try { fs.rmSync(path.join(PROJECTS_ROOT, USER), { recursive: true, force: true }); } catch { /* gone */ }
    try { fs.rmSync(SANDBOX_ROOT, { recursive: true, force: true }); } catch { /* gone */ }
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(TEST_DB + suffix); } catch { /* gone */ }
    }
});

describe('display-ready tails', () => {
    test('escape codes go, a progress line keeps its last state, CRLF is a newline', () => {
        expect(displayText('\u001b[32mgreen\u001b[0m done\r\n')).toBe('green done\n');
        expect(displayText('loading 10%\rloading 50%\rloading 100%\nnext')).toBe('loading 100%\nnext');
        expect(displayText('\u001b]0;title\u0007plain')).toBe('plain');
    });

    test('UTF-8 split across chunks decodes whole, and the tail is capped', () => {
        const tail = new LiveTail(10);
        const bytes = Buffer.from('héllo wörld ✓', 'utf8');
        for (const byte of bytes) tail.push(Buffer.from([byte]));
        expect(tail.value()).toBe('llo wörld ✓'.slice(-10));
        expect(tail.bytes).toBe(bytes.length);
    });

    test('writes are throttled, never overlap, and stop at close', async () => {
        const writes = [];
        let active = 0;
        let overlapped = false;
        const live = new JobLiveOutput({
            flushMs: 20,
            write: async (snapshot) => {
                if (active) overlapped = true;
                active++;
                await new Promise(resolve => setTimeout(resolve, 15));
                writes.push(snapshot);
                active--;
            }
        });
        live.onOutput('stdout', Buffer.from('a\n'));
        live.onOutput('stderr', Buffer.from('oops\n'));
        live.onOutput('stdout', Buffer.from('b\n'));
        expect(writes).toHaveLength(0);
        await new Promise(resolve => setTimeout(resolve, 60));
        expect(writes).toHaveLength(1);
        expect(writes[0]).toMatchObject({ stdout: 'a\nb\n', stderr: 'oops\n', bytes: 9 });
        live.onOutput('stdout', Buffer.from('c\n'));
        await Promise.all([live.flush(), live.flush()]);
        expect(overlapped).toBe(false);
        await live.close();
        const count = writes.length;
        live.onOutput('stdout', Buffer.from('after close\n'));
        await live.flush();
        await new Promise(resolve => setTimeout(resolve, 40));
        expect(writes).toHaveLength(count);
    });
});

describe('a running job', () => {
    test('its output is readable while it runs, then the recorded tails take over', async () => {
        const service = new ObservatoryService({
            config: {
                enabled: true, projectsEnabled: true, scope: 'everywhere',
                maxProjectsPerUser: 5, maxMembersPerProject: 5, maxProjectMb: 8, maxActiveJobsPerUser: 2, maxResumes: 2,
                maxWorkspaceFiles: 50, maxWorkspaceReadMb: 8, maxUploadMb: 2, maxRenderFrames: 10, renderFps: 24,
                ffmpegCommand: 'ffmpeg', historyEnabled: false, gitCommand: 'git', reposEnabled: false
            },
            sandbox: new SandboxService({
                enabled: true, scope: 'everywhere', timeoutMs: 20_000, maxCpuSeconds: 20, maxMemoryMb: 2048,
                maxWriteMb: 16, maxOutputBytes: 64 * 1024, maxOutputFiles: 8, maxFileSizeBytes: 8 * 1024 * 1024,
                runsPerWindow: 1000, maxConcurrent: 4, retentionHours: 24, allowNetwork: false,
                requireStrongIsolation: false, pythonCommand: 'python3', extraBinds: [], runsDir: SANDBOX_ROOT, forceLocal: true
            })
        });
        service._liveFlushMs = 100;
        expect(service.sandbox.liveOutputSupported()).toBe(true);
        const { slug } = await service.createProject({ userId: USER, name: 'Live Lab' });
        const code = [
            'import sys, time',
            'for i in range(8):',
            '    print(f"step {i}", flush=True)',
            '    if i == 3: print("warn \\u2713", file=sys.stderr, flush=True)',
            '    time.sleep(0.3)'
        ].join('\n');
        const started = await service.run({ userId: USER, project: slug, language: 'python', code, background: true });
        const jobId = started.jobId ?? started.job?.id ?? started.id;
        expect(jobId).toBeTruthy();

        let seenLive = null;
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
            const live = await service.jobLive({ userId: USER, jobId });
            if (live.streaming && /step [1-6]/.test(live.stdout) && !/step 7/.test(live.stdout)) { seenLive = live; break; }
            if (!live.running) break;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        expect(seenLive).not.toBeNull();
        expect(seenLive).toMatchObject({ running: true, streaming: true, liveSupported: true });
        expect(seenLive.bytes).toBeGreaterThan(0);
        // `since` the same moment: nothing to send.
        const again = await service.jobLive({ userId: USER, jobId, since: seenLive.at });
        expect(again.unchanged === true || again.at !== seenLive.at).toBe(true);
        // A stranger cannot read it.
        await expect(service.jobLive({ userId: `${USER}9`, jobId })).rejects.toMatchObject({ status: 404 });

        while (Date.now() < deadline) {
            const job = await service.getJob({ userId: USER, jobId });
            if (job.status !== 'RUNNING') break;
            await new Promise(resolve => setTimeout(resolve, 150));
        }
        const settled = await service.jobLive({ userId: USER, jobId });
        expect(settled).toMatchObject({ status: 'COMPLETED', running: false, streaming: false });
        expect(settled.stdout).toContain('step 7');
        expect(settled.stderr).toContain('warn ✓');
        const row = await db.get('SELECT liveStdout, liveStderr, liveBytes, liveAt FROM observatory_jobs WHERE id = @id', { id: jobId });
        expect(row).toEqual({ liveStdout: null, liveStderr: null, liveBytes: null, liveAt: null });
    }, 30_000);

    test('a remote runner cannot stream, and says so', () => {
        const sandbox = new SandboxService({ enabled: true, scope: 'everywhere', timeoutMs: 1000, maxOutputBytes: 1024, runsDir: SANDBOX_ROOT });
        const previous = process.env.GOOBSTER_SANDBOX_URL;
        process.env.GOOBSTER_SANDBOX_URL = 'http://sandbox:3200';
        try {
            expect(sandbox.liveOutputSupported()).toBe(false);
        } finally {
            if (previous === undefined) delete process.env.GOOBSTER_SANDBOX_URL;
            else process.env.GOOBSTER_SANDBOX_URL = previous;
        }
    });
});
