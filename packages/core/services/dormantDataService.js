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
    return { missions, decisions };
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

    const memberships = (await db.run(
        'DELETE FROM project_members WHERE userId = @userId', { userId }
    )).changes;
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
    return { projects, jobs, shareLinks, memberships, invites, workspaceDirs: countWorkspaceDirs(userId), projectNodes };
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
    countProjects
};
