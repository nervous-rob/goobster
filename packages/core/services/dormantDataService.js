/**
 * Erasure and counting for per-user data that belongs to an optional
 * feature (documentation/packaging.md, "Dormant data").
 *
 * A reduced payload may ship without the projects, expeditions or sandbox
 * modules while their tables still hold rows written when the feature was
 * installed. /forget-me, the post-erasure audit and the account export must
 * reach those rows anyway, so the SQL and the on-disk workspace roots live
 * here, in core, and the feature services delegate to it. Nothing in this
 * module may require a feature module; runtime state a feature holds in
 * memory (live jobs) is handed in by the caller when the feature is loaded.
 */

const fs = require('node:fs');
const path = require('node:path');
const db = require('../db');
const { dataDir } = require('../runtimePaths');
const { dmScopeId } = require('../utils/dmScope');

const PROJECTS_ROOT = path.join(dataDir, 'sandbox', 'projects');
/**
 * Dashboards live OUTSIDE the workspace on purpose: the workspace is
 * bind-mounted writable into snippet runs, and a served dashboard is
 * trusted HTML - a snippet must never be able to author it.
 */
const DASHBOARDS_ROOT = path.join(dataDir, 'sandbox', 'dashboards');
const USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** /forget-me: every trigger belonging to the user (deliveries cascade; made explicit). */
async function forgetProjectTriggers(userId) {
    await db.run(
        `DELETE FROM project_trigger_deliveries
         WHERE triggerId IN (SELECT id FROM project_triggers WHERE userId = @userId)`,
        { userId }
    );
    const triggers = (await db.run(
        'DELETE FROM project_triggers WHERE userId = @userId',
        { userId }
    )).changes;
    return { triggers };
}

/**
 * /forget-me: authored versions (repair each asset's head to the latest
 * surviving version; delete an asset left with zero versions) plus any
 * leftover owned asset rows.
 */
async function forgetProjectAssets(userId) {
    const affected = await db.all(
        `SELECT DISTINCT assetId FROM project_asset_versions WHERE userId = @userId`,
        { userId }
    );
    const versions = (await db.run(
        'DELETE FROM project_asset_versions WHERE userId = @userId',
        { userId }
    )).changes;
    let emptied = 0;
    for (const { assetId } of affected) {
        const asset = await db.get(
            'SELECT id, currentVersionId FROM project_assets WHERE id = @id',
            { id: assetId }
        );
        if (!asset) continue;
        const headStill = asset.currentVersionId
            ? await db.get(
                'SELECT id FROM project_asset_versions WHERE id = @id',
                { id: asset.currentVersionId }
            )
            : null;
        if (headStill) continue;
        const latest = await db.get(
            `SELECT id FROM project_asset_versions
             WHERE assetId = @assetId
             ORDER BY version DESC, id DESC LIMIT 1`,
            { assetId }
        );
        if (latest) {
            await db.run(
                `UPDATE project_assets
                 SET currentVersionId = @versionId, revision = revision + 1, updatedAt = datetime('now')
                 WHERE id = @id`,
                { versionId: latest.id, id: assetId }
            );
        } else {
            await db.run('DELETE FROM project_assets WHERE id = @id', { id: assetId });
            emptied += 1;
        }
    }
    const leftover = (await db.run(
        'DELETE FROM project_assets WHERE userId = @userId',
        { userId }
    )).changes;
    return { assets: leftover + emptied, versions };
}

