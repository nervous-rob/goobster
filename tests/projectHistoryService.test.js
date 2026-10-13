/**
 * Workspace history (ADR 0014): git snapshots beside every project
 * workspace, taken by the host after writes, runs and restores.
 *
 * Uses the real git on PATH (CI runners have it). The git directory is a
 * sibling of the workspace, never inside it; frames, renders and
 * oversized files are excluded; authors are project-scoped pseudonyms;
 * the history budget squashes and pauses; delete and /forget-me leave
 * nothing behind; a missing git binary turns the feature off quietly.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const TEST_DB = path.join(os.tmpdir(), `goobster-project-history-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const {
    ObservatoryService,
    PROJECTS_ROOT
} = require('@goobster/core/services/projectService');
const { SandboxService } = require('@goobster/core/services/sandboxService');
const projectHistoryService = require('@goobster/core/services/projectHistoryService');
const { ProjectHistoryService, cleanMessage } = projectHistoryService;
const privacyService = require('@goobster/core/services/privacyService');

const SANDBOX_ROOT = path.join(os.tmpdir(), `goobster-project-history-runs-${process.pid}`);
const TEST_USERS = [];

function makeService(observatory = {}) {
    return new ObservatoryService({
        config: {
            enabled: true,
            projectsEnabled: true,
            scope: 'everywhere',
            maxProjectsPerUser: 5,
            maxMembersPerProject: 5,
            maxProjectMb: 8,
            maxActiveJobsPerUser: 2,
            maxResumes: 2,
            maxWorkspaceFiles: 50,
            maxWorkspaceReadMb: 8,
            maxUploadMb: 2,
            maxRenderFrames: 10,
            renderFps: 24,
            ffmpegCommand: 'ffmpeg',
            historyEnabled: true,
            historyMaxFileMb: 1,
            historyMaxMb: 1,
            gitCommand: 'git',
            ...observatory
        },
        sandbox: new SandboxService({
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
            requireStrongIsolation: false,
            pythonCommand: 'python3',
            extraBinds: [],
            runsDir: SANDBOX_ROOT
        })
    });
}

let userSeq = 0;
function nextUser() {
    const id = `${100_000_000_000_000_000n + BigInt(process.pid) * 1000n + BigInt(userSeq++)}`;
    TEST_USERS.push(id);
    return id;
}

function workspace(userId, slug) {
    return path.join(PROJECTS_ROOT, userId, slug);
}

function historyDir(userId, slug) {
    return path.join(PROJECTS_ROOT, userId, `${slug}.git`);
}

async function expectThrow(fn, expected) {
    let caught = null;
    try { await fn(); } catch (error) { caught = error; }
    expect(caught).not.toBeNull();
    expect(caught).toMatchObject(expected);
    return caught;
}

afterAll(async () => {
    await db.closeConnection();
    for (const userId of TEST_USERS) {
        try { fs.rmSync(path.join(PROJECTS_ROOT, userId), { recursive: true, force: true }); } catch { /* gone */ }
    }
    try { fs.rmSync(SANDBOX_ROOT, { recursive: true, force: true }); } catch { /* gone */ }
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(TEST_DB + suffix); } catch { /* gone */ }
    }
});

