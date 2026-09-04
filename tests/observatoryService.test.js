/**
 * The Observatory (services/observatoryService.js).
 *
 * Exercises the real thing against the real sandbox executor with tiny
 * limits: project CRUD + caps + slug rules, the persistent workspace
 * ($GOOBSTER_PROJECT_DIR survives between runs), the per-project disk
 * quota, background jobs end to end (completion, failure, cancellation,
 * the checkpoint/resume round-trip, the resume budget), orphaned-job
 * reaping after a "crash", the frame->video render pipeline (happy path +
 * missing-ffmpeg fallback), completion notifications riding the followups
 * table, the disabled gates, and the /forget-me erasure.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

process.env.GOOBSTER_DB_PATH = path.join(os.tmpdir(), `goobster-observatory-test-${process.pid}.sqlite`);

const db = require('@goobster/core/db');
const { SandboxService } = require('@goobster/core/services/sandboxService');
const { ObservatoryService, PROJECTS_ROOT, DASHBOARDS_ROOT } = require('@goobster/core/services/observatoryService');

const SANDBOX_ROOT = path.join(os.tmpdir(), `goobster-obs-sandbox-runs-${process.pid}`);
const TEST_USERS = [];

function makeSandboxConfig(overrides = {}) {
    return {
        enabled: true,
        scope: 'everywhere',
        timeoutMs: 15_000,
        maxCpuSeconds: 15,
        maxMemoryMb: 2048,
        maxWriteMb: 16,
        maxOutputBytes: 64 * 1024,
        maxOutputFiles: 8,
        maxFileSizeBytes: 8 * 1024 * 1024,
        runsPerWindow: 1000,
        maxConcurrent: 4,
        retentionHours: 24,
        allowNetwork: false,
        pythonCommand: 'python3',
        extraBinds: [],
        requireStrongIsolation: false,
        runsDir: SANDBOX_ROOT,
        ...overrides
    };
}

function makeObservatoryConfig(overrides = {}) {
    return {
        enabled: true,
        scope: 'everywhere',
        maxProjectsPerUser: 5,
        maxProjectMb: 256,
        maxActiveJobsPerUser: 2,
        maxResumes: 12,
        maxWorkspaceFiles: 50,
        maxWorkspaceReadMb: 8,
        maxUploadMb: 50,
        maxRenderFrames: 2000,
        renderFps: 24,
        ffmpegCommand: 'ffmpeg',
        ...overrides
    };
}

function makeService({ sandbox = {}, observatory = {} } = {}) {
    return new ObservatoryService({
        config: makeObservatoryConfig(observatory),
        sandbox: new SandboxService(makeSandboxConfig(sandbox))
    });
}

/** A unique per-test user id (workspaces are keyed by user on disk). */
let userSeq = 0;
function nextUser() {
    const id = `obs-user-${process.pid}-${userSeq++}`;
    TEST_USERS.push(id);
    return id;
}

/** Assert an ObservatoryError with a machine-readable code. */
async function expectThrow(fn, expected) {
    let caught = null;
    try { await fn(); } catch (error) { caught = error; }
    expect(caught).not.toBeNull();
    expect(caught).toMatchObject(expected);
    return caught;
}

/** Poll until a job leaves RUNNING (or the deadline passes). */
async function waitForJob(svc, userId, jobId, { timeoutMs = 25_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const job = await svc.getJob({ userId, jobId });
        if (job.status !== 'RUNNING') return job;
        if (Date.now() > deadline) throw new Error(`Job #${jobId} still RUNNING after ${timeoutMs}ms`);
        await new Promise(resolve => setTimeout(resolve, 150));
    }
}

/** Wait for a predicate on the job row (e.g. renderPath set post-terminal). */
async function waitFor(fn, { timeoutMs = 10_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await fn();
        if (value) return value;
        if (Date.now() > deadline) throw new Error('waitFor timed out');
        await new Promise(resolve => setTimeout(resolve, 150));
    }
}

afterAll(() => {
    for (const userId of TEST_USERS) {
        try { fs.rmSync(path.join(PROJECTS_ROOT, userId), { recursive: true, force: true }); } catch { /* gone */ }
        try { fs.rmSync(path.join(DASHBOARDS_ROOT, userId), { recursive: true, force: true }); } catch { /* gone */ }
    }
    try { fs.rmSync(SANDBOX_ROOT, { recursive: true, force: true }); } catch { /* gone */ }
    try { fs.rmSync(process.env.GOOBSTER_DB_PATH, { force: true }); } catch { /* held open */ }
});

describe('gates', () => {
    test('disabled Observatory refuses everything', async () => {
        const svc = makeService({ observatory: { enabled: false } });
        expect(svc.enabled).toBe(false);
        await expectThrow(async () => await svc.createProject({ userId: nextUser(), name: 'x' }), { code: 'DISABLED', status: 403 });
    });

    test('a disabled sandbox disables the Observatory too (it grants persistence, not execution)', async () => {
        const svc = makeService({ sandbox: { enabled: false } });
        expect(svc.enabled).toBe(false);
        await expectThrow(async () => await svc.listProjects(nextUser()), { code: 'DISABLED' });
    });
});

describe('projects', () => {
    test('createProject slugs the name and creates an owner-only workspace', async () => {
        const svc = makeService();
        const userId = nextUser();
        const created = await svc.createProject({ userId, name: 'Galaxy Merger!! (v2)' });
        expect(created.slug).toBe('galaxy-merger-v2');
        expect(created.name).toBe('Galaxy Merger!! (v2)');
        const dir = path.join(PROJECTS_ROOT, userId, created.slug);
        expect(fs.existsSync(dir)).toBe(true);
        expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    });

    test('resolveProject returns a concrete workspace dir string (fetch-data contract)', async () => {
        const svc = makeService();
        const userId = nextUser();
        const created = await svc.createProject({ userId, name: 'space-weather-watch' });
        const row = await svc.resolveProject({ userId, project: created.slug });
        expect(row.slug).toBe('space-weather-watch');
        expect(typeof row.dir).toBe('string');
        expect(row.dir).toBe(path.join(PROJECTS_ROOT, userId, created.slug));
        expect(fs.existsSync(row.dir)).toBe(true);
        await expectThrow(async () => await svc.resolveProject({ userId, project: 'nope' }), {
            code: 'NO_SUCH_PROJECT', status: 404
        });
    });

    test('unusable names are rejected', async () => {
        const svc = makeService();
        const userId = nextUser();
        await expectThrow(async () => await svc.createProject({ userId, name: '   ' }), { code: 'BAD_NAME' });
        await expectThrow(async () => await svc.createProject({ userId, name: '!!!' }), { code: 'BAD_NAME' });
    });

    test('duplicate slugs are refused', async () => {
        const svc = makeService();
        const userId = nextUser();
        await svc.createProject({ userId, name: 'Accretion Engine' });
        await expectThrow(async () => await svc.createProject({ userId, name: 'accretion engine' }), { code: 'DUPLICATE_PROJECT', status: 409 });
    });

    test('the per-user project cap holds', async () => {
        const svc = makeService({ observatory: { maxProjectsPerUser: 2 } });
        const userId = nextUser();
        await svc.createProject({ userId, name: 'one' });
        await svc.createProject({ userId, name: 'two' });
        await expectThrow(async () => await svc.createProject({ userId, name: 'three' }), { code: 'TOO_MANY_PROJECTS' });
    });

    test('the workshop inbox project does not consume a project slot', async () => {
        const svc = makeService({ observatory: { maxProjectsPerUser: 1 } });
        const userId = nextUser();
        const workshop = await svc.ensureWorkshopProject(userId);
        expect(workshop.slug).toBe('workshop');
        expect(workshop.name).toBe('Workshop');
        const again = await svc.ensureWorkshopProject(userId);
        expect(again.id).toBe(workshop.id);
        const created = await svc.createProject({ userId, name: 'real-lab' });
        expect(created.slug).toBe('real-lab');
        await expectThrow(async () => await svc.createProject({ userId, name: 'another' }), {
            code: 'TOO_MANY_PROJECTS'
        });
    });

    test('ensureWorkshopProject works when the Observatory is disabled', async () => {
        const svc = makeService({ observatory: { enabled: false } });
        const userId = nextUser();
        const workshop = await svc.ensureWorkshopProject(userId);
        expect(workshop.slug).toBe('workshop');
        expect(fs.existsSync(path.join(PROJECTS_ROOT, userId, 'workshop'))).toBe(true);
    });

    test('projects resolve by slug or by name (case-insensitive)', async () => {
        const svc = makeService();
        const userId = nextUser();
        await svc.createProject({ userId, name: 'Moonlet Capture' });
        expect((await svc.listFiles({ userId, project: 'moonlet-capture' })).project).toBe('moonlet-capture');
        expect((await svc.listFiles({ userId, project: 'MOONLET capture' })).project).toBe('moonlet-capture');
        await expectThrow(async () => await svc.listFiles({ userId, project: 'nope' }), { code: 'NO_SUCH_PROJECT', status: 404 });
    });

    test('one user cannot see another\'s projects', async () => {
        const svc = makeService();
        const owner = nextUser();
        await svc.createProject({ userId: owner, name: 'private-sim' });
        await expectThrow(async () => await svc.listFiles({ userId: nextUser(), project: 'private-sim' }), { code: 'NO_SUCH_PROJECT' });
    });

    test('deleteProject removes the rows and the workspace tree', async () => {
        const svc = makeService();
        const userId = nextUser();
        const { slug } = await svc.createProject({ userId, name: 'ephemeral' });
        const dir = path.join(PROJECTS_ROOT, userId, slug);
        fs.writeFileSync(path.join(dir, 'data.txt'), 'bytes');
        expect(await svc.deleteProject({ userId, project: slug })).toEqual({ deleted: true, slug });
        expect(fs.existsSync(dir)).toBe(false);
        expect(await svc.listProjects(userId)).toHaveLength(0);
    });
});