async function forgetProjectMissions(userId) {
    if (!userId) return { missions: 0, decisions: 0 };
    const decisions = (await db.run(
        'DELETE FROM project_decisions WHERE userId = @userId', { userId }
    )).changes;
    const missions = (await db.run(
        'DELETE FROM project_missions WHERE userId = @userId', { userId }
    )).changes;
    // What the person's delegated assistant left on plans they do not own
    // (ADR 0019): the evidence links of its runs go with the runs, and the
    // steps it carried out lose the link to the person, the run and the
    // grant. A step it still held goes back to READY.
    const delegatedEvidence = (await db.run(
        "DELETE FROM project_mission_evidence WHERE userId = @userId AND kind = 'agent_run'", { userId }
    )).changes;
    const delegatedSteps = (await db.run(
        `UPDATE project_mission_steps
         SET status = CASE WHEN status IN ('STARTING', 'RUNNING') THEN 'READY' ELSE status END,
             startedAt = CASE WHEN status IN ('STARTING', 'RUNNING') THEN NULL ELSE startedAt END,
             authorizationKind = CASE WHEN status IN ('STARTING', 'RUNNING') THEN NULL ELSE authorizationKind END,
             executionAttemptId = NULL, startedByUserId = NULL, agentRunId = NULL,
             grantResponsibilityId = NULL, grantRevision = NULL, updatedAt = datetime('now')
         WHERE authorizationKind = 'delegated' AND startedByUserId = @userId`,
        { userId }
    )).changes;
    return { missions, decisions, delegatedSteps, delegatedEvidence };
}

/**
 * The person's research briefs go (they also cascade with the
 * expeditions); briefs someone else owns that this person paid for keep
 * the row with the payer nulled, the same rule as resource_events.
 * @param {Object} [handle] - transaction handle when called inside one
 */
async function forgetExpeditionBriefs(userId, handle = db) {
    const deleted = (await handle.run('DELETE FROM expedition_briefs WHERE userId = @userId', { userId: String(userId) })).changes;
    const anonymized = (await handle.run(
        'UPDATE expedition_briefs SET payer = NULL WHERE payer = @userId', { userId: String(userId) }
    )).changes;
    return { deleted, anonymized };
}

/**
 * Installed sandbox packages stay (they are host state every user shares),
 * but the requester/approver attribution goes.
 * @returns {Promise<number>} rows anonymized
 */
async function anonymizeSandboxPackages(userId) {
    return (await db.run(
        `UPDATE sandbox_packages SET
             requestedBy = CASE WHEN requestedBy = @userId THEN NULL ELSE requestedBy END,
             approvedBy = CASE WHEN approvedBy = @userId THEN NULL ELSE approvedBy END
         WHERE requestedBy = @userId OR approvedBy = @userId`,
        { userId }
    )).changes;
}

/** /forget-me: the user's sandbox request rows go; package attribution is nulled. */
async function forgetSandboxRequests(userId) {
    const requests = (await db.run('DELETE FROM sandbox_requests WHERE userId = @userId', { userId })).changes;
    const packagesAnonymized = await anonymizeSandboxPackages(userId);
    return { requests, packagesAnonymized };
}

function projectKnowledgeScope(projectId, ownerId) {
    const knowledgeGraphService = require('./knowledgeGraphService');
    return { guildId: dmScopeId(ownerId), scopeKey: knowledgeGraphService.projectScopeKey(projectId) };
}

/**
 * Erase a user's project footprint. The owner path deletes whole projects
 * (CASCADE members/invites) and returns a notify list so the caller can
 * tell collaborators after commit. The member path drops memberships,
 * invites addressed to them, and authored jobs. Asset-version repair is
 * forgetProjectAssets.
 * @param {string} userId
 * @param {Object} [options]
 * @param {(jobId: number) => void} [options.abortJob] - stops a live job
 *   the loaded projects module is running; absent when it is not loaded
 */
