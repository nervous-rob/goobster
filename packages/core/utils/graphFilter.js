/**
 * Client-side constellation filter. Pure: the Map keeps the full payload
 * and hides nodes that don't match search / type / tag / source so the
 * user can navigate a graph that is otherwise too dense.
 *
 * The `you` anchor is always kept so the personal map never loses its
 * center. Edges whose endpoints dropped out are dropped with them.
 */

function normalize(value) {
    return String(value || '').trim().toLowerCase();
}

function nodeHaystack(node) {
    const tags = Array.isArray(node.tags) ? node.tags : [];
    return [node.label, node.content, ...tags].map(normalize).join(' ');
}

function nodeHasTag(node, tag) {
    if (!tag) return true;
    const tags = Array.isArray(node.tags) ? node.tags : [];
    return tags.some((item) => normalize(item) === tag);
}

/**
 * @param {{ nodes?: object[], edges?: object[] }} graph
 * @param {{ q?: string, type?: string, tag?: string, source?: string }} filters
 * @returns {{ nodes: object[], edges: object[] }}
 */
function filterConstellation(graph, filters = {}) {
    const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
    const edges = Array.isArray(graph?.edges) ? graph.edges : [];
    const q = normalize(filters.q);
    const type = String(filters.type || '').trim();
    const tag = normalize(filters.tag);
    const source = String(filters.source || '').trim();
    const active = Boolean(q || type || tag || source);

    if (!active) return { nodes, edges };

    const filteredNodes = nodes.filter((node) => {
        if (node.id === 'you') return true;
        if (type && node.type !== type) return false;
        if (source && node.source !== source) return false;
        if (!nodeHasTag(node, tag)) return false;
        if (q && !nodeHaystack(node).includes(q)) return false;
        return true;
    });
    const ids = new Set(filteredNodes.map((node) => node.id));
    const filteredEdges = edges.filter((edge) => (
        ids.has(edge.sourceId) && ids.has(edge.targetId)
    ));
    return { nodes: filteredNodes, edges: filteredEdges };
}

function pairKey(a, b) {
    const left = String(a);
    const right = String(b);
    return left < right ? `${left}\0${right}` : `${right}\0${left}`;
}

function tagNodeId(tag) {
    return `tag:${tag}`;
}

/**
 * Visual-only tag hubs. Never written to kg_nodes / kg_edges.
 * Each distinct tag becomes a `type: 'tag'` node; notes connect to it
 * with a standard `tagged` edge (Parlor's tag-first shape). The `you`
 * anchor is skipped. A second pass on an already-augmented graph is a no-op.
 *
 * @param {object[]} nodes
 * @param {object[]} [existing]
 * @returns {{ nodes: object[], edges: object[] }}
 */
function tagHubs(nodes = [], existing = []) {
    const occupied = new Set();
    for (const node of nodes) {
        if (node?.id != null) occupied.add(String(node.id));
    }

    const groups = new Map();
    for (const node of nodes) {
        if (node == null || node.id == null || node.id === 'you') continue;
        if (node.type === 'tag') continue;
        const tags = Array.isArray(node.tags) ? node.tags : [];
        for (const raw of tags) {
            const tag = normalize(raw);
            if (!tag) continue;
            const id = tagNodeId(tag);
            if (occupied.has(id)) continue;
            const label = String(raw).trim() || tag;
            const list = groups.get(tag);
            if (list) list.members.push(node);
            else groups.set(tag, { label, members: [node] });
        }
    }

    const seen = new Set();
    for (const edge of existing) {
        if (edge?.sourceId == null || edge?.targetId == null) continue;
        if (edge.sourceId === edge.targetId) continue;
        seen.add(pairKey(edge.sourceId, edge.targetId));
    }

    const hubs = [];
    const edges = [];
    for (const [tag, group] of groups) {
        const unique = [];
        const ids = new Set();
        for (const node of group.members) {
            if (ids.has(node.id)) continue;
            ids.add(node.id);
            unique.push(node);
        }
        if (unique.length < 1) continue;

        const id = tagNodeId(tag);
        hubs.push({
            id,
            type: 'tag',
            label: group.label,
            content: unique.length === 1
                ? '1 note carries this tag'
                : `${unique.length} notes carry this tag`,
            source: 'derived',
            tags: [group.label],
            salience: Math.min(1, 0.4 + unique.length * 0.06),
            derived: true
        });

        for (const node of unique) {
            const key = pairKey(node.id, id);
            if (seen.has(key)) continue;
            seen.add(key);
            edges.push({
                sourceId: node.id,
                targetId: id,
                relation: 'tagged',
                relationKind: 'associative',
                weight: 0.6,
                viaTag: tag,
                derived: true
            });
        }
    }
    return { nodes: hubs, edges };
}

/**
 * Overlay tag hubs on a (possibly filtered) constellation. Off by default.
 * @param {{ nodes?: object[], edges?: object[] }} graph
 * @param {boolean} enabled
 */
function withTagLinks(graph, enabled) {
    const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
    const edges = Array.isArray(graph?.edges) ? graph.edges : [];
    if (!enabled) return { nodes, edges };
    const hubs = tagHubs(nodes, edges);
    return { nodes: nodes.concat(hubs.nodes), edges: edges.concat(hubs.edges) };
}

module.exports = { filterConstellation, tagHubs, withTagLinks, tagNodeId };
