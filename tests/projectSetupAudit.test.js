/**
 * Setup-contract auditor + Needs-you / human-choice mission helpers.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

process.env.GOOBSTER_DB_PATH = path.join(os.tmpdir(), `goobster-setup-audit-${process.pid}.sqlite`);

const {
    auditProjectSetup,
    auditTriggers,
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

    test('flags dangling event filters and malformed output contracts as warnings', () => {
        const audited = auditProjectSetup({
            scripts: [{ slug: 'fetch', source: 'print(1)' }],
            assetIds: [10],
            triggers: [
                {
                    id: 1, name: 'After deleted fetch', kind: 'event', eventTopic: 'job_completed',
                    action: 'run_script', actionAssetId: 10, sourceAssetId: 99, sourceTriggerId: null
                },
                {
                    id: 2, name: 'After deleted cron', kind: 'event', eventTopic: 'job_completed',
                    action: 'render', sourceAssetId: null, sourceTriggerId: 777
                },
                {
                    id: 3, name: 'Escaping contract', kind: 'cron', schedule: '0 1 * * *',
                    action: 'run_script', actionAssetId: 10,
                    actionParams: JSON.stringify({ requiredOutputs: [{ path: '../escape.json' }] })
                },
                {
                    id: 4, name: 'Unknown template', kind: 'cron', schedule: '0 2 * * *',
                    action: 'run_script', actionAssetId: 10,
                    actionParams: { requiredOutputs: ['out/{when}.json'] }
                },
                {
                    id: 5, name: 'Corrupt params', kind: 'cron', schedule: '0 3 * * *',
                    action: 'run_script', actionAssetId: 10, actionParams: '{not json'
                },
                null
            ]
        });
        expect(audited.ok).toBe(false);
        const byCode = {};
        for (const finding of audited.findings) (byCode[finding.code] ||= []).push(finding);
        expect(byCode.trigger_source_asset_missing.map(f => f.triggerId)).toEqual([1]);
        expect(byCode.trigger_source_trigger_missing.map(f => f.triggerId)).toEqual([2]);
        expect(byCode.trigger_output_contract_invalid.map(f => f.triggerId)).toEqual([3, 4]);
        expect(byCode.trigger_output_contract_invalid[0].message).toMatch(/requiredOutputs\[0\]\.path/);
        expect(byCode.trigger_output_contract_invalid[1].message).toMatch(/Unsupported template variable "\{when\}"/);
        expect(byCode.trigger_source_asset_missing[0].message).toMatch(/script asset #99/);
        expect(byCode.trigger_source_trigger_missing[0].message).toMatch(/trigger #777/);
        expect(byCode.trigger_unfiltered_fanout).toBeUndefined();
        expect(formatSetupAuditText(audited)).toMatch(/\[warn\] Trigger "After deleted fetch"/);
    });

    test('an unfiltered job_completed run_script trigger is informational and keeps the audit ok', () => {
        const audited = auditProjectSetup({
            scripts: [{ slug: 'fetch', source: 'print(1)' }],
            assetIds: [10, 11],
            triggers: [
                {
                    id: 1, name: 'Fan-out', kind: 'event', eventTopic: 'job_completed',
                    action: 'run_script', actionAssetId: 11,
                    actionParams: { background: true, requiredOutputs: ['pipeline/manifest_{utc_date}.json'] }
                },
                // Filtered, other topics, or non-script actions are not fan-out.
                {
                    id: 2, name: 'Filtered', kind: 'event', eventTopic: 'job_completed',
                    action: 'run_script', actionAssetId: 11, sourceAssetId: 10
                },
                { id: 3, name: 'On failure', kind: 'event', eventTopic: 'job_failed', action: 'run_script', actionAssetId: 11 },
                { id: 4, name: 'Render all', kind: 'event', eventTopic: 'job_completed', action: 'render' }
            ]
        });
        expect(audited.ok).toBe(true);
        const fanout = audited.findings.filter(f => f.code === 'trigger_unfiltered_fanout');
        expect(fanout).toEqual([expect.objectContaining({ severity: 'info', triggerId: 1 })]);
        expect(fanout[0].message).toMatch(/sourceAsset \/ sourceTrigger/);
        expect(audited.findings.some(f => f.code === 'trigger_output_contract_invalid')).toBe(false);
        expect(audited.findings.some(f => f.code === 'setup_ok')).toBe(false);
    });

    test('auditTriggers tolerates missing inputs', () => {
        expect(auditTriggers([], { assetIds: new Set(), triggerIds: new Set() })).toEqual([]);
        expect(auditProjectSetup({ triggers: 'nope', assetIds: null }).findings.map(f => f.code))
            .toEqual(['no_script_asset']);
        expect(auditProjectSetup({
            scripts: [{ slug: 'ok', source: 'print(1)' }], triggers: [null, undefined, 'junk'], assetIds: null
        })).toEqual({ ok: true, findings: [expect.objectContaining({ code: 'setup_ok' })] });
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

    test('auditSetup surfaces a trigger whose source asset was deleted and a bad stored contract', async () => {
        const svc = makeService();
        const db = require('@goobster/core/db');
        const projectAssetService = require('@goobster/core/services/projectAssetService');
        const userId = `audit-triggers-${process.pid}`;
        users.push(userId);
        const { slug } = await svc.createProject({ userId, name: 'Pipeline Lab' });
        const project = await db.get(
            'SELECT id FROM observatory_projects WHERE userId = @userId AND slug = @slug', { userId, slug }
        );
        const stage = await projectAssetService.save({
            userId, project: slug, name: 'Stage 3', kind: 'script',
            language: 'python', source: 'print("stage 3")', origin: 'portal'
        });
        // Rows written directly: the service refuses these shapes at write
        // time, but an asset deleted later (or an older install) leaves them.
        await db.insert(
            `INSERT INTO project_triggers (projectId, userId, name, kind, eventTopic, action, actionAssetId,
                                           actionParams, sourceAssetId, sourceTriggerId)
             VALUES (@projectId, @userId, 'After fetch', 'event', 'job_completed', 'run_script', @assetId,
                     '{"background":true}', 424242, NULL)`,
            { projectId: project.id, userId, assetId: stage.id }
        );
        await db.insert(
            `INSERT INTO project_triggers (projectId, userId, name, kind, schedule, action, actionAssetId, actionParams)
             VALUES (@projectId, @userId, 'Nightly', 'cron', '0 1 * * *', 'run_script', @assetId,
                     '{"requiredOutputs":[{"path":"/tmp/absolute.json"}]}')`,
            { projectId: project.id, userId, assetId: stage.id }
        );
        await db.insert(
            `INSERT INTO project_triggers (projectId, userId, name, kind, eventTopic, action, actionAssetId,
                                           actionParams, sourceAssetId)
             VALUES (@projectId, @userId, 'Healthy', 'event', 'job_completed', 'run_script', @assetId,
                     '{"requiredOutputs":["pipeline/manifest_{utc_date}.json"]}', @assetId)`,
            { projectId: project.id, userId, assetId: stage.id }
        );

        const audited = await svc.auditSetup({ userId, project: slug });
        expect(audited.ok).toBe(false);
        const codes = audited.findings.map(f => f.code);
        expect(codes).toContain('trigger_source_asset_missing');
        expect(codes).toContain('trigger_output_contract_invalid');
        expect(codes).not.toContain('trigger_source_trigger_missing');
        expect(codes).not.toContain('trigger_unfiltered_fanout');
        expect(audited.findings.filter(f => f.triggerId != null)).toHaveLength(2);
        expect(audited.text).toMatch(/Trigger "After fetch" filters on script asset #424242/);
        expect(audited.text).toMatch(/Trigger "Nightly" declares an invalid output contract/);
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