async function forgetProjects(userId, { abortJob = null } = {}) {
    const owned = await db.all(
        'SELECT id, name, slug FROM observatory_projects WHERE userId = @userId',
        { userId }
    );
    const notifyMembers = [];
    const knowledgeGraphService = require('./knowledgeGraphService');
    for (const project of owned) {
        const members = await db.all(
            'SELECT userId FROM project_members WHERE projectId = @id',
            { id: project.id }
        );
        if (members.length) {
            notifyMembers.push({
                name: project.name,
                slug: project.slug,
                memberIds: members.map(m => m.userId)
            });
        }
        await knowledgeGraphService.deleteScope(projectKnowledgeScope(project.id, userId));
    }

    if (abortJob) {
        const running = await db.all(
            `SELECT id FROM observatory_jobs
             WHERE status = 'RUNNING' AND (
                 userId = @userId
                 OR projectId IN (SELECT id FROM observatory_projects WHERE userId = @userId)
             )`,
            { userId }
        );
        for (const row of running) abortJob(row.id);
    }

    // What was shared with a project the person owned goes with the project.
    const ownedProjects = 'SELECT id FROM observatory_projects WHERE userId = @userId';
    await db.run(
        `DELETE FROM assistant_update_receipts WHERE updateId IN
            (SELECT id FROM assistant_updates WHERE audienceKind = 'project' AND projectId IN (${ownedProjects}))`,
        { userId }
    );
    await db.run(
        `DELETE FROM assistant_updates WHERE audienceKind = 'project' AND projectId IN (${ownedProjects})`, { userId }
    );
    const memberships = (await db.run(
        'DELETE FROM project_members WHERE userId = @userId', { userId }
    )).changes;
    // Clones they made in someone else's project are project data; the
    // attribution goes (ADR 0015).
    await db.run('UPDATE project_repos SET createdBy = NULL WHERE createdBy = @userId', { userId });
    const invites = (await db.run(
        'DELETE FROM project_invites WHERE inviteeId = @userId', { userId }
    )).changes;
    const shareLinks = (await db.run(
        'DELETE FROM observatory_share_links WHERE userId = @userId', { userId }
    )).changes;
    const jobs = (await db.run(
        'DELETE FROM observatory_jobs WHERE userId = @userId', { userId }
    )).changes;
    const projects = (await db.run(
        'DELETE FROM observatory_projects WHERE userId = @userId', { userId }
    )).changes;
    if (USER_ID_PATTERN.test(String(userId || ''))) {
        try {
            fs.rmSync(path.join(PROJECTS_ROOT, String(userId)), { recursive: true, force: true });
        } catch { /* best effort */ }
        try {
            fs.rmSync(path.join(DASHBOARDS_ROOT, String(userId)), { recursive: true, force: true });
        } catch { /* best effort */ }
    }
    return { projects, jobs, shareLinks, memberships, invites, notifyMembers };
}

/**
 * Tell collaborators that an owned project they sat on is gone. Goes
 * through the Inbox (the Discord DM is an echo when a gateway is given);
 * a closed DM is not an error.
 */
async function notifyProjectsGone(notices, gateway = null, client = null) {
    const resolved = require('../gateway').toGateway(gateway || client);
    if (!Array.isArray(notices) || notices.length === 0) return;
    const inboxService = require('./inboxService');
    for (const notice of notices) {
        const line = `🔭 The project "${notice.name || notice.slug}" has been deleted by its owner.`;
        for (const memberId of notice.memberIds || []) {
            try {
                await inboxService.deliver({
                    userId: memberId,
                    kind: 'project',
                    title: `Project "${notice.name || notice.slug}" was deleted`,
                    body: line,
                    source: { type: 'project', id: notice.slug || notice.name },
                    link: '/projects',
                    discord: resolved ? { gateway: resolved, payload: { content: line } } : false
                });
            } catch { /* a notice is best effort */ }
        }
    }
}

/** Workspace and dashboard directories still on disk for the user (0, 1 or 2). */
function countWorkspaceDirs(userId) {
    let workspaceDirs = 0;
    if (USER_ID_PATTERN.test(String(userId || ''))) {
        for (const root of [PROJECTS_ROOT, DASHBOARDS_ROOT]) {
            try {
                if (fs.existsSync(path.join(root, String(userId)))) workspaceDirs++;
            } catch { /* unreadable = uncounted */ }
        }
    }
    return workspaceDirs;
}