describe('availability', () => {
    test('git on PATH means history is on; a missing binary turns it off with a reason', () => {
        const on = new ProjectHistoryService({ config: { historyEnabled: true, gitCommand: 'git' } });
        expect(on.availability()).toEqual({ enabled: true, reason: null });

        const missing = new ProjectHistoryService({ config: { historyEnabled: true, gitCommand: 'goobster-no-such-git-binary' } });
        expect(missing.availability()).toEqual({ enabled: false, reason: 'GIT_MISSING' });

        const off = new ProjectHistoryService({ config: { historyEnabled: false, gitCommand: 'git' } });
        expect(off.availability()).toEqual({ enabled: false, reason: 'DISABLED' });
    });

    test('with git missing, writes still work and history answers enabled:false without throwing', async () => {
        const service = makeService({ gitCommand: 'goobster-no-such-git-binary' });
        const userId = nextUser();
        const project = await service.createProject({ userId, name: 'No Git Lab' });
        await service.writeWorkspaceFile({ userId, slug: project.slug, relativePath: 'a.txt', bytes: 'hello' });
        expect(fs.existsSync(historyDir(userId, project.slug))).toBe(false);

        const log = await service.history.log({ userId, project: project.slug });
        expect(log).toMatchObject({ enabled: false, reason: 'GIT_MISSING', commits: [] });
        expect(await service.history.commit({ userId, project: project.slug, message: 'x' }))
            .toEqual({ committed: false, reason: 'GIT_MISSING' });
        await expectThrow(
            () => service.history.restore({ userId, project: project.slug, rev: 'HEAD' }),
            { status: 503, code: 'GIT_MISSING' }
        );
    });

    test('commit messages are one bounded line without control characters', () => {
        expect(cleanMessage('  wrote\n\tdata/a.txt \u0000x  ')).toBe('wrote data/a.txt x');
        expect(cleanMessage('')).toBe('snapshot');
        expect(cleanMessage('y'.repeat(500)).length).toBe(160);
    });
});

