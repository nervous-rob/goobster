const db = require('../db');
const kgConfig = require('../config/knowledgeGraphConfig');
const logger = require('../utils/logger');
const KnowledgeGraphLegalizer = require('./knowledgeGraphLegalizer');

/** Bounded per-node revision history (spec: spitball_expeditions.md §27). */
const MAX_REVISIONS_PER_NODE = 20;

const {
    MAX_LABEL_LENGTH,
    MAX_CONTENT_LENGTH,
    MAX_RELATION_LENGTH,
    MAX_NODES_GUILD_WIDE,
    MAX_NODES_USER,
    MAX_EDGES_PER_SCOPE,
    MAX_TAGS_PER_SCOPE,
    MAX_TAGS_PER_NODE,
    MAX_TAG_LENGTH,
    NODE_TYPES,
    NODE_SOURCES,
    ORPHAN_CONFIDENCE_THRESHOLD
} = kgConfig;

function clamp01(value, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(1, Math.max(0, n));
}

function normalizeLabel(label) {
    return String(label || '').trim().slice(0, MAX_LABEL_LENGTH);
}

/** Stable label for a fact sentence mirrored into the graph. */
function factLabelFromContent(content) {
    const trimmed = String(content || '').trim();
    if (!trimmed) return '';
    if (trimmed.length <= MAX_LABEL_LENGTH) return trimmed;
    return `${trimmed.slice(0, MAX_LABEL_LENGTH - 3)}...`;
}

function normalizeTagName(name) {
    return String(name || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, MAX_TAG_LENGTH);
}

/**
 * Resolve scopeKey from subject metadata.
 * @param {{ subjectType?: string, subjectId?: string|null }} params
 * @returns {string}
 */
function resolveScopeKey({ subjectType = null, subjectId = null } = {}) {
    if (subjectType === 'USER' && subjectId) return `USER:${subjectId}`;
    if (subjectType === 'GUILD') return 'GUILD';
    return '';
}

function maxNodesForScope(scopeKey) {
    return scopeKey.startsWith('USER:') ? MAX_NODES_USER : MAX_NODES_GUILD_WIDE;
}

/**
 * User + guild knowledge graph. Spec: documentation/user_knowledge_graph.md
 *
 * Maintained by consolidation (user-scoped), rememberFact (tool), internal
 * monologue (guild-wide), and one-time migration from legacy facts.
 */
class KnowledgeGraphService {
    constructor() {
        this._legalizer = new KnowledgeGraphLegalizer(this);
    }

    get nodeTypes() {
        return NODE_TYPES;
    }

    get legalizer() {
        return this._legalizer;
    }

    resolveScopeKey = resolveScopeKey;

    /**
     * @param {Object} node
     * @returns {{id: number, created: boolean}|null}
     */
    async upsertNode({
        guildId,
        scopeKey = '',
        subjectType = null,
        subjectId = null,
        type = null,
        label,
        content = null,
        salience,
        confidence,
        source = 'monologue'
    } = {}) {
        const sk = scopeKey || resolveScopeKey({ subjectType, subjectId });
        const cleanLabel = normalizeLabel(label);
        if (!guildId || !cleanLabel) return null;

        const cleanType = type && NODE_TYPES.includes(type) ? type : null;
        const cleanContent = content ? String(content).trim().slice(0, MAX_CONTENT_LENGTH) : null;
        const cleanSource = kgConfig.NODE_SOURCES.includes(source) ? source : 'monologue';

        const existing = await db.get(
            `SELECT id, type, label, content, salience, confidence, source FROM kg_nodes
             WHERE guildId = @guildId AND scopeKey = @scopeKey AND label = @label`,
            { guildId, scopeKey: sk, label: cleanLabel }
        );

        if (existing) {
            // `source` records who authored the knowledge, so only a
            // content-bearing write may rebrand it. Structural touches (link
            // auto-upserting its endpoints, weave passes, tag attachment)
            // must not relabel a research/user note as their own writer -
            // every writer is already recorded in kg_provenance.
            const rebrandSource = (cleanContent || cleanType) ? cleanSource : null;
            await db.run(
                `UPDATE kg_nodes SET
                     type = COALESCE(@type, type),
                     content = COALESCE(@content, content),
                     salience = COALESCE(@salience, salience),
                     confidence = COALESCE(@confidence, confidence),
                     source = COALESCE(@source, source),
                     subjectType = COALESCE(@subjectType, subjectType),
                     subjectId = COALESCE(@subjectId, subjectId),
                     updatedAt = CURRENT_TIMESTAMP
                 WHERE id = @id`,
                {
                    id: existing.id,
                    type: cleanType,
                    content: cleanContent,
                    salience: salience === undefined ? null : clamp01(salience, 0.5),
                    confidence: confidence === undefined ? null : clamp01(confidence, 0.5),
                    source: rebrandSource,
                    subjectType: subjectType || null,
                    subjectId: subjectId || null
                }
            );
            // Revision only when the knowledge materially changed (type or
            // content) - salience/confidence drift alone is not a new
            // representation and would churn the bounded history.
            const materiallyChanged = (cleanType && cleanType !== existing.type)
                || (cleanContent && cleanContent !== (existing.content || null));
            if (materiallyChanged) {
                await this._recordRevision(existing.id, cleanSource);
            }
            return { id: existing.id, created: false };
        }

        const result = await db.insert(
            `INSERT INTO kg_nodes (
                guildId, scopeKey, type, label, content, salience, confidence, source, subjectType, subjectId
             ) VALUES (
                @guildId, @scopeKey, @type, @label, @content, @salience, @confidence, @source, @subjectType, @subjectId
             )`,
            {
                guildId,
                scopeKey: sk,
                type: cleanType || 'concept',
                label: cleanLabel,
                content: cleanContent,
                salience: clamp01(salience, 0.5),
                confidence: clamp01(confidence, 0.5),
                source: cleanSource,
                subjectType: subjectType || null,
                subjectId: subjectId || null
            }
        );
        await this.pruneScope(guildId, sk);
        await this._recordRevision(Number(result), cleanSource, 'created');
        return { id: Number(result), created: true };
    }

