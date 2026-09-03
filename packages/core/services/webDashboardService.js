/**
 * Web app dashboard: the memory & privacy data behind the browser UI.
 *
 * Access model (validated here, not in the routes):
 *  - A user's DM scope ("dm:<userId>") is wholly their own data - they can
 *    browse and delete everything in it.
 *  - In a guild scope, a user must be a member (verified live through the
 *    Discord gateway seam, like the Activity WebSocket join) and can only
 *    see/delete memories and facts ABOUT THEMSELVES.
 *  - The knowledge graph and internal monologue are guild-level features
 *    gated on Manage Server, mirroring the /monologue command.
 *
 * Every memory deletion calls memoryService.cleanupVecIndex() so derived
 * vectors never outlive their memories.
 */

const db = require('../db');
const memoryService = require('./memoryService');
const privacyService = require('./privacyService');
const factsService = require('./factsService');
const knowledgeGraphService = require('./knowledgeGraphService');
const kgConfig = require('../config/knowledgeGraphConfig');
const { dmScopeId, isDmScopeId } = require('../utils/dmScope');
const { requireGuildMember } = require('../utils/webGuildAccess');
const { toGateway, isGatewayUnavailable } = require('../gateway');

const MEMORY_PAGE_LIMIT = 500;
const USAGE_MAX_DAYS = 365;
const RETENTION_MAX_DAYS = 3650; // the /privacy retention ceiling

/** Machine-readable web app error (HTTP status + code). */
class WebDashboardError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = 'WebDashboardError';
        this.status = status;
        this.code = code;
    }
}

class WebDashboardService {
    /**
     * The scopes a user may browse: their DM scope plus every guild they
     * share with the bot (membership checked live through the gateway).
     * With the bot unreachable (split deployment, bot restarting) the DM
     * scope still lists and guild scopes simply drop out until he
     * reconnects - degraded, never a crash.
     * @param {Object} params - { gateway, userId }
     * @returns {Promise<Array<Object>>}
     */
    async listScopes({ gateway, client, userId }) {
        const scopes = [{
            id: dmScopeId(userId),
            kind: 'dm',
            name: 'Direct messages & web chat',
            manageGuild: true,
            graphAvailable: false
        }];

        const resolved = toGateway(gateway || client);
        let mutualGuilds;
        try {
            mutualGuilds = resolved ? await resolved.listMutualGuilds(userId) : [];
        } catch (error) {
            // Degraded mode: the DM scope still works with the bot down;
            // guild scopes simply don't list until he reconnects.
            if (!isGatewayUnavailable(error)) throw error;
            return scopes;
        }

        for (const guild of mutualGuilds) {
            scopes.push({
                id: guild.id,
                kind: 'guild',
                name: guild.name,
                icon: guild.icon || null,
                manageGuild: guild.manageGuild === true,
                graphAvailable: guild.manageGuild === true
            });
        }
        return scopes;
    }

    /**
     * Validate that a user may browse a scope; returns the member snapshot
     * for guild scopes (null for the DM scope).
     * @param {Object} params - { gateway, scope, userId }
     */
    async _requireScopeAccess({ gateway, client, scope, userId }) {
        if (isDmScopeId(scope)) {
            if (scope !== dmScopeId(userId)) {
                throw new WebDashboardError(403, 'FORBIDDEN', 'That DM scope belongs to another user.');
            }
            return null;
        }
        return await requireGuildMember({ gateway: gateway || client, guildId: scope, userId });
    }

    /**
     * The per-scope transparency report (same data as
     * /what-do-you-know-about-me).
     * @param {Object} params - { gateway, scope, userId }
     */
    async getReport({ gateway, client, scope, userId }) {
        await this._requireScopeAccess({ gateway: gateway || client, scope, userId });
        return await privacyService.buildUserReport({ guildId: scope, userId });
    }

    /**
     * Browse stored memories. DM scope: everything in the scope (both sides
     * of the conversation). Guild scope: only memories the user authored.
     * @param {Object} params - { gateway, scope, userId, limit }
     */
    async listMemories({ gateway, client, scope, userId, limit = 100 }) {
        await this._requireScopeAccess({ gateway: gateway || client, scope, userId });
        const bounded = Math.max(1, Math.min(Number(limit) || 100, MEMORY_PAGE_LIMIT));
        const dmScope = isDmScopeId(scope);
        const params = dmScope ? { scope, limit: bounded } : { scope, userId, limit: bounded };
        return await db.all(
            `SELECT id, channelId, authorId, authorName, content, createdAt
             FROM memory_embeddings
             WHERE guildId = @scope ${dmScope ? '' : 'AND authorId = @userId'}
             ORDER BY createdAt DESC, id DESC LIMIT @limit`,
            params
        );
    }

