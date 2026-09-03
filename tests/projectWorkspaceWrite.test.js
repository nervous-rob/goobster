/**
 * Phase 5: workspace writes, path legalization, quota, portal-origin
 * versioning, run-from-UI provenance, and /forget-me leaving zero files.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const TEST_DB = path.join(os.tmpdir(), `goobster-workspace-write-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const {
    ObservatoryService,
    ObservatoryError,
    PROJECTS_ROOT,
    DASHBOARDS_ROOT,
    legalizeWorkspacePath
} = require('@goobster/core/services/projectService');
const { SandboxService } = require('@goobster/core/services/sandboxService');
const projectAssetService = require('@goobster/core/services/projectAssetService');
const privacyService = require('@goobster/core/services/privacyService');

const SANDBOX_ROOT = path.join(os.tmpdir(), `goobster-ws-write-runs-${process.pid}`);
const TEST_USERS = [];

function makeService(observatory = {}) {
    return new ObservatoryService({
        config: {
            enabled: true,
            scope: 'everywhere',
            maxProjectsPerUser: 5,
            maxProjectMb: 8,
            maxActiveJobsPerUser: 2,
            maxResumes: 2,
            maxWorkspaceFiles: 50,
            maxWorkspaceReadMb: 8,
            maxUploadMb: 1,
            maxRenderFrames: 10,
            renderFps: 24,
            ffmpegCommand: 'ffmpeg',
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
            pythonCommand: 'python3',
            extraBinds: [],
            runsDir: SANDBOX_ROOT
        })
    });
}

let userSeq = 0;
function nextUser() {
    const id = `ws-user-${process.pid}-${userSeq++}`;
    TEST_USERS.push(id);
    return id;
}

async function expectThrow(fn, expected) {
    let caught = null;
    try { await fn(); } catch (error) { caught = error; }
    expect(caught).not.toBeNull();
    expect(caught).toMatchObject(expected);
    return caught;
}

afterAll(async () => {
    for (const userId of TEST_USERS) {
        try { fs.rmSync(path.join(PROJECTS_ROOT, userId), { recursive: true, force: true }); } catch { /* gone */ }
        try { fs.rmSync(path.join(DASHBOARDS_ROOT, userId), { recursive: true, force: true }); } catch { /* gone */ }
    }
    try { fs.rmSync(SANDBOX_ROOT, { recursive: true, force: true }); } catch { /* gone */ }
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(TEST_DB + suffix); } catch { /* gone */ }
    }
});

describe('legalizeWorkspacePath', () => {
    const root = path.join(os.tmpdir(), `goobster-legalize-${process.pid}`);

    beforeAll(() => {
        fs.mkdirSync(root, { recursive: true });
        fs.writeFileSync(path.join(root, 'ok.txt'), 'yes');
    });
    afterAll(() => {
        try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* gone */ }
    });

    test('accepts a workspace-relative file and refuses traversal / absolute paths', () => {
        expect(legalizeWorkspacePath(root, 'ok.txt').relativePath).toBe('ok.txt');
        expect(legalizeWorkspacePath(root, 'nested/out.csv').relativePath).toBe('nested/out.csv');
        for (const evil of ['../../../etc/passwd', '/etc/passwd', 'frames/../../other', '..', '.', 'C:\\Windows']) {
            expect(() => legalizeWorkspacePath(root, evil)).toThrow(ObservatoryError);
            try { legalizeWorkspacePath(root, evil); } catch (error) {
                expect(error.code).toBe('BAD_PATH');
                expect(error.status).toBe(400);
            }
        }
    });

    test('refuses a symlink that points outside the workspace', () => {
        const outside = path.join(os.tmpdir(), `goobster-legalize-out-${process.pid}.txt`);
        fs.writeFileSync(outside, 'nope');
        const link = path.join(root, 'escape.txt');
        try {
            fs.symlinkSync(outside, link);
            expect(() => legalizeWorkspacePath(root, 'escape.txt')).toThrow(ObservatoryError);
            try { legalizeWorkspacePath(root, 'escape.txt'); } catch (error) {
                expect(error.code).toBe('BAD_PATH');
            }
        } finally {
            try { fs.unlinkSync(link); } catch { /* gone */ }
            try { fs.unlinkSync(outside); } catch { /* gone */ }
        }
    });
});