    /**
     * Append a bounded revision-history snapshot of a node's CURRENT state
     * (documentation/spitball_expeditions.md §27). changeKind derives from
     * the writer: a user edit is human_edit (the record of the preferred
     * representation research must not casually overwrite), research writes
     * are research_expand, merges are reflection_merge, the rest are plain
     * updates. Best-effort: history must never break a knowledge write.
     * @param {number} nodeId
     * @param {string} writerSource - a NODE_SOURCES value
     * @param {string} [changeKind] - explicit kind (e.g. 'created', 'reflection_merge')
     */
    async _recordRevision(nodeId, writerSource, changeKind = null) {
        try {
            const node = await db.get(
                'SELECT type, label, content, salience, confidence, source FROM kg_nodes WHERE id = @id',
                { id: nodeId }
            );
            if (!node) return;
            const kind = changeKind
                || (writerSource === 'user' ? 'human_edit'
                    : writerSource === 'research' ? 'research_expand'
                        : 'update');
            const next = await db.get(
                'SELECT COALESCE(MAX(revisionNumber), 0) + 1 AS n FROM kg_node_revisions WHERE nodeId = @id',
                { id: nodeId }
            );
            await db.run(
                `INSERT INTO kg_node_revisions
                    (nodeId, revisionNumber, label, type, content, salience, confidence, source, changeKind, changedBy)
                 VALUES
                    (@nodeId, @revisionNumber, @label, @type, @content, @salience, @confidence, @source, @changeKind, @changedBy)`,
                {
                    nodeId,
                    revisionNumber: next?.n || 1,
                    label: node.label,
                    type: node.type,
                    content: node.content,
                    salience: node.salience,
                    confidence: node.confidence,
                    source: node.source,
                    changeKind: kind,
                    changedBy: writerSource || null
                }
            );
            await db.run(
                `DELETE FROM kg_node_revisions
                 WHERE nodeId = @nodeId AND revisionNumber <= (
                     SELECT MAX(revisionNumber) - @keep FROM kg_node_revisions WHERE nodeId = @nodeId
                 )`,
                { nodeId, keep: MAX_REVISIONS_PER_NODE }
            );
        } catch (error) {
            logger.warn?.(`[KG] Revision snapshot for node #${nodeId} failed: ${error.message}`);
        }
    }

    /**
     * The bounded revision history of one node, newest first.
     * @param {number} nodeId
     * @param {number} [limit]
     */
    async listNodeRevisions(nodeId, limit = 20) {
        return await db.all(
            `SELECT revisionNumber, label, type, content, salience, confidence, source,
                    changeKind, changedBy, createdAt
             FROM kg_node_revisions
             WHERE nodeId = @nodeId
             ORDER BY revisionNumber DESC LIMIT @limit`,
            { nodeId: Number(nodeId), limit: Math.min(Math.max(Number(limit) || 20, 1), 100) }
        );
    }

    async getNode(guildId, label, scopeKey = '') {
        return await db.get(
            `SELECT * FROM kg_nodes
             WHERE guildId = @guildId AND scopeKey = @scopeKey AND label = @label`,
            { guildId, scopeKey, label: normalizeLabel(label) }
        );
    }

    async deleteNode(guildId, label, scopeKey = '') {
        const cleanLabel = normalizeLabel(label);
        if (!guildId || !cleanLabel) return 0;
        return (await db.run(
            `DELETE FROM kg_nodes
             WHERE guildId = @guildId AND scopeKey = @scopeKey AND label = @label`,
            { guildId, scopeKey, label: cleanLabel }
        )).changes;
    }

    async searchNodes({ guildId, scopeKey = '', query, type = null, limit = 10 }) {
        if (!guildId) return [];
        const terms = String(query || '')
            .toLowerCase()
            .split(/[^\p{L}\p{N}]+/u)
            .filter(t => t.length >= 3)
            .slice(0, 12);
        if (terms.length === 0) return [];

        const clauses = terms.map((_, i) => `(n.label LIKE @t${i} OR n.content LIKE @t${i} OR a.extractedText LIKE @t${i} OR a.originalName LIKE @t${i})`);
        const params = { guildId, scopeKey, limit };
        terms.forEach((t, i) => { params[`t${i}`] = `%${t}%`; });

        let sql = `SELECT DISTINCT n.* FROM kg_nodes n
                   LEFT JOIN kg_artifacts a ON a.nodeId = n.id
                   WHERE n.guildId = @guildId AND n.scopeKey = @scopeKey AND (${clauses.join(' OR ')})`;
        if (type && NODE_TYPES.includes(type)) {
            sql += ' AND n.type = @type';
            params.type = type;
        }
        sql += ' ORDER BY n.salience DESC, n.updatedAt DESC LIMIT @limit';
        return await db.all(sql, params);
    }

    async topNodes(guildId, scopeKey = '', limit = 10) {
        return await db.all(
            `SELECT * FROM kg_nodes
             WHERE guildId = @guildId AND scopeKey = @scopeKey
             ORDER BY salience DESC, updatedAt DESC LIMIT @limit`,
            { guildId, scopeKey, limit }
        );
    }

