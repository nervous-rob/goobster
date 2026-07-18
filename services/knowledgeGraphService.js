const db = require('../db');

// Caps keep the graph bounded on low-power hardware; pruning drops the
// least salient, least recently touched nodes first (edges cascade).
const MAX_NODES_PER_GUILD = 500;
const MAX_EDGES_PER_GUILD = 1500;
const MAX_LABEL_LENGTH = 120;
const MAX_CONTENT_LENGTH = 1000;
const MAX_RELATION_LENGTH = 60;

const NODE_TYPES = ['concept', 'fact', 'opinion', 'experience', 'person', 'place', 'event', 'thing'];

function clamp01(value, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(1, Math.max(0, n));
}

function normalizeLabel(label) {
    return String(label || '').trim().slice(0, MAX_LABEL_LENGTH);
}

/**
 * Per-guild knowledge graph: a semantic network of nodes (concepts, facts,
 * opinions, experiences, people, places, events, things) connected by typed,
 * weighted edges ("dimensional links"). Maintained primarily by the internal
 * monologue (services/monologueService.js), which creates, queries, updates,
 * and deletes nodes as it reflects on server life.
 *
 * All methods are synchronous (better-sqlite3) and safe to call from
 * fire-and-forget paths; validation failures return null/0 rather than throw.
 */
class KnowledgeGraphService {
    get nodeTypes() {
        return NODE_TYPES;
    }

    /**
     * Create a node, or update it when a node with the same label already
     * exists in the guild (labels are unique per guild, case-insensitive).
     * Omitted fields (type/content/salience) are preserved on update.
     * @param {Object} node - { guildId, type, label, content, salience }
     * @returns {{id: number, created: boolean}|null} null when invalid
     */
    upsertNode({ guildId, type = null, label, content = null, salience } = {}) {
        const cleanLabel = normalizeLabel(label);
        if (!guildId || !cleanLabel) return null;

        const cleanType = type && NODE_TYPES.includes(type) ? type : null;
        const cleanContent = content ? String(content).trim().slice(0, MAX_CONTENT_LENGTH) : null;

        const existing = db.get(
            'SELECT id FROM kg_nodes WHERE guildId = @guildId AND label = @label',
            { guildId, label: cleanLabel }
        );

        if (existing) {
            db.run(
                `UPDATE kg_nodes SET
                     type = COALESCE(@type, type),
                     content = COALESCE(@content, content),
                     salience = COALESCE(@salience, salience),
                     updatedAt = CURRENT_TIMESTAMP
                 WHERE id = @id`,
                {
                    id: existing.id,
                    type: cleanType,
                    content: cleanContent,
                    salience: salience === undefined ? null : clamp01(salience, 0.5)
                }
            );
            return { id: existing.id, created: false };
        }

        const result = db.run(
            `INSERT INTO kg_nodes (guildId, type, label, content, salience)
             VALUES (@guildId, @type, @label, @content, @salience)`,
            {
                guildId,
                type: cleanType || 'concept',
                label: cleanLabel,
                content: cleanContent,
                salience: clamp01(salience, 0.5)
            }
        );
        this._pruneNodes(guildId);
        return { id: Number(result.lastInsertRowid), created: true };
    }

    /**
     * Fetch a node by label (case-insensitive) or undefined.
     */
    getNode(guildId, label) {
        return db.get(
            'SELECT * FROM kg_nodes WHERE guildId = @guildId AND label = @label',
            { guildId, label: normalizeLabel(label) }
        );
    }

    /**
     * Delete a node by label. Incident edges cascade.
     * @returns {number} rows removed (0 or 1)
     */
    deleteNode(guildId, label) {
        const cleanLabel = normalizeLabel(label);
        if (!guildId || !cleanLabel) return 0;
        return db.run(
            'DELETE FROM kg_nodes WHERE guildId = @guildId AND label = @label',
            { guildId, label: cleanLabel }
        ).changes;
    }

