/**
 * Phase 7 collaborative projects: actor resolution, owner-only guards,
 * invite lifecycle, member erasure (head repair), actor-charged limits,
 * and the agent_prompt owner-only rule.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

process.env.GOOBSTER_DB_PATH = path.join(os.tmpdir(), `goobster-project-collab-${process.pid}.sqlite`);

const db = require('@goobster/core/db');
const { SandboxService } = require('@goobster/core/services/sandboxService');
const {
    ObservatoryService, PROJECTS_ROOT, DASHBOARDS_ROOT
} = require('@goobster/core/services/observatoryService');
const { ProjectAssetService } = require('@goobster/core/services/projectAssetService');
const { ProjectTriggerService } = require('@goobster/core/services/projectTriggerService');
const privacyService = require('@goobster/core/services/privacyService');

const SANDBOX_ROOT = path.join(os.tmpdir(), `goobster-collab-sandbox-${process.pid}`);
const TEST_USERS = [];

const OWNER = '500000000000000001';
const MEMBER = '500000000000000002';
const STRANGER = '500000000000000003';
const OTHER_OWNER = '500000000000000004';
const THIRD_OWNER = '500000000000000005';

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
        maxMembersPerProject: 5,
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

async function expectCode(fn, code) {
    let caught = null;
    try { await fn(); } catch (error) { caught = error; }
    expect(caught).not.toBeNull();
    expect(caught.code).toBe(code);
    return caught;
}

function fakeGateway({ invitee = MEMBER, name = 'Frieda', bot = false, failSend = false } = {}) {
    const sendDm = jest.fn(async () => {
        if (failSend) return { ok: false, error: 'closed' };
        return { ok: true, channelId: 'dm-1', messageId: 'm-1' };
    });
    return {
        isGoobsterGateway: true,
        getUser: jest.fn(async (id) => {
            if (id !== invitee) return null;
            return { id: invitee, username: name.toLowerCase(), globalName: name, bot };
        }),
        sendDm
    };
}

async function acceptInvite(svc, { ownerId = OWNER, project = 'lab', inviteeId = MEMBER, inviteeName = 'Frieda' } = {}) {
    const gateway = fakeGateway({ invitee: inviteeId, name: inviteeName });
    const { invite } = await svc.invite({
        gateway, userId: ownerId, ownerName: 'Rob', project, inviteeId
    });
    return await svc.respondInvite({
        userId: inviteeId, userName: inviteeName, inviteId: invite.id, accept: true
    });
}

beforeEach(async () => {
    for (const table of [
        'project_invites', 'project_members', 'project_triggers',
        'project_asset_versions', 'project_assets',
        'observatory_jobs', 'observatory_share_links', 'observatory_projects'
    ]) {
        await db.run(`DELETE FROM ${table}`);
    }
});

afterAll(async () => {
    await db.closeConnection();
    for (const userId of [...TEST_USERS, OWNER, MEMBER, STRANGER, OTHER_OWNER, THIRD_OWNER]) {
        try { fs.rmSync(path.join(PROJECTS_ROOT, userId), { recursive: true, force: true }); } catch { /* gone */ }
        try { fs.rmSync(path.join(DASHBOARDS_ROOT, userId), { recursive: true, force: true }); } catch { /* gone */ }
    }
    try { fs.rmSync(SANDBOX_ROOT, { recursive: true, force: true }); } catch { /* gone */ }
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(process.env.GOOBSTER_DB_PATH + suffix); } catch { /* already gone */ }
    }
});