describe('workspace writes', () => {
    test('PUT creates nested files; DELETE removes them; listFiles path lists one directory', async () => {
        const svc = makeService();
        const userId = nextUser();
        const { slug } = await svc.createProject({ userId, name: 'Write Lab' });
        const written = await svc.writeWorkspaceFile({
            userId, slug, relativePath: 'data/notes.txt', bytes: Buffer.from('hello workspace')
        });
        expect(written.relativePath).toBe('data/notes.txt');
        expect(written.size).toBe(Buffer.byteLength('hello workspace'));
        const disk = path.join(PROJECTS_ROOT, userId, slug, 'data', 'notes.txt');
        expect(fs.readFileSync(disk, 'utf8')).toBe('hello workspace');

        const listing = await svc.listFiles({ userId, project: slug, path: '' });
        expect(listing.entries.some(e => e.name === 'data' && e.kind === 'directory')).toBe(true);
        const nested = await svc.listFiles({ userId, project: slug, path: 'data' });
        expect(nested.files.map(f => f.path)).toContain('data/notes.txt');

        await svc.deleteWorkspaceFile({ userId, slug, relativePath: 'data/notes.txt' });
        expect(fs.existsSync(disk)).toBe(false);
        await svc.deleteWorkspaceFile({ userId, slug, relativePath: 'data' });
        expect(fs.existsSync(path.join(PROJECTS_ROOT, userId, slug, 'data'))).toBe(false);
    });

    test('every write route refuses traversal, absolute paths, and escaping symlinks', async () => {
        const svc = makeService();
        const userId = nextUser();
        const { slug } = await svc.createProject({ userId, name: 'Guard Lab' });
        const dir = path.join(PROJECTS_ROOT, userId, slug);
        for (const evil of ['../../../etc/passwd', '/etc/passwd', 'frames/../../other']) {
            await expectThrow(
                () => svc.writeWorkspaceFile({ userId, slug, relativePath: evil, bytes: 'x' }),
                { code: 'BAD_PATH', status: 400 }
            );
            await expectThrow(
                () => svc.deleteWorkspaceFile({ userId, slug, relativePath: evil }),
                { code: 'BAD_PATH', status: 400 }
            );
        }
        const outside = path.join(os.tmpdir(), `goobster-ws-escape-${process.pid}.txt`);
        fs.writeFileSync(outside, 'nope');
        const link = path.join(dir, 'escape.txt');
        try {
            fs.symlinkSync(outside, link);
            await expectThrow(
                () => svc.writeWorkspaceFile({ userId, slug, relativePath: 'escape.txt', bytes: 'overwrite' }),
                { code: 'BAD_PATH', status: 400 }
            );
            await expectThrow(
                () => svc.deleteWorkspaceFile({ userId, slug, relativePath: 'escape.txt' }),
                { code: 'BAD_PATH', status: 400 }
            );
            expect(fs.readFileSync(outside, 'utf8')).toBe('nope');
        } finally {
            try { fs.unlinkSync(link); } catch { /* gone */ }
            try { fs.unlinkSync(outside); } catch { /* gone */ }
        }
    });

    test('quota is enforced before an upload or edit is accepted', async () => {
        const svc = makeService({ maxProjectMb: 1, maxUploadMb: 50 });
        const userId = nextUser();
        const { slug } = await svc.createProject({ userId, name: 'Quota Lab' });
        await svc.writeWorkspaceFile({
            userId, slug, relativePath: 'keep.txt', bytes: Buffer.alloc(400 * 1024, 0x61)
        });
        await expectThrow(
            () => svc.writeWorkspaceFile({
                userId, slug, relativePath: 'too-big.txt', bytes: Buffer.alloc(800 * 1024, 0x62)
            }),
            { code: 'QUOTA_EXCEEDED', status: 413 }
        );
        expect(fs.existsSync(path.join(PROJECTS_ROOT, userId, slug, 'too-big.txt'))).toBe(false);

        const tight = makeService({ maxProjectMb: 256, maxUploadMb: 1 });
        const other = nextUser();
        const created = await tight.createProject({ userId: other, name: 'Upload Cap' });
        await expectThrow(
            () => tight.writeWorkspaceFile({
                userId: other, slug: created.slug,
                relativePath: 'huge.bin',
                bytes: Buffer.alloc(2 * 1024 * 1024, 0x63)
            }),
            { code: 'FILE_TOO_LARGE', status: 413 }
        );
        expect(fs.existsSync(path.join(PROJECTS_ROOT, other, created.slug, 'huge.bin'))).toBe(false);
    });
});