    /**
     * Keyword search over labels and content. The query is split into terms
     * and nodes matching any term are returned, most salient first.
     * @param {Object} params - { guildId, query, type, limit }
     */
    searchNodes({ guildId, query, type = null, limit = 10 }) {
        if (!guildId) return [];
        const terms = String(query || '')
            .toLowerCase()
            .split(/[^\p{L}\p{N}]+/u)
            .filter(t => t.length >= 3)
            .slice(0, 12);
        if (terms.length === 0) return [];

        const clauses = terms.map((_, i) => `(label LIKE @t${i} OR content LIKE @t${i})`);
        const params = { guildId, limit };
        terms.forEach((t, i) => { params[`t${i}`] = `%${t}%`; });

        let sql = `SELECT * FROM kg_nodes WHERE guildId = @guildId AND (${clauses.join(' OR ')})`;
        if (type && NODE_TYPES.includes(type)) {
            sql += ' AND type = @type';
            params.type = type;
        }
        sql += ' ORDER BY salience DESC, updatedAt DESC LIMIT @limit';
        return db.all(sql, params);
    }

    /**
     * Most salient, most recently touched nodes for a guild.
     */
    topNodes(guildId, limit = 10) {
        return db.all(
            `SELECT * FROM kg_nodes WHERE guildId = @guildId
             ORDER BY salience DESC, updatedAt DESC LIMIT @limit`,
            { guildId, limit }
        );
    }

    /**
     * Create or update a semantic edge between two nodes (referenced by
     * label). Missing endpoints are auto-created as stub concept nodes so the
     * monologue can link freely without strict ordering.
     * @param {Object} edge - { guildId, source, target, relation, weight }
     * @returns {{id: number}|null} null when invalid (e.g. self-loop)
     */
    link({ guildId, source, target, relation, weight } = {}) {
        const sourceLabel = normalizeLabel(source);
        const targetLabel = normalizeLabel(target);
        const cleanRelation = String(relation || '').trim().slice(0, MAX_RELATION_LENGTH);
        if (!guildId || !sourceLabel || !targetLabel || !cleanRelation) return null;
        if (sourceLabel.toLowerCase() === targetLabel.toLowerCase()) return null;

        // Touch (or stub-create) both endpoints so links never dangle
        const sourceNode = this.upsertNode({ guildId, label: sourceLabel });
        const targetNode = this.upsertNode({ guildId, label: targetLabel });
        if (!sourceNode || !targetNode) return null;

        db.run(
            `INSERT INTO kg_edges (guildId, sourceId, targetId, relation, weight)
             VALUES (@guildId, @sourceId, @targetId, @relation, @weight)
             ON CONFLICT(guildId, sourceId, targetId, relation) DO UPDATE SET
                 weight = @weight,
                 updatedAt = CURRENT_TIMESTAMP`,
            {
                guildId,
                sourceId: sourceNode.id,
                targetId: targetNode.id,
                relation: cleanRelation,
                weight: clamp01(weight, 0.5)
            }
        );
        this._pruneEdges(guildId);

        const row = db.get(
            `SELECT id FROM kg_edges
             WHERE guildId = @guildId AND sourceId = @sourceId AND targetId = @targetId AND relation = @relation`,
            { guildId, sourceId: sourceNode.id, targetId: targetNode.id, relation: cleanRelation }
        );
        return row ? { id: row.id } : null;
    }

    /**
     * Remove edges between two nodes (optionally only a specific relation).
     * @returns {number} rows removed
     */
    unlink({ guildId, source, target, relation = null } = {}) {
        const sourceNode = this.getNode(guildId, source);
        const targetNode = this.getNode(guildId, target);
        if (!sourceNode || !targetNode) return 0;

        let sql = `DELETE FROM kg_edges
                   WHERE guildId = @guildId AND sourceId = @sourceId AND targetId = @targetId`;
        const params = { guildId, sourceId: sourceNode.id, targetId: targetNode.id };
        if (relation) {
            sql += ' AND relation = @relation';
            params.relation = String(relation).trim().slice(0, MAX_RELATION_LENGTH);
        }
        return db.run(sql, params).changes;
    }

    /**
     * Edges incident to a set of node ids (both directions), with endpoint
     * labels resolved for rendering.
     */
    edgesFor(guildId, nodeIds) {
        if (!Array.isArray(nodeIds) || nodeIds.length === 0) return [];
        const placeholders = nodeIds.map((_, i) => `@n${i}`).join(', ');
        const params = { guildId };
        nodeIds.forEach((id, i) => { params[`n${i}`] = id; });

        return db.all(
            `SELECT e.id, e.sourceId, e.targetId, e.relation, e.weight,
                    s.label AS sourceLabel, t.label AS targetLabel
             FROM kg_edges e
             JOIN kg_nodes s ON s.id = e.sourceId
             JOIN kg_nodes t ON t.id = e.targetId
             WHERE e.guildId = @guildId
               AND (e.sourceId IN (${placeholders}) OR e.targetId IN (${placeholders}))
             ORDER BY e.weight DESC`,
            params
        );
    }