/**
 * Post-erasure audit counts (privacyService.auditUser).
 * @param {string} userId
 */
async function countProjects(userId) {
    const projects = (await db.get(
        'SELECT COUNT(*) AS c FROM observatory_projects WHERE userId = @userId', { userId }
    )).c;
    const jobs = (await db.get(
        'SELECT COUNT(*) AS c FROM observatory_jobs WHERE userId = @userId', { userId }
    )).c;
    const shareLinks = (await db.get(
        'SELECT COUNT(*) AS c FROM observatory_share_links WHERE userId = @userId', { userId }
    )).c;
    const memberships = (await db.get(
        'SELECT COUNT(*) AS c FROM project_members WHERE userId = @userId', { userId }
    )).c;
    const invites = (await db.get(
        'SELECT COUNT(*) AS c FROM project_invites WHERE inviteeId = @userId', { userId }
    )).c;
    const projectNodes = (await db.get(
        `SELECT COUNT(*) AS c FROM kg_nodes
         WHERE guildId = @dmScope AND scopeKey LIKE 'PROJECT:%'`,
        { dmScope: dmScopeId(userId) }
    )).c;
    const repoAttributions = (await db.get(
        'SELECT COUNT(*) AS c FROM project_repos WHERE createdBy = @userId', { userId }
    )).c;
    return { projects, jobs, shareLinks, memberships, invites, workspaceDirs: countWorkspaceDirs(userId), projectNodes, repoAttributions };
}

const RESPONSIBILITY_PRINCIPALS = ['authorizedBy', 'actingUserId', 'payerUserId'];
const RESPONSIBILITY_INVOLVES = `(authorizedBy = @userId OR actingUserId = @userId OR payerUserId = @userId)`;

/**
 * /forget-me for delegated responsibilities (ADR 0016). The person's own
 * grants go with their revision history. On someone else's grant the
 * person's principal fields are nulled (in the row and in every stored
 * snapshot) and a grant that could still run is revoked, because the
 * authority it named is gone.
 * @returns {Promise<{ responsibilities: number, revisions: number, anonymized: number }>}
 */
