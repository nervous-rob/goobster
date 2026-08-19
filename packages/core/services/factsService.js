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
            await knowledgeGraphService.deleteMirroredFact({
                factId: row.id,
                guildId,
                subjectType,
                subjectId
            });
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
            await knowledgeGraphService.deleteMirroredFact({
                factId: row.id,
                guildId,
                subjectType: row.subjectType,
                subjectId: row.subjectId
            });
        }
        return removed;
    }

    _mergeFactLists(primary, secondary, limit) {
        const seen = new Set();
        const merged = [];
        for (const row of [...primary, ...secondary]) {
            const content = String(row.content || '').trim();
            if (!content) continue;
            const key = content.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            merged.push(row);
            if (merged.length >= limit) break;
        }
        return merged;
    }

    async getUserFacts(guildId, userId, limit = DOSSIER_LIMIT) {
        const graphFacts = await knowledgeGraphService.listFactNodes({
            guildId,
            subjectType: 'USER',
            subjectId: userId,
            limit
        }).then(rows => rows.map(f => ({
            content: f.content || f.label,
            updatedAt: f.updatedAt,
            source: f.nodeSource || 'graph'
        })));
        const legacyFacts = await db.all(
            `SELECT content, updatedAt, source FROM facts
             WHERE guildId = @guildId AND subjectType = 'USER' AND subjectId = @userId
             ORDER BY updatedAt DESC, id DESC LIMIT @limit`,
            { guildId, userId, limit }
        );
        return this._mergeFactLists(graphFacts, legacyFacts, limit);
    }

    async getGuildFacts(guildId, limit = DOSSIER_LIMIT) {
        const graphFacts = await knowledgeGraphService.listFactNodes({
            guildId,
            subjectType: 'GUILD',
            subjectId: null,
            limit
        }).then(rows => rows.map(f => ({
            content: f.content || f.label,
            updatedAt: f.updatedAt,
            source: f.nodeSource || 'graph'
        })));
        const legacyFacts = await db.all(
            `SELECT content, updatedAt, source FROM facts
             WHERE guildId = @guildId AND subjectType = 'GUILD'
             ORDER BY updatedAt DESC, id DESC LIMIT @limit`,
            { guildId, limit }
        );
        return this._mergeFactLists(graphFacts, legacyFacts, limit);
    }

    /**
     * Facts for the web portal (legacy ids + graph-only nodes).
     */
    async listFactsForScope({ guildId, subjectType, subjectId = null, allInScope = false, limit = 200 }) {
        const legacy = allInScope
            ? await db.all(
                `SELECT id, subjectType, content, source, updatedAt FROM facts
                 WHERE guildId = @guildId
                 ORDER BY updatedAt DESC, id DESC LIMIT @limit`,
                { guildId, limit }
            )
            : await db.all(
                `SELECT id, subjectType, content, source, updatedAt FROM facts
                 WHERE guildId = @guildId AND subjectType = @subjectType
                   AND (subjectId = @subjectId OR (subjectId IS NULL AND @subjectId IS NULL))
                 ORDER BY updatedAt DESC, id DESC LIMIT @limit`,
                { guildId, subjectType, subjectId, limit }
            );

        const graphRows = allInScope
            ? await db.all(
                `SELECT n.id, n.label, n.content, n.updatedAt, n.source AS nodeSource
                 FROM kg_nodes n
                 WHERE n.guildId = @guildId AND n.type = 'fact'
                 ORDER BY n.updatedAt DESC, n.id DESC LIMIT @limit`,
                { guildId, limit }
            )
            : await knowledgeGraphService.listFactNodes({
                guildId,
                subjectType,
                subjectId,
                limit
            });
        const legacyContents = new Set(legacy.map(f => String(f.content).trim().toLowerCase()));
        const graphOnly = graphRows
            .filter(f => !legacyContents.has(String(f.content || f.label).trim().toLowerCase()))
            .map(f => ({
                id: `kg:${f.id}`,
                subjectType,
                content: f.content || f.label,
                source: f.nodeSource || 'graph',
                updatedAt: f.updatedAt
            }));
        return [...legacy, ...graphOnly].slice(0, limit);
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
