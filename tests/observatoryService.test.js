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

const db = require('../db');
const { SandboxService } = require('../services/sandboxService');
const { ObservatoryService, PROJECTS_ROOT } = require('../services/observatoryService');

const SANDBOX_ROOT = path.join(__dirname, '..', 'data', 'sandbox', 'runs');
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

/** Assert a synchronous ObservatoryError with a machine-readable code. */
function expectThrow(fn, expected) {
    let caught = null;
    try { fn(); } catch (error) { caught = error; }
    expect(caught).not.toBeNull();
    expect(caught).toMatchObject(expected);
    return caught;
}

/** Poll until a job leaves RUNNING (or the deadline passes). */
async function waitForJob(svc, userId, jobId, { timeoutMs = 25_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const job = svc.getJob({ userId, jobId });
        if (job.status !== 'RUNNING') return job;
        if (Date.now() > deadline) throw new Error(`Job #${jobId} still RUNNING after ${timeoutMs}ms`);
        await new Promise(resolve => setTimeout(resolve, 150));
    }
}

/** Wait for a predicate on the job row (e.g. renderPath set post-terminal). */
async function waitFor(fn, { timeoutMs = 10_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = fn();
        if (value) return value;
        if (Date.now() > deadline) throw new Error('waitFor timed out');
        await new Promise(resolve => setTimeout(resolve, 150));
    }
}

afterAll(() => {
    for (const userId of TEST_USERS) {
        try { fs.rmSync(path.join(PROJECTS_ROOT, userId), { recursive: true, force: true }); } catch { /* gone */ }
    }
    try { fs.rmSync(SANDBOX_ROOT, { recursive: true, force: true }); } catch { /* shared with sandbox spec */ }
    try { fs.rmSync(process.env.GOOBSTER_DB_PATH, { force: true }); } catch { /* held open */ }
});

describe('gates', () => {
    test('disabled Observatory refuses everything', () => {
        const svc = makeService({ observatory: { enabled: false } });
        expect(svc.enabled).toBe(false);
        expectThrow(() => svc.createProject({ userId: nextUser(), name: 'x' }), { code: 'DISABLED', status: 403 });
    });

    test('a disabled sandbox disables the Observatory too (it grants persistence, not execution)', () => {
        const svc = makeService({ sandbox: { enabled: false } });
        expect(svc.enabled).toBe(false);
        expectThrow(() => svc.listProjects(nextUser()), { code: 'DISABLED' });
    });
});

describe('projects', () => {
    test('createProject slugs the name and creates an owner-only workspace', () => {
        const svc = makeService();
        const userId = nextUser();
        const created = svc.createProject({ userId, name: 'Galaxy Merger!! (v2)' });
        expect(created.slug).toBe('galaxy-merger-v2');
        expect(created.name).toBe('Galaxy Merger!! (v2)');
        const dir = path.join(PROJECTS_ROOT, userId, created.slug);
        expect(fs.existsSync(dir)).toBe(true);
        expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    });

    test('unusable names are rejected', () => {
        const svc = makeService();
        const userId = nextUser();
        expectThrow(() => svc.createProject({ userId, name: '   ' }), { code: 'BAD_NAME' });
        expectThrow(() => svc.createProject({ userId, name: '!!!' }), { code: 'BAD_NAME' });
    });

    test('duplicate slugs are refused', () => {
        const svc = makeService();
        const userId = nextUser();
        svc.createProject({ userId, name: 'Accretion Engine' });
        expectThrow(() => svc.createProject({ userId, name: 'accretion engine' }), { code: 'DUPLICATE_PROJECT', status: 409 });
    });

    test('the per-user project cap holds', () => {
        const svc = makeService({ observatory: { maxProjectsPerUser: 2 } });
        const userId = nextUser();
        svc.createProject({ userId, name: 'one' });
        svc.createProject({ userId, name: 'two' });
        expectThrow(() => svc.createProject({ userId, name: 'three' }), { code: 'TOO_MANY_PROJECTS' });
    });

    test('projects resolve by slug or by name (case-insensitive)', () => {
        const svc = makeService();
        const userId = nextUser();
        svc.createProject({ userId, name: 'Moonlet Capture' });
        expect(svc.listFiles({ userId, project: 'moonlet-capture' }).project).toBe('moonlet-capture');
        expect(svc.listFiles({ userId, project: 'MOONLET capture' }).project).toBe('moonlet-capture');
        expectThrow(() => svc.listFiles({ userId, project: 'nope' }), { code: 'NO_SUCH_PROJECT', status: 404 });
    });

    test('one user cannot see another\'s projects', () => {
        const svc = makeService();
        const owner = nextUser();
        svc.createProject({ userId: owner, name: 'private-sim' });
        expectThrow(() => svc.listFiles({ userId: nextUser(), project: 'private-sim' }), { code: 'NO_SUCH_PROJECT' });
    });

    test('deleteProject removes the rows and the workspace tree', () => {
        const svc = makeService();
        const userId = nextUser();
        const { slug } = svc.createProject({ userId, name: 'ephemeral' });
        const dir = path.join(PROJECTS_ROOT, userId, slug);
        fs.writeFileSync(path.join(dir, 'data.txt'), 'bytes');
        expect(svc.deleteProject({ userId, project: slug })).toEqual({ deleted: true, slug });
        expect(fs.existsSync(dir)).toBe(false);
        expect(svc.listProjects(userId)).toHaveLength(0);
    });
});