    /**
     * Delete one memory the user owns (their DM scope, or their own guild
     * memory), then clean orphaned vectors.
     * @param {Object} params - { gateway, scope, userId, memoryId }
     */
    async deleteMemory({ gateway, client, scope, userId, memoryId }) {
        await this._requireScopeAccess({ gateway: gateway || client, scope, userId });
        const dmScope = isDmScopeId(scope);
        const params = dmScope
            ? { memoryId: Number(memoryId), scope }
            : { memoryId: Number(memoryId), scope, userId };
        const owned = await db.get(
            `SELECT id FROM memory_embeddings
             WHERE id = @memoryId AND guildId = @scope ${dmScope ? '' : 'AND authorId = @userId'}`,
            params
        );
        if (!owned) {
            throw new WebDashboardError(404, 'NOT_FOUND', 'No such memory (or it is not yours to delete).');
        }
        const deleted = await memoryService.deleteMemoriesByIds([owned.id]);
        return { deleted };
    }

    /**
     * Browse distilled facts. DM scope: every fact in the scope. Guild
     * scope: USER facts about the requesting user only.
     * @param {Object} params - { gateway, scope, userId }
     */
    async listFacts({ gateway, client, scope, userId }) {
        await this._requireScopeAccess({ gateway: gateway || client, scope, userId });
        const dmScope = isDmScopeId(scope);
        return await factsService.listFactsForScope({
            guildId: scope,
            subjectType: 'USER',
            subjectId: userId,
            allInScope: dmScope,
            limit: 200
        });
    }

    /**
     * Delete one fact the user owns (any fact in their DM scope, or a USER
     * fact about them in a guild).
     * @param {Object} params - { gateway, scope, userId, factId }
     */
    async deleteFact({ gateway, client, scope, userId, factId }) {
        await this._requireScopeAccess({ gateway: gateway || client, scope, userId });
        const rawId = String(factId);
        if (rawId.startsWith('kg:')) {
            const nodeId = Number(rawId.slice(3));
            const scopeKey = knowledgeGraphService.resolveScopeKey({
                subjectType: 'USER',
                subjectId: userId
            });
            const node = await db.get(
                `SELECT label FROM kg_nodes
                 WHERE id = @nodeId AND guildId = @scope AND scopeKey = @scopeKey AND type = 'fact'`,
                { nodeId, scope: scope, scopeKey }
            );
            if (!node) {
                throw new WebDashboardError(404, 'NOT_FOUND', 'No such fact (or it is not yours to delete).');
            }
            await knowledgeGraphService.deleteNode(scope, node.label, scopeKey);
            return { deleted: 1 };
        }

        const dmScope = isDmScopeId(scope);
        const params = dmScope
            ? { factId: Number(factId), scope }
            : { factId: Number(factId), scope, userId };
        const row = await db.get(
            `SELECT id, subjectType, subjectId FROM facts
             WHERE id = @factId AND guildId = @scope
               ${dmScope ? '' : "AND subjectType = 'USER' AND subjectId = @userId"}`,
            params
        );
        if (!row) {
            throw new WebDashboardError(404, 'NOT_FOUND', 'No such fact (or it is not yours to delete).');
        }
        await db.run('DELETE FROM facts WHERE id = @factId', { factId: row.id });
        await knowledgeGraphService.deleteMirroredFact({
            factId: row.id,
            guildId: scope,
            subjectType: row.subjectType,
            subjectId: row.subjectId
        });
        return { deleted: 1 };
    }