    async link({
        guildId,
        scopeKey = '',
        subjectType = null,
        subjectId = null,
        nodeSource = 'monologue',
        source,
        target,
        relation,
        relationKind = null,
        weight
    } = {}) {
        const sk = scopeKey;
        const sourceLabel = normalizeLabel(source);
        const targetLabel = normalizeLabel(target);
        const cleanRelation = String(relation || '').trim().slice(0, MAX_RELATION_LENGTH);
        if (!guildId || !sourceLabel || !targetLabel || !cleanRelation) return null;
        if (sourceLabel.toLowerCase() === targetLabel.toLowerCase()) return null;

        const endpoint = { guildId, scopeKey: sk, subjectType, subjectId, source: nodeSource };
        const sourceNode = await this.upsertNode({ ...endpoint, label: sourceLabel });
        const targetNode = await this.upsertNode({ ...endpoint, label: targetLabel });
        if (!sourceNode || !targetNode) return null;

        const kind = relationKind && kgConfig.RELATION_KINDS.includes(relationKind) ? relationKind : null;

        await db.run(
            `INSERT INTO kg_edges (guildId, scopeKey, sourceId, targetId, relation, relationKind, weight)
             VALUES (@guildId, @scopeKey, @sourceId, @targetId, @relation, @relationKind, @weight)
             ON CONFLICT(guildId, sourceId, targetId, relation) DO UPDATE SET
                 weight = @weight,
                 relationKind = COALESCE(@relationKind, kg_edges.relationKind),
                 updatedAt = CURRENT_TIMESTAMP`,
            {
                guildId,
                scopeKey: sk,
                sourceId: sourceNode.id,
                targetId: targetNode.id,
                relation: cleanRelation,
                relationKind: kind,
                weight: clamp01(weight, 0.5)
            }
        );
        await this._pruneEdges(guildId, sk);

        const row = await db.get(
            `SELECT id FROM kg_edges
             WHERE guildId = @guildId AND sourceId = @sourceId AND targetId = @targetId AND relation = @relation`,
            { guildId, sourceId: sourceNode.id, targetId: targetNode.id, relation: cleanRelation }
        );
        return row ? { id: row.id } : null;
    }

    async unlink({ guildId, source, target, relation = null, scopeKey = '' } = {}) {
        const sourceNode = await this.getNode(guildId, source, scopeKey);
        const targetNode = await this.getNode(guildId, target, scopeKey);
        if (!sourceNode || !targetNode) return 0;

        let sql = `DELETE FROM kg_edges
                   WHERE guildId = @guildId AND sourceId = @sourceId AND targetId = @targetId`;
        const params = { guildId, sourceId: sourceNode.id, targetId: targetNode.id };
        if (relation) {
            sql += ' AND relation = @relation';
            params.relation = String(relation).trim().slice(0, MAX_RELATION_LENGTH);
        }
        return (await db.run(sql, params)).changes;
    }

    async edgesFor(guildId, nodeIds, scopeKey = null) {
        if (!Array.isArray(nodeIds) || nodeIds.length === 0) return [];
        const placeholders = nodeIds.map((_, i) => `@n${i}`).join(', ');
        const params = { guildId };
        nodeIds.forEach((id, i) => { params[`n${i}`] = id });

        let sql = `SELECT e.id, e.sourceId, e.targetId, e.relation, e.relationKind, e.weight,
                          s.label AS sourceLabel, t.label AS targetLabel
                   FROM kg_edges e
                   JOIN kg_nodes s ON s.id = e.sourceId
                   JOIN kg_nodes t ON t.id = e.targetId
                   WHERE e.guildId = @guildId
                     AND (e.sourceId IN (${placeholders}) OR e.targetId IN (${placeholders}))`;
        if (scopeKey !== null) {
            sql += ' AND e.scopeKey = @scopeKey';
            params.scopeKey = scopeKey;
        }
        sql += ' ORDER BY e.weight DESC';
        return await db.all(sql, params);
    }

    async getNeighborhood({ guildId, label, scopeKey = '', depth = 1, maxNodes = 15 } = {}) {
        const start = await this.getNode(guildId, label, scopeKey);
        if (!start) return { nodes: [], edges: [] };

        const visited = new Map([[start.id, start]]);
        let frontier = [start.id];

        for (let hop = 0; hop < depth && frontier.length > 0 && visited.size < maxNodes; hop++) {
            const edges = await this.edgesFor(guildId, frontier, scopeKey);
            const next = [];
            for (const edge of edges) {
                for (const nodeId of [edge.sourceId, edge.targetId]) {
                    if (visited.has(nodeId) || visited.size >= maxNodes) continue;
                    const node = await db.get('SELECT * FROM kg_nodes WHERE id = @id', { id: nodeId });
                    if (node) {
                        visited.set(nodeId, node);
                        next.push(nodeId);
                    }
                }
            }
            frontier = next;
        }

        const nodes = [...visited.values()];
        const edgeRows = (await this.edgesFor(guildId, nodes.map(n => n.id), scopeKey))
            .filter(e => visited.has(e.sourceId) && visited.has(e.targetId));
        return { nodes, edges: edgeRows };
    }

    async _enrichArtifactNodes(nodes) {
        const artifactNodeIds = (nodes || []).filter(n => n.type === 'artifact').map(n => n.id);
        if (artifactNodeIds.length === 0) return nodes;
        const placeholders = artifactNodeIds.map((_, i) => `@id${i}`).join(', ');
        const params = {};
        artifactNodeIds.forEach((id, i) => { params[`id${i}`] = id; });
        const rows = await db.all(
            `SELECT nodeId, originalName, artifactKind FROM kg_artifacts WHERE nodeId IN (${placeholders})`,
            params
        );
        const byNode = new Map(rows.map(r => [r.nodeId, r]));
        return nodes.map(n => {
            if (n.type !== 'artifact') return n;
            const meta = byNode.get(n.id);
            return meta ? { ...n, originalName: meta.originalName, artifactKind: meta.artifactKind } : n;
        });
    }