    /**
     * Breadth-first neighborhood expansion from a node, following edges in
     * both directions up to `depth` hops.
     * @param {Object} params - { guildId, label, depth, maxNodes }
     * @returns {{nodes: Array, edges: Array}} empty result when the node is unknown
     */
    getNeighborhood({ guildId, label, depth = 1, maxNodes = 15 } = {}) {
        const start = this.getNode(guildId, label);
        if (!start) return { nodes: [], edges: [] };

        const visited = new Map([[start.id, start]]);
        let frontier = [start.id];

        for (let hop = 0; hop < depth && frontier.length > 0 && visited.size < maxNodes; hop++) {
            const edges = this.edgesFor(guildId, frontier);
            const next = [];
            for (const edge of edges) {
                for (const nodeId of [edge.sourceId, edge.targetId]) {
                    if (visited.has(nodeId) || visited.size >= maxNodes) continue;
                    const node = db.get('SELECT * FROM kg_nodes WHERE id = @id', { id: nodeId });
                    if (node) {
                        visited.set(nodeId, node);
                        next.push(nodeId);
                    }
                }
            }
            frontier = next;
        }

        const nodes = [...visited.values()];
        const edgeRows = this.edgesFor(guildId, nodes.map(n => n.id))
            .filter(e => visited.has(e.sourceId) && visited.has(e.targetId));
        return { nodes, edges: edgeRows };
    }

    /**
     * Render a set of nodes and edges as compact prompt text.
     * @returns {string|null} null when there is nothing to show
     */
    formatSubgraph({ nodes, edges }) {
        if (!nodes || nodes.length === 0) return null;

        const lines = nodes.map(n => {
            const detail = n.content ? `: ${n.content}` : '';
            return `- [${n.type}] "${n.label}" (salience ${Number(n.salience).toFixed(2)})${detail}`;
        });
        for (const edge of edges || []) {
            lines.push(`- "${edge.sourceLabel}" --${edge.relation}--> "${edge.targetLabel}" (weight ${Number(edge.weight).toFixed(2)})`);
        }
        return lines.join('\n');
    }

    /**
     * Convenience: nodes relevant to a query (falling back to the most
     * salient nodes) plus the edges among them, formatted for a prompt.
     * @param {Object} params - { guildId, query, limit }
     * @returns {string|null}
     */
    describeForPrompt({ guildId, query = null, limit = 10 } = {}) {
        let nodes = query ? this.searchNodes({ guildId, query, limit }) : [];
        if (nodes.length === 0) {
            nodes = this.topNodes(guildId, limit);
        }
        if (nodes.length === 0) return null;

        const ids = new Set(nodes.map(n => n.id));
        const edges = this.edgesFor(guildId, [...ids])
            .filter(e => ids.has(e.sourceId) && ids.has(e.targetId));
        return this.formatSubgraph({ nodes, edges });
    }

    getStats(guildId) {
        const nodes = db.get(
            'SELECT COUNT(*) AS c FROM kg_nodes WHERE guildId = @guildId', { guildId }
        ).c;
        const edges = db.get(
            'SELECT COUNT(*) AS c FROM kg_edges WHERE guildId = @guildId', { guildId }
        ).c;
        return { nodes, edges };
    }

    /**
     * Delete the whole graph for a guild.
     * @returns {number} nodes removed (edges cascade)
     */
    forgetGuild(guildId) {
        return db.run('DELETE FROM kg_nodes WHERE guildId = @guildId', { guildId }).changes;
    }

    _pruneNodes(guildId) {
        db.run(
            `DELETE FROM kg_nodes
             WHERE guildId = @guildId
               AND id NOT IN (
                   SELECT id FROM kg_nodes WHERE guildId = @guildId
                   ORDER BY salience DESC, updatedAt DESC, id DESC LIMIT @max
               )`,
            { guildId, max: MAX_NODES_PER_GUILD }
        );
    }

    _pruneEdges(guildId) {
        db.run(
            `DELETE FROM kg_edges
             WHERE guildId = @guildId
               AND id NOT IN (
                   SELECT id FROM kg_edges WHERE guildId = @guildId
                   ORDER BY weight DESC, updatedAt DESC, id DESC LIMIT @max
               )`,
            { guildId, max: MAX_EDGES_PER_GUILD }
        );
    }
}

module.exports = new KnowledgeGraphService();