    /**
     * Personal AI usage stats from usage_log: the user's own calls and
     * token volume, bot-wide, for the portal's usage dashboard. Token
     * counts only - usage_log records no prices, so no dollar figures are
     * invented here.
     * @param {Object} params - { userId, days }
     * @returns {{ days, totals, byModel, byOperation, byDay }}
     */
    async getUsageStats({ userId, days = 30 }) {
        const bounded = Math.max(1, Math.min(Math.floor(Number(days) || 30), USAGE_MAX_DAYS));
        const params = { userId, cutoff: new Date(Date.now() - bounded * 24 * 60 * 60 * 1000) };

        const totals = await db.get(
            `SELECT COALESCE(SUM(count), 0) AS calls,
                    COALESCE(SUM(inputTokens), 0) AS inputTokens,
                    COALESCE(SUM(outputTokens), 0) AS outputTokens
             FROM usage_log
             WHERE userId = @userId
               AND createdAt >= @cutoff`,
            params
        );

        const byModel = await db.all(
            `SELECT provider, model,
                    SUM(count) AS calls,
                    SUM(inputTokens) AS inputTokens,
                    SUM(outputTokens) AS outputTokens
             FROM usage_log
             WHERE userId = @userId
               AND createdAt >= @cutoff
             GROUP BY provider, model
             ORDER BY SUM(inputTokens) + SUM(outputTokens) DESC`,
            params
        );

        const byOperation = await db.all(
            `SELECT operation,
                    SUM(count) AS calls,
                    SUM(inputTokens + outputTokens) AS totalTokens
             FROM usage_log
             WHERE userId = @userId
               AND createdAt >= @cutoff
             GROUP BY operation
             ORDER BY totalTokens DESC`,
            params
        );

        const byDay = await db.all(
            `SELECT date(createdAt) AS day,
                    SUM(count) AS calls,
                    SUM(inputTokens) AS inputTokens,
                    SUM(outputTokens) AS outputTokens
             FROM usage_log
             WHERE userId = @userId
               AND createdAt >= @cutoff
             GROUP BY date(createdAt)
             ORDER BY day ASC`,
            params
        );

        return {
            days: bounded,
            totals: {
                calls: totals?.calls || 0,
                inputTokens: totals?.inputTokens || 0,
                outputTokens: totals?.outputTokens || 0
            },
            byModel,
            byOperation,
            byDay
        };
    }

    /**
     * The memory auto-delete window for the user's own DM scope (their
     * DMs + web chats). DM scope only: guild retention stays a Manage
     * Server action via /privacy.
     * @param {Object} params - { scope, userId }
     * @returns {{ retentionDays: number|null, memoryCount: number }}
     */
    async getRetention({ scope, userId }) {
        this._requireOwnDmScope({ scope, userId });
        const row = await db.get(
            'SELECT memory_retention_days AS days FROM guild_settings WHERE guildId = @scope',
            { scope }
        );
        const count = await db.get(
            'SELECT COUNT(*) AS c FROM memory_embeddings WHERE guildId = @scope',
            { scope }
        );
        return { retentionDays: row?.days ?? null, memoryCount: count?.c || 0 };
    }

    /**
     * Set the DM-scope memory retention window (0/null = keep forever) and
     * purge immediately, like /privacy retention. Every deletion path
     * cleans orphaned vectors.
     * @param {Object} params - { scope, userId, days }
     * @returns {{ retentionDays: number|null, purged: number }}
     */
    async setRetention({ scope, userId, days }) {
        this._requireOwnDmScope({ scope, userId });
        const value = days === null || days === undefined || days === '' ? 0 : Number(days);
        if (!Number.isInteger(value) || value < 0 || value > RETENTION_MAX_DAYS) {
            throw new WebDashboardError(400, 'BAD_RETENTION',
                `days must be an integer between 0 (keep forever) and ${RETENTION_MAX_DAYS}.`);
        }
        const { setMemoryRetentionDays } = require('../utils/guildSettings');
        const stored = await setMemoryRetentionDays(scope, value);
        let purged = 0;
        if (stored) {
            purged = await memoryService.applyRetention(scope);
            if (purged > 0) await memoryService.cleanupVecIndex();
        }
        return { retentionDays: stored ?? null, purged };
    }

    /** Guard: the scope must be the requesting user's own DM scope. */
    _requireOwnDmScope({ scope, userId }) {
        if (!isDmScopeId(scope)) {
            throw new WebDashboardError(400, 'BAD_SCOPE',
                'Memory retention here covers your DM scope only - guild retention is set with /privacy.');
        }
        if (scope !== dmScopeId(userId)) {
            throw new WebDashboardError(403, 'FORBIDDEN', 'That DM scope belongs to another user.');
        }
    }