    formatSubgraph({ nodes, edges }) {
        if (!nodes || nodes.length === 0) return null;

        const lines = nodes.map(n => {
            const detail = n.content ? `: ${n.content}` : '';
            const conf = n.confidence != null ? `, confidence ${Number(n.confidence).toFixed(2)}` : '';
            const fileBit = n.type === 'artifact' && n.originalName ? `, file=${n.originalName}` : '';
            const kindBit = n.type === 'artifact' && n.artifactKind ? `/${n.artifactKind}` : '';
            return `- [${n.type}${kindBit}] "${n.label}" (salience ${Number(n.salience).toFixed(2)}${conf}${fileBit})${detail}`;
        });
        for (const edge of edges || []) {
            const kind = edge.relationKind ? ` (${edge.relationKind})` : '';
            lines.push(
                `- "${edge.sourceLabel}" --${edge.relation}${kind}--> "${edge.targetLabel}" (weight ${Number(edge.weight).toFixed(2)})`
            );
        }
        return lines.join('\n');
    }

    async describeForPrompt({ guildId, scopeKey = '', query = null, limit = 10 } = {}) {
        let nodes = query
            ? await this.searchNodes({ guildId, scopeKey, query, limit })
            : [];
        if (nodes.length === 0) {
            nodes = await this.topNodes(guildId, scopeKey, limit);
        }
        if (nodes.length === 0) return null;

        nodes = await this._enrichArtifactNodes(nodes);

        const ids = new Set(nodes.map(n => n.id));
        const edges = (await this.edgesFor(guildId, [...ids], scopeKey))
            .filter(e => ids.has(e.sourceId) && ids.has(e.targetId));
        return this.formatSubgraph({ nodes, edges });
    }

    /**
     * Graph-first dossier for chat prompts (replaces flat facts list).
     */
    async buildUserDossier({ guildId, userId, userName, query = null, limit = 10 } = {}) {
        if (!guildId || !userId) return null;
        const scopeKey = resolveScopeKey({ subjectType: 'USER', subjectId: userId });

        await this.syncLegacyFacts({ guildId, subjectType: 'USER', subjectId: userId });

        const excerpt = await this.describeForPrompt({ guildId, scopeKey, query, limit });
        if (!excerpt) return null;

        return `WHAT YOU KNOW (distilled knowledge graph about ${userName || 'this user'} — use naturally, do not recite):
${excerpt}`;
    }

    async getStats(guildId, scopeKey = null) {
        let nodeSql = 'SELECT COUNT(*) AS c FROM kg_nodes WHERE guildId = @guildId';
        let edgeSql = 'SELECT COUNT(*) AS c FROM kg_edges WHERE guildId = @guildId';
        const params = { guildId };
        if (scopeKey !== null) {
            nodeSql += ' AND scopeKey = @scopeKey';
            edgeSql += ' AND scopeKey = @scopeKey';
            params.scopeKey = scopeKey;
        }
        const nodes = (await db.get(nodeSql, params)).c;
        const edges = (await db.get(edgeSql, params)).c;
        return { nodes, edges };
    }

    async forgetGuild(guildId) {
        return (await db.run('DELETE FROM kg_nodes WHERE guildId = @guildId', { guildId })).changes;
    }

    async forgetUserScope(guildId, userId) {
        const scopeKey = resolveScopeKey({ subjectType: 'USER', subjectId: userId });
        return (await db.run(
            'DELETE FROM kg_nodes WHERE guildId = @guildId AND scopeKey = @scopeKey',
            { guildId, scopeKey }
        )).changes;
    }

    async pruneScope(guildId, scopeKey = '') {
        await this._pruneNodes(guildId, scopeKey);
        await this._pruneEdges(guildId, scopeKey);
        await this._pruneTags(guildId, scopeKey);
        await this._pruneOrphans(guildId, scopeKey);
    }

    async _pruneNodes(guildId, scopeKey = '') {
        const max = maxNodesForScope(scopeKey);
        await db.run(
            `DELETE FROM kg_nodes
             WHERE guildId = @guildId AND scopeKey = @scopeKey
               AND id NOT IN (
                   SELECT id FROM kg_nodes
                   WHERE guildId = @guildId AND scopeKey = @scopeKey
                   ORDER BY (salience * confidence) DESC, updatedAt DESC, id DESC
                   LIMIT @max
               )`,
            { guildId, scopeKey, max }
        );
    }

    async _pruneEdges(guildId, scopeKey = '') {
        await db.run(
            `DELETE FROM kg_edges
             WHERE guildId = @guildId AND scopeKey = @scopeKey
               AND id NOT IN (
                   SELECT id FROM kg_edges
                   WHERE guildId = @guildId AND scopeKey = @scopeKey
                   ORDER BY weight DESC, updatedAt DESC, id DESC
                   LIMIT @max
               )`,
            { guildId, scopeKey, max: MAX_EDGES_PER_SCOPE }
        );
    }

    async _pruneTags(guildId, scopeKey = '') {
        await db.run(
            `DELETE FROM kg_tags
             WHERE guildId = @guildId AND scopeKey = @scopeKey
               AND id NOT IN (
                   SELECT t.id FROM kg_tags t
                   WHERE t.guildId = @guildId AND t.scopeKey = @scopeKey
                   ORDER BY (
                       SELECT COUNT(*) FROM kg_node_tags nt WHERE nt.tagId = t.id
                   ) DESC, t.id DESC
                   LIMIT @max
               )`,
            { guildId, scopeKey, max: MAX_TAGS_PER_SCOPE }
        );
    }

    async _pruneOrphans(guildId, scopeKey = '') {
        await db.run(
            `DELETE FROM kg_nodes
             WHERE guildId = @guildId AND scopeKey = @scopeKey
               AND confidence < @threshold
               AND id NOT IN (SELECT nodeId FROM kg_provenance)
               AND id NOT IN (
                   SELECT sourceId FROM kg_edges
                   WHERE guildId = @guildId AND scopeKey = @scopeKey
                   UNION SELECT targetId FROM kg_edges
                   WHERE guildId = @guildId AND scopeKey = @scopeKey
               )`,
            { guildId, scopeKey, threshold: ORPHAN_CONFIDENCE_THRESHOLD }
        );
    }