describe('snapshots', () => {
    test('portal writes and deletes each take a snapshot in a sibling git dir, authored by a pseudonym', async () => {
        const service = makeService();
        const userId = nextUser();
        const project = await service.createProject({ userId, name: 'Snap Lab' });
        const slug = project.slug;

        await service.writeWorkspaceFile({ userId, slug, relativePath: 'notes/a.txt', bytes: 'one\n' });
        await service.writeWorkspaceFile({ userId, slug, relativePath: 'notes/a.txt', bytes: 'one\ntwo\n' });
        await service.writeWorkspaceFile({ userId, slug, relativePath: 'b.txt', bytes: 'bee\n' });
        await service.deleteWorkspaceFile({ userId, slug, relativePath: 'b.txt' });

        // The repository lives beside the workspace, not inside it.
        expect(fs.existsSync(path.join(historyDir(userId, slug), 'HEAD'))).toBe(true);
        expect(fs.existsSync(path.join(workspace(userId, slug), '.git'))).toBe(false);
        const listing = await service.listFiles({ userId, project: slug });
        expect(listing.files.map(f => f.path)).toEqual(['notes/a.txt']);

        const log = await service.history.log({ userId, project: slug });
        expect(log.enabled).toBe(true);
        expect(log.commits.map(c => c.message)).toEqual([
            'deleted b.txt', 'wrote b.txt', 'wrote notes/a.txt', 'wrote notes/a.txt'
        ]);
        expect(log.commits[0].files).toEqual(['b.txt']);
        expect(log.commits[0].author).toEqual({ role: 'owner', name: 'owner' });
        expect(log.commits[0].when).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

        // The raw git author is the project-scoped token, never the user id.
        const { spawnSync } = require('node:child_process');
        const raw = spawnSync('git', ['--git-dir', historyDir(userId, slug), 'log', '--format=%an %ae']).stdout.toString();
        expect(raw).not.toContain(userId);
        expect(raw).toContain(`${service.history.authorToken(project.id, userId)} `);

        // A path filter narrows the listing.
        const onlyA = await service.history.log({ userId, project: slug, path: 'notes/a.txt' });
        expect(onlyA.commits.map(c => c.message)).toEqual(['wrote notes/a.txt', 'wrote notes/a.txt']);

        // Identical trees are a no-op.
        expect(await service.history.commit({ userId, project: slug, message: 'again' }))
            .toEqual({ committed: false, reason: 'NO_CHANGES' });
    });

    test('a foreground run snapshots the workspace with the job id and outcome', async () => {
        const service = makeService();
        const userId = nextUser();
        const project = await service.createProject({ userId, name: 'Run Lab' });
        const outcome = await service.run({
            userId, project: project.slug, language: 'bash',
            code: 'echo hi > "$GOOBSTER_PROJECT_DIR/out.txt"'
        });
        expect(outcome.mode).toBe('foreground');
        const log = await service.history.log({ userId, project: project.slug });
        expect(log.commits[0].message).toBe(`run #${outcome.jobId} completed`);
        expect(log.commits[0].files).toContain('out.txt');
    }, 30_000);

    test('diff, read-at-snapshot, and restore of one path or the whole workspace', async () => {
        const service = makeService();
        const userId = nextUser();
        const { slug } = await service.createProject({ userId, name: 'Restore Lab' });
        const dir = workspace(userId, slug);

        await service.writeWorkspaceFile({ userId, slug, relativePath: 'notes/a.txt', bytes: 'one\n' });
        const first = (await service.history.log({ userId, project: slug })).commits[0];
        await service.writeWorkspaceFile({ userId, slug, relativePath: 'notes/a.txt', bytes: 'one\ntwo\n' });
        await service.writeWorkspaceFile({ userId, slug, relativePath: 'later.txt', bytes: 'added later\n' });

        const change = await service.history.diff({ userId, project: slug, rev: first.short });
        expect(change.label).toBe(`snapshot ${first.short}`);
        expect(change.content).toContain('+one');

        const since = await service.history.diff({ userId, project: slug, rev: first.hash, to: 'workspace', path: 'notes/a.txt' });
        expect(since.content).toContain('+two');
        expect(since.content).not.toContain('later');

        const clean = await service.history.diff({ userId, project: slug });
        expect(clean.empty).toBe(true);

        const old = await service.history.showText({ userId, project: slug, rev: first.short, path: 'notes/a.txt' });
        expect(old.content).toBe('one\n');
        expect(old.short).toBe(first.short);
        await expectThrow(
            () => service.history.show({ userId, project: slug, rev: first.short, path: 'later.txt' }),
            { status: 404, code: 'NOT_FOUND' }
        );
        await expectThrow(
            () => service.history.show({ userId, project: slug, rev: first.short, path: 'notes' }),
            { status: 400, code: 'NOT_A_FILE' }
        );

        // One path: later.txt survives, and an unsnapshotted edit made by a
        // run or by hand is captured first so the restore can be undone.
        fs.writeFileSync(path.join(dir, 'notes/a.txt'), 'one\ntwo\nthree (unsaved)\n');
        const one = await service.history.restore({ userId, project: slug, rev: first.short, path: 'notes/a.txt' });
        expect(one.changed).toBe(true);
        expect(fs.readFileSync(path.join(dir, 'notes/a.txt'), 'utf8')).toBe('one\n');
        expect(fs.existsSync(path.join(dir, 'later.txt'))).toBe(true);
        let log = await service.history.log({ userId, project: slug });
        expect(log.commits[0].message).toBe(`restored notes/a.txt from ${first.short}`);
        expect(log.commits[1].message).toBe('before restoring notes/a.txt');
        expect(log.commits[1].hash).toBe(one.before);
        expect((await service.history.showText({ userId, project: slug, rev: one.before, path: 'notes/a.txt' })).content)
            .toBe('one\ntwo\nthree (unsaved)\n');

        // Whole workspace: files the snapshot does not have are removed.
        const all = await service.history.restore({ userId, project: slug, rev: first.hash });
        expect(all.restored).toBe('');
        expect(fs.existsSync(path.join(dir, 'later.txt'))).toBe(false);
        expect(fs.readFileSync(path.join(dir, 'notes/a.txt'), 'utf8')).toBe('one\n');
        log = await service.history.log({ userId, project: slug });
        expect(log.commits[0].message).toBe(`restored the workspace from ${first.short}`);

        // And the restore itself is reversible: back to the "before" snapshot.
        await service.history.restore({ userId, project: slug, rev: all.before });
        expect(fs.existsSync(path.join(dir, 'later.txt'))).toBe(true);
        expect(fs.readFileSync(path.join(dir, 'notes/a.txt'), 'utf8')).toBe('one\n');
    });

    test('revisions and paths are legalized: no flags, no traversal, no symlinks, no unknown snapshots', async () => {
        const service = makeService();
        const userId = nextUser();
        const { slug } = await service.createProject({ userId, name: 'Legal Lab' });
        await service.writeWorkspaceFile({ userId, slug, relativePath: 'a.txt', bytes: 'a' });

        for (const rev of ['--output=/tmp/x', '-n', 'main', 'HEAD~x', 'refs/heads/main', '']) {
            await expectThrow(
                () => service.history.diff({ userId, project: slug, rev: rev || ' ' }),
                { status: 400, code: 'BAD_REV' }
            );
        }
        await expectThrow(
            () => service.history.restore({ userId, project: slug, rev: 'deadbeef' }),
            { status: 404, code: 'NOT_FOUND' }
        );
        await expectThrow(
            () => service.history.show({ userId, project: slug, rev: 'HEAD', path: '../a.txt' }),
            { status: 400, code: 'BAD_PATH' }
        );
        await expectThrow(
            () => service.history.restore({ userId, project: slug, rev: 'HEAD', path: '/etc/passwd' }),
            { status: 400, code: 'BAD_PATH' }
        );
        fs.symlinkSync('/etc', path.join(workspace(userId, slug), 'escape'));
        await expectThrow(
            () => service.history.restore({ userId, project: slug, rev: 'HEAD', path: 'escape/passwd' }),
            { status: 400, code: 'BAD_PATH' }
        );
        await expectThrow(
            () => service.history.restore({ userId, project: slug, rev: 'HEAD', path: 'nope.txt' }),
            { status: 404, code: 'NOT_FOUND' }
        );
    });

    test('frames, renders and oversized files stay out; the budget squashes and then pauses', async () => {
        const service = makeService({ historyMaxFileMb: 1, historyMaxMb: 1 });
        const userId = nextUser();
        const { slug } = await service.createProject({ userId, name: 'Budget Lab' });
        const dir = workspace(userId, slug);

        fs.mkdirSync(path.join(dir, 'runs/1/frames'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'runs/1/frames/frame_0001.png'), 'png');
        fs.mkdirSync(path.join(dir, 'renders'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'renders/out.mp4'), 'mp4');
        fs.writeFileSync(path.join(dir, 'big.bin'), crypto.randomBytes(1024 * 1024 + 1));
        fs.writeFileSync(path.join(dir, 'small.txt'), 'kept');
        const snap = await service.history.commit({ userId, project: slug, message: 'first' });
        expect(snap.committed).toBe(true);
        const log = await service.history.log({ userId, project: slug });
        expect(log.commits[0].files).toEqual(['small.txt']);
        expect(fs.readFileSync(path.join(historyDir(userId, slug), 'info/exclude'), 'utf8')).toContain('/big.bin');

        // Two 700 KB random blobs are over a 1 MB budget: squash to one snapshot.
        fs.writeFileSync(path.join(dir, 'mid.bin'), crypto.randomBytes(700 * 1024));
        expect((await service.history.commit({ userId, project: slug, message: 'mid1' })).squashed).toBe(false);
        fs.writeFileSync(path.join(dir, 'mid.bin'), crypto.randomBytes(700 * 1024));
        const squashed = await service.history.commit({ userId, project: slug, message: 'mid2' });
        expect(squashed).toMatchObject({ committed: true, squashed: true, paused: false });
        const after = await service.history.log({ userId, project: slug });
        expect(after.commits).toHaveLength(1);
        expect(after.commits[0].message).toMatch(/history squashed to one snapshot/);
        expect(after.paused).toBe(false);
        // The latest files are still what the single snapshot holds.
        const kept = await service.history.show({ userId, project: slug, rev: 'HEAD', path: 'mid.bin' });
        expect(kept.bytes.equals(fs.readFileSync(path.join(dir, 'mid.bin')))).toBe(true);

        // A workspace that alone exceeds the budget pauses snapshots...
        fs.writeFileSync(path.join(dir, 'mid.bin'), crypto.randomBytes(1000 * 1024));
        fs.writeFileSync(path.join(dir, 'mid2.bin'), crypto.randomBytes(1000 * 1024));
        const paused = await service.history.commit({ userId, project: slug, message: 'too big' });
        expect(paused).toMatchObject({ committed: true, squashed: true, paused: true });
        expect((await service.history.log({ userId, project: slug })).paused).toBe(true);
        fs.writeFileSync(path.join(dir, 'small.txt'), 'changed while paused');
        expect(await service.history.commit({ userId, project: slug, message: 'ignored' }))
            .toEqual({ committed: false, reason: 'PAUSED' });

        // ...until it shrinks.
        fs.rmSync(path.join(dir, 'mid.bin'));
        fs.rmSync(path.join(dir, 'mid2.bin'));
        const resumed = await service.history.commit({ userId, project: slug, message: 'slim again' });
        expect(resumed.committed).toBe(true);
        expect((await service.history.log({ userId, project: slug })).paused).toBe(false);
    }, 60_000);

    test('a restore that would break the quota is rolled back', async () => {
        const service = makeService({ maxProjectMb: 1, historyMaxFileMb: 8, historyMaxMb: 64 });
        const userId = nextUser();
        const { slug } = await service.createProject({ userId, name: 'Quota Lab' });
        const dir = workspace(userId, slug);
        fs.writeFileSync(path.join(dir, 'blob.bin'), crypto.randomBytes(600 * 1024));
        const big = await service.history.commit({ userId, project: slug, message: 'big' });
        fs.rmSync(path.join(dir, 'blob.bin'));
        fs.writeFileSync(path.join(dir, 'other.bin'), crypto.randomBytes(600 * 1024));
        await service.history.commit({ userId, project: slug, message: 'swapped' });

        await expectThrow(
            () => service.history.restore({ userId, project: slug, rev: big.hash, path: 'blob.bin' }),
            { status: 413, code: 'QUOTA_EXCEEDED' }
        );
        expect(fs.existsSync(path.join(dir, 'blob.bin'))).toBe(false);
        expect(fs.existsSync(path.join(dir, 'other.bin'))).toBe(true);
    });

    test('a collaborator is named while a member and "former collaborator" after erasure', async () => {
        const service = makeService();
        const ownerId = nextUser();
        const memberId = nextUser();
        const project = await service.createProject({ userId: ownerId, name: 'Shared Lab' });
        await db.run(
            `INSERT INTO project_members (projectId, userId, userName, invitedBy)
             VALUES (@projectId, @userId, 'Dana', @ownerId)`,
            { projectId: project.id, userId: memberId, ownerId }
        );
        await service.writeWorkspaceFile({ userId: memberId, slug: project.slug, owner: ownerId, relativePath: 'shared.txt', bytes: 'hi' });
        let log = await service.history.log({ userId: ownerId, project: project.slug });
        expect(log.commits[0].author).toEqual({ role: 'collaborator', name: 'Dana' });

        await privacyService.forgetUser({ userId: memberId });
        log = await service.history.log({ userId: ownerId, project: project.slug });
        expect(log.commits[0].author).toEqual({ role: 'former', name: 'former collaborator' });
        expect(fs.existsSync(path.join(historyDir(ownerId, project.slug), 'HEAD'))).toBe(true);
    });

    test('deleting the project and /forget-me remove the history directory', async () => {
        const service = makeService();
        const userId = nextUser();
        const a = await service.createProject({ userId, name: 'Gone A' });
        const b = await service.createProject({ userId, name: 'Gone B' });
        await service.writeWorkspaceFile({ userId, slug: a.slug, relativePath: 'a.txt', bytes: 'a' });
        await service.writeWorkspaceFile({ userId, slug: b.slug, relativePath: 'b.txt', bytes: 'b' });
        expect(fs.existsSync(historyDir(userId, a.slug))).toBe(true);
        expect(fs.existsSync(historyDir(userId, b.slug))).toBe(true);

        await service.deleteProject({ userId, project: a.slug });
        expect(fs.existsSync(historyDir(userId, a.slug))).toBe(false);
        expect(fs.existsSync(historyDir(userId, b.slug))).toBe(true);

        await privacyService.forgetUser({ userId });
        expect(fs.existsSync(path.join(PROJECTS_ROOT, userId))).toBe(false);
    });
});