    /**
     * The guild's knowledge graph + inner life, for the visualization.
     * Manage Server only (parity with /monologue graph|thoughts).
     * @param {Object} params - { gateway, guildId, userId }
     */
    async getGraph({ gateway, client, guildId, userId }) {
        if (isDmScopeId(guildId)) {
            throw new WebDashboardError(400, 'BAD_SCOPE',
                'The knowledge graph is a server feature - DMs do not have one.');
        }
        const resolved = toGateway(gateway || client);
        await this._requireScopeAccess({ gateway: resolved, scope: guildId, userId });
        // A live permission check, never cached (the spec §6 rule for
        // permission-gated surfaces), mirroring /monologue graph.
        const manageGuild = resolved
            ? await resolved.memberHasPermission(guildId, userId, 'ManageGuild').catch(() => false)
            : false;
        if (!manageGuild) {
            throw new WebDashboardError(403, 'FORBIDDEN',
                'Viewing the knowledge graph requires Manage Server.');
        }

        const nodes = await db.all(
            `SELECT id, type, label, content, salience, confidence, source, updatedAt FROM kg_nodes
             WHERE guildId = @guildId AND scopeKey = ''
             ORDER BY salience DESC, updatedAt DESC LIMIT @limit`,
            { guildId, limit: kgConfig.MAX_NODES_GUILD_WIDE }
        );
        const nodeIds = new Set(nodes.map(n => n.id));
        const edges = (await db.all(
            `SELECT sourceId, targetId, relation, relationKind, weight FROM kg_edges
             WHERE guildId = @guildId AND scopeKey = ''`,
            { guildId }
        )).filter(e => nodeIds.has(e.sourceId) && nodeIds.has(e.targetId));
        const tagMap = await knowledgeGraphService.getTagsForNodes(nodes.map(n => n.id));
        for (const node of nodes) {
            node.tags = tagMap.get(node.id) || [];
        }

        const thoughts = await db.all(
            `SELECT thought, createdAt FROM monologue_thoughts
             WHERE guildId = @guildId ORDER BY createdAt DESC, id DESC LIMIT 5`,
            { guildId }
        );
        const scratchpad = await db.all(
            `SELECT content, updatedAt FROM monologue_scratchpad
             WHERE guildId = @guildId ORDER BY updatedAt DESC, id DESC LIMIT 12`,
            { guildId }
        );

        return { nodes, edges, thoughts, scratchpad };
    }

    /**
     * Companion Home snapshot: what Goobster knows about you, what he is
     * watching, where to pick up, and (when enabled) the Observatory dome.
     * Chat is a verb from here, not the landing page.
     * @param {Object} params - { gateway, userId }
     */
    async getHome({ gateway, client, userId }) {
        const scope = dmScopeId(userId);
        const report = await privacyService.buildUserReport({ guildId: scope, userId });
        const webChatService = require('./webChatService');
        const parlorService = require('./parlorService');
        const webAppletService = require('./webAppletService');

        const conversations = (await webChatService.listConversations(userId))
            .slice(0, 5)
            .map(row => ({
                id: row.id,
                title: row.title || 'Untitled chat',
                lastMessageAt: row.lastMessageAt || row.createdAt,
                messageCount: row.messageCount || 0
            }));

        let parlor;
        try {
            parlor = (await parlorService.listConversations(userId))
                .slice(0, 4)
                .map(row => ({
                    id: row.id,
                    title: row.title || 'Untitled discussion',
                    lastMessageAt: row.lastMessageAt || row.createdAt,
                    messageCount: row.messageCount || 0,
                    participants: (row.participants || []).map(p => p.name || p.personaName).filter(Boolean)
                }));
        } catch {
            parlor = [];
        }

        const workshop = await webAppletService.listWorkshop(userId);
        const scopes = await this.listScopes({ gateway: gateway || client, userId });
        const servers = scopes.filter(s => s.kind === 'guild').map(s => ({
            id: s.id,
            name: s.name,
            icon: s.icon || null
        }));

        let observatory = { enabled: false };
        try {
            const observatoryService = require('./observatoryService');
            if (observatoryService.enabled) {
                const projects = await observatoryService.listProjects(userId);
                observatory = {
                    enabled: true,
                    projectCount: projects.length,
                    runningJobs: projects.reduce((n, p) => n + (Number(p.runningJobs) || 0), 0),
                    latest: projects[0]
                        ? { name: projects[0].name, updatedAt: projects[0].updatedAt }
                        : null
                };
            }
        } catch {
            observatory = { enabled: false };
        }

        return {
            you: {
                nickname: report.nickname,
                facts: (report.facts || []).slice(0, 8).map(f => f.content),
                factCount: (report.facts || []).length,
                memoryCount: report.memories?.count || 0,
                memoryOldest: report.memories?.oldest || null,
                memoryNewest: report.memories?.newest || null,
                parlor: report.parlor,
                applets: report.applets || 0
            },
            watching: {
                followups: report.followups || [],
                automations: report.automations || []
            },
            pickup: { conversations, parlor },
            workshop: {
                pinned: workshop.pinned.slice(0, 4),
                discoveredCount: workshop.discovered.length
            },
            observatory,
            servers
        };
    }