    /**
     * Remove provenance rows for deleted memories and prune orphaned nodes.
     * @param {number[]} memoryIds
     */
    async cleanupProvenanceForMemories(memoryIds) {
        if (!Array.isArray(memoryIds) || memoryIds.length === 0) return 0;
        const placeholders = memoryIds.map((_, i) => `@m${i}`).join(', ');
        const params = {};
        memoryIds.forEach((id, i) => { params[`m${i}`] = id });

        const affected = await db.all(
            `SELECT DISTINCT n.guildId, n.scopeKey FROM kg_provenance p
             JOIN kg_nodes n ON n.id = p.nodeId
             WHERE p.sourceKind = 'memory' AND p.sourceId IN (${placeholders})`,
            params
        );

        const removed = (await db.run(
            `DELETE FROM kg_provenance
             WHERE sourceKind = 'memory' AND sourceId IN (${placeholders})`,
            params
        )).changes;

        for (const { guildId, scopeKey } of affected) {
            await this._pruneOrphans(guildId, scopeKey || '');
        }
        return removed;
    }

    /**
     * Delete the kg node mirrored from a legacy facts row.
     */
    async deleteMirroredFact({ factId, guildId, subjectType, subjectId }) {
        const scopeKey = resolveScopeKey({ subjectType, subjectId });
        const prov = await db.get(
            `SELECT nodeId FROM kg_provenance
             WHERE sourceKind = 'fact' AND sourceId = @factId`,
            { factId }
        );
        if (prov?.nodeId) {
            const node = await db.get('SELECT label FROM kg_nodes WHERE id = @id', { id: prov.nodeId });
            if (node) {
                return await this.deleteNode(guildId, node.label, scopeKey);
            }
        }
        return 0;
    }

    /**
     * Provenance rows for a node (for transparency UI).
     */
    async getProvenanceForNode(nodeId) {
        return await db.all(
            `SELECT sourceKind, sourceId, createdAt FROM kg_provenance
             WHERE nodeId = @nodeId ORDER BY createdAt DESC`,
            { nodeId: Number(nodeId) }
        );
    }

    static hasMutationWork(applied) {
        if (!applied) return false;
        return (applied.nodesUpserted || 0) + (applied.linksCreated || 0) + (applied.nodesMerged || 0)
            + (applied.nodesDeleted || 0) + (applied.contradictions || 0) + (applied.tagsApplied || 0) > 0;
    }

    static hasMutationPayload(mutations) {
        if (!mutations || typeof mutations !== 'object') return false;
        for (const key of ['upsert', 'link', 'tag', 'merge', 'delete', 'contradict']) {
            if (Array.isArray(mutations[key]) && mutations[key].length > 0) return true;
        }
        return false;
    }

    async addTagsToNode({ guildId, scopeKey = '', label, tags }) {
        const node = await this.getNode(guildId, label, scopeKey);
        if (!node || !Array.isArray(tags)) return 0;

        let applied = 0;
        for (const raw of tags.slice(0, MAX_TAGS_PER_NODE)) {
            const name = normalizeTagName(raw);
            if (!name) continue;

            let tag = await db.get(
                `SELECT id FROM kg_tags
                 WHERE guildId = @guildId AND scopeKey = @scopeKey AND name = @name`,
                { guildId, scopeKey, name }
            );
            if (!tag) {
                const tagId = await db.insert(
                    `INSERT INTO kg_tags (guildId, scopeKey, name) VALUES (@guildId, @scopeKey, @name)`,
                    { guildId, scopeKey, name }
                );
                tag = { id: Number(tagId) };
            }

            await db.run(
                `INSERT INTO kg_node_tags (nodeId, tagId) VALUES (@nodeId, @tagId)
                 ON CONFLICT DO NOTHING`,
                { nodeId: node.id, tagId: tag.id }
            );
            applied++;
        }
        await this._pruneTags(guildId, scopeKey);
        return applied;
    }

    async getTagsForNodes(nodeIds) {
        if (!nodeIds.length) return new Map();
        const placeholders = nodeIds.map((_, i) => `@n${i}`).join(', ');
        const params = {};
        nodeIds.forEach((id, i) => { params[`n${i}`] = id });
        const rows = await db.all(
            `SELECT nt.nodeId, t.name
             FROM kg_node_tags nt
             JOIN kg_tags t ON t.id = nt.tagId
             WHERE nt.nodeId IN (${placeholders})`,
            params
        );
        const map = new Map();
        for (const row of rows) {
            if (!map.has(row.nodeId)) map.set(row.nodeId, []);
            map.get(row.nodeId).push(row.name);
        }
        return map;
    }

    async addProvenance({ nodeId, sourceKind, sourceId = null }) {
        if (!nodeId || !kgConfig.PROVENANCE_KINDS.includes(sourceKind)) return null;
        try {
            return await db.insert(
                `INSERT INTO kg_provenance (nodeId, sourceKind, sourceId)
                 VALUES (@nodeId, @sourceKind, @sourceId)
                 ON CONFLICT(nodeId, sourceKind, sourceId) DO NOTHING`,
                { nodeId, sourceKind, sourceId }
            );
        } catch {
            return null;
        }
    }

    /**
     * Mirror a legacy facts row into the graph (dual-write path).
     */
    async syncFactNode({ guildId, subjectType, subjectId, content, factId, source = 'tool' }) {
        const trimmed = String(content || '').trim();
        if (!guildId || !trimmed) return null;

        const scopeKey = resolveScopeKey({ subjectType, subjectId });
        const label = factLabelFromContent(trimmed);

        const result = await this.upsertNode({
            guildId,
            scopeKey,
            subjectType,
            subjectId,
            type: 'fact',
            label,
            content: trimmed,
            salience: 0.72,
            confidence: 0.85,
            source: source === 'consolidation' ? 'consolidation' : source === 'user' ? 'user' : 'tool'
        });
        if (result?.id && factId) {
            await this.addProvenance({ nodeId: result.id, sourceKind: 'fact', sourceId: factId });
        }
        return result;
    }