describe('foreground runs (the persistent workspace)', () => {
    test('$GOOBSTER_PROJECT_DIR survives between runs', async () => {
        const svc = makeService();
        const userId = nextUser();
        svc.createProject({ userId, name: 'state-test' });

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
        svc.createProject({ userId, name: 'outputs' });
        const { result } = await svc.run({
            userId, project: 'outputs', language: 'bash',
            code: 'echo report > summary.txt'
        });
        expect(result.files.map(f => f.name)).toEqual(['summary.txt']);
    });

    test('the disk quota is enforced before spending compute', async () => {
        const svc = makeService({ observatory: { maxProjectMb: 1 } });
        const userId = nextUser();
        const { slug } = svc.createProject({ userId, name: 'over-quota' });
        fs.writeFileSync(
            path.join(PROJECTS_ROOT, userId, slug, 'big.bin'),
            Buffer.alloc(2 * 1024 * 1024)
        );
        await expect(svc.run({ userId, project: slug, language: 'bash', code: 'echo hi' }))
            .rejects.toMatchObject({ code: 'QUOTA_EXCEEDED', status: 413 });
    });
});

describe('workspace files', () => {
    test('listFiles walks subdirectories, newest first, bounded', () => {
        const svc = makeService({ observatory: { maxWorkspaceFiles: 2 } });
        const userId = nextUser();
        const { slug } = svc.createProject({ userId, name: 'file-walk' });
        const dir = path.join(PROJECTS_ROOT, userId, slug);
        fs.mkdirSync(path.join(dir, 'frames'));
        fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
        fs.writeFileSync(path.join(dir, 'frames', 'frame_0001.png'), 'p');
        fs.writeFileSync(path.join(dir, 'render.mp4'), 'v');

        const listing = svc.listFiles({ userId, project: slug });
        expect(listing.totalFiles).toBe(3);
        expect(listing.files).toHaveLength(2);
        const all = new Set(['a.txt', 'frames/frame_0001.png', 'render.mp4']);
        for (const file of listing.files) expect(all.has(file.path)).toBe(true);

        // An unbounded listing sees everything and classifies types
        const wide = makeService().listFiles({ userId, project: slug });
        expect(wide.files).toHaveLength(3);
        expect(wide.files.find(f => f.path === 'render.mp4').isVideo).toBe(true);
        expect(wide.files.find(f => f.path === 'frames/frame_0001.png').isImage).toBe(true);
    });

    test('resolveFile refuses path traversal out of the workspace', () => {
        const svc = makeService();
        const userId = nextUser();
        const { slug } = svc.createProject({ userId, name: 'contained' });
        fs.writeFileSync(path.join(PROJECTS_ROOT, userId, slug, 'ok.txt'), 'fine');
        expect(svc.resolveFile({ userId, project: slug, relPath: 'ok.txt' }).name).toBe('ok.txt');
        for (const evil of ['../../../etc/passwd', '..', '/etc/passwd', 'frames/../../other']) {
            expectThrow(() => svc.resolveFile({ userId, project: slug, relPath: evil }), { code: 'NOT_FOUND' });
        }
    });
});