describe('actor resolution', () => {
    test('owner, member, and stranger resolve as specified; own-first beats a shared slug', async () => {
        const svc = makeService();
        await svc.createProject({ userId: OWNER, name: 'Lab' });
        await svc.createProject({ userId: OTHER_OWNER, name: 'Lab' });
        await acceptInvite(svc, { project: 'lab', inviteeId: MEMBER });

        const asOwner = await svc.resolveProjectForActor({ userId: OWNER, project: 'lab' });
        expect(asOwner.role).toBe('owner');
        expect(asOwner.ownerId).toBe(OWNER);

        const asMember = await svc.resolveProjectForActor({ userId: MEMBER, project: 'lab' });
        expect(asMember.role).toBe('collaborator');
        expect(asMember.ownerId).toBe(OWNER);

        await expectCode(
            () => svc.resolveProjectForActor({ userId: STRANGER, project: 'lab' }),
            'NO_SUCH_PROJECT'
        );

        await acceptInvite(svc, {
            ownerId: OTHER_OWNER, project: 'lab', inviteeId: OWNER, inviteeName: 'Rob'
        });
        const ownFirst = await svc.resolveProjectForActor({ userId: OWNER, project: 'lab' });
        expect(ownFirst.ownerId).toBe(OWNER);
        expect(ownFirst.role).toBe('owner');

        const qualified = await svc.resolveProjectForActor({
            userId: OWNER, project: 'lab', owner: OTHER_OWNER
        });
        expect(qualified.ownerId).toBe(OTHER_OWNER);
        expect(qualified.role).toBe('collaborator');
    });

    test('two memberships with the same slug are ambiguous without owner', async () => {
        const svc = makeService();
        await svc.createProject({ userId: OWNER, name: 'Lab' });
        await svc.createProject({ userId: OTHER_OWNER, name: 'Lab' });
        await acceptInvite(svc, { project: 'lab', inviteeId: MEMBER });
        await acceptInvite(svc, {
            ownerId: OTHER_OWNER, project: 'lab', inviteeId: MEMBER, inviteeName: 'Frieda'
        });

        await expectCode(
            () => svc.resolveProjectForActor({ userId: MEMBER, project: 'lab' }),
            'AMBIGUOUS_PROJECT'
        );
        const picked = await svc.resolveProjectForActor({
            userId: MEMBER, project: 'lab', owner: OTHER_OWNER
        });
        expect(picked.ownerId).toBe(OTHER_OWNER);

        await expectCode(
            () => svc.resolveProjectForActor({
                userId: MEMBER, project: 'lab', owner: STRANGER
            }),
            'NO_SUCH_PROJECT'
        );
    });

    test('listProjects includes owned and collaborated rows with ownerId and role', async () => {
        const svc = makeService();
        await svc.createProject({ userId: OWNER, name: 'Mine' });
        await svc.createProject({ userId: OTHER_OWNER, name: 'Theirs' });
        await acceptInvite(svc, {
            ownerId: OTHER_OWNER, project: 'theirs', inviteeId: OWNER, inviteeName: 'Rob'
        });
        const listed = await svc.listProjects(OWNER);
        expect(listed).toEqual(expect.arrayContaining([
            expect.objectContaining({ slug: 'mine', ownerId: OWNER, role: 'owner' }),
            expect.objectContaining({ slug: 'theirs', ownerId: OTHER_OWNER, role: 'collaborator' })
        ]));
    });
});

describe('owner-only reserved actions', () => {
    test('delete, invite, revoke, remove others, and share mint/revoke refuse a member', async () => {
        const svc = makeService();
        await svc.createProject({ userId: OWNER, name: 'Lab' });
        await acceptInvite(svc, { project: 'lab' });

        await expectCode(
            () => svc.deleteProject({ userId: MEMBER, project: 'lab' }),
            'NOT_OWNER'
        );
        await expectCode(
            () => svc.invite({ userId: MEMBER, project: 'lab', inviteeId: STRANGER }),
            'NOT_OWNER'
        );
        await expectCode(
            () => svc.createShareLink({ userId: MEMBER, project: 'lab' }),
            'NOT_OWNER'
        );

        const { invite } = await svc.invite({
            userId: OWNER, project: 'lab', inviteeId: STRANGER
        });
        await expectCode(
            () => svc.revokeInvite({ userId: MEMBER, inviteId: invite.id }),
            'NO_SUCH_INVITE'
        );
        await expectCode(
            () => svc.removeMember({ userId: MEMBER, project: 'lab', memberId: STRANGER }),
            'NOT_OWNER'
        );

        await svc.createShareLink({ userId: OWNER, project: 'lab' });
        await expectCode(
            () => svc.revokeShareLink({ userId: MEMBER, project: 'lab' }),
            'NOT_OWNER'
        );

        const left = await svc.removeMember({ userId: MEMBER, project: 'lab', memberId: MEMBER });
        expect(left.left).toBe(true);
    });
});