    /**
     * One-time backfill of legacy facts rows into kg_nodes.
     */
    async syncLegacyFacts({ guildId, subjectType = 'USER', subjectId }) {
        const rows = await db.all(
            `SELECT f.id, f.content, f.source FROM facts f
             WHERE f.guildId = @guildId AND f.subjectType = @subjectType
               AND (f.subjectId = @subjectId OR (f.subjectId IS NULL AND @subjectId IS NULL))
               AND NOT EXISTS (
                   SELECT 1 FROM kg_provenance p
                   WHERE p.sourceKind = 'fact' AND p.sourceId = f.id
               )`,
            { guildId, subjectType, subjectId }
        );
        for (const row of rows) {
            await this.syncFactNode({
                guildId,
                subjectType,
                subjectId,
                content: row.content,
                factId: row.id,
                source: row.source
            });
        }
    }

    /**
     * Merge drop node into keep node (edges repointed, drop deleted).
     */
    async mergeNodes({ guildId, scopeKey = '', keepLabel, dropLabel }) {
        const keep = await this.getNode(guildId, keepLabel, scopeKey);
        const drop = await this.getNode(guildId, dropLabel, scopeKey);
        if (!keep || !drop || keep.id === drop.id) return false;

        await db.transaction(async () => {
            const provRows = await db.all(
                'SELECT sourceKind, sourceId FROM kg_provenance WHERE nodeId = @dropId',
                { dropId: drop.id }
            );
            for (const row of provRows) {
                await this.addProvenance({
                    nodeId: keep.id,
                    sourceKind: row.sourceKind,
                    sourceId: row.sourceId
                });
            }
            const tagRows = await db.all(
                'SELECT tagId FROM kg_node_tags WHERE nodeId = @dropId',
                { dropId: drop.id }
            );
            for (const row of tagRows) {
                await db.run(
                    `INSERT INTO kg_node_tags (nodeId, tagId) VALUES (@nodeId, @tagId)
                     ON CONFLICT DO NOTHING`,
                    { nodeId: keep.id, tagId: row.tagId }
                );
            }

            const edges = await db.all(
                `SELECT * FROM kg_edges
                 WHERE guildId = @guildId AND (sourceId = @dropId OR targetId = @dropId)`,
                { guildId, dropId: drop.id }
            );
            for (const edge of edges) {
                const newSource = edge.sourceId === drop.id ? keep.id : edge.sourceId;
                const newTarget = edge.targetId === drop.id ? keep.id : edge.targetId;
                if (newSource === newTarget) continue;
                await db.run(
                    `INSERT INTO kg_edges (guildId, scopeKey, sourceId, targetId, relation, relationKind, weight)
                     VALUES (@guildId, @scopeKey, @sourceId, @targetId, @relation, @relationKind, @weight)
                     ON CONFLICT(guildId, sourceId, targetId, relation) DO UPDATE SET
                         weight = CASE WHEN weight > @weight THEN weight ELSE @weight END,
                         updatedAt = CURRENT_TIMESTAMP`,
                    {
                        guildId,
                        scopeKey: edge.scopeKey || scopeKey,
                        sourceId: newSource,
                        targetId: newTarget,
                        relation: edge.relation,
                        relationKind: edge.relationKind,
                        weight: edge.weight
                    }
                );
            }
            await db.run('DELETE FROM kg_nodes WHERE id = @id', { id: drop.id });
            await this._recordRevision(keep.id, keep.source, 'reflection_merge');
        });
        return true;
    }

    /**
     * Personal graph payload for the web portal Map tab.
     */
    async getPersonalGraphView({ guildId, userId, userLabel = 'You' }) {
        const scopeKey = resolveScopeKey({ subjectType: 'USER', subjectId: userId });
        await this.syncLegacyFacts({ guildId, subjectType: 'USER', subjectId: userId });

        const cap = maxNodesForScope(scopeKey);
        const dbNodes = await db.all(
            `SELECT * FROM kg_nodes
             WHERE guildId = @guildId AND scopeKey = @scopeKey
             ORDER BY salience DESC, updatedAt DESC LIMIT @limit`,
            { guildId, scopeKey, limit: cap }
        );

        const anchorId = 'you';
        const nodes = [{
            id: anchorId,
            type: 'person',
            label: userLabel,
            content: 'Your distilled knowledge — connected notes Goobster keeps about you.',
            salience: 1
        }];

        const idMap = new Map();
        for (const node of dbNodes) {
            const portalId = `kg:${node.id}`;
            idMap.set(node.id, portalId);
            nodes.push({
                id: portalId,
                type: node.type,
                label: node.label,
                content: node.content,
                salience: node.salience,
                confidence: node.confidence,
                source: node.source,
                ref: { kind: 'kg_node', id: node.id }
            });
        }

        const edges = [];
        let semanticEdgeCount = 0;
        if (dbNodes.length > 0) {
            const edgeRows = await this.edgesFor(guildId, dbNodes.map(n => n.id), scopeKey);
            semanticEdgeCount = edgeRows.length;
            for (const edge of edgeRows) {
                edges.push({
                    sourceId: idMap.get(edge.sourceId),
                    targetId: idMap.get(edge.targetId),
                    relation: edge.relation,
                    relationKind: edge.relationKind,
                    weight: edge.weight
                });
            }
            // Anchor unlinked high-salience nodes to the user
            const linked = new Set();
            for (const e of edges) {
                linked.add(e.sourceId);
                linked.add(e.targetId);
            }
            for (const node of nodes.slice(1)) {
                if (!linked.has(node.id) && (node.salience ?? 0) >= 0.55) {
                    edges.push({
                        sourceId: anchorId,
                        targetId: node.id,
                        relation: 'knows',
                        relationKind: 'associative',
                        weight: node.salience ?? 0.5
                    });
                }
            }
        }

        const tags = await this.getTagsForNodes(dbNodes.map(n => n.id));
        const provenanceMap = new Map();
        if (dbNodes.length > 0) {
            const placeholders = dbNodes.map((_, i) => `@n${i}`).join(', ');
            const params = {};
            dbNodes.forEach((n, i) => { params[`n${i}`] = n.id });
            const provRows = await db.all(
                `SELECT nodeId, sourceKind, sourceId, createdAt FROM kg_provenance
                 WHERE nodeId IN (${placeholders})
                 ORDER BY createdAt DESC`,
                params
            );
            for (const row of provRows) {
                if (!provenanceMap.has(row.nodeId)) provenanceMap.set(row.nodeId, []);
                provenanceMap.get(row.nodeId).push({
                    sourceKind: row.sourceKind,
                    sourceId: row.sourceId,
                    createdAt: row.createdAt
                });
            }
        }
        for (const node of nodes.slice(1)) {
            const kgId = Number(String(node.id).replace('kg:', ''));
            node.tags = tags.get(kgId) || [];
            node.provenance = provenanceMap.get(kgId) || [];
        }

        return {
            kind: 'personal',
            nodes,
            edges,
            counts: {
                nodes: dbNodes.length,
                edges: edges.length,
                semanticEdges: semanticEdgeCount,
                anchorEdges: Math.max(0, edges.length - semanticEdgeCount),
                memories: 0,
                tags: [...tags.values()].reduce((n, arr) => n + arr.length, 0),
                cap,
                truncated: dbNodes.length >= cap
            }
        };
    }

