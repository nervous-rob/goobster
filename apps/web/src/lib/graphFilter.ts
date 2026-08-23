/**
 * Client-side constellation filter. Mirrors packages/core/utils/graphFilter.js
 * so the Map can hide nodes without another round-trip.
 */

export type GraphFilterNode = {
    id?: string | number;
    type?: string;
    label?: string;
    content?: string;
    source?: string;
    tags?: string[];
};

export type GraphFilterEdge = {
    sourceId?: string | number;
    targetId?: string | number;
};

export type GraphFilters = {
    q?: string;
    type?: string;
    tag?: string;
    source?: string;
};

function normalize(value: unknown): string {
    return String(value || '').trim().toLowerCase();
}

function nodeHaystack(node: GraphFilterNode): string {
    const tags = Array.isArray(node.tags) ? node.tags : [];
    return [node.label, node.content, ...tags].map(normalize).join(' ');
}

function nodeHasTag(node: GraphFilterNode, tag: string): boolean {
    if (!tag) return true;
    const tags = Array.isArray(node.tags) ? node.tags : [];
    return tags.some((item) => normalize(item) === tag);
}

export function filterConstellation<
    N extends GraphFilterNode,
    E extends GraphFilterEdge
>(
    graph: { nodes?: N[]; edges?: E[] } | null | undefined,
    filters: GraphFilters = {}
): { nodes: N[]; edges: E[] } {
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