describe('foreground runs (the persistent workspace)', () => {
    test('$GOOBSTER_PROJECT_DIR survives between runs', async () => {
        const svc = makeService();
        const userId = nextUser();
        await svc.createProject({ userId, name: 'state-test' });

        const first = await svc.run({
            userId, project: 'state-test', language: 'bash',
            code: 'echo "42" > "$GOOBSTER_PROJECT_DIR/state.txt"; echo wrote'
        });
        expect(first.mode).toBe('foreground');
        expect(first.result.ok).toBe(true);

        const second = await svc.run({
            userId, project: 'state-test', language: 'bash',
            code: 'cat "$GOOBSTER_PROJECT_DIR/state.txt"'
        });
        expect(second.result.stdout.trim()).toBe('42');
    });

    test('files written to the run cwd still come back as chat outputs', async () => {
        const svc = makeService();
        const userId = nextUser();
        await svc.createProject({ userId, name: 'outputs' });
        const { result } = await svc.run({
            userId, project: 'outputs', language: 'bash',
            code: 'echo report > summary.txt'
        });
        expect(result.files.map(f => f.name)).toEqual(['summary.txt']);
    });

    test('the disk quota is enforced before spending compute', async () => {
        const svc = makeService({ observatory: { maxProjectMb: 1 } });
        const userId = nextUser();
        const { slug } = await svc.createProject({ userId, name: 'over-quota' });
        fs.writeFileSync(
            path.join(PROJECTS_ROOT, userId, slug, 'big.bin'),
            Buffer.alloc(2 * 1024 * 1024)
        );
        await expect(svc.run({ userId, project: slug, language: 'bash', code: 'echo hi' }))
            .rejects.toMatchObject({ code: 'QUOTA_EXCEEDED', status: 413 });
    });
});

