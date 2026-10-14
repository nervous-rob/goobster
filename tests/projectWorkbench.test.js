/**
 * The project workbench: GOOBSTER.md project instructions (read into every
 * agent turn on the project), workspace search, run-again and "what changed
 * since the last good run", and the Overview's Now read.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const TEST_DB = path.join(os.tmpdir(), `goobster-project-workbench-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const { ObservatoryService, PROJECTS_ROOT } = require('@goobster/core/services/projectService');
const { SandboxService } = require('@goobster/core/services/sandboxService');
const { ProjectTriggerService } = require('@goobster/core/services/projectTriggerService');

const SANDBOX_ROOT = path.join(os.tmpdir(), `goobster-project-workbench-runs-${process.pid}`);
const TEST_USERS = [];
const CONFIG = {
    enabled: true, projectsEnabled: true, scope: 'everywhere',
    maxProjectsPerUser: 5, maxMembersPerProject: 5, maxProjectMb: 8, maxActiveJobsPerUser: 2, maxResumes: 2,
    maxWorkspaceFiles: 50, maxWorkspaceReadMb: 8, maxUploadMb: 2, maxRenderFrames: 10, renderFps: 24,
    ffmpegCommand: 'ffmpeg', historyEnabled: true, historyMaxFileMb: 8, historyMaxMb: 64, gitCommand: 'git',
    reposEnabled: false, maxReposPerProject: 2, repoCloneDepth: 50, repoMaxMb: 64
};

function makeService() {
    return new ObservatoryService({
        config: CONFIG,
        sandbox: new SandboxService({
            enabled: true, scope: 'everywhere', timeoutMs: 15_000, maxCpuSeconds: 15, maxMemoryMb: 2048,
            maxWriteMb: 16, maxOutputBytes: 64 * 1024, maxOutputFiles: 8, maxFileSizeBytes: 8 * 1024 * 1024,
            runsPerWindow: 1000, maxConcurrent: 4, retentionHours: 24, allowNetwork: false,
            requireStrongIsolation: false, pythonCommand: 'python3', extraBinds: [], runsDir: SANDBOX_ROOT
        })
    });
}

let seq = 0;
function nextUser() {
    const id = `${300_000_000_000_000_000n + BigInt(process.pid) * 1000n + BigInt(seq++)}`;
    TEST_USERS.push(id);
    return id;
}

const workspace = (userId, slug) => path.join(PROJECTS_ROOT, userId, slug);

async function insertJob(projectId, userId, status, extra = {}) {
    return db.insert(
        `INSERT INTO observatory_jobs (projectId, userId, language, code, status, exitCode, errorCode, stderrTail, finishedAt, startedBy)
         VALUES (@projectId, @userId, 'python', @code, @status, @exitCode, @errorCode, @stderrTail, @finishedAt, 'portal')`,
        {
            projectId, userId, status, code: extra.code || 'print(1)', exitCode: extra.exitCode ?? null,
            errorCode: extra.errorCode || null, stderrTail: extra.stderrTail || null,
            finishedAt: status === 'RUNNING' ? null : '2026-01-01 00:00:00'
        }
    );
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

describe('project instructions (GOOBSTER.md)', () => {
    test('read, capped, and carried by the manifest, unattended turns and the project chat seat', async () => {
        const service = makeService();
        const userId = nextUser();
        const project = await service.createProject({ userId, name: 'Rules Lab' });
        const ws = workspace(userId, project.slug);

        expect(await service.getInstructions({ userId, project: project.slug })).toMatchObject({ exists: false, path: 'GOOBSTER.md' });
        expect(await service.instructionsPromptForProjectId(project.id)).toBe('');
        expect((await service.buildChatManifest({ userId, project: project.slug })).text).not.toContain('PROJECT INSTRUCTIONS');

        fs.writeFileSync(path.join(ws, 'GOOBSTER.md'), '# House rules\r\nRun `npm test` before every push.\nNever touch vendor/.\n');
        const read = await service.getInstructions({ userId, project: project.slug });
        expect(read).toMatchObject({ exists: true, lines: 3, truncated: false });
        expect(read.text).toBe('# House rules\nRun `npm test` before every push.\nNever touch vendor/.');
        expect((await service.buildChatManifest({ userId, project: project.slug })).text)
            .toMatch(/PROJECT INSTRUCTIONS \(GOOBSTER\.md[\s\S]*Run `npm test` before every push/);
        expect(await service.instructionsPromptForProjectId(project.id)).toContain('Never touch vendor/.');

        // Unattended turns (triggers and CI watches) carry the same block.
        const triggers = new ProjectTriggerService();
        const seen = [];
        triggers._agentPromptFn = async (params) => { seen.push(params.message); };
        await triggers.runAgentPrompt({ userId, name: 'nightly', projectRow: { ...project, ownerId: userId, userId }, prompt: 'do the thing' });
        expect(seen[0]).toContain('do the thing');
        expect(seen[0]).toContain('PROJECT INSTRUCTIONS');

        // The project chat seat's system prompt carries it too.
        const parlor = require('@goobster/core/services/parlorService');
        const messages = parlor._buildPersonaMessages({
            persona: { name: 'Goobster', charter: 'helpful' }, ownerName: 'dana', history: [], retrieved: [],
            projectSeat: true, projectInstructions: await service.instructionsPromptForProjectId(project.id)
        });
        expect(messages[0].content).toContain('Run `npm test` before every push.');
        const notSeat = parlor._buildPersonaMessages({
            persona: { name: 'Sage', charter: 'wise' }, ownerName: 'dana', history: [], retrieved: [],
            projectSeat: false, projectInstructions: 'SHOULD NOT APPEAR'
        });
        expect(notSeat[0].content).not.toContain('SHOULD NOT APPEAR');

        // Capped, never a whole novel in every turn.
        fs.writeFileSync(path.join(ws, 'GOOBSTER.md'), 'x'.repeat(9000));
        const long = await service.getInstructions({ userId, project: project.slug });
        expect(long).toMatchObject({ truncated: true });
        expect(long.text).toHaveLength(6000);
        expect(service.instructionsPrompt({ dir: ws })).toMatch(/cut at 6000 characters/);
    });
});

describe('workspace search', () => {
    test('finds lines and file names, skips binary, big and dependency files, and stays inside the workspace', async () => {
        const service = makeService();
        const userId = nextUser();
        const { slug } = await service.createProject({ userId, name: 'Search Lab' });
        const ws = workspace(userId, slug);
        fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
        fs.mkdirSync(path.join(ws, 'node_modules/pkg'), { recursive: true });
        fs.writeFileSync(path.join(ws, 'src/main.py'), 'import os\n\ndef Simulate(steps):\n    return simulate_inner(steps)\n');
        fs.writeFileSync(path.join(ws, 'notes.md'), 'TODO: simulate faster\n');
        fs.writeFileSync(path.join(ws, 'src/simulate_helpers.py'), 'pass\n');
        fs.writeFileSync(path.join(ws, 'node_modules/pkg/index.js'), 'simulate()\n');
        fs.writeFileSync(path.join(ws, 'blob.bin'), Buffer.from([0, 1, 2, 115, 105, 109, 117, 108, 97, 116, 101]));

        const found = await service.searchWorkspace({ userId, project: slug, query: 'SIMULATE' });
        expect(found.hits.map(hit => `${hit.path}:${hit.line}`).sort()).toEqual(['notes.md:1', 'src/main.py:3', 'src/main.py:4']);
        expect(found.hits.find(hit => hit.path === 'src/main.py' && hit.line === 3).text).toBe('def Simulate(steps):');
        expect(found.files).toEqual(['src/simulate_helpers.py']);
        expect(found.truncated).toBe(false);

        const narrowed = await service.searchWorkspace({ userId, project: slug, query: 'simulate', path: 'src' });
        expect(new Set(narrowed.hits.map(hit => hit.path))).toEqual(new Set(['src/main.py']));
        expect((await service.searchWorkspace({ userId, project: slug, query: 'simulate', path: 'notes.md' })).hits).toHaveLength(1);
        expect((await service.searchWorkspace({ userId, project: slug, query: 'simulate', limit: 1 })).truncated).toBe(true);

        await expect(service.searchWorkspace({ userId, project: slug, query: 'x' })).rejects.toMatchObject({ code: 'BAD_QUERY' });
        await expect(service.searchWorkspace({ userId, project: slug, query: 'simulate', path: '../..' })).rejects.toMatchObject({ code: 'BAD_PATH' });
        await expect(service.searchWorkspace({ userId, project: slug, query: 'simulate', path: 'nope' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
        await expect(service.searchWorkspace({ userId: nextUser(), project: slug, query: 'simulate' })).rejects.toMatchObject({ status: 404 });
    });
});

describe('failed runs', () => {
    test('run again starts the same code; the last good run and the failure map to their snapshots', async () => {
        const service = makeService();
        const userId = nextUser();
        const project = await service.createProject({ userId, name: 'Runs Lab' });
        const ws = workspace(userId, project.slug);
        const row = { ...project, ownerId: userId, userId, dir: ws };

        const good = await insertJob(project.id, userId, 'COMPLETED', { exitCode: 0 });
        fs.writeFileSync(path.join(ws, 'model.py'), 'rate = 1\n');
        const goodSnap = await service.history.commitQuietly(row, { userId, message: `job #${good} completed` });
        const bad = await insertJob(project.id, userId, 'FAILED', { exitCode: 1, code: 'raise SystemExit(1)', errorCode: 'EXIT_NONZERO', stderrTail: 'Traceback: boom' });
        fs.writeFileSync(path.join(ws, 'model.py'), 'rate = 2\n');
        const badSnap = await service.history.commitQuietly(row, { userId, message: `job #${bad} failed (exit 1)` });

        const changes = await service.jobChanges({ userId, jobId: bad });
        expect(changes).toMatchObject({ jobId: Number(bad), goodJobId: Number(good), goodRev: goodSnap.hash, failedRev: badSnap.hash });
        const diff = await service.history.diff({ row, userId, rev: changes.goodRev, to: changes.failedRev });
        expect(diff.content).toContain('+rate = 2');

        const runSpy = jest.spyOn(service, 'run').mockResolvedValue({ id: 999, status: 'RUNNING' });
        try {
            expect(await service.rerunJob({ userId, jobId: bad })).toEqual({ id: 999, status: 'RUNNING' });
            expect(runSpy).toHaveBeenCalledWith(expect.objectContaining({
                userId, project: project.slug, owner: userId, language: 'python', code: 'raise SystemExit(1)', background: true, startedBy: 'portal'
            }));
            const running = await insertJob(project.id, userId, 'RUNNING');
            await expect(service.rerunJob({ userId, jobId: running })).rejects.toMatchObject({ code: 'STILL_RUNNING' });
            await db.run("UPDATE observatory_jobs SET status = 'CANCELLED' WHERE id = @id", { id: running });
        } finally {
            runSpy.mockRestore();
        }
        await expect(service.jobChanges({ userId: nextUser(), jobId: bad })).rejects.toMatchObject({ status: 404 });
    });
});

describe('now', () => {
    test('running and failed runs, instructions, and what Goobster last said; a later success clears the failure', async () => {
        const service = makeService();
        const userId = nextUser();
        const project = await service.createProject({ userId, name: 'Now Lab' });

        const empty = await service.now({ userId, project: project.slug });
        expect(empty).toMatchObject({ running: [], failure: null, instructions: { exists: false }, lastGoobster: null, repos: [] });

        await insertJob(project.id, userId, 'COMPLETED', { exitCode: 0 });
        const failed = await insertJob(project.id, userId, 'FAILED', { exitCode: 2, errorCode: 'EXIT_NONZERO', stderrTail: 'x'.repeat(1000) + 'KeyError' });
        const running = await insertJob(project.id, userId, 'RUNNING');
        fs.writeFileSync(path.join(workspace(userId, project.slug), 'GOOBSTER.md'), 'rules\n');
        const conversation = await db.insert(
            "INSERT INTO parlor_conversations (ownerId, title, projectId) VALUES (@userId, 'Project chat', @projectId)",
            { userId, projectId: project.id }
        );
        await db.run(
            "INSERT INTO parlor_messages (conversationId, role, personaName, content) VALUES (@c, 'persona', 'Goobster', @content)",
            { c: conversation, content: 'I pushed   the fix\nto feature/x.' }
        );

        const now = await service.now({ userId, project: project.slug });
        expect(now.running).toEqual([expect.objectContaining({ id: Number(running), startedBy: 'portal' })]);
        expect(now.failure).toMatchObject({ id: Number(failed), status: 'FAILED', exitCode: 2, errorCode: 'EXIT_NONZERO' });
        expect(now.failure.stderrTail).toHaveLength(400);
        expect(now.failure.stderrTail.endsWith('KeyError')).toBe(true);
        expect(now.instructions).toMatchObject({ exists: true, lines: 1 });
        expect(now.lastGoobster).toMatchObject({ conversationId: Number(conversation), excerpt: 'I pushed the fix to feature/x.' });

        await db.run("UPDATE observatory_jobs SET status = 'COMPLETED', finishedAt = '2026-01-02 00:00:00' WHERE id = @id", { id: running });
        expect((await service.now({ userId, project: project.slug })).failure).toBeNull();
        await expect(service.now({ userId: nextUser(), project: project.slug })).rejects.toMatchObject({ status: 404 });
    });
});