    /**
     * Personal constellation: you at the center, facts and memories as
     * satellites. Available in every scope the user can browse — DM is
     * wholly theirs; a guild shows only facts/memories about them.
     * The guild knowledge graph stays Manage Server and is a separate call.
     * @param {Object} params - { gateway, scope, userId }
     */
    async getConstellation({ gateway, client, scope, userId }) {
        const resolved = gateway || client;
        await this._requireScopeAccess({ gateway: resolved, scope, userId });
        const isDm = isDmScopeId(scope);
        const youLabel = isDm ? 'You' : 'You, here';

        const knowledgeGraphService = require('./knowledgeGraphService');
        const graph = await knowledgeGraphService.getPersonalGraphView({
            guildId: scope,
            userId,
            userLabel: youLabel
        });

        const memories = await this.listMemories({ gateway: resolved, scope, userId, limit: 80 });
        graph.counts = {
            ...graph.counts,
            memories: memories.length,
            facts: graph.counts?.nodes || 0
        };

        return graph;
    }

    /**
     * List the requesting user's personal notes in this scope, with
     * search / type / tag / source filters for the Notes tab.
     */
    async listNotes({ gateway, client, scope, userId, q, type, tag, source, limit, offset } = {}) {
        await this._requireScopeAccess({ gateway: gateway || client, scope, userId });
        return knowledgeGraphService.listUserNotes({
            guildId: scope,
            userId,
            q,
            type,
            tag,
            source,
            limit,
            offset
        });
    }

    /**
     * Manual create of a personal note.
     */
    async createNote({ gateway, client, scope, userId, label, content, type, tags } = {}) {
        await this._requireScopeAccess({ gateway: gateway || client, scope, userId });
        try {
            const note = await knowledgeGraphService.createUserNote({
                guildId: scope,
                userId,
                label,
                content,
                type,
                tags
            });
            return { note };
        } catch (err) {
            if (err && err.status === 409) {
                throw new WebDashboardError(409, 'CONFLICT', err.message);
            }
            if (err && err.status === 400) {
                throw new WebDashboardError(400, 'BAD_REQUEST', err.message);
            }
            throw err;
        }
    }

    /**
     * Manual edit of a personal note. Ownership is re-checked in the
     * graph service; a missing / foreign note is 404.
     */
    async updateNote({ gateway, client, scope, userId, nodeId, label, content, type, tags } = {}) {
        await this._requireScopeAccess({ gateway: gateway || client, scope, userId });
        try {
            const note = await knowledgeGraphService.updateUserNote({
                guildId: scope,
                userId,
                nodeId,
                label,
                content,
                type,
                tags
            });
            if (!note) {
                throw new WebDashboardError(404, 'NOT_FOUND', 'Note not found.');
            }
            return { note };
        } catch (err) {
            if (err && err.status === 409) {
                throw new WebDashboardError(409, 'CONFLICT', err.message);
            }
            if (err && err.status === 400) {
                throw new WebDashboardError(400, 'BAD_REQUEST', err.message);
            }
            throw err;
        }
    }

    /**
     * Delete a personal note. Cascades edges / tags / revisions via FKs.
     */
    async deleteNote({ gateway, client, scope, userId, nodeId } = {}) {
        await this._requireScopeAccess({ gateway: gateway || client, scope, userId });
        const deleted = await knowledgeGraphService.deleteUserNote({
            guildId: scope,
            userId,
            nodeId
        });
        if (!deleted) {
            throw new WebDashboardError(404, 'NOT_FOUND', 'Note not found.');
        }
        return { deleted: true };
    }