describe('workspace files', () => {
    test('listFiles walks subdirectories, newest first, bounded', async () => {
        const svc = makeService({ observatory: { maxWorkspaceFiles: 2 } });
        const userId = nextUser();
        const { slug } = await svc.createProject({ userId, name: 'file-walk' });
        const dir = path.join(PROJECTS_ROOT, userId, slug);
        fs.mkdirSync(path.join(dir, 'frames'));
        fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
        fs.writeFileSync(path.join(dir, 'frames', 'frame_0001.png'), 'p');
        fs.writeFileSync(path.join(dir, 'render.mp4'), 'v');

        const listing = await svc.listFiles({ userId, project: slug });
        expect(listing.totalFiles).toBe(3);
        expect(listing.files).toHaveLength(2);
        const all = new Set(['a.txt', 'frames/frame_0001.png', 'render.mp4']);
        for (const file of listing.files) expect(all.has(file.path)).toBe(true);

        // An unbounded listing sees everything and classifies types
        const wide = await makeService().listFiles({ userId, project: slug });
        expect(wide.files).toHaveLength(3);
        expect(wide.files.find(f => f.path === 'render.mp4').isVideo).toBe(true);
        expect(wide.files.find(f => f.path === 'frames/frame_0001.png').isImage).toBe(true);
    });

    test('resolveFile refuses path traversal out of the workspace', async () => {
        const svc = makeService();
        const userId = nextUser();
        const { slug } = await svc.createProject({ userId, name: 'contained' });
        fs.writeFileSync(path.join(PROJECTS_ROOT, userId, slug, 'ok.txt'), 'fine');
        expect((await svc.resolveFile({ userId, project: slug, relPath: 'ok.txt' })).name).toBe('ok.txt');
        for (const evil of ['../../../etc/passwd', '..', '/etc/passwd', 'frames/../../other']) {
            await expectThrow(async () => await svc.resolveFile({ userId, project: slug, relPath: evil }), { code: 'NOT_FOUND' });
        }
    });

    test('readWorkspaceFile returns owner bytes and refuses traversal, types, and size', async () => {
        const svc = makeService({ observatory: { maxWorkspaceReadMb: 1 } });
        const userId = nextUser();
        const other = nextUser();
        const { slug } = await svc.createProject({ userId, name: 'jwst-atlas' });
        const dir = path.join(PROJECTS_ROOT, userId, slug);
        fs.mkdirSync(path.join(dir, 'live_pointings'));
        const payload = JSON.stringify({ n: 2, items: ['a', 'b'] });
        fs.writeFileSync(path.join(dir, 'live_pointings', 'pointings.json'), payload);
        fs.writeFileSync(path.join(dir, 'notes.txt'), 'hello');
        fs.writeFileSync(path.join(dir, 'secret.py'), 'print(1)');
        fs.writeFileSync(path.join(dir, 'huge.txt'), 'x'.repeat(2 * 1024 * 1024));
        fs.mkdirSync(path.join(dir, 'frames'));

        const json = await svc.readWorkspaceFile({
            userId, slug, relativePath: 'live_pointings/pointings.json'
        });
        expect(json.mime).toBe('application/json');
        expect(json.name).toBe('pointings.json');
        expect(json.relativePath).toBe('live_pointings/pointings.json');
        expect(json.bytes.toString('utf8')).toBe(payload);
        expect(JSON.stringify(json)).not.toContain(dir);

        const text = await svc.readWorkspaceFile({ userId, slug, relativePath: 'notes.txt' });
        expect(text.mime).toBe('text/plain');
        expect(text.bytes.toString('utf8')).toBe('hello');

        await expectThrow(
            async () => await svc.readWorkspaceFile({ userId, slug, relativePath: '../../../etc/passwd' }),
            { code: 'BAD_PATH', status: 400 }
        );
        await expectThrow(
            async () => await svc.readWorkspaceFile({ userId, slug, relativePath: '/etc/passwd' }),
            { code: 'BAD_PATH', status: 400 }
        );
        await expectThrow(
            async () => await svc.readWorkspaceFile({ userId, slug, relativePath: 'frames/../../other' }),
            { code: 'BAD_PATH', status: 400 }
        );
        await expectThrow(
            async () => await svc.readWorkspaceFile({ userId, slug, relativePath: 'frames' }),
            { code: 'NOT_A_FILE', status: 400 }
        );
        await expectThrow(
            async () => await svc.readWorkspaceFile({ userId, slug, relativePath: 'secret.py' }),
            { code: 'UNSUPPORTED_TYPE', status: 415 }
        );
        await expectThrow(
            async () => await svc.readWorkspaceFile({ userId, slug, relativePath: 'huge.txt' }),
            { code: 'FILE_TOO_LARGE', status: 413 }
        );
        await expectThrow(
            async () => await svc.readWorkspaceFile({ userId: other, slug, relativePath: 'notes.txt' }),
            { code: 'NO_SUCH_PROJECT', status: 404 }
        );

        const outside = path.join(os.tmpdir(), `goobster-obs-escape-${process.pid}.txt`);
        fs.writeFileSync(outside, 'nope');
        const link = path.join(dir, 'escape.txt');
        try {
            fs.symlinkSync(outside, link);
            await expectThrow(
                async () => await svc.readWorkspaceFile({ userId, slug, relativePath: 'escape.txt' }),
                { code: 'BAD_PATH', status: 400 }
            );
        } finally {
            try { fs.unlinkSync(outside); } catch { /* gone */ }
        }
    });

    test('readWorkspaceText windows a long text file and refuses binaries', async () => {
        const svc = makeService({ observatory: { maxWorkspaceReadMb: 1 } });
        const userId = nextUser();
        const { slug } = await svc.createProject({ userId, name: 'read-window' });
        const dir = path.join(PROJECTS_ROOT, userId, slug);
        const lines = Array.from({ length: 600 }, (_, i) => `line-${i + 1}`);
        fs.mkdirSync(path.join(dir, 'src'));
        fs.writeFileSync(path.join(dir, 'src', 'long.py'), lines.join('\n'));
        fs.writeFileSync(path.join(dir, 'notes.md'), '# hello\nworld');
        fs.writeFileSync(path.join(dir, 'plot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));
        fs.writeFileSync(path.join(dir, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0x03]));

        const first = await svc.readWorkspaceText({
            userId, slug, relativePath: 'src/long.py'
        });
        expect(first.relativePath).toBe('src/long.py');
        expect(first.totalLines).toBe(600);
        expect(first.startLine).toBe(1);
        expect(first.endLine).toBe(400);
        expect(first.nextOffset).toBe(401);
        expect(first.content).toContain('line-1');
        expect(first.content).toContain('line-400');
        expect(first.content).not.toContain('line-401');
        expect(JSON.stringify(first)).not.toContain(dir);

        const rest = await svc.readWorkspaceText({
            userId, slug, relativePath: 'src/long.py', offset: 401
        });
        expect(rest.startLine).toBe(401);
        expect(rest.endLine).toBe(600);
        expect(rest.nextOffset).toBeNull();
        expect(rest.content).toContain('line-600');

        const note = await svc.readWorkspaceText({
            userId, slug, relativePath: 'notes.md'
        });
        expect(note.content).toBe('# hello\nworld');
        expect(note.nextOffset).toBeNull();

        await expectThrow(
            async () => await svc.readWorkspaceText({ userId, slug, relativePath: 'plot.png' }),
            { code: 'NOT_TEXT', status: 415 }
        );
        await expectThrow(
            async () => await svc.readWorkspaceText({ userId, slug, relativePath: 'blob.bin' }),
            { code: 'NOT_TEXT', status: 415 }
        );
        await expectThrow(
            async () => await svc.readWorkspaceText({ userId, slug, relativePath: '../../../etc/passwd' }),
            { code: 'BAD_PATH', status: 400 }
        );
    });
});

describe('the standardized project detail', () => {
    test('getProjectDetail returns registry, jobs with tails, files, and the checkpoint in one shape', async () => {
        const svc = makeService();
        const userId = nextUser();
        const { slug } = await svc.createProject({ userId, name: 'Detail Sim' });
        const dir = path.join(PROJECTS_ROOT, userId, slug);
        fs.writeFileSync(path.join(dir, 'checkpoint.json'), JSON.stringify({ step: 7 }));
        fs.writeFileSync(path.join(dir, 'plot.png'), 'pretend-png-bytes');
        const { jobId } = await svc.run({
            userId, project: slug, language: 'bash', code: 'echo tail me', background: true
        });
        await waitForJob(svc, userId, jobId);
        await svc.createShareLink({ userId, project: slug });

        const detail = await svc.getProjectDetail({ userId, project: slug });
        expect(detail.project).toMatchObject({
            slug, name: 'Detail Sim', shared: true, runningJobs: 0, totalJobs: 1
        });
        expect(detail.project.quotaMb).toBe(256);
        expect(detail.project.updatedAt).toBeTruthy();
        expect(detail.totalFiles).toBe(2);
        expect(detail.files.map(f => f.path).sort()).toEqual(['checkpoint.json', 'plot.png']);
        expect(detail.files.find(f => f.path === 'plot.png').isImage).toBe(true);
        expect(detail.checkpoint).toContain('"step":7');

        const job = detail.jobs.find(j => j.id === jobId);
        expect(job.status).toBe('COMPLETED');
        expect(job.stdoutTail).toContain('tail me');
    }, 20_000);

    test('listJobs includes output tails only when asked (the tool listing stays compact)', async () => {
        const svc = makeService();
        const userId = nextUser();
        await svc.createProject({ userId, name: 'tails' });
        const { jobId } = await svc.run({
            userId, project: 'tails', language: 'bash', code: 'echo tail bytes', background: true
        });
        await waitForJob(svc, userId, jobId);

        const compact = await svc.listJobs({ userId, project: 'tails' });
        expect(compact[0].stdoutTail).toBeUndefined();
        const full = await svc.listJobs({ userId, project: 'tails', includeTails: true });
        expect(full[0].stdoutTail).toContain('tail bytes');
    }, 20_000);

    test('an oversized checkpoint comes back truncated, and no checkpoint is null', async () => {
        const svc = makeService();
        const userId = nextUser();
        const { slug } = await svc.createProject({ userId, name: 'big-checkpoint' });
        expect((await svc.getProjectDetail({ userId, project: slug })).checkpoint).toBeNull();

        fs.writeFileSync(
            path.join(PROJECTS_ROOT, userId, slug, 'checkpoint.json'), 'x'.repeat(10_000));
        const detail = await svc.getProjectDetail({ userId, project: slug });
        expect(detail.checkpoint.length).toBeLessThan(5_000);
        expect(detail.checkpoint).toContain('[truncated]');
    });
});

describe('background jobs', () => {
    test('a short job completes and records its output tail', async () => {
        const svc = makeService();
        const userId = nextUser();
        await svc.createProject({ userId, name: 'quick-job' });
        const started = await svc.run({
            userId, project: 'quick-job', language: 'bash',
            code: 'echo simulation done', background: true
        });
        expect(started.mode).toBe('background');
        expect(started.status).toBe('RUNNING');

        const job = await waitForJob(svc, userId, started.jobId);
        expect(job.status).toBe('COMPLETED');
        expect(job.exitCode).toBe(0);
        expect(job.segments).toBe(1);
        expect(job.resumeCount).toBe(0);
        expect(job.stdoutTail).toContain('simulation done');
    }, 20_000);

    test('a crashing job settles as FAILED with the exit code', async () => {
        const svc = makeService();
        const userId = nextUser();
        await svc.createProject({ userId, name: 'crash-job' });
        const { jobId } = await svc.run({
            userId, project: 'crash-job', language: 'bash',
            code: 'echo boom >&2; exit 3', background: true
        });
        const job = await waitForJob(svc, userId, jobId);
        expect(job.status).toBe('FAILED');
        expect(job.exitCode).toBe(3);
        expect(job.error).toContain('exited with code 3');
        expect(job.stderrTail).toContain('boom');
    }, 20_000);

    test('checkpoint/resume round-trip: killed at the wall, resumed, finishes', async () => {
        const svc = makeService({ sandbox: { timeoutMs: 1500, maxCpuSeconds: 30 } });
        const userId = nextUser();
        await svc.createProject({ userId, name: 'checkpointed' });
        const code = [
            'import json, os, time',
            "d = os.environ['GOOBSTER_RUN_DIR']",
            "cp = os.path.join(d, 'checkpoint.json')",
            "state = {'step': 0}",
            'if os.path.exists(cp):',
            '    state = json.load(open(cp))',
            "if state['step'] >= 2:",
            "    print('finished at step', state['step'])",
            '    raise SystemExit(0)',
            "state['step'] += 1",
            "json.dump(state, open(cp, 'w'))",
            'time.sleep(60)'
        ].join('\n');
        const { jobId } = await svc.run({
            userId, project: 'checkpointed', language: 'python', code, background: true
        });
        const job = await waitForJob(svc, userId, jobId, { timeoutMs: 40_000 });
        expect(job.status).toBe('COMPLETED');
        expect(job.segments).toBe(3);
        expect(job.resumeCount).toBe(2);
        expect(job.checkpointAt).toBeTruthy();
        expect(job.stdoutTail).toContain('finished at step 2');
    }, 60_000);

    test('a timeout without checkpoint progress is terminal, with the reason spelled out', async () => {
        const svc = makeService({ sandbox: { timeoutMs: 1200, maxCpuSeconds: 30 } });
        const userId = nextUser();
        await svc.createProject({ userId, name: 'no-checkpoint' });
        const { jobId } = await svc.run({
            userId, project: 'no-checkpoint', language: 'bash',
            code: 'sleep 60', background: true
        });
        const job = await waitForJob(svc, userId, jobId);
        expect(job.status).toBe('TIMED_OUT');
        expect(job.segments).toBe(1);
        expect(job.error).toMatch(/checkpoint\.json/);
    }, 20_000);

    test('the resume budget is a hard ceiling', async () => {
        const svc = makeService({
            sandbox: { timeoutMs: 1200, maxCpuSeconds: 30 },
            observatory: { maxResumes: 0 }
        });
        const userId = nextUser();
        await svc.createProject({ userId, name: 'budgeted' });
        const { jobId } = await svc.run({
            userId, project: 'budgeted', language: 'bash',
            code: 'date > "$GOOBSTER_RUN_DIR/checkpoint.json"; sleep 60',
            background: true
        });
        const job = await waitForJob(svc, userId, jobId);
        expect(job.status).toBe('TIMED_OUT');
        expect(job.error).toContain('resume budget');
    }, 20_000);

    test('cancel kills the live segment and settles the job as CANCELLED', async () => {
        const svc = makeService();
        const userId = nextUser();
        await svc.createProject({ userId, name: 'cancellable' });
        const { jobId } = await svc.run({
            userId, project: 'cancellable', language: 'bash',
            code: 'sleep 60', background: true
        });
        // Give the segment a beat to actually spawn before cancelling
        await new Promise(resolve => setTimeout(resolve, 500));
        expect(await svc.cancel({ userId, jobId })).toEqual({ cancelled: true, jobId });
        const job = await waitForJob(svc, userId, jobId);
        expect(job.status).toBe('CANCELLED');
    }, 20_000);

    test('the per-user active-job cap holds', async () => {
        const svc = makeService({ observatory: { maxActiveJobsPerUser: 1 } });
        const userId = nextUser();
        await svc.createProject({ userId, name: 'busy' });
        const { jobId } = await svc.run({
            userId, project: 'busy', language: 'bash', code: 'sleep 20', background: true
        });
        await expect(svc.run({
            userId, project: 'busy', language: 'bash', code: 'echo hi', background: true
        })).rejects.toMatchObject({ code: 'TOO_MANY_JOBS', status: 429 });
        await svc.cancel({ userId, jobId });
        await waitForJob(svc, userId, jobId);
    }, 20_000);

    test('only one RUNNING job is allowed per project', async () => {
        const svc = makeService({ observatory: { maxActiveJobsPerUser: 4 } });
        const userId = nextUser();
        await svc.createProject({ userId, name: 'one-at-a-time' });
        const { jobId } = await svc.run({
            userId, project: 'one-at-a-time', language: 'bash',
            code: 'sleep 20', background: true
        });
        await expect(svc.run({
            userId, project: 'one-at-a-time', language: 'bash',
            code: 'echo hi', background: true
        })).rejects.toMatchObject({ code: 'PROJECT_BUSY', status: 409 });
        await svc.cancel({ userId, jobId });
        await waitForJob(svc, userId, jobId);
    }, 20_000);

    test('foreground runs take the same durable project claim as background jobs', async () => {
        const svc = makeService({ observatory: { maxActiveJobsPerUser: 4 } });
        const userId = nextUser();
        await svc.createProject({ userId, name: 'fg-claim' });
        const first = svc.run({
            userId, project: 'fg-claim', language: 'bash', code: 'sleep 3; echo a'
        });
        await new Promise(resolve => setTimeout(resolve, 200));
        await expect(svc.run({
            userId, project: 'fg-claim', language: 'bash', code: 'echo b'
        })).rejects.toMatchObject({ code: 'PROJECT_BUSY', status: 409 });
        await expect(svc.run({
            userId, project: 'fg-claim', language: 'bash', code: 'echo c', background: true
        })).rejects.toMatchObject({ code: 'PROJECT_BUSY', status: 409 });
        await first;
    }, 20_000);

    test('foreground lease expiry aborts the run before another job starts', async () => {
        const a = makeService();
        const userId = nextUser();
        const { slug } = await a.createProject({ userId, name: 'fg-lease' });
        const dir = path.join(PROJECTS_ROOT, userId, slug);
        const running = a.run({
            userId, project: slug, language: 'bash',
            code: 'while true; do echo tick >> "$GOOBSTER_PROJECT_DIR/out.txt"; sleep 0.2; done'
        });
        await new Promise(resolve => setTimeout(resolve, 400));
        const job = await db.get(
            `SELECT id FROM observatory_jobs WHERE userId = @userId AND status = 'RUNNING'`,
            { userId }
        );
        expect(job).toBeTruthy();
        expect(a._jobs.has(job.id)).toBe(true);

        const stale = new Date(Date.now() - 5 * 60 * 1000).toISOString()
            .replace('T', ' ').replace(/\.\d+Z$/, '');
        await db.run(
            'UPDATE observatory_jobs SET lastHeartbeatAt = @stale WHERE id = @id',
            { id: job.id, stale }
        );
        const b = makeService();
        await b._ensureReaped();
        const afterReap = await db.get(
            'SELECT status, cancelRequested FROM observatory_jobs WHERE id = @id', { id: job.id }
        );
        expect(afterReap.status).toBe('RUNNING');
        expect(Number(afterReap.cancelRequested)).toBe(1);

        await expect(b.run({
            userId, project: slug, language: 'bash',
            code: 'echo overlap > "$GOOBSTER_PROJECT_DIR/second.txt"'
        })).rejects.toMatchObject({ code: 'PROJECT_BUSY', status: 409 });

        const first = await running;
        expect(first.result.aborted).toBe(true);
        const sizeAfterStop = fs.statSync(path.join(dir, 'out.txt')).size;
        await new Promise(resolve => setTimeout(resolve, 600));
        expect(fs.statSync(path.join(dir, 'out.txt')).size).toBe(sizeAfterStop);

        const second = await b.run({
            userId, project: slug, language: 'bash',
            code: 'echo second > "$GOOBSTER_PROJECT_DIR/second.txt"'
        });
        expect(second.result.ok).toBe(true);
        expect(fs.readFileSync(path.join(dir, 'second.txt'), 'utf8').trim()).toBe('second');
        expect(fs.statSync(path.join(dir, 'out.txt')).size).toBe(sizeAfterStop);
    }, 25_000);

    test('foreground cancel is observed and keeps the claim until the run stops', async () => {
        const a = makeService();
        const b = makeService();
        const userId = nextUser();
        const { slug } = await a.createProject({ userId, name: 'fg-cancel' });
        const running = a.run({
            userId, project: slug, language: 'bash',
            code: 'while true; do echo tick >> "$GOOBSTER_PROJECT_DIR/out.txt"; sleep 0.2; done'
        });
        await new Promise(resolve => setTimeout(resolve, 300));
        const job = await db.get(
            `SELECT id FROM observatory_jobs WHERE userId = @userId AND status = 'RUNNING'`,
            { userId }
        );
        expect(await b.cancel({ userId, jobId: job.id })).toEqual({ cancelled: true, jobId: job.id });
        await expect(b.run({
            userId, project: slug, language: 'bash', code: 'echo overlap'
        })).rejects.toMatchObject({ code: 'PROJECT_BUSY' });

        const first = await running;
        expect(first.result.aborted).toBe(true);
        expect((await db.get(
            'SELECT status FROM observatory_jobs WHERE id = @id', { id: job.id }
        )).status).toBe('CANCELLED');
        await b.run({ userId, project: slug, language: 'bash', code: 'echo later' });
    }, 25_000);

    test('a new job does not inherit project-root checkpoint.json or frames/', async () => {
        const svc = makeService();
        const userId = nextUser();
        const { slug } = await svc.createProject({ userId, name: 'no-legacy' });
        const dir = path.join(PROJECTS_ROOT, userId, slug);
        fs.writeFileSync(path.join(dir, 'checkpoint.json'), JSON.stringify({ stale: true }));
        fs.mkdirSync(path.join(dir, 'frames'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'frames', 'frame_0001.png'), 'not-a-real-png');
        const { jobId } = await svc.run({
            userId, project: slug, language: 'bash', background: true,
            code: 'echo fresh'
        });
        const finished = await waitForJob(svc, userId, jobId);
        expect(finished.status).toBe('COMPLETED');
        expect(Number(finished.legacyWorkspace)).toBe(0);
        expect(svc._checkpointMtime(dir, jobId, finished)).toBeNull();
        expect(svc._listFrames(dir, jobId, finished)).toEqual([]);
        await new Promise(resolve => setTimeout(resolve, 400));
        expect((await svc.getJob({ userId, jobId })).renderPath).toBeFalsy();
    }, 20_000);

    test('expired A loses the lease: B takes over and A cannot write or finish', async () => {
        const a = makeService();
        const userId = nextUser();
        const { slug } = await a.createProject({ userId, name: 'lease-steal' });
        const { jobId } = await a.run({
            userId, project: slug, language: 'bash',
            code: 'sleep 60', background: true
        });
        const handleA = a._jobs.get(jobId);
        const tokenA = handleA.leaseToken;
        expect(tokenA).toBeTruthy();
        clearInterval(handleA.heartbeat);
        clearInterval(handleA.cancelPoll);
        a._jobs.delete(jobId);

        const stale = () => new Date(Date.now() - 5 * 60 * 1000).toISOString()
            .replace('T', ' ').replace(/\.\d+Z$/, '');
        const b = makeService();
        async function reapUntil(predicate) {
            for (let i = 0; i < 8; i++) {
                await db.run(
                    'UPDATE observatory_jobs SET lastHeartbeatAt = @stale WHERE id = @id',
                    { id: jobId, stale: stale() }
                );
                await b._ensureReaped();
                const row = await db.get(
                    'SELECT status, cancelRequested FROM observatory_jobs WHERE id = @id',
                    { id: jobId }
                );
                if (predicate(row)) return row;
            }
            throw new Error('two-phase reap did not reach the expected state');
        }
        const stopping = await reapUntil(row => (
            (row.status === 'RUNNING' && Number(row.cancelRequested) === 1)
            || row.status === 'INTERRUPTED'
        ));
        expect(['RUNNING', 'INTERRUPTED']).toContain(stopping.status);
        const interrupted = await reapUntil(row => row.status === 'INTERRUPTED');
        expect(interrupted.status).toBe('INTERRUPTED');
        handleA.controller.abort();

        const dir = path.join(PROJECTS_ROOT, userId, slug);
        fs.mkdirSync(path.join(dir, 'runs', String(jobId)), { recursive: true });
        fs.writeFileSync(
            path.join(dir, 'runs', String(jobId), 'checkpoint.json'),
            JSON.stringify({ recovered: true })
        );
        const resumed = await b.autoResumeInterrupted();
        expect(resumed).toContain(jobId);
        const tokenB = (await db.get(
            'SELECT leaseToken FROM observatory_jobs WHERE id = @id', { id: jobId }
        )).leaseToken;
        expect(tokenB).toBeTruthy();
        expect(tokenB).not.toBe(tokenA);

        expect(await a._touchLease(jobId, tokenA)).toBe(false);
        expect(await a._finishJob(jobId, 'COMPLETED', {}, tokenA)).toBe(false);
        const afterA = await db.get('SELECT * FROM observatory_jobs WHERE id = @id', { id: jobId });
        expect(afterA.leaseToken).toBe(tokenB);
        expect(afterA.status).not.toBe('COMPLETED');
        expect(['RUNNING', 'INTERRUPTED'].includes(afterA.status)
            || ['COMPLETED', 'FAILED', 'TIMED_OUT', 'CANCELLED'].includes(afterA.status)).toBe(true);
        if (afterA.status === 'COMPLETED') {
            // B's resumed loop finished; A still must not have been the writer.
            expect(afterA.leaseToken).toBe(tokenB);
        }

        const applied = (await db.run(
            `UPDATE observatory_jobs SET stdoutTail = 'from-A'
             WHERE id = @id AND status = 'RUNNING' AND leaseToken = @token`,
            { id: jobId, token: tokenA }
        )).changes;
        expect(applied).toBe(0);
        await b.cancel({ userId, jobId }).catch(() => {});
        await waitForJob(b, userId, jobId);
    }, 25_000);

    test('cancel through a second instance stops the owner and keeps the claim until then', async () => {
        const a = makeService();
        const b = makeService();
        const userId = nextUser();
        const { slug } = await a.createProject({ userId, name: 'x-cancel' });
        const { jobId } = await a.run({
            userId, project: slug, language: 'bash', background: true,
            code: 'while true; do echo tick >> "$GOOBSTER_PROJECT_DIR/out.txt"; sleep 0.2; done'
        });
        await new Promise(resolve => setTimeout(resolve, 400));
        expect(a._jobs.has(jobId)).toBe(true);
        expect(b._jobs.has(jobId)).toBe(false);

        expect(await b.cancel({ userId, jobId })).toEqual({ cancelled: true, jobId });
        const requested = await db.get(
            'SELECT status, cancelRequested FROM observatory_jobs WHERE id = @id',
            { id: jobId }
        );
        expect(Number(requested.cancelRequested)).toBe(1);

        await expect(b.run({
            userId, project: slug, language: 'bash', code: 'echo overlap', background: true
        })).rejects.toMatchObject({ code: 'PROJECT_BUSY' });

        const job = await waitForJob(a, userId, jobId);
        expect(job.status).toBe('CANCELLED');
        await b.run({
            userId, project: slug, language: 'bash', code: 'echo later', background: true
        });
    }, 25_000);

    test('background jobs write checkpoints under runs/<jobId>/', async () => {
        const svc = makeService();
        const userId = nextUser();
        const { slug } = await svc.createProject({ userId, name: 'run-dir' });
        const { jobId } = await svc.run({
            userId, project: slug, language: 'bash', background: true,
            code: 'echo state > "$GOOBSTER_RUN_DIR/checkpoint.json"; echo ran'
        });
        const finished = await waitForJob(svc, userId, jobId);
        expect(finished.status).toBe('COMPLETED');
        const owned = path.join(PROJECTS_ROOT, userId, slug, 'runs', String(jobId), 'checkpoint.json');
        expect(fs.readFileSync(owned, 'utf8').trim()).toBe('state');
        expect(fs.existsSync(path.join(PROJECTS_ROOT, userId, slug, 'checkpoint.json'))).toBe(false);
    }, 20_000);

    test('a bad language is rejected before a job row exists', async () => {
        const svc = makeService();
        const userId = nextUser();
        await svc.createProject({ userId, name: 'bad-lang' });
        await expect(svc.run({
            userId, project: 'bad-lang', language: 'ruby', code: 'puts 1', background: true
        })).rejects.toMatchObject({ code: 'BAD_LANGUAGE' });
        expect(await svc.listJobs({ userId })).toHaveLength(0);
    });

    test('jobs are scoped to their owner', async () => {
        const svc = makeService();
        const userId = nextUser();
        await svc.createProject({ userId, name: 'owned' });
        const { jobId } = await svc.run({
            userId, project: 'owned', language: 'bash', code: 'echo mine', background: true
        });
        await waitForJob(svc, userId, jobId);
        await expectThrow(async () => await svc.getJob({ userId: nextUser(), jobId }), { code: 'NO_SUCH_JOB', status: 404 });
    }, 20_000);
});

describe('orphan reaping and resume', () => {
    test('a RUNNING job with no live handle is reaped to INTERRUPTED', async () => {
        const svc = makeService();
        const userId = nextUser();
        const { slug } = await svc.createProject({ userId, name: 'orphaned' });
        const project = await db.get(
            'SELECT id FROM observatory_projects WHERE userId = @userId AND slug = @slug',
            { userId, slug }
        );
        const job = await db.get(
            `INSERT INTO observatory_jobs (projectId, userId, language, code, lastHeartbeatAt, runnerId)
             VALUES (@projectId, @userId, 'bash', 'echo orphan', @stale, 'other-process')
             RETURNING id`,
            {
                projectId: project.id, userId,
                stale: new Date(Date.now() - 5 * 60 * 1000).toISOString()
                    .replace('T', ' ').replace(/\.\d+Z$/, '')
            }
        );

        // A fresh service instance = a fresh process as far as handles go.
        // First stale pass asks the owner to stop and keeps the RUNNING claim.
        const restarted = makeService();
        await restarted._ensureReaped();
        const stopping = await db.get(
            'SELECT status, cancelRequested FROM observatory_jobs WHERE id = @id',
            { id: job.id }
        );
        expect(stopping.status).toBe('RUNNING');
        expect(Number(stopping.cancelRequested)).toBe(1);
        await db.run(
            'UPDATE observatory_jobs SET lastHeartbeatAt = @stale WHERE id = @id',
            {
                id: job.id,
                stale: new Date(Date.now() - 5 * 60 * 1000).toISOString()
                    .replace('T', ' ').replace(/\.\d+Z$/, '')
            }
        );
        await restarted._ensureReaped();
        const reaped = await restarted.getJob({ userId, jobId: job.id });
        expect(reaped.status).toBe('INTERRUPTED');
        expect(reaped.error).toMatch(/lease expired|restart/i);
    });

    test('a RUNNING job with a fresh heartbeat from another runner is left alone', async () => {
        const svc = makeService();
        const userId = nextUser();
        const { slug } = await svc.createProject({ userId, name: 'live-elsewhere' });
        const project = await db.get(
            'SELECT id FROM observatory_projects WHERE userId = @userId AND slug = @slug',
            { userId, slug }
        );
        const job = await db.get(
            `INSERT INTO observatory_jobs
                (projectId, userId, language, code, lastHeartbeatAt, runnerId)
             VALUES (@projectId, @userId, 'bash', 'echo live', datetime('now'), 'api-process')
             RETURNING id`,
            { projectId: project.id, userId }
        );
        const other = makeService();
        const still = await other.getJob({ userId, jobId: job.id });
        expect(still.status).toBe('RUNNING');
    });

    test('an INTERRUPTED job resumes from its checkpoint and finishes', async () => {
        const svc = makeService();
        const userId = nextUser();
        const { slug } = await svc.createProject({ userId, name: 'resumable' });
        const dir = path.join(PROJECTS_ROOT, userId, slug);
        fs.writeFileSync(path.join(dir, 'checkpoint.json'), JSON.stringify({ step: 2 }));
        const project = await db.get(
            'SELECT id FROM observatory_projects WHERE userId = @userId AND slug = @slug',
            { userId, slug }
        );
        const code = [
            'import json, os',
            "d = os.environ['GOOBSTER_PROJECT_DIR']",
            "state = json.load(open(os.path.join(d, 'checkpoint.json')))",
            "print('resumed at step', state['step'])"
        ].join('\n');
        const job = await db.get(
            `INSERT INTO observatory_jobs
                 (projectId, userId, language, code, status, segments, lastHeartbeatAt, legacyWorkspace)
             VALUES (@projectId, @userId, 'python', @code, 'INTERRUPTED', 1, datetime('now'), 1)
             RETURNING id`,
            { projectId: project.id, userId, code }
        );

        expect(await svc.resume({ userId, jobId: job.id }))
            .toEqual({ resumed: true, jobId: job.id, status: 'RUNNING' });
        const finished = await waitForJob(svc, userId, job.id);
        expect(finished.status).toBe('COMPLETED');
        expect(finished.stdoutTail).toContain('resumed at step 2');
    }, 20_000);

    test('resume refuses jobs without a checkpoint, non-resumable states, and a spent budget', async () => {
        const svc = makeService({ observatory: { maxResumes: 0 } });
        const userId = nextUser();
        const { slug } = await svc.createProject({ userId, name: 'unresumable' });
        const project = await db.get(
            'SELECT id FROM observatory_projects WHERE userId = @userId AND slug = @slug',
            { userId, slug }
        );
        const insert = async (status) => await db.get(
            `INSERT INTO observatory_jobs (projectId, userId, language, code, status)
             VALUES (@projectId, @userId, 'bash', 'echo x', @status)
             RETURNING id`,
            { projectId: project.id, userId, status }
        );

        const noCheckpoint = await insert('INTERRUPTED');
        await expectThrow(async () => await svc.resume({ userId, jobId: noCheckpoint.id }), { code: 'NO_CHECKPOINT' });

        const completed = await insert('COMPLETED');
        await expectThrow(async () => await svc.resume({ userId, jobId: completed.id }), { code: 'NOT_RESUMABLE' });

        fs.writeFileSync(
            path.join(PROJECTS_ROOT, userId, slug, 'checkpoint.json'), '{}');
        const spent = await db.get(
            `INSERT INTO observatory_jobs
                 (projectId, userId, language, code, status, legacyWorkspace)
             VALUES (@projectId, @userId, 'bash', 'echo x', 'TIMED_OUT', 1)
             RETURNING id`,
            { projectId: project.id, userId }
        );
        await expectThrow(async () => await svc.resume({ userId, jobId: spent.id }), { code: 'RESUME_BUDGET' });
    });

    test('startup auto-resume restarts a checkpointed job orphaned by a crash', async () => {
        const svc = makeService();
        const userId = nextUser();
        const { slug } = await svc.createProject({ userId, name: 'auto-resumed' });
        fs.writeFileSync(
            path.join(PROJECTS_ROOT, userId, slug, 'checkpoint.json'),
            JSON.stringify({ step: 5 })
        );
        const project = await db.get(
            'SELECT id FROM observatory_projects WHERE userId = @userId AND slug = @slug',
            { userId, slug }
        );
        // A job left RUNNING by a "crash" (no live in-process handle)
        const job = await db.get(
            `INSERT INTO observatory_jobs
                 (projectId, userId, language, code, status, segments, lastHeartbeatAt, runnerId, legacyWorkspace)
             VALUES (@projectId, @userId, 'bash', 'echo back from the dead', 'RUNNING', 1, @stale, 'crashed', 1)
             RETURNING id`,
            {
                projectId: project.id, userId,
                stale: new Date(Date.now() - 5 * 60 * 1000).toISOString()
                    .replace('T', ' ').replace(/\.\d+Z$/, '')
            }
        );

        // "Reboot": a fresh instance reaps the orphan, then auto-resume revives it
        const restarted = makeService();
        const resumed = await restarted.autoResumeInterrupted();
        expect(resumed).toContain(job.id);

        const finished = await waitForJob(restarted, userId, job.id);
        expect(finished.status).toBe('COMPLETED');
        expect(finished.stdoutTail).toContain('back from the dead');
        // An INTERRUPTED revival never consumes the timeout-resume budget
        expect(finished.resumeCount).toBe(0);
    }, 25_000);

    test('auto-resume skips jobs without a checkpoint - they stay INTERRUPTED for a manual resume', async () => {
        const svc = makeService();
        const userId = nextUser();
        const { slug } = await svc.createProject({ userId, name: 'no-cp-orphan' });
        const project = await db.get(
            'SELECT id FROM observatory_projects WHERE userId = @userId AND slug = @slug',
            { userId, slug }
        );
        const job = await db.get(
            `INSERT INTO observatory_jobs
                 (projectId, userId, language, code, status, segments, lastHeartbeatAt, runnerId)
             VALUES (@projectId, @userId, 'bash', 'echo x', 'RUNNING', 1, @stale, 'crashed')
             RETURNING id`,
            {
                projectId: project.id, userId,
                stale: new Date(Date.now() - 5 * 60 * 1000).toISOString()
                    .replace('T', ' ').replace(/\.\d+Z$/, '')
            }
        );

        const restarted = makeService();
        const resumed = await restarted.autoResumeInterrupted();
        expect(resumed).not.toContain(job.id);
        expect((await restarted.getJob({ userId, jobId: job.id })).status).toBe('INTERRUPTED');
    });

    test('auto-resume is a no-op when the feature is disabled', async () => {
        const svc = makeService({ observatory: { enabled: false } });
        expect(await svc.autoResumeInterrupted()).toEqual([]);
    });
});

describe('notifications', () => {
    test('a finished background job files a follow-up in the user\'s DM scope', async () => {
        const svc = makeService();
        const userId = nextUser();
        await svc.createProject({ userId, name: 'notify-me' });
        const client = {
            users: {
                fetch: async () => ({ createDM: async () => ({ id: 'dm-channel-1' }) })
            }
        };
        const { jobId } = await svc.run({
            userId, project: 'notify-me', language: 'bash',
            code: 'echo hi', background: true, client
        });
        await waitForJob(svc, userId, jobId);
        const followup = await waitFor(async () => await db.get(
            `SELECT guildId, channelId, note, status FROM followups
             WHERE userId = @userId ORDER BY id DESC LIMIT 1`,
            { userId }
        ));
        expect(followup.guildId).toBe(`dm:${userId}`);
        expect(followup.channelId).toBe('dm-channel-1');
        expect(followup.status).toBe('PENDING');
        expect(followup.note).toContain(`job #${jobId}`);
        expect(followup.note).toContain('notify-me');
        expect(followup.note).toContain('finished successfully');
    }, 20_000);

    test('no client = no notification, and never an error', async () => {
        const svc = makeService();
        const userId = nextUser();
        await svc.createProject({ userId, name: 'silent' });
        const { jobId } = await svc.run({
            userId, project: 'silent', language: 'bash', code: 'echo hi', background: true
        });
        const job = await waitForJob(svc, userId, jobId);
        expect(job.status).toBe('COMPLETED');
        expect((await db.get(
            'SELECT COUNT(*) AS c FROM followups WHERE userId = @userId', { userId }
        )).c).toBe(0);
    }, 20_000);
});

describe('the render pipeline', () => {
    /** Write n tiny real PNG frames into the project's frames/ dir. */
    async function writeFrames(dir, n) {
        const sharp = require('sharp');
        fs.mkdirSync(path.join(dir, 'frames'), { recursive: true });
        for (let i = 1; i <= n; i++) {
            await sharp({
                create: {
                    width: 16, height: 16, channels: 3,
                    background: { r: (i * 60) % 255, g: 40, b: 200 }
                }
            }).png().toFile(path.join(dir, 'frames', `frame_${String(i).padStart(4, '0')}.png`));
        }
    }

    test('render stitches frames into an mp4', async () => {
        const svc = makeService();
        const userId = nextUser();
        const { slug } = await svc.createProject({ userId, name: 'render-me' });
        await writeFrames(path.join(PROJECTS_ROOT, userId, slug), 4);

        const render = await svc.render({ userId, project: slug, fps: 8 });
        expect(render.frames).toBe(4);
        expect(render.fps).toBe(8);
        expect(render.relPath).toMatch(/^renders\/render_\d+\.mp4$/);
        expect(fs.existsSync(render.path)).toBe(true);
        expect(render.sizeBytes).toBeGreaterThan(0);
    }, 30_000);

    test('render without frames is a clear refusal', async () => {
        const svc = makeService();
        const userId = nextUser();
        await svc.createProject({ userId, name: 'frameless' });
        await expectThrow(async () => await svc.render({ userId, project: 'frameless' }), { code: 'NO_FRAMES' });
    });

    test('missing ffmpeg degrades to a clear message, never a crash', async () => {
        const svc = makeService({ observatory: { ffmpegCommand: 'definitely-not-ffmpeg-xyz' } });
        const userId = nextUser();
        const { slug } = await svc.createProject({ userId, name: 'no-ffmpeg' });
        await writeFrames(path.join(PROJECTS_ROOT, userId, slug), 2);
        await expectThrow(async () => await svc.render({ userId, project: slug }), { code: 'FFMPEG_MISSING', status: 503 });
    }, 30_000);

    test('a completed job with frames is auto-rendered', async () => {
        const svc = makeService();
        const userId = nextUser();
        const { slug } = await svc.createProject({ userId, name: 'auto-render' });
        await writeFrames(path.join(PROJECTS_ROOT, userId, slug), 3);
        const { jobId } = await svc.run({
            userId, project: slug, language: 'bash', background: true,
            code: [
                'mkdir -p "$GOOBSTER_RUN_DIR/frames"',
                'cp "$GOOBSTER_PROJECT_DIR/frames/"* "$GOOBSTER_RUN_DIR/frames/"',
                'echo frames ready'
            ].join('; ')
        });
        await waitForJob(svc, userId, jobId);
        const job = await waitFor(async () => {
            const row = await svc.getJob({ userId, jobId });
            return row.renderPath ? row : null;
        });
        expect(job.renderPath).toMatch(/^renders\/render_\d+\.mp4$/);
        expect(fs.existsSync(
            path.join(PROJECTS_ROOT, userId, slug, job.renderPath))).toBe(true);
    }, 40_000);
});

describe('the dashboard artifact', () => {
    test('every foreground run regenerates a dashboard OUTSIDE the workspace, fully escaped', async () => {
        const svc = makeService();
        const userId = nextUser();
        const name = 'Sim <script>alert(1)</script>';
        const { slug } = await svc.createProject({ userId, name });
        await svc.run({
            userId, project: slug, language: 'bash',
            code: 'echo data > "$GOOBSTER_PROJECT_DIR/results.csv"'
        });

        const dashPath = path.join(DASHBOARDS_ROOT, userId, `${slug}.html`);
        expect(fs.existsSync(dashPath)).toBe(true);
        // Never inside the snippet-writable workspace
        expect(dashPath.startsWith(path.join(PROJECTS_ROOT, userId))).toBe(false);

        const html = fs.readFileSync(dashPath, 'utf8');
        expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
        expect(html).not.toContain('<script>alert(1)');
        expect(html).toContain('results.csv');
        expect(html).toContain('Content-Security-Policy');
    });

    test('a snippet cannot author the served dashboard (workspace dashboard.html is inert)', async () => {
        const svc = makeService();
        const userId = nextUser();
        const { slug } = await svc.createProject({ userId, name: 'tamper-proof' });
        await svc.run({
            userId, project: slug, language: 'bash',
            code: 'echo "<script>EVIL_MARKER</script>" > "$GOOBSTER_PROJECT_DIR/dashboard.html"'
        });
        const { html } = await svc.getDashboard({ userId, project: slug });
        expect(html).not.toContain('<script>EVIL_MARKER');
        // The tampered file is merely LISTED (escaped), like any other file
        expect(html).toContain('dashboard.html');
    });

    test('small media is inlined as data URLs; oversized media is skipped with a note', async () => {
        const sharp = require('sharp');
        const svc = makeService();
        const userId = nextUser();
        const { slug } = await svc.createProject({ userId, name: 'media-inline' });
        const dir = path.join(PROJECTS_ROOT, userId, slug);
        await sharp({ create: { width: 16, height: 16, channels: 3, background: { r: 200, g: 40, b: 40 } } })
            .png().toFile(path.join(dir, 'plot.png'));
        // "PNG" by extension but over the 2MB inline cap - must be skipped
        fs.writeFileSync(path.join(dir, 'huge.png'), Buffer.alloc(3 * 1024 * 1024));

        const dashboard = await svc.generateDashboard({ userId, project: slug });
        const html = fs.readFileSync(dashboard.path, 'utf8');
        expect(html).toContain('data:image/png;base64,');
        expect(html).toContain('too large to embed');
    });

    test('a finished background job refreshes the dashboard with its record', async () => {
        const svc = makeService();
        const userId = nextUser();
        const { slug } = await svc.createProject({ userId, name: 'dash-job' });
        const { jobId } = await svc.run({
            userId, project: slug, language: 'bash', code: 'echo dashboard me', background: true
        });
        await waitForJob(svc, userId, jobId);
        const html = await waitFor(() => {
            try {
                const content = fs.readFileSync(path.join(DASHBOARDS_ROOT, userId, `${slug}.html`), 'utf8');
                return content.includes(`Job #${jobId}`) ? content : null;
            } catch {
                return null;
            }
        });
        expect(html).toContain('COMPLETED');
    }, 20_000);

    test('deleteProject removes the dashboard artifact too', async () => {
        const svc = makeService();
        const userId = nextUser();
        const { slug } = await svc.createProject({ userId, name: 'dash-cleanup' });
        await svc.generateDashboard({ userId, project: slug });
        const dashPath = path.join(DASHBOARDS_ROOT, userId, `${slug}.html`);
        expect(fs.existsSync(dashPath)).toBe(true);
        await svc.deleteProject({ userId, project: slug });
        expect(fs.existsSync(dashPath)).toBe(false);
    });
});

describe('dashboard share links', () => {
    test('create is idempotent, status reflects it, and the token resolves the live page', async () => {
        const svc = makeService();
        const userId = nextUser();
        const { slug } = await svc.createProject({ userId, name: 'share-me' });

        expect(await svc.getShareLink({ userId, project: slug })).toEqual({ shared: false });
        const created = await svc.createShareLink({ userId, project: slug });
        expect(created.token).toMatch(/^[a-f0-9]{40}$/);
        expect(created.url).toBe(`/app/observatory/share/${created.token}`);
        expect((await svc.createShareLink({ userId, project: slug })).token).toBe(created.token);
        expect((await svc.getShareLink({ userId, project: slug })).shared).toBe(true);
        expect((await svc.listProjects(userId)).find(p => p.slug === slug).shared).toBe(true);

        const shared = await svc.getSharedDashboard(created.token);
        expect(shared.name).toBe('share-me');
        expect(shared.html).toContain('share-me');

        // The shared page is LIVE: regenerated on view when state moved on
        fs.writeFileSync(path.join(PROJECTS_ROOT, userId, slug, 'new-result.txt'), 'fresh');
        await svc._touchProject((await db.get(
            'SELECT id FROM observatory_projects WHERE userId = @userId AND slug = @slug',
            { userId, slug }
        )).id);
        // updatedAt has second precision - make the dashboard clearly older
        const dashPath = path.join(DASHBOARDS_ROOT, userId, `${slug}.html`);
        const past = new Date(Date.now() - 60_000);
        fs.utimesSync(dashPath, past, past);
        expect((await svc.getSharedDashboard(created.token)).html).toContain('new-result.txt');
    });

    test('revocation and bad tokens are clean 404s', async () => {
        const svc = makeService();
        const userId = nextUser();
        const { slug } = await svc.createProject({ userId, name: 'revocable' });
        const { token } = await svc.createShareLink({ userId, project: slug });
        expect(await svc.revokeShareLink({ userId, project: slug })).toEqual({ revoked: true });
        await expectThrow(async () => await svc.getSharedDashboard(token), { code: 'NOT_FOUND', status: 404 });
        await expectThrow(async () => await svc.getSharedDashboard('not-a-token'), { code: 'NOT_FOUND' });
        await expectThrow(async () => await svc.getSharedDashboard('a'.repeat(40)), { code: 'NOT_FOUND' });
    });

    test('share links die with the feature switch', async () => {
        const svc = makeService();
        const userId = nextUser();
        const { slug } = await svc.createProject({ userId, name: 'switched-off' });
        const { token } = await svc.createShareLink({ userId, project: slug });
        const disabled = makeService({ observatory: { enabled: false } });
        await expectThrow(() => disabled.getSharedDashboard(token), { code: 'DISABLED', status: 403 });
    });
});

describe('privacy (/forget-me)', () => {
    test('forgetUser erases rows, workspaces, and cancels live jobs', async () => {
        const svc = makeService();
        const userId = nextUser();
        await svc.createProject({ userId, name: 'to-forget' });
        const { jobId } = await svc.run({
            userId, project: 'to-forget', language: 'bash', code: 'sleep 60', background: true
        });
        await new Promise(resolve => setTimeout(resolve, 300));

        const counts = await svc.forgetUser(userId);
        expect(counts.projects).toBe(1);
        expect(counts.jobs).toBe(1);
        expect(fs.existsSync(path.join(PROJECTS_ROOT, userId))).toBe(false);
        expect(fs.existsSync(path.join(DASHBOARDS_ROOT, userId))).toBe(false);
        expect(await svc.countUserData(userId)).toEqual({
            projects: 0, jobs: 0, shareLinks: 0, memberships: 0, invites: 0, workspaceDirs: 0,
            projectNodes: 0
        });
        // The killed job's loop must not resurrect anything
        await new Promise(resolve => setTimeout(resolve, 500));
        expect((await db.get(
            'SELECT COUNT(*) AS c FROM observatory_jobs WHERE userId = @userId', { userId }
        )).c).toBe(0);
        expect(jobId).toBeGreaterThan(0);
    }, 20_000);

    test('privacyService wires the Observatory into report, erasure, and audit', async () => {
        const svc = require('@goobster/core/services/observatoryService');
        const privacyService = require('@goobster/core/services/privacyService');
        const userId = nextUser();
        // The singleton reads the real (possibly disabled) config; erasure
        // and audit must work regardless, so seed rows directly.
        const project = await db.get(
            `INSERT INTO observatory_projects (userId, slug, name)
             VALUES (@userId, 'audit-sim', 'Audit Sim') RETURNING id`,
            { userId }
        );
        await db.run(
            `INSERT INTO observatory_jobs (projectId, userId, language, code, status)
             VALUES (@projectId, @userId, 'bash', 'echo x', 'COMPLETED')`,
            { projectId: project.id, userId }
        );
        fs.mkdirSync(path.join(PROJECTS_ROOT, userId, 'audit-sim'), { recursive: true });

        await db.run(
            `INSERT INTO observatory_share_links (userId, projectId, token)
             VALUES (@userId, @projectId, @token)`,
            { userId, projectId: project.id, token: 'a'.repeat(40) }
        );

        const report = await privacyService.buildUserReport({ guildId: 'g1', userId });
        expect(report.observatory).toEqual({
            projects: 1, jobs: 1, runningJobs: 0, sharedDashboards: 1,
            assets: 0, assetVersions: 0, triggers: 0,
            collaboratedProjects: 0, pendingInvites: 0, knowledgeNodes: 0,
            missions: 0, openMissions: 0, decisions: 0
        });

        const counts = await privacyService.forgetUser({ userId });
        expect(counts.observatoryProjects).toBe(1);
        expect(counts.observatoryJobs).toBe(1);
        expect(counts.observatoryShareLinks).toBe(1);
        expect(counts.projectAssets).toBe(0);
        expect(counts.projectAssetVersions).toBe(0);
        expect(counts.projectTriggers).toBe(0);
        expect(counts.projectMissions).toBe(0);

        const audit = await privacyService.auditUser({ userId });
        expect(audit.byTable.observatory_projects).toBe(0);
        expect(audit.byTable.observatory_jobs).toBe(0);
        expect(audit.byTable.observatory_share_links).toBe(0);
        expect(audit.byTable.project_assets).toBe(0);
        expect(audit.byTable.project_asset_versions).toBe(0);
        expect(audit.byTable.project_triggers).toBe(0);
        expect(audit.byTable.project_missions).toBe(0);
        expect(audit.byTable.project_decisions).toBe(0);
        expect(audit.byTable.observatory_workspaces).toBe(0);
        expect((await svc.countUserData(userId)).workspaceDirs).toBe(0);
    });
});

describe('HTTP runner cancel holds the project claim until writes stop', () => {
    const { createSandboxApp } = require('../apps/sandbox/server');
    const prevUrl = process.env.GOOBSTER_SANDBOX_URL;
    const prevToken = process.env.GOOBSTER_INTERNAL_TOKEN;
    let server;

    beforeAll(async () => {
        process.env.GOOBSTER_INTERNAL_TOKEN = 'obs-http-cancel-token';
        const runner = new SandboxService(makeSandboxConfig({ forceLocal: true }));
        const app = createSandboxApp({ sandbox: runner });
        server = await new Promise((resolve) => {
            const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
        });
        process.env.GOOBSTER_SANDBOX_URL = `http://127.0.0.1:${server.address().port}`;
    });

    afterAll(async () => {
        if (prevUrl === undefined) delete process.env.GOOBSTER_SANDBOX_URL;
        else process.env.GOOBSTER_SANDBOX_URL = prevUrl;
        if (prevToken === undefined) delete process.env.GOOBSTER_INTERNAL_TOKEN;
        else process.env.GOOBSTER_INTERNAL_TOKEN = prevToken;
        if (server) await new Promise(resolve => server.close(resolve));
    });

    test('cancel through the HTTP runner stops writes before another job starts', async () => {
        const a = new ObservatoryService({
            config: makeObservatoryConfig(),
            sandbox: new SandboxService(makeSandboxConfig())
        });
        const b = new ObservatoryService({
            config: makeObservatoryConfig(),
            sandbox: new SandboxService(makeSandboxConfig())
        });
        const userId = nextUser();
        const { slug } = await a.createProject({ userId, name: 'http-cancel' });
        const dir = path.join(PROJECTS_ROOT, userId, slug);
        const { jobId } = await a.run({
            userId, project: slug, language: 'bash', background: true,
            code: 'while true; do echo tick >> "$GOOBSTER_PROJECT_DIR/out.txt"; sleep 0.2; done'
        });
        const out = path.join(dir, 'out.txt');
        const deadline = Date.now() + 8_000;
        while (!fs.existsSync(out) && Date.now() < deadline) {
            const current = await a.getJob({ userId, jobId });
            if (current.status !== 'RUNNING') {
                throw new Error(`job left RUNNING before cancel (${current.status}: ${current.error})`);
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        expect(fs.existsSync(out)).toBe(true);
        expect(await b.cancel({ userId, jobId })).toEqual({ cancelled: true, jobId });
        await expect(b.run({
            userId, project: slug, language: 'bash', code: 'echo overlap', background: true
        })).rejects.toMatchObject({ code: 'PROJECT_BUSY' });
        const job = await waitForJob(a, userId, jobId);
        expect(job.status).toBe('CANCELLED');
        const size = fs.statSync(path.join(dir, 'out.txt')).size;
        await new Promise(resolve => setTimeout(resolve, 600));
        expect(fs.statSync(path.join(dir, 'out.txt')).size).toBe(size);
        const next = await b.run({
            userId, project: slug, language: 'bash', code: 'echo later', background: true
        });
        expect(next.jobId).toBeTruthy();
        await waitForJob(b, userId, next.jobId);
    }, 25_000);
});