    /**
     * Replace a node's tags (used by the human note editor). Empty list clears.
     */
    async setTagsOnNode({ guildId, scopeKey = '', label, tags }) {
        const node = await this.getNode(guildId, label, scopeKey);
        if (!node) return 0;
        await db.run('DELETE FROM kg_node_tags WHERE nodeId = @id', { id: node.id });
        if (!Array.isArray(tags) || tags.length === 0) return 0;
        return this.addTagsToNode({ guildId, scopeKey, label, tags });
    }

    _shapeUserNote(node, tags = []) {
        if (!node) return null;
        return {
            id: node.id,
            type: node.type,
            label: node.label,
            content: node.content,
            salience: node.salience,
            confidence: node.confidence,
            source: node.source,
            tags,
            createdAt: node.createdAt,
            updatedAt: node.updatedAt
        };
    }

    /**
     * Browse the user's personal notes (the Spitball Notes tab).
     * Filters are exact on type/source/tag; q is a case-insensitive
     * substring of label, content, or tag name.
     */
    async listUserNotes({
        guildId, userId, q = '', type = null, tag = null, source = null,
        limit = 200, offset = 0
    } = {}) {
        const scopeKey = resolveScopeKey({ subjectType: 'USER', subjectId: userId });
        const query = String(q || '').trim();
        const typeFilter = type && NODE_TYPES.includes(type) ? type : null;
        const sourceFilter = source && NODE_SOURCES.includes(source) ? source : null;
        const tagFilter = tag ? normalizeTagName(tag) : null;
        const bounded = Math.max(1, Math.min(Number(limit) || 200, maxNodesForScope(scopeKey)));
        const skip = Math.max(0, Number(offset) || 0);

        const clauses = ['n.guildId = @guildId', 'n.scopeKey = @scopeKey'];
        const params = { guildId, scopeKey, limit: bounded, offset: skip };
        if (typeFilter) {
            clauses.push('n.type = @type');
            params.type = typeFilter;
        }
        if (sourceFilter) {
            clauses.push('n.source = @source');
            params.source = sourceFilter;
        }
        if (tagFilter) {
            clauses.push(`EXISTS (
                SELECT 1 FROM kg_node_tags nt JOIN kg_tags t ON t.id = nt.tagId
                WHERE nt.nodeId = n.id AND t.name = @tag
            )`);
            params.tag = tagFilter;
        }
        if (query) {
            clauses.push(`(
                n.label LIKE @q ESCAPE '#' OR n.content LIKE @q ESCAPE '#' OR EXISTS (
                    SELECT 1 FROM kg_node_tags nt JOIN kg_tags t ON t.id = nt.tagId
                    WHERE nt.nodeId = n.id AND t.name LIKE @q ESCAPE '#'
                )
            )`);
            params.q = `%${query.replace(/[#%_]/g, '#$&')}%`;
        }

        const where = clauses.join(' AND ');
        const totalRow = await db.get(
            `SELECT COUNT(*) AS c FROM kg_nodes n WHERE ${where}`, params
        );
        const rows = await db.all(
            `SELECT n.* FROM kg_nodes n
             WHERE ${where}
             ORDER BY n.updatedAt DESC, n.id DESC
             LIMIT @limit OFFSET @offset`,
            params
        );
        const tagMap = await this.getTagsForNodes(rows.map(row => row.id));
        const vocab = await db.all(
            `SELECT t.name, COUNT(nt.nodeId) AS uses
             FROM kg_tags t
             JOIN kg_node_tags nt ON nt.tagId = t.id
             WHERE t.guildId = @guildId AND t.scopeKey = @scopeKey
             GROUP BY t.id, t.name
             ORDER BY uses DESC, t.name LIMIT 80`,
            { guildId, scopeKey }
        );
        const typeRows = await db.all(
            `SELECT type, COUNT(*) AS c FROM kg_nodes
             WHERE guildId = @guildId AND scopeKey = @scopeKey
             GROUP BY type ORDER BY c DESC`,
            { guildId, scopeKey }
        );
        const sourceRows = await db.all(
            `SELECT source, COUNT(*) AS c FROM kg_nodes
             WHERE guildId = @guildId AND scopeKey = @scopeKey
             GROUP BY source ORDER BY c DESC`,
            { guildId, scopeKey }
        );
        return {
            notes: rows.map(row => this._shapeUserNote(row, tagMap.get(row.id) || [])),
            total: totalRow?.c || 0,
            cap: maxNodesForScope(scopeKey),
            types: typeRows,
            sources: sourceRows,
            tags: vocab,
            nodeTypes: NODE_TYPES,
            nodeSources: NODE_SOURCES
        };
    }

