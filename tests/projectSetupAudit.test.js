/**
 * Setup-contract auditor + Needs-you / human-choice mission helpers.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

process.env.GOOBSTER_DB_PATH = path.join(os.tmpdir(), `goobster-setup-audit-${process.pid}.sqlite`);

const {
    auditProjectSetup,
    formatSetupAuditText,
    scanCheckpointUsage,
    RUN_DIR_ENV,
    PROJECT_DIR_ENV,
    CHECKPOINT_FILE
} = require('@goobster/core/utils/projectSetupContract');

const {
    ObservatoryService,
    PROJECTS_ROOT
} = require('@goobster/core/services/projectService');
const { SandboxService } = require('@goobster/core/services/sandboxService');
const {
    ProjectMissionService,
    legalizeHumanActionParams
} = require('@goobster/core/services/projectMissionService');

function makeService() {
    return new ObservatoryService({
        config: {
            enabled: true, scope: 'everywhere', maxProjectsPerUser: 10, maxProjectMb: 64,
            maxActiveJobsPerUser: 2, maxResumes: 2, maxWorkspaceFiles: 50, maxWorkspaceReadMb: 8,
            maxUploadMb: 10, maxRenderFrames: 100, renderFps: 24, ffmpegCommand: 'ffmpeg'
        },
        sandbox: new SandboxService({
            enabled: true, scope: 'everywhere', timeoutMs: 5000, maxCpuSeconds: 5,
            maxMemoryMb: 512, maxWriteMb: 8, maxOutputBytes: 64 * 1024, maxOutputFiles: 4,
            maxFileSizeBytes: 1024 * 1024, runsPerWindow: 100, maxConcurrent: 2,
            retentionHours: 1, allowNetwork: false, pythonCommand: 'python3',
            extraBinds: [], requireStrongIsolation: false,
            runsDir: path.join(os.tmpdir(), `setup-audit-runs-${process.pid}`)
        })
    });
}

describe('auditProjectSetup (pure)', () => {
    test('flags legacy root checkpoint and project-dir script writers', () => {
        const audited = auditProjectSetup({
            hasRootCheckpoint: true,
            hasRootFrames: true,
            runCheckpointCount: 0,
            jobs: [{ id: 1, legacyWorkspace: 1 }],
            scripts: [{
                slug: 'sim',
                source: 'open(os.environ["GOOBSTER_PROJECT_DIR"] + "/checkpoint.json","w").write("x")'
            }]
        });
        expect(audited.ok).toBe(false);
        expect(audited.findings.map(f => f.code)).toEqual(expect.arrayContaining([
            'legacy_root_checkpoint',
            'legacy_root_frames',
            'legacy_workspace_jobs',
            'script_writes_project_checkpoint'
        ]));
        expect(formatSetupAuditText(audited)).toMatch(/need attention/);
    });

    test('scanCheckpointUsage distinguishes run-dir vs project-dir', () => {
        expect(scanCheckpointUsage(
            `d=os.environ['${RUN_DIR_ENV}']; open(d+'/${CHECKPOINT_FILE}','w')`
        ).usesRunDir).toBe(true);
        expect(scanCheckpointUsage(
            `p=os.environ['${PROJECT_DIR_ENV}']; open(p+'/${CHECKPOINT_FILE}','w')`
        ).usesProjectCheckpoint).toBe(true);
    });
});

describe('auditSetup + needs-you board', () => {
    const users = [];
    afterAll(() => {
        for (const userId of users) {
            try { fs.rmSync(path.join(PROJECTS_ROOT, userId), { recursive: true, force: true }); } catch { /* */ }
        }
    });

    test('auditSetup reports legacy root checkpoint on an existing project', async () => {
        const svc = makeService();
        const userId = `audit-${process.pid}`;
        users.push(userId);
        const { slug } = await svc.createProject({ userId, name: 'Legacy Lab' });
        fs.writeFileSync(path.join(PROJECTS_ROOT, userId, slug, 'checkpoint.json'), '{"step":1}');
        const audited = await svc.auditSetup({ userId, project: slug });
        expect(audited.ok).toBe(false);
        expect(audited.findings.some(f => f.code === 'legacy_root_checkpoint')).toBe(true);
        expect(audited.text).toContain('Legacy Lab');
    });

    test('human step choices legalize and completeStep requires a selection', async () => {
        const legal = legalizeHumanActionParams({
            prompt: 'Ship schedule?',
            choices: [{ label: 'Nightly cron' }, { label: 'Manual only' }]
        });
        expect(legal.choices).toHaveLength(2);
        expect(legal.choices[0].id).toBeTruthy();

        const obs = makeService();
        const missions = new ProjectMissionService({ observatory: obs });
        const userId = `choice-${process.pid}`;
        users.push(userId);
        const { slug } = await obs.createProject({ userId, name: 'Choice Lab' });
        const drafted = await missions.create({
            userId, project: slug,
            title: 'Decide schedule',
            objective: 'Pick how we run ingest',
            successCriteria: ['A schedule is chosen'],
            steps: [{
                kind: 'human',
                title: 'Choose schedule',
                actionParams: {
                    prompt: 'How should ingest run?',
                    choices: [{ label: 'Nightly cron' }, { label: 'Manual only' }]
                }
            }]
        });
        const step = drafted.steps[0];
        expect(step.actionParams.choices).toHaveLength(2);

        const db = require('@goobster/core/db');
        await db.run(
            `UPDATE project_missions SET status = 'ACTIVE', approvedAt = datetime('now'),
                 approvedRevision = planRevision WHERE id = @id`,
            { id: drafted.id }
        );
        await db.run(
            `UPDATE project_mission_steps SET status = 'READY' WHERE id = @id`,
            { id: step.id }
        );

        await expect(missions.completeStep({
            userId, project: slug, stepId: step.id
        })).rejects.toMatchObject({ code: 'BAD_CHOICE' });

        const done = await missions.completeStep({
            userId, project: slug, stepId: step.id,
            selectedId: step.actionParams.choices[0].id
        });
        const finished = done.steps.find(s => s.id === step.id);
        expect(finished.status).toBe('DONE');
        expect(finished.actionParams.selectedId).toBe(step.actionParams.choices[0].id);

        const queue = await missions.listNeedsYou({ userId });
        expect(queue.text).toMatch(/Needs you/);
        expect(queue.cards.some(c => c.column === 'answer' && c.stepId === step.id)).toBe(false);
    });

    test('listNeedsYou surfaces DRAFT approve cards and setup findings', async () => {
        const obs = makeService();
        const missions = new ProjectMissionService({ observatory: obs });
        const userId = `board-${process.pid}`;
        users.push(userId);
        const { slug } = await obs.createProject({ userId, name: 'Board Lab' });
        fs.writeFileSync(path.join(PROJECTS_ROOT, userId, slug, 'checkpoint.json'), '{}');
        await missions.create({
            userId, project: slug,
            title: 'Draft mission',
            objective: 'Needs approval',
            successCriteria: ['Approved']
        });
        const queue = await missions.listNeedsYou({ userId });
        expect(queue.cards.some(c => c.column === 'approve' && c.projectSlug === slug)).toBe(true);
        expect(queue.cards.some(c => c.column === 'setup' && c.projectSlug === slug)).toBe(true);
    });
});
