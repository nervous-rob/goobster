/**
 * Web app dashboard: the memory & privacy data behind the browser UI.
 *
 * Access model (validated here, not in the routes):
 *  - A user's DM scope ("dm:<userId>") is wholly their own data - they can
 *    browse and delete everything in it.
 *  - In a guild scope, a user must be a member (verified through the bot
 *    client, like the Activity WebSocket join) and can only see/delete
 *    memories and facts ABOUT THEMSELVES.
 *  - The knowledge graph and internal monologue are guild-level features
 *    gated on Manage Server, mirroring the /monologue command.
 *
 * Every memory deletion calls memoryService.cleanupVecIndex() so derived
 * vectors never outlive their memories.
 */

const { PermissionFlagsBits } = require('discord.js');
const db = require('../db');
const memoryService = require('./memoryService');
const privacyService = require('./privacyService');
const { dmScopeId, isDmScopeId } = require('../utils/dmScope');
const { requireGuildMember } = require('../utils/webGuildAccess');

const MEMORY_PAGE_LIMIT = 500;

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
     * share with the bot (membership checked live through the client).
     * @param {Object} params - { client, userId }
     * @returns {Promise<Array<Object>>}
     */
    async listScopes({ client, userId }) {
        const scopes = [{
            id: dmScopeId(userId),
            kind: 'dm',
            name: 'Direct messages & web chat',
            manageGuild: true,
            graphAvailable: false
        }];

        const guilds = [...(client?.guilds?.cache?.values?.() || [])];
        const memberships = await Promise.allSettled(
            guilds.map(guild => guild.members.fetch(userId))
        );

        for (let i = 0; i < guilds.length; i++) {
            if (memberships[i].status !== 'fulfilled') continue;
            const guild = guilds[i];
            const member = memberships[i].value;
            const manageGuild = Boolean(member.permissions?.has?.(PermissionFlagsBits.ManageGuild));
            scopes.push({
                id: guild.id,
                kind: 'guild',
                name: guild.name,
                icon: guild.iconURL?.({ size: 64 }) || null,
                manageGuild,
                graphAvailable: manageGuild
            });
        }
        return scopes;
    }

    /**
     * Validate that a user may browse a scope; returns the member for guild
     * scopes (null for the DM scope).
     * @param {Object} params - { client, scope, userId }
     */
    async _requireScopeAccess({ client, scope, userId }) {
        if (isDmScopeId(scope)) {
            if (scope !== dmScopeId(userId)) {
                throw new WebDashboardError(403, 'FORBIDDEN', 'That DM scope belongs to another user.');
            }
            return null;
        }
        return requireGuildMember({ client, guildId: scope, userId });
    }

    /**
     * The per-scope transparency report (same data as
     * /what-do-you-know-about-me).
     * @param {Object} params - { client, scope, userId }
     */
    async getReport({ client, scope, userId }) {
        await this._requireScopeAccess({ client, scope, userId });
        return privacyService.buildUserReport({ guildId: scope, userId });
    }

    /**
     * Browse stored memories. DM scope: everything in the scope (both sides
     * of the conversation). Guild scope: only memories the user authored.
     * @param {Object} params - { client, scope, userId, limit }
     */
    async listMemories({ client, scope, userId, limit = 100 }) {
        await this._requireScopeAccess({ client, scope, userId });
        const bounded = Math.max(1, Math.min(Number(limit) || 100, MEMORY_PAGE_LIMIT));
        const dmScope = isDmScopeId(scope);
        const params = dmScope ? { scope, limit: bounded } : { scope, userId, limit: bounded };
        return db.all(
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
     * @param {Object} params - { client, scope, userId, memoryId }
     */
    async deleteMemory({ client, scope, userId, memoryId }) {
        await this._requireScopeAccess({ client, scope, userId });
        const dmScope = isDmScopeId(scope);
        const params = dmScope
            ? { memoryId: Number(memoryId), scope }
            : { memoryId: Number(memoryId), scope, userId };
        const result = db.run(
            `DELETE FROM memory_embeddings
             WHERE id = @memoryId AND guildId = @scope ${dmScope ? '' : 'AND authorId = @userId'}`,
            params
        );
        if (result.changes === 0) {
            throw new WebDashboardError(404, 'NOT_FOUND', 'No such memory (or it is not yours to delete).');
        }
        memoryService.cleanupVecIndex();
        return { deleted: result.changes };
    }

    /**
     * Browse distilled facts. DM scope: every fact in the scope. Guild
     * scope: USER facts about the requesting user only.
     * @param {Object} params - { client, scope, userId }
     */
    async listFacts({ client, scope, userId }) {
        await this._requireScopeAccess({ client, scope, userId });
        const dmScope = isDmScopeId(scope);
        const params = dmScope ? { scope } : { scope, userId };
        return db.all(
            `SELECT id, subjectType, content, source, updatedAt FROM facts
             WHERE guildId = @scope
               ${dmScope ? '' : "AND subjectType = 'USER' AND subjectId = @userId"}
             ORDER BY updatedAt DESC, id DESC LIMIT 200`,
            params
        );
    }

    /**
     * Delete one fact the user owns (any fact in their DM scope, or a USER
     * fact about them in a guild).
     * @param {Object} params - { client, scope, userId, factId }
     */
    async deleteFact({ client, scope, userId, factId }) {
        await this._requireScopeAccess({ client, scope, userId });
        const dmScope = isDmScopeId(scope);
        const params = dmScope
            ? { factId: Number(factId), scope }
            : { factId: Number(factId), scope, userId };
        const result = db.run(
            `DELETE FROM facts
             WHERE id = @factId AND guildId = @scope
               ${dmScope ? '' : "AND subjectType = 'USER' AND subjectId = @userId"}`,
            params
        );
        if (result.changes === 0) {
            throw new WebDashboardError(404, 'NOT_FOUND', 'No such fact (or it is not yours to delete).');
        }
        return { deleted: result.changes };
    }

    /**
     * The guild's knowledge graph + inner life, for the visualization.
     * Manage Server only (parity with /monologue graph|thoughts).
     * @param {Object} params - { client, guildId, userId }
     */
    async getGraph({ client, guildId, userId }) {
        if (isDmScopeId(guildId)) {
            throw new WebDashboardError(400, 'BAD_SCOPE',
                'The knowledge graph is a server feature - DMs do not have one.');
        }
        const member = await this._requireScopeAccess({ client, scope: guildId, userId });
        if (!member?.permissions?.has?.(PermissionFlagsBits.ManageGuild)) {
            throw new WebDashboardError(403, 'FORBIDDEN',
                'Viewing the knowledge graph requires Manage Server.');
        }

        const nodes = db.all(
            `SELECT id, type, label, content, salience, updatedAt FROM kg_nodes
             WHERE guildId = @guildId
             ORDER BY salience DESC, updatedAt DESC LIMIT 300`,
            { guildId }
        );
        const nodeIds = new Set(nodes.map(n => n.id));
        const edges = db.all(
            `SELECT sourceId, targetId, relation, weight FROM kg_edges
             WHERE guildId = @guildId`,
            { guildId }
        ).filter(e => nodeIds.has(e.sourceId) && nodeIds.has(e.targetId));

        const thoughts = db.all(
            `SELECT thought, createdAt FROM monologue_thoughts
             WHERE guildId = @guildId ORDER BY createdAt DESC, id DESC LIMIT 5`,
            { guildId }
        );
        const scratchpad = db.all(
            `SELECT content, updatedAt FROM monologue_scratchpad
             WHERE guildId = @guildId ORDER BY updatedAt DESC, id DESC LIMIT 12`,
            { guildId }
        );

        return { nodes, edges, thoughts, scratchpad };
    }
}

module.exports = new WebDashboardService();
module.exports.WebDashboardError = WebDashboardError;