    /**
     * Human edit of a personal note. Records a human_edit revision so
     * research must not casually overwrite the preferred representation.
     */
    async updateUserNote({
        guildId, userId, nodeId, label, content, type, tags
    } = {}) {
        const scopeKey = resolveScopeKey({ subjectType: 'USER', subjectId: userId });
        const node = await db.get('SELECT * FROM kg_nodes WHERE id = @id', { id: Number(nodeId) });
        if (!node || node.guildId !== guildId || node.scopeKey !== scopeKey) return null;

        const nextLabel = label !== undefined ? normalizeLabel(label) : node.label;
        if (!nextLabel) {
            const error = new Error('Title is required.');
            error.status = 400;
            error.code = 'BAD_REQUEST';
            throw error;
        }
        if (nextLabel.toLowerCase() !== String(node.label).toLowerCase()) {
            const clash = await this.getNode(guildId, nextLabel, scopeKey);
            if (clash && clash.id !== node.id) {
                const error = new Error('A note with that title already exists.');
                error.status = 409;
                error.code = 'CONFLICT';
                throw error;
            }
        }
        const nextType = type && NODE_TYPES.includes(type) ? type : node.type;
        const nextContent = content !== undefined
            ? (content ? String(content).trim().slice(0, MAX_CONTENT_LENGTH) : null)
            : node.content;

        await db.run(
            `UPDATE kg_nodes SET
                 label = @label, type = @type, content = @content,
                 source = 'user', updatedAt = CURRENT_TIMESTAMP
             WHERE id = @id`,
            { id: node.id, label: nextLabel, type: nextType, content: nextContent }
        );
        const materiallyChanged = nextLabel !== node.label
            || nextType !== node.type
            || nextContent !== (node.content || null);
        if (materiallyChanged) {
            await this._recordRevision(node.id, 'user');
        }
        if (Array.isArray(tags)) {
            await this.setTagsOnNode({ guildId, scopeKey, label: nextLabel, tags });
        }
        const fresh = await db.get('SELECT * FROM kg_nodes WHERE id = @id', { id: node.id });
        const tagMap = await this.getTagsForNodes([node.id]);
        return this._shapeUserNote(fresh, tagMap.get(node.id) || []);
    }

    async deleteUserNote({ guildId, userId, nodeId } = {}) {
        const scopeKey = resolveScopeKey({ subjectType: 'USER', subjectId: userId });
        const node = await db.get(
            'SELECT id FROM kg_nodes WHERE id = @id AND guildId = @guildId AND scopeKey = @scopeKey',
            { id: Number(nodeId), guildId, scopeKey }
        );
        if (!node) return 0;
        return (await db.run('DELETE FROM kg_nodes WHERE id = @id', { id: node.id })).changes;
    }

    /**
     * Manual create of a personal note. Distinct from upsertNode so a
     * colliding title is a 409 instead of a silent overwrite.
     */
    async createUserNote({
        guildId, userId, label, content, type, tags
    } = {}) {
        const scopeKey = resolveScopeKey({ subjectType: 'USER', subjectId: userId });
        const cleanLabel = normalizeLabel(label);
        if (!cleanLabel) {
            const error = new Error('Title is required.');
            error.status = 400;
            error.code = 'BAD_REQUEST';
            throw error;
        }
        const clash = await this.getNode(guildId, cleanLabel, scopeKey);
        if (clash) {
            const error = new Error('A note with that title already exists.');
            error.status = 409;
            error.code = 'CONFLICT';
            throw error;
        }
        const cleanType = type && NODE_TYPES.includes(type) ? type : 'concept';
        const cleanContent = content
            ? String(content).trim().slice(0, MAX_CONTENT_LENGTH)
            : null;
        const created = await this.upsertNode({
            guildId,
            scopeKey,
            subjectType: 'USER',
            subjectId: userId,
            type: cleanType,
            label: cleanLabel,
            content: cleanContent,
            source: 'user'
        });
        if (Array.isArray(tags) && tags.length) {
            await this.addTagsToNode({ guildId, scopeKey, label: cleanLabel, tags });
        }
        const fresh = await db.get('SELECT * FROM kg_nodes WHERE id = @id', { id: created.id });
        const tagMap = await this.getTagsForNodes([created.id]);
        return this._shapeUserNote(fresh, tagMap.get(created.id) || []);
    }

    /**
     * List fact-type nodes (Phase 4: canonical read path for factsService).
     */
    async listFactNodes({ guildId, subjectType, subjectId, limit = 50 }) {
        const scopeKey = resolveScopeKey({ subjectType, subjectId });
        await this.syncLegacyFacts({ guildId, subjectType, subjectId });
        return await db.all(
            `SELECT n.id, n.label, n.content, n.updatedAt, n.source AS nodeSource
             FROM kg_nodes n
             WHERE n.guildId = @guildId AND n.scopeKey = @scopeKey AND n.type = 'fact'
             ORDER BY n.updatedAt DESC, n.id DESC LIMIT @limit`,
            { guildId, scopeKey, limit }
        );
    }

    async applyMutations(params) {
        return this._legalizer.applyMutations(params);
    }
}

module.exports = new KnowledgeGraphService();
module.exports.hasMutationWork = KnowledgeGraphService.hasMutationWork;
module.exports.hasMutationPayload = KnowledgeGraphService.hasMutationPayload;
