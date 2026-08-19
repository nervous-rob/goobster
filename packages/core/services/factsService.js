const db = require('../db');
const { isDmScopeId } = require('../utils/dmScope');
const knowledgeGraphService = require('./knowledgeGraphService');

const MAX_FACTS_PER_USER = 50;
const MAX_FACTS_PER_GUILD_SUBJECT = 100;
const DOSSIER_LIMIT = 12;

/**
 * Distilled facts about users and servers. Canonical storage is kg_nodes
 * (type=fact); the facts table is a compatibility mirror during migration.
 * Spec: documentation/user_knowledge_graph.md
 */
class FactsService {
    async addFact({ guildId, subjectType, subjectId = null, content, source = 'model' }) {
        const trimmed = String(content || '').trim();
        if (!guildId || !trimmed || trimmed.length > 500) return null;

        const existing = await db.get(
            `SELECT id FROM facts
             WHERE guildId = @guildId AND subjectType = @subjectType
               AND (subjectId = @subjectId OR (subjectId IS NULL AND @subjectId IS NULL))
               AND content = @content`,
            { guildId, subjectType, subjectId, content: trimmed }
        );
        if (existing) {
            await db.run(`UPDATE facts SET updatedAt = CURRENT_TIMESTAMP WHERE id = @id`, { id: existing.id });
            await knowledgeGraphService.syncFactNode({
                guildId,
                subjectType,
                subjectId,
                content: trimmed,
                factId: existing.id,
                source
            });
            return existing.id;
        }

        const result = await db.insert(
            `INSERT INTO facts (guildId, subjectType, subjectId, content, source)
             VALUES (@guildId, @subjectType, @subjectId, @content, @source)`,
            { guildId, subjectType, subjectId, content: trimmed, source }
        );
        const factId = Number(result);

        await knowledgeGraphService.syncFactNode({
            guildId,
            subjectType,
            subjectId,
            content: trimmed,
            factId,
            source
        });

        await this._prune(guildId, subjectType, subjectId);
        return factId;
    }

    async _prune(guildId, subjectType, subjectId) {
        const max = subjectType === 'USER' ? MAX_FACTS_PER_USER : MAX_FACTS_PER_GUILD_SUBJECT;
        const stale = await db.all(
            `SELECT id, content FROM facts
             WHERE guildId = @guildId AND subjectType = @subjectType
               AND (subjectId = @subjectId OR (subjectId IS NULL AND @subjectId IS NULL))
               AND id NOT IN (
                   SELECT id FROM facts
                   WHERE guildId = @guildId AND subjectType = @subjectType
                     AND (subjectId = @subjectId OR (subjectId IS NULL AND @subjectId IS NULL))
                   ORDER BY updatedAt DESC, id DESC LIMIT @max
               )`,
            { guildId, subjectType, subjectId, max }
        );
        for (const row of stale) {
            await db.run('DELETE FROM facts WHERE id = @id', { id: row.id });
            const scopeKey = knowledgeGraphService.resolveScopeKey({ subjectType, subjectId });
            const node = await knowledgeGraphService.getNode(guildId, row.content.slice(0, 120), scopeKey);
            if (node?.type === 'fact') {
                await knowledgeGraphService.deleteNode(guildId, node.label, scopeKey);
            }
        }
    }

    async removeFacts({ guildId, subjectType = null, subjectId = null, match }) {
        const pattern = `%${String(match || '').trim()}%`;
        if (!guildId || pattern === '%%') return 0;

        let sql = `SELECT id, content, subjectType, subjectId FROM facts
                   WHERE guildId = @guildId AND content LIKE @pattern`;
        const params = { guildId, pattern };
        if (subjectType) {
            sql += ' AND subjectType = @subjectType';
            params.subjectType = subjectType;
        }
        if (subjectId) {
            sql += ' AND subjectId = @subjectId';
            params.subjectId = subjectId;
        }
        const rows = await db.all(sql, params);

        let removed = 0;
        for (const row of rows) {
            removed += (await db.run('DELETE FROM facts WHERE id = @id', { id: row.id })).changes;
            const scopeKey = knowledgeGraphService.resolveScopeKey({
                subjectType: row.subjectType,
                subjectId: row.subjectId
            });
            const node = await db.get(
                `SELECT label FROM kg_nodes
                 WHERE guildId = @guildId AND scopeKey = @scopeKey AND content LIKE @pattern`,
                { guildId, scopeKey, pattern: `%${row.content}%` }
            );
            if (node) {
                await knowledgeGraphService.deleteNode(guildId, node.label, scopeKey);
            }
        }
        return removed;
    }

    async getUserFacts(guildId, userId, limit = DOSSIER_LIMIT) {
        const graphFacts = await knowledgeGraphService.listFactNodes({
            guildId,
            subjectType: 'USER',
            subjectId: userId,
            limit
        });
        if (graphFacts.length > 0) {
            return graphFacts.map(f => ({
                content: f.content || f.label,
                updatedAt: f.updatedAt
            }));
        }
        return await db.all(
            `SELECT content, updatedAt FROM facts
             WHERE guildId = @guildId AND subjectType = 'USER' AND subjectId = @userId
             ORDER BY updatedAt DESC, id DESC LIMIT @limit`,
            { guildId, userId, limit }
        );
    }

    async getGuildFacts(guildId, limit = DOSSIER_LIMIT) {
        const graphFacts = await knowledgeGraphService.listFactNodes({
            guildId,
            subjectType: 'GUILD',
            subjectId: null,
            limit
        });
        if (graphFacts.length > 0) {
            return graphFacts.map(f => ({
                content: f.content || f.label,
                updatedAt: f.updatedAt
            }));
        }
        return await db.all(
            `SELECT content, updatedAt FROM facts
             WHERE guildId = @guildId AND subjectType = 'GUILD'
             ORDER BY updatedAt DESC, id DESC LIMIT @limit`,
            { guildId, limit }
        );
    }

    async buildDossier({ guildId, userId, userName, query = null }) {
        return knowledgeGraphService.buildUserDossier({ guildId, userId, userName, query });
    }

    async getStats(guildId) {
        const row = await db.get(
            `SELECT
                SUM(CASE WHEN subjectType = 'USER' THEN 1 ELSE 0 END) AS userFacts,
                SUM(CASE WHEN subjectType = 'GUILD' THEN 1 ELSE 0 END) AS guildFacts
             FROM facts WHERE guildId = @guildId`,
            { guildId }
        );
        return { userFacts: row?.userFacts || 0, guildFacts: row?.guildFacts || 0 };
    }

    async forgetGuild(guildId) {
        return (await db.run('DELETE FROM facts WHERE guildId = @guildId', { guildId })).changes;
    }
}

module.exports = new FactsService();
