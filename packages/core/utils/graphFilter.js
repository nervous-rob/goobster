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

function asList(single, many) {
    if (Array.isArray(many) && many.length) {
        return many.map((item) => String(item || '').trim()).filter(Boolean);
    }
    const one = String(single || '').trim();
    return one ? [one] : [];
}

function asNormList(single, many) {
    return asList(single, many).map(normalize).filter(Boolean);
}

function nodeHasAnyTag(node, tags) {
    if (!tags.length) return true;
    const have = (Array.isArray(node.tags) ? node.tags : []).map(normalize);
    return tags.some((tag) => have.includes(tag));
}

function resolveFilters(filters = {}) {
    return {
        q: normalize(filters.q),
        types: asList(filters.type, filters.types),
        tags: asNormList(filters.tag, filters.tags),
        sources: asList(filters.source, filters.sources)
    };
}

function nodeMatchesFilters(node, resolved) {
    if (!node || node.id === 'you') return true;
    if (resolved.types.length && !resolved.types.includes(node.type)) return false;
    if (resolved.sources.length && !resolved.sources.includes(node.source)) return false;
    if (!nodeHasAnyTag(node, resolved.tags)) return false;
    if (resolved.q && !nodeHaystack(node).includes(resolved.q)) return false;
    return true;
}

/**
 * @param {{ nodes?: object[], edges?: object[] }} graph
 * @param {{ q?: string, type?: string, types?: string[], tag?: string, tags?: string[], source?: string, sources?: string[] }} filters
 * @returns {{ nodes: object[], edges: object[] }}
 */
function filterConstellation(graph, filters = {}) {
    const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
    const edges = Array.isArray(graph?.edges) ? graph.edges : [];
    const resolved = resolveFilters(filters);
    const active = Boolean(
        resolved.q || resolved.types.length || resolved.tags.length || resolved.sources.length
    );

    if (!active) return { nodes, edges };

    const filteredNodes = nodes.filter((node) => nodeMatchesFilters(node, resolved));
    const ids = new Set(filteredNodes.map((node) => node.id));
    const filteredEdges = edges.filter((edge) => (
        ids.has(edge.sourceId) && ids.has(edge.targetId)
    ));
    return { nodes: filteredNodes, edges: filteredEdges };
}

/**
 * Counts for slicer checkboxes. Each facet ignores its own selection so
 * picking "concept" does not hide the other type rows.
 * @returns {{ types: Array<{value: string, count: number}>, tags: Array<{value: string, count: number}>, sources: Array<{value: string, count: number}> }}
 */
function facetCounts(graph, filters = {}) {
    const tally = (nodes, pick) => {
        const counts = new Map();
        for (const node of nodes || []) {
            if (!node || node.id === 'you' || node.type === 'tag') continue;
            const values = pick(node);
            const seen = new Set();
            for (const raw of values) {
                const value = String(raw || '').trim();
                if (!value || seen.has(value)) continue;
                seen.add(value);
                counts.set(value, (counts.get(value) || 0) + 1);
            }
        }
        return [...counts.entries()]
            .map(([value, count]) => ({ value, count }))
            .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
    };
    const typeNodes = filterConstellation(graph, { ...filters, type: '', types: [] }).nodes;
    const tagNodes = filterConstellation(graph, { ...filters, tag: '', tags: [] }).nodes;
    const sourceNodes = filterConstellation(graph, { ...filters, source: '', sources: [] }).nodes;
    return {
        types: tally(typeNodes, (node) => (node.type ? [node.type] : [])),
        tags: tally(tagNodes, (node) => node.tags || []),
        sources: tally(sourceNodes, (node) => (node.source ? [node.source] : []))
    };
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
        clusters: grouped.clusters,
        collapsed: grouped.collapsed
    };
}

module.exports = { filterConstellation, facetCounts, tagHubs, withTagLinks, tagNodeId };