    /**
     * Resolve a reflection target to a graph scopeKey + pass list, enforcing
     * the same access rules as the views the button sits on: 'personal' is
     * any browsable scope (the Map tab); 'guild' is the guild-wide graph and
     * requires Manage Server (the Server graph tab).
     * @param {Object} params - { gateway, scope, userId, target }
     */
    async _resolveReflectionTarget({ gateway, client, scope, userId, target = 'personal' }) {
        const reflection = require('./knowledgeReflectionService');
        const resolved = toGateway(gateway || client);
        if (target === 'guild') {
            if (isDmScopeId(scope)) {
                throw new WebDashboardError(400, 'BAD_SCOPE',
                    'The server graph is a guild feature - DMs do not have one.');
            }
            await this._requireScopeAccess({ gateway: resolved, scope, userId });
            const manageGuild = resolved
                ? await resolved.memberHasPermission(scope, userId, 'ManageGuild').catch(() => false)
                : false;
            if (!manageGuild) {
                throw new WebDashboardError(403, 'FORBIDDEN',
                    'Reflecting on the server graph requires Manage Server.');
            }
            // The guild-wide graph ('' scope). No distill here: the nightly
            // consolidation owns turning raw memories into distilled notes.
            return {
                scopeKey: '',
                subjectType: null,
                subjectId: null,
                passes: reflection.scheduledPasses
            };
        }
        await this._requireScopeAccess({ gateway: resolved, scope, userId });
        return {
            scopeKey: knowledgeGraphService.resolveScopeKey({
                subjectType: 'USER',
                subjectId: userId
            }),
            subjectType: 'USER',
            subjectId: userId,
            passes: reflection.manualPasses
        };
    }

    /**
     * The Library "Reflect" button: start a knowledge-enrichment run for the
     * user's personal graph (or the guild graph with Manage Server). Returns
     * immediately with the run row; the passes execute in the background and
     * the client polls getReflection until the run settles.
     * @param {Object} params - { gateway, scope, userId, target }
     */
    async startReflection({ gateway, client, scope, userId, target = 'personal' }) {
        const resolved = gateway || client;
        const { scopeKey, subjectType, subjectId, passes } =
            await this._resolveReflectionTarget({ gateway: resolved, scope, userId, target });
        const reflection = require('./knowledgeReflectionService');
        try {
            const { run, execution } = await reflection.startRun({
                guildId: scope,
                scopeKey,
                subjectType,
                subjectId,
                passes,
                trigger: 'manual',
                requestedBy: userId
            });
            execution.catch(() => { /* settled into the run row by _execute */ });
            return { run };
        } catch (error) {
            if (error?.code === 'REFLECTION_BUSY') {
                throw new WebDashboardError(409, 'REFLECTION_BUSY', error.message);
            }
            throw error;
        }
    }

    /**
     * The latest reflection run for a scope/target (button state, polling,
     * and the "last reflected" hint). Same access rules as startReflection.
     * @param {Object} params - { gateway, scope, userId, target }
     */
    async getReflection({ gateway, client, scope, userId, target = 'personal' }) {
        const resolved = gateway || client;
        const { scopeKey } =
            await this._resolveReflectionTarget({ gateway: resolved, scope, userId, target });
        const reflection = require('./knowledgeReflectionService');
        return { run: await reflection.getLatestRun(scope, scopeKey) };
    }

    /**
     * Web face of /forget-me. Requires typing FORGET ME. Sessions die
     * inside forgetUser; the current request still finishes with counts.
     * @param {Object} params - { userId, extraNames, confirm }
     */
    async forgetMe({ userId, extraNames = [], confirm, gateway = null, client = null }) {
        if (String(confirm || '').trim().toUpperCase() !== 'FORGET ME') {
            throw new WebDashboardError(400, 'BAD_CONFIRM',
                'Type FORGET ME to confirm full erasure.');
        }
        const counts = await privacyService.forgetUser({
            userId, extraNames, gateway: gateway || client
        });
        const audit = await privacyService.auditUser({ userId });
        return { counts, audit };
    }
}

module.exports = new WebDashboardService();
module.exports.WebDashboardError = WebDashboardError;