describe('invite lifecycle', () => {
    test('pending invite DMs accept/decline buttons; accept, decline, and revoke settle it', async () => {
        const svc = makeService();
        await svc.createProject({ userId: OWNER, name: 'Lab' });
        const gateway = fakeGateway();
        const { invite, dmSent, inviteeName } = await svc.invite({
            gateway, userId: OWNER, ownerName: 'Rob', project: 'lab', inviteeId: MEMBER
        });
        expect(dmSent).toBe(true);
        expect(inviteeName).toBe('Frieda');
        expect(invite.status).toBe('pending');
        expect(gateway.sendDm).toHaveBeenCalled();
        const payload = gateway.sendDm.mock.calls[0][1];
        const customIds = payload.components[0].components.map(b => b.toJSON().custom_id || b.data.custom_id);
        expect(customIds).toEqual([
            `accept_projectinvite_${invite.id}`,
            `decline_projectinvite_${invite.id}`
        ]);

        const pending = await svc.listInvites(MEMBER);
        expect(pending).toHaveLength(1);
        expect(pending[0].slug).toBe('lab');

        const accepted = await svc.respondInvite({
            userId: MEMBER, userName: 'Frieda', inviteId: invite.id, accept: true
        });
        expect(accepted.status).toBe('accepted');
        const roster = await svc.listMembers({ userId: OWNER, project: 'lab' });
        expect(roster.members.map(m => m.userId)).toContain(MEMBER);

        const second = await svc.invite({
            userId: OWNER, project: 'lab', inviteeId: STRANGER
        });
        await svc.respondInvite({
            userId: STRANGER, inviteId: second.invite.id, accept: false
        });
        expect((await svc.listInvites(STRANGER))).toHaveLength(0);

        const third = await svc.invite({
            userId: OWNER, project: 'lab', inviteeId: OTHER_OWNER
        });
        await svc.revokeInvite({ userId: OWNER, inviteId: third.invite.id });
        await expectCode(
            () => svc.respondInvite({
                userId: OTHER_OWNER, inviteId: third.invite.id, accept: true
            }),
            'INVITE_SETTLED'
        );
    });

    test('member cap counts accepted collaborators plus pending invites', async () => {
        const svc = makeService({ observatory: { maxMembersPerProject: 1 } });
        await svc.createProject({ userId: OWNER, name: 'Lab' });
        const { invite } = await svc.invite({ userId: OWNER, project: 'lab', inviteeId: MEMBER });
        await expectCode(
            () => svc.invite({ userId: OWNER, project: 'lab', inviteeId: STRANGER }),
            'PROJECT_FULL'
        );
        await svc.respondInvite({
            userId: MEMBER, userName: 'Frieda', inviteId: invite.id, accept: true
        });
        await expectCode(
            () => svc.invite({ userId: OWNER, project: 'lab', inviteeId: STRANGER }),
            'PROJECT_FULL'
        );
    });

    test('maxProjectsPerUser counts owned projects only', async () => {
        const svc = makeService({ observatory: { maxProjectsPerUser: 1 } });
        await svc.createProject({ userId: MEMBER, name: 'Mine' });
        await svc.createProject({ userId: OWNER, name: 'Lab' });
        await acceptInvite(svc, { project: 'lab' });
        await expectCode(
            () => svc.createProject({ userId: MEMBER, name: 'Another' }),
            'TOO_MANY_PROJECTS'
        );
        const listed = await svc.listProjects(MEMBER);
        expect(listed.filter(p => p.role === 'owner')).toHaveLength(1);
        expect(listed.filter(p => p.role === 'collaborator')).toHaveLength(1);
    });
});

describe('member erasure', () => {
    test('repairs asset heads, drops empty assets and authored jobs, leaves workspace files', async () => {
        const svc = makeService();
        const assets = new ProjectAssetService();
        await svc.createProject({ userId: OWNER, name: 'Lab' });
        await acceptInvite(svc, { project: 'lab' });

        await assets.save({
            userId: OWNER, project: 'lab', name: 'Notes',
            kind: 'note', language: 'markdown', source: 'v1 owner'
        });
        await assets.save({
            userId: MEMBER, project: 'lab', name: 'Notes',
            kind: 'note', language: 'markdown', source: 'v2 member'
        });
        await assets.save({
            userId: MEMBER, project: 'lab', name: 'OnlyMine',
            kind: 'note', language: 'markdown', source: 'member only'
        });

        const row = await svc.resolveProjectForActor({ userId: OWNER, project: 'lab' });
        await db.run(
            `INSERT INTO observatory_jobs (projectId, userId, language, code, status)
             VALUES (@projectId, @userId, 'python', 'print(1)', 'COMPLETED')`,
            { projectId: row.id, userId: MEMBER }
        );
        fs.writeFileSync(path.join(row.dir, 'keep.txt'), 'workspace stays');

        const assetGone = await assets.forgetUser(MEMBER);
        expect(assetGone.versions).toBe(2);
        const head = await assets.get({ userId: OWNER, project: 'lab', asset: 'notes' });
        expect(head.source).toBe('v1 owner');
        expect(head.version).toBe(1);
        await expectCode(
            () => assets.get({ userId: OWNER, project: 'lab', asset: 'onlymine' }),
            'NO_SUCH_ASSET'
        );

        const forgotten = await svc.forgetUser(MEMBER);
        expect(forgotten.memberships).toBe(1);
        expect(forgotten.jobs).toBe(1);
        expect(fs.existsSync(path.join(row.dir, 'keep.txt'))).toBe(true);
        await expectCode(
            () => svc.resolveProjectForActor({ userId: MEMBER, project: 'lab' }),
            'NO_SUCH_PROJECT'
        );
    });

    test('owner forget-me deletes the project and lists members to notify', async () => {
        const svc = makeService();
        await svc.createProject({ userId: OWNER, name: 'Lab' });
        await acceptInvite(svc, { project: 'lab' });
        const forgotten = await svc.forgetUser(OWNER);
        expect(forgotten.projects).toBe(1);
        expect(forgotten.notifyMembers).toEqual([
            expect.objectContaining({ slug: 'lab', memberIds: [MEMBER] })
        ]);
        const report = await privacyService.buildUserReport({ userId: MEMBER });
        expect(report.observatory.collaboratedProjects).toBe(0);
    });
});

