/**
 * Client-side constellation filter. Pure: the Map keeps the full payload
 * and hides nodes that don't match search / type / tag / source so the
 * user can navigate a graph that is otherwise too dense.
 *
 * The `you` anchor is always kept so the personal map never loses its
 * center. Edges whose endpoints dropped out are dropped with them.
 *
 * Tag hubs (and the parent/child grouping derived from co-occurrence)
 * are overlaid by withTagLinks so the renderer can clump notes without
 * writing anything to kg_nodes.
 */

const { attachTagHubs } = require('./graphClusters');

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
    const result = withTagLinks({ nodes, edges: existing }, true);
    const originalIds = new Set(nodes.map((node) => node.id));
    return {
        nodes: result.nodes.filter((node) => node.type === 'tag' && !originalIds.has(node.id)),
        edges: result.edges.filter((edge) => edge.derived)
    };
}

/**
 * Overlay tag hubs on a (possibly filtered) constellation. On by default in the Map UI.
 * @param {{ nodes?: object[], edges?: object[] }} graph
 * @param {boolean} enabled
 */
function withTagLinks(graph, enabled) {
    const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
    const edges = Array.isArray(graph?.edges) ? graph.edges : [];
    if (!enabled) return { nodes, edges };
    const grouped = attachTagHubs(nodes, edges);
    const originalIds = new Set(nodes.map((node) => node.id));
    return {
        nodes: grouped.nodes.map((node) => {
            if (node.type === 'tag' && !originalIds.has(node.id)) {
                return {
                    ...node,
                    derived: true,
                    source: node.source || 'derived',
                    tags: node.tags?.length ? node.tags : [node.label]
                };
            }
            return node;
        }),
        edges: grouped.edges.map((edge) => {
            if (!edge.kind) return edge;
            const via = edge.kind === 'tag' && String(edge.targetId || '').startsWith('tag:')
                ? String(edge.targetId).slice(4)
                : undefined;
            return { ...edge, derived: true, viaTag: via || edge.viaTag };
        }),
        tags: grouped.tags,
        clusters: grouped.clusters
    };
}

module.exports = { filterConstellation, tagHubs, withTagLinks, tagNodeId };