describe('background jobs', () => {
    test('a short job completes and records its output tail', async () => {
        const svc = makeService();
        const userId = nextUser();
        svc.createProject({ userId, name: 'quick-job' });
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
        svc.createProject({ userId, name: 'crash-job' });
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
        svc.createProject({ userId, name: 'checkpointed' });
        const code = [
            'import json, os, time',
            "d = os.environ['GOOBSTER_PROJECT_DIR']",
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
        svc.createProject({ userId, name: 'no-checkpoint' });
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
        svc.createProject({ userId, name: 'budgeted' });
        const { jobId } = await svc.run({
            userId, project: 'budgeted', language: 'bash',
            code: 'date > "$GOOBSTER_PROJECT_DIR/checkpoint.json"; sleep 60',
            background: true
        });
        const job = await waitForJob(svc, userId, jobId);
        expect(job.status).toBe('TIMED_OUT');
        expect(job.error).toContain('resume budget');
    }, 20_000);

    test('cancel kills the live segment and settles the job as CANCELLED', async () => {
        const svc = makeService();
        const userId = nextUser();
        svc.createProject({ userId, name: 'cancellable' });
        const { jobId } = await svc.run({
            userId, project: 'cancellable', language: 'bash',
            code: 'sleep 60', background: true
        });
        // Give the segment a beat to actually spawn before cancelling
        await new Promise(resolve => setTimeout(resolve, 500));
        expect(svc.cancel({ userId, jobId })).toEqual({ cancelled: true, jobId });
        const job = await waitForJob(svc, userId, jobId);
        expect(job.status).toBe('CANCELLED');
    }, 20_000);

    test('the per-user active-job cap holds', async () => {
        const svc = makeService({ observatory: { maxActiveJobsPerUser: 1 } });
        const userId = nextUser();
        svc.createProject({ userId, name: 'busy' });
        const { jobId } = await svc.run({
            userId, project: 'busy', language: 'bash', code: 'sleep 20', background: true
        });
        await expect(svc.run({
            userId, project: 'busy', language: 'bash', code: 'echo hi', background: true
        })).rejects.toMatchObject({ code: 'TOO_MANY_JOBS', status: 429 });
        svc.cancel({ userId, jobId });
        await waitForJob(svc, userId, jobId);
    }, 20_000);

    test('a bad language is rejected before a job row exists', async () => {
        const svc = makeService();
        const userId = nextUser();
        svc.createProject({ userId, name: 'bad-lang' });
        await expect(svc.run({
            userId, project: 'bad-lang', language: 'ruby', code: 'puts 1', background: true
        })).rejects.toMatchObject({ code: 'BAD_LANGUAGE' });
        expect(svc.listJobs({ userId })).toHaveLength(0);
    });

    test('jobs are scoped to their owner', async () => {
        const svc = makeService();
        const userId = nextUser();
        svc.createProject({ userId, name: 'owned' });
        const { jobId } = await svc.run({
            userId, project: 'owned', language: 'bash', code: 'echo mine', background: true
        });
        await waitForJob(svc, userId, jobId);
        expectThrow(() => svc.getJob({ userId: nextUser(), jobId }), { code: 'NO_SUCH_JOB', status: 404 });
    }, 20_000);
});

describe('orphan reaping and resume', () => {
    test('a RUNNING job with no live handle is reaped to INTERRUPTED', () => {
        const svc = makeService();
        const userId = nextUser();
        const { slug } = svc.createProject({ userId, name: 'orphaned' });
        const project = db.get(
            'SELECT id FROM observatory_projects WHERE userId = @userId AND slug = @slug',
            { userId, slug }
        );
        const job = db.get(
            `INSERT INTO observatory_jobs (projectId, userId, language, code, lastHeartbeatAt)
             VALUES (@projectId, @userId, 'bash', 'echo orphan', datetime('now'))
             RETURNING id`,
            { projectId: project.id, userId }
        );

        // A fresh service instance = a fresh process as far as handles go
        const restarted = makeService();
        const reaped = restarted.getJob({ userId, jobId: job.id });
        expect(reaped.status).toBe('INTERRUPTED');
        expect(reaped.error).toMatch(/restart/i);
    });

    test('an INTERRUPTED job resumes from its checkpoint and finishes', async () => {
        const svc = makeService();
        const userId = nextUser();
        const { slug } = svc.createProject({ userId, name: 'resumable' });
        const dir = path.join(PROJECTS_ROOT, userId, slug);
        fs.writeFileSync(path.join(dir, 'checkpoint.json'), JSON.stringify({ step: 2 }));
        const project = db.get(
            'SELECT id FROM observatory_projects WHERE userId = @userId AND slug = @slug',
            { userId, slug }
        );
        const code = [
            'import json, os',
            "d = os.environ['GOOBSTER_PROJECT_DIR']",
            "state = json.load(open(os.path.join(d, 'checkpoint.json')))",
            "print('resumed at step', state['step'])"
        ].join('\n');
        const job = db.get(
            `INSERT INTO observatory_jobs
                 (projectId, userId, language, code, status, segments, lastHeartbeatAt)
             VALUES (@projectId, @userId, 'python', @code, 'INTERRUPTED', 1, datetime('now'))
             RETURNING id`,
            { projectId: project.id, userId, code }
        );

        expect(svc.resume({ userId, jobId: job.id }))
            .toEqual({ resumed: true, jobId: job.id, status: 'RUNNING' });
        const finished = await waitForJob(svc, userId, job.id);
        expect(finished.status).toBe('COMPLETED');
        expect(finished.stdoutTail).toContain('resumed at step 2');
    }, 20_000);

    test('resume refuses jobs without a checkpoint, non-resumable states, and a spent budget', async () => {
        const svc = makeService({ observatory: { maxResumes: 0 } });
        const userId = nextUser();
        const { slug } = svc.createProject({ userId, name: 'unresumable' });
        const project = db.get(
            'SELECT id FROM observatory_projects WHERE userId = @userId AND slug = @slug',
            { userId, slug }
        );
        const insert = (status) => db.get(
            `INSERT INTO observatory_jobs (projectId, userId, language, code, status)
             VALUES (@projectId, @userId, 'bash', 'echo x', @status)
             RETURNING id`,
            { projectId: project.id, userId, status }
        );

        const noCheckpoint = insert('INTERRUPTED');
        expectThrow(() => svc.resume({ userId, jobId: noCheckpoint.id }), { code: 'NO_CHECKPOINT' });

        const completed = insert('COMPLETED');
        expectThrow(() => svc.resume({ userId, jobId: completed.id }), { code: 'NOT_RESUMABLE' });

        fs.writeFileSync(
            path.join(PROJECTS_ROOT, userId, slug, 'checkpoint.json'), '{}');
        const spent = insert('TIMED_OUT');
        expectThrow(() => svc.resume({ userId, jobId: spent.id }), { code: 'RESUME_BUDGET' });
    });
});

describe('notifications', () => {
    test('a finished background job files a follow-up in the user\'s DM scope', async () => {
        const svc = makeService();
        const userId = nextUser();
        svc.createProject({ userId, name: 'notify-me' });
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
        const followup = await waitFor(() => db.get(
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
        svc.createProject({ userId, name: 'silent' });
        const { jobId } = await svc.run({
            userId, project: 'silent', language: 'bash', code: 'echo hi', background: true
        });
        const job = await waitForJob(svc, userId, jobId);
        expect(job.status).toBe('COMPLETED');
        expect(db.get(
            'SELECT COUNT(*) AS c FROM followups WHERE userId = @userId', { userId }
        ).c).toBe(0);
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
        const { slug } = svc.createProject({ userId, name: 'render-me' });
        await writeFrames(path.join(PROJECTS_ROOT, userId, slug), 4);

        const render = svc.render({ userId, project: slug, fps: 8 });
        expect(render.frames).toBe(4);
        expect(render.fps).toBe(8);
        expect(render.relPath).toMatch(/^renders\/render_\d+\.mp4$/);
        expect(fs.existsSync(render.path)).toBe(true);
        expect(render.sizeBytes).toBeGreaterThan(0);
    }, 30_000);

    test('render without frames is a clear refusal', () => {
        const svc = makeService();
        const userId = nextUser();
        svc.createProject({ userId, name: 'frameless' });
        expectThrow(() => svc.render({ userId, project: 'frameless' }), { code: 'NO_FRAMES' });
    });

    test('missing ffmpeg degrades to a clear message, never a crash', async () => {
        const svc = makeService({ observatory: { ffmpegCommand: 'definitely-not-ffmpeg-xyz' } });
        const userId = nextUser();
        const { slug } = svc.createProject({ userId, name: 'no-ffmpeg' });
        await writeFrames(path.join(PROJECTS_ROOT, userId, slug), 2);
        expectThrow(() => svc.render({ userId, project: slug }), { code: 'FFMPEG_MISSING', status: 503 });
    }, 30_000);

    test('a completed job with frames is auto-rendered', async () => {
        const svc = makeService();
        const userId = nextUser();
        const { slug } = svc.createProject({ userId, name: 'auto-render' });
        await writeFrames(path.join(PROJECTS_ROOT, userId, slug), 3);
        const { jobId } = await svc.run({
            userId, project: slug, language: 'bash', code: 'echo frames ready', background: true
        });
        await waitForJob(svc, userId, jobId);
        const job = await waitFor(() => {
            const row = svc.getJob({ userId, jobId });
            return row.renderPath ? row : null;
        });
        expect(job.renderPath).toMatch(/^renders\/render_\d+\.mp4$/);
        expect(fs.existsSync(
            path.join(PROJECTS_ROOT, userId, slug, job.renderPath))).toBe(true);
    }, 40_000);
});

describe('privacy (/forget-me)', () => {
    test('forgetUser erases rows, workspaces, and cancels live jobs', async () => {
        const svc = makeService();
        const userId = nextUser();
        svc.createProject({ userId, name: 'to-forget' });
        const { jobId } = await svc.run({
            userId, project: 'to-forget', language: 'bash', code: 'sleep 60', background: true
        });
        await new Promise(resolve => setTimeout(resolve, 300));

        const counts = svc.forgetUser(userId);
        expect(counts.projects).toBe(1);
        expect(counts.jobs).toBe(1);
        expect(fs.existsSync(path.join(PROJECTS_ROOT, userId))).toBe(false);
        expect(svc.countUserData(userId)).toEqual({ projects: 0, jobs: 0, workspaceDirs: 0 });
        // The killed job's loop must not resurrect anything
        await new Promise(resolve => setTimeout(resolve, 500));
        expect(db.get(
            'SELECT COUNT(*) AS c FROM observatory_jobs WHERE userId = @userId', { userId }
        ).c).toBe(0);
        expect(jobId).toBeGreaterThan(0);
    }, 20_000);

    test('privacyService wires the Observatory into report, erasure, and audit', async () => {
        const svc = require('../services/observatoryService');
        const privacyService = require('../services/privacyService');
        const userId = nextUser();
        // The singleton reads the real (possibly disabled) config; erasure
        // and audit must work regardless, so seed rows directly.
        const project = db.get(
            `INSERT INTO observatory_projects (userId, slug, name)
             VALUES (@userId, 'audit-sim', 'Audit Sim') RETURNING id`,
            { userId }
        );
        db.run(
            `INSERT INTO observatory_jobs (projectId, userId, language, code, status)
             VALUES (@projectId, @userId, 'bash', 'echo x', 'COMPLETED')`,
            { projectId: project.id, userId }
        );
        fs.mkdirSync(path.join(PROJECTS_ROOT, userId, 'audit-sim'), { recursive: true });

        const report = privacyService.buildUserReport({ guildId: 'g1', userId });
        expect(report.observatory).toEqual({ projects: 1, jobs: 1, runningJobs: 0 });

        const counts = privacyService.forgetUser({ userId });
        expect(counts.observatoryProjects).toBe(1);
        expect(counts.observatoryJobs).toBe(1);

        const audit = privacyService.auditUser({ userId });
        expect(audit.byTable.observatory_projects).toBe(0);
        expect(audit.byTable.observatory_jobs).toBe(0);
        expect(audit.byTable.observatory_workspaces).toBe(0);
        expect(svc.countUserData(userId).workspaceDirs).toBe(0);
    });
});