describe('actor-charged limits and agent_prompt', () => {
    test('active-job cap charges the actor, not the owner', async () => {
        const svc = makeService({ observatory: { maxActiveJobsPerUser: 1 } });
        await svc.createProject({ userId: OWNER, name: 'Lab' });
        await acceptInvite(svc, { project: 'lab' });

        const memberJob = await svc.run({
            userId: MEMBER,
            project: 'lab',
            language: 'python',
            code: 'import time; time.sleep(20)',
            background: true
        });
        expect(memberJob.mode).toBe('background');
        await expectCode(
            () => svc.run({
                userId: MEMBER,
                project: 'lab',
                language: 'python',
                code: 'print(2)',
                background: true
            }),
            'TOO_MANY_JOBS'
        );
        const ownerJob = await svc.run({
            userId: OWNER,
            project: 'lab',
            language: 'python',
            code: 'import time; time.sleep(20)',
            background: true
        });
        expect(ownerJob.mode).toBe('background');
        await svc.cancel({ userId: MEMBER, jobId: memberJob.jobId });
        await svc.cancel({ userId: OWNER, jobId: ownerJob.jobId });
        await new Promise(resolve => setTimeout(resolve, 300));
    });

    test('agent_prompt create/edit is owner-only; deterministic actions stay member-editable', async () => {
        const svc = makeService();
        const triggers = new ProjectTriggerService();
        const assets = new ProjectAssetService();
        await svc.createProject({ userId: OWNER, name: 'Lab' });
        await acceptInvite(svc, { project: 'lab' });
        await assets.save({
            userId: MEMBER, project: 'lab', name: 'ingest',
            kind: 'script', language: 'python', source: 'print("ok")'
        });

        await expectCode(
            () => triggers.create({
                userId: MEMBER, project: 'lab', name: 'Prompt',
                kind: 'event', eventTopic: 'job_settled',
                action: 'agent_prompt', actionParams: { prompt: 'do the thing' }
            }),
            'OWNER_ONLY'
        );

        const owned = await triggers.create({
            userId: OWNER, project: 'lab', name: 'Prompt',
            kind: 'event', eventTopic: 'job_settled',
            action: 'agent_prompt', actionParams: { prompt: 'owner prompt' }
        });
        expect(owned.createdBy).toBe(OWNER);
        await expectCode(
            () => triggers.update({
                userId: MEMBER, project: 'lab', trigger: owned.id,
                actionParams: { prompt: 'hijack' }
            }),
            'OWNER_ONLY'
        );

        const script = await triggers.create({
            userId: MEMBER, project: 'lab', name: 'Nightly',
            kind: 'cron', schedule: '0 2 * * *',
            action: 'run_script', actionAsset: 'ingest'
        });
        expect(script.createdBy).toBe(MEMBER);
        const updated = await triggers.update({
            userId: MEMBER, project: 'lab', trigger: script.id,
            isEnabled: false
        });
        expect(updated.isEnabled).toBe(false);
    });
});

describe('privacy report', () => {
    test('audit and what-do-you-know counts memberships, invites, and owned vs collaborated', async () => {
        const svc = makeService();
        await svc.createProject({ userId: OWNER, name: 'Mine' });
        await svc.createProject({ userId: OTHER_OWNER, name: 'Theirs' });
        await svc.invite({ userId: OTHER_OWNER, project: 'theirs', inviteeId: OWNER });
        await svc.createProject({ userId: THIRD_OWNER, name: 'Also' });
        await acceptInvite(svc, {
            ownerId: THIRD_OWNER, project: 'also', inviteeId: OWNER, inviteeName: 'Rob'
        });

        const report = await privacyService.buildUserReport({ userId: OWNER });
        expect(report.observatory.projects).toBe(1);
        expect(report.observatory.collaboratedProjects).toBe(1);
        expect(report.observatory.pendingInvites).toBe(1);

        const audit = await privacyService.auditUser({ userId: OWNER });
        expect(audit.byTable.project_members).toBe(1);
        // Accepted + pending rows addressed to the user both count.
        expect(audit.byTable.project_invites).toBe(2);
    });
});