async function forgetAssistantResponsibilities(userId) {
    const owned = 'responsibilityId IN (SELECT id FROM assistant_responsibilities WHERE ownerUserId = @userId)';
    // A project's shared update stays with the project; it loses the person
    // and its links to their records, which are deleted next.
    await db.run(
        `UPDATE assistant_updates SET
            producerUserId = CASE WHEN producerUserId = @userId THEN NULL ELSE producerUserId END,
            responsibilityId = CASE WHEN responsibilityId IN (SELECT id FROM assistant_responsibilities WHERE ownerUserId = @userId)
                THEN NULL ELSE responsibilityId END,
            initiativeId = CASE WHEN initiativeId IN (SELECT id FROM assistant_initiatives WHERE ownerUserId = @userId)
                THEN NULL ELSE initiativeId END
         WHERE producerUserId = @userId
            OR responsibilityId IN (SELECT id FROM assistant_responsibilities WHERE ownerUserId = @userId)
            OR initiativeId IN (SELECT id FROM assistant_initiatives WHERE ownerUserId = @userId)`,
        { userId }
    );
    // Run journals hold retrieved text: they go before the initiatives they
    // belong to (explicitly, not only through the cascade).
    const runsOwned = `ownerUserId = @userId OR initiativeId IN (SELECT id FROM assistant_initiatives WHERE ownerUserId = @userId OR ${owned})`;
    const runOperations = (await db.run(
        `DELETE FROM assistant_run_operations WHERE ownerUserId = @userId OR runId IN (SELECT id FROM assistant_runs WHERE ${runsOwned})`,
        { userId }
    )).changes;
    const runs = (await db.run(`DELETE FROM assistant_runs WHERE ${runsOwned}`, { userId })).changes;
    // Proposed and applied note changes hold the person's note text (before and after).
    const knowledgeChanges = (await db.run('DELETE FROM kg_change_sets WHERE userId = @userId', { userId })).changes;
    const cursors = (await db.run(`DELETE FROM assistant_source_cursors WHERE ${owned}`, { userId })).changes;
    const proposalCounters = (await db.run(
        `DELETE FROM assistant_proposal_counters WHERE ownerUserId = @userId OR ${owned}`, { userId }
    )).changes;
    const messageLabels = (await db.run(
        `DELETE FROM assistant_message_labels WHERE ownerUserId = @userId OR ${owned}`, { userId }
    )).changes;
    // What they said about findings and proposals, and what was learned from it (codes and numbers).
    const feedback = (await db.run(
        `DELETE FROM assistant_feedback WHERE userId = @userId OR ${owned}`, { userId }
    )).changes;
    const sourceWeights = (await db.run(
        `DELETE FROM assistant_source_weights WHERE ownerUserId = @userId OR ${owned}`, { userId }
    )).changes;
    const initiatives = (await db.run(
        `DELETE FROM assistant_initiatives WHERE ownerUserId = @userId OR ${owned}`, { userId }
    )).changes;
    const personal = "audienceKind = 'user' AND audienceUserId = @userId";
    const receipts = (await db.run(
        `DELETE FROM assistant_update_receipts
         WHERE userId = @userId OR updateId IN (SELECT id FROM assistant_updates WHERE ${personal})`,
        { userId }
    )).changes;
    const updates = (await db.run(`DELETE FROM assistant_updates WHERE ${personal}`, { userId })).changes;
    // The digests sent to them (ids only; the Inbox items go with the Inbox).
    const digests = (await db.run('DELETE FROM assistant_digests WHERE userId = @userId', { userId })).changes;
    const processContracts = (await db.run('DELETE FROM assistant_process_contracts WHERE ownerUserId = @userId', { userId })).changes;
    const processObservations = (await db.run('DELETE FROM assistant_process_observations WHERE ownerUserId = @userId', { userId })).changes;
    const incidentMembers = (await db.run('DELETE FROM assistant_process_incident_members WHERE ownerUserId = @userId', { userId })).changes;
    const incidents = (await db.run('DELETE FROM assistant_process_incidents WHERE ownerUserId = @userId', { userId })).changes;
    const processLifecycle = (await db.run('DELETE FROM assistant_process_lifecycle WHERE ownerUserId = @userId', { userId })).changes;
    const processCleanups = (await db.run('DELETE FROM assistant_process_cleanups WHERE ownerUserId = @userId', { userId })).changes;

    const revisions = (await db.run(
        `DELETE FROM assistant_responsibility_revisions
         WHERE responsibilityId IN (SELECT id FROM assistant_responsibilities WHERE ownerUserId = @userId)`,
        { userId }
    )).changes;
    const responsibilities = (await db.run(
        'DELETE FROM assistant_responsibilities WHERE ownerUserId = @userId', { userId }
    )).changes;

    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const others = await db.all(
        `SELECT id, status FROM assistant_responsibilities WHERE ${RESPONSIBILITY_INVOLVES}`, { userId }
    );
    for (const row of others) {
        const revoke = ['DRAFT', 'ACTIVE', 'PAUSED', 'NEEDS_REVIEW'].includes(row.status);
        await db.run(
            `UPDATE assistant_responsibilities SET
                authorizedBy = CASE WHEN authorizedBy = @userId THEN NULL ELSE authorizedBy END,
                actingUserId = CASE WHEN actingUserId = @userId THEN NULL ELSE actingUserId END,
                payerUserId = CASE WHEN payerUserId = @userId THEN NULL ELSE payerUserId END,
                ${revoke ? "status = 'REVOKED', endedAt = @now," : ''}
                revision = revision + 1, authorityRevision = revision + 1, updatedAt = @now
             WHERE id = @id`,
            { id: row.id, userId, now }
        );
        await db.run(
            `UPDATE assistant_runs SET
                actingUserId = CASE WHEN actingUserId = @userId THEN NULL ELSE actingUserId END,
                payerUserId = CASE WHEN payerUserId = @userId THEN NULL ELSE payerUserId END
             WHERE responsibilityId = @id AND (actingUserId = @userId OR payerUserId = @userId)`,
            { id: row.id, userId }
        );
        // The origin of a conversation request names its speaker, the acting person.
        await db.run(
            `UPDATE assistant_initiatives SET
                actingUserId = CASE WHEN actingUserId = @userId THEN NULL ELSE actingUserId END,
                originJson = CASE WHEN actingUserId = @userId THEN NULL ELSE originJson END,
                status = CASE WHEN status IN ('CANDIDATE', 'QUEUED', 'RUNNING', 'WAITING', 'REVIEW') THEN 'CANCELLED' ELSE status END,
                stopCode = CASE WHEN status IN ('CANDIDATE', 'QUEUED', 'RUNNING', 'WAITING', 'REVIEW') THEN 'PRINCIPAL_ERASED' ELSE stopCode END,
                endedAt = CASE WHEN status IN ('CANDIDATE', 'QUEUED', 'RUNNING', 'WAITING', 'REVIEW') THEN @now ELSE endedAt END,
                leaseToken = NULL, leaseExpiresAt = NULL, revision = revision + 1, updatedAt = @now
             WHERE responsibilityId = @id`,
            { id: row.id, userId, now }
        );
        const updated = await db.get(
            'SELECT id, revision, authorityRevision, status FROM assistant_responsibilities WHERE id = @id', { id: row.id }
        );
        await db.run(
            `INSERT INTO assistant_responsibility_revisions
                (responsibilityId, revision, authorityRevision, changeKind, changedBy, snapshotJson)
             VALUES (@id, @revision, @authorityRevision, @changeKind, NULL, @snapshot)`,
            {
                id: updated.id,
                revision: updated.revision,
                authorityRevision: updated.authorityRevision,
                changeKind: revoke ? 'revoke' : 'edit',
                snapshot: JSON.stringify({ id: Number(updated.id), revision: Number(updated.revision), status: updated.status, reason: 'principal_erased' })
            }
        );
    }

    const snapshots = await db.all(
        `SELECT id, snapshotJson FROM assistant_responsibility_revisions
         WHERE changedBy = @userId OR snapshotJson LIKE @pattern`,
        { userId, pattern: `%"${userId}"%` }
    );
    for (const snap of snapshots) {
        let parsed;
        try { parsed = JSON.parse(snap.snapshotJson); } catch { parsed = null; }
        if (parsed && typeof parsed === 'object') {
            for (const key of RESPONSIBILITY_PRINCIPALS) {
                if (parsed[key] === userId) parsed[key] = null;
            }
        }
        await db.run(
            `UPDATE assistant_responsibility_revisions
             SET changedBy = CASE WHEN changedBy = @userId THEN NULL ELSE changedBy END, snapshotJson = @snapshot
             WHERE id = @id`,
            { id: snap.id, userId, snapshot: parsed ? JSON.stringify(parsed) : '{}' }
        );
    }
    return {
        responsibilities, revisions, anonymized: others.length,
        initiatives, cursors, proposalCounters, messageLabels, updates, receipts, processContracts, processObservations, incidents, incidentMembers,
        processLifecycle, processCleanups,
        runs, runOperations, knowledgeChanges, digests, feedback, sourceWeights
    };
}