describe('portal-origin versioning and run-from-UI provenance', () => {
    test('save with origin=portal uses the shared path (dedupe + new version)', async () => {
        const svc = makeService();
        const userId = nextUser();
        const { slug } = await svc.createProject({ userId, name: 'Asset Lab' });
        const first = await projectAssetService.save({
            userId, project: slug, name: 'ingest', kind: 'script',
            language: 'python', source: 'print(1)\n', origin: 'portal'
        });
        expect(first.origin).toBe('portal');
        expect(first.version).toBe(1);
        const again = await projectAssetService.save({
            userId, project: slug, slug: 'ingest', name: 'ingest',
            kind: 'script', language: 'python', source: 'print(1)\n', origin: 'portal'
        });
        expect(again.deduped).toBe(true);
        expect(again.version).toBe(1);
        const second = await projectAssetService.save({
            userId, project: slug, slug: 'ingest', name: 'ingest',
            kind: 'script', language: 'python', source: 'print(2)\n', origin: 'portal',
            note: 'bump from the portal'
        });
        expect(second.deduped).toBe(false);
        expect(second.version).toBe(2);
        expect(second.origin).toBe('portal');
    });

    test('run-from-UI records assetVersionId and startedBy=portal', async () => {
        const svc = makeService();
        const userId = nextUser();
        const { slug } = await svc.createProject({ userId, name: 'Run Lab' });
        const asset = await projectAssetService.save({
            userId, project: slug, name: 'ingest', kind: 'script',
            language: 'python', source: 'print("portal-run")\n', origin: 'portal'
        });
        const outcome = await svc.run({
            userId,
            project: slug,
            language: asset.language,
            code: asset.source,
            background: true,
            assetVersionId: asset.versionId,
            startedBy: 'portal'
        });
        expect(outcome.mode).toBe('background');
        const deadline = Date.now() + 15_000;
        let job = null;
        while (Date.now() < deadline) {
            job = await db.get(
                `SELECT assetVersionId, startedBy, status FROM observatory_jobs WHERE id = @id`,
                { id: outcome.jobId }
            );
            if (job && job.status !== 'RUNNING') break;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(job).toBeTruthy();
        expect(job.status).not.toBe('RUNNING');
        expect(job.startedBy).toBe('portal');
        expect(Number(job.assetVersionId)).toBe(Number(asset.versionId));
    });
});

describe('erasure after a portal write', () => {
    test('/forget-me leaves zero workspace files', async () => {
        const svc = makeService();
        const userId = nextUser();
        const { slug } = await svc.createProject({ userId, name: 'Forget Lab' });
        await svc.writeWorkspaceFile({
            userId, slug, relativePath: 'data/keep.txt', bytes: 'secret'
        });
        expect(fs.existsSync(path.join(PROJECTS_ROOT, userId, slug, 'data', 'keep.txt'))).toBe(true);
        await privacyService.forgetUser({ userId });
        expect(fs.existsSync(path.join(PROJECTS_ROOT, userId))).toBe(false);
        expect((await svc.countUserData(userId)).workspaceDirs).toBe(0);
    });
});
