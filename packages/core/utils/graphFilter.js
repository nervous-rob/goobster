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

module.exports = { filterConstellation };
