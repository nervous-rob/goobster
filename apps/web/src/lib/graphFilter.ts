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
    relation?: string;
    relationKind?: string;
    weight?: number;
    viaTag?: string;
    derived?: boolean;
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

const TAG_CLIQUE_LIMIT = 6;

function pairKey(a: string | number, b: string | number): string {
    const left = String(a);
    const right = String(b);
    return left < right ? `${left}\0${right}` : `${right}\0${left}`;
}

function salienceOf(node: GraphFilterNode & { salience?: number }): number {
    const n = Number(node?.salience);
    return Number.isFinite(n) ? n : 0;
}

export function tagLinks<N extends GraphFilterNode & { salience?: number }>(
    nodes: N[] = [],
    existing: GraphFilterEdge[] = []
): GraphFilterEdge[] {
    const groups = new Map<string, N[]>();
    for (const node of nodes) {
        if (node == null || node.id == null || node.id === 'you') continue;
        const tags = Array.isArray(node.tags) ? node.tags : [];
        for (const raw of tags) {
            const tag = normalize(raw);
            if (!tag) continue;
            const list = groups.get(tag);
            if (list) list.push(node);
            else groups.set(tag, [node]);
        }
    }

    const seen = new Set<string>();
    for (const edge of existing) {
        if (edge?.sourceId == null || edge?.targetId == null) continue;
        if (edge.sourceId === edge.targetId) continue;
        seen.add(pairKey(edge.sourceId, edge.targetId));
    }

    const edges: GraphFilterEdge[] = [];
    for (const [tag, members] of groups) {
        const unique: N[] = [];
        const ids = new Set<string | number>();
        for (const node of members) {
            if (node.id == null || ids.has(node.id)) continue;
            ids.add(node.id);
            unique.push(node);
        }
        if (unique.length < 2) continue;
        unique.sort((a, b) => salienceOf(b) - salienceOf(a) || String(a.id).localeCompare(String(b.id)));

        const pairs: Array<[N, N]> = [];
        if (unique.length <= TAG_CLIQUE_LIMIT) {
            for (let i = 0; i < unique.length; i++) {
                for (let j = i + 1; j < unique.length; j++) {
                    pairs.push([unique[i], unique[j]]);
                }
            }
        } else {
            const hub = unique[0];
            for (let i = 1; i < unique.length; i++) pairs.push([hub, unique[i]]);
        }

        for (const [a, b] of pairs) {
            if (a.id == null || b.id == null) continue;
            const key = pairKey(a.id, b.id);
            if (seen.has(key)) continue;
            seen.add(key);
            edges.push({
                sourceId: a.id,
                targetId: b.id,
                relation: 'tagged',
                relationKind: 'associative',
                weight: 0.28,
                viaTag: tag,
                derived: true
            });
        }
    }
    return edges;
}

export function withTagLinks<
    N extends GraphFilterNode & { salience?: number },
    E extends GraphFilterEdge
>(
    graph: { nodes?: N[]; edges?: E[] } | null | undefined,
    enabled: boolean
): { nodes: N[]; edges: Array<E | GraphFilterEdge> } {
    const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
    const edges = Array.isArray(graph?.edges) ? graph.edges : [];
    if (!enabled) return { nodes, edges };
    return { nodes, edges: edges.concat(tagLinks(nodes, edges) as E[]) };
}