/** Transparency report counts for the person's own responsibilities. */
async function countAssistantResponsibilities(userId) {
    const row = await db.get(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status = 'DRAFT' THEN 1 ELSE 0 END) AS drafts,
                SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END) AS active,
                SUM(CASE WHEN status = 'PAUSED' THEN 1 ELSE 0 END) AS paused,
                SUM(CASE WHEN status = 'NEEDS_REVIEW' THEN 1 ELSE 0 END) AS needsReview
         FROM assistant_responsibilities WHERE ownerUserId = @userId`,
        { userId }
    );
    const involved = await db.get(
        `SELECT COUNT(*) AS c FROM assistant_responsibilities
         WHERE ownerUserId <> @userId AND ${RESPONSIBILITY_INVOLVES}`,
        { userId }
    );
    const count = async (sql) => Number((await db.get(sql, { userId }))?.c || 0);
    return {
        total: Number(row?.total || 0),
        drafts: Number(row?.drafts || 0),
        active: Number(row?.active || 0),
        paused: Number(row?.paused || 0),
        needsReview: Number(row?.needsReview || 0),
        onOthersGrants: Number(involved?.c || 0),
        initiatives: await count('SELECT COUNT(*) AS c FROM assistant_initiatives WHERE ownerUserId = @userId'),
        openInitiatives: await count(
            `SELECT COUNT(*) AS c FROM assistant_initiatives
             WHERE ownerUserId = @userId AND status IN ('CANDIDATE', 'QUEUED', 'RUNNING', 'WAITING', 'REVIEW')`
        ),
        runs: await count('SELECT COUNT(*) AS c FROM assistant_runs WHERE ownerUserId = @userId'),
        runOperations: await count('SELECT COUNT(*) AS c FROM assistant_run_operations WHERE ownerUserId = @userId'),
        proposalCounters: await count('SELECT COUNT(*) AS c FROM assistant_proposal_counters WHERE ownerUserId = @userId'),
        messageLabels: await count('SELECT COUNT(*) AS c FROM assistant_message_labels WHERE ownerUserId = @userId'),
        knowledgeChanges: await count('SELECT COUNT(*) AS c FROM kg_change_sets WHERE userId = @userId'),
        updates: await count("SELECT COUNT(*) AS c FROM assistant_updates WHERE audienceKind = 'user' AND audienceUserId = @userId"),
        updateReceipts: await count('SELECT COUNT(*) AS c FROM assistant_update_receipts WHERE userId = @userId'),
        digests: await count('SELECT COUNT(*) AS c FROM assistant_digests WHERE userId = @userId'),
        // Feedback given (and items recorded as ignored), and the sources whose rate it changed.
        feedback: await count('SELECT COUNT(*) AS c FROM assistant_feedback WHERE userId = @userId'),
        sourceWeights: await count('SELECT COUNT(*) AS c FROM assistant_source_weights WHERE ownerUserId = @userId'),
        loweredSources: await count('SELECT COUNT(*) AS c FROM assistant_source_weights WHERE ownerUserId = @userId AND weight < 1'),
        processContracts: await count('SELECT COUNT(*) AS c FROM assistant_process_contracts WHERE ownerUserId = @userId'),
        processObservations: await count('SELECT COUNT(*) AS c FROM assistant_process_observations WHERE ownerUserId = @userId'),
        processIncidents: await count('SELECT COUNT(*) AS c FROM assistant_process_incidents WHERE ownerUserId = @userId'),
        openProcessIncidents: await count(
            "SELECT COUNT(*) AS c FROM assistant_process_incidents WHERE ownerUserId = @userId AND status <> 'RESOLVED'"
        ),
        pausedProcesses: await count("SELECT COUNT(*) AS c FROM assistant_process_lifecycle WHERE ownerUserId = @userId AND stage = 'PAUSED'"),
        archivedProcesses: await count(
            "SELECT COUNT(*) AS c FROM assistant_process_lifecycle WHERE ownerUserId = @userId AND stage IN ('ARCHIVED', 'CLEANED')"
        ),
        processCleanups: await count('SELECT COUNT(*) AS c FROM assistant_process_cleanups WHERE ownerUserId = @userId')
    };
}

/** Post-erasure audit counts (privacyService.auditUser). */
async function auditAssistantResponsibilities(userId) {
    const responsibilities = (await db.get(
        `SELECT COUNT(*) AS c FROM assistant_responsibilities
         WHERE ownerUserId = @userId OR ${RESPONSIBILITY_INVOLVES}`,
        { userId }
    )).c;
    const revisions = (await db.get(
        `SELECT COUNT(*) AS c FROM assistant_responsibility_revisions
         WHERE changedBy = @userId OR snapshotJson LIKE @pattern
            OR responsibilityId IN (SELECT id FROM assistant_responsibilities WHERE ownerUserId = @userId)`,
        { userId, pattern: `%"${userId}"%` }
    )).c;
    const count = async (sql) => Number((await db.get(sql, { userId }))?.c || 0);
    return {
        responsibilities: Number(responsibilities),
        revisions: Number(revisions),
        initiatives: await count('SELECT COUNT(*) AS c FROM assistant_initiatives WHERE ownerUserId = @userId OR actingUserId = @userId'),
        cursors: await count(
            'SELECT COUNT(*) AS c FROM assistant_source_cursors WHERE responsibilityId IN (SELECT id FROM assistant_responsibilities WHERE ownerUserId = @userId)'
        ),
        updates: await count(
            "SELECT COUNT(*) AS c FROM assistant_updates WHERE (audienceKind = 'user' AND audienceUserId = @userId) OR producerUserId = @userId"
        ),
        receipts: await count('SELECT COUNT(*) AS c FROM assistant_update_receipts WHERE userId = @userId'),
        digests: await count('SELECT COUNT(*) AS c FROM assistant_digests WHERE userId = @userId'),
        processContracts: await count('SELECT COUNT(*) AS c FROM assistant_process_contracts WHERE ownerUserId = @userId'),
        processObservations: await count('SELECT COUNT(*) AS c FROM assistant_process_observations WHERE ownerUserId = @userId'),
        incidents: await count('SELECT COUNT(*) AS c FROM assistant_process_incidents WHERE ownerUserId = @userId'),
        incidentMembers: await count('SELECT COUNT(*) AS c FROM assistant_process_incident_members WHERE ownerUserId = @userId'),
        processLifecycle: await count('SELECT COUNT(*) AS c FROM assistant_process_lifecycle WHERE ownerUserId = @userId'),
        processCleanups: await count('SELECT COUNT(*) AS c FROM assistant_process_cleanups WHERE ownerUserId = @userId'),
        runs: await count('SELECT COUNT(*) AS c FROM assistant_runs WHERE ownerUserId = @userId OR actingUserId = @userId OR payerUserId = @userId'),
        runOperations: await count('SELECT COUNT(*) AS c FROM assistant_run_operations WHERE ownerUserId = @userId'),
        proposalCounters: await count('SELECT COUNT(*) AS c FROM assistant_proposal_counters WHERE ownerUserId = @userId'),
        messageLabels: await count('SELECT COUNT(*) AS c FROM assistant_message_labels WHERE ownerUserId = @userId'),
        knowledgeChanges: await count('SELECT COUNT(*) AS c FROM kg_change_sets WHERE userId = @userId'),
        feedback: await count('SELECT COUNT(*) AS c FROM assistant_feedback WHERE userId = @userId'),
        sourceWeights: await count('SELECT COUNT(*) AS c FROM assistant_source_weights WHERE ownerUserId = @userId')
    };
}

module.exports = {
    PROJECTS_ROOT,
    DASHBOARDS_ROOT,
    USER_ID_PATTERN,
    forgetProjectTriggers,
    forgetProjectAssets,
    forgetProjectMissions,
    forgetExpeditionBriefs,
    anonymizeSandboxPackages,
    forgetSandboxRequests,
    forgetProjects,
    notifyProjectsGone,
    countWorkspaceDirs,
    countProjects,
    forgetAssistantResponsibilities,
    countAssistantResponsibilities,
    auditAssistantResponsibilities
};
