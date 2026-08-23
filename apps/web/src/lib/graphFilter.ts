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
    salience?: number;
    derived?: boolean;
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

function pairKey(a: string | number, b: string | number): string {
    const left = String(a);
    const right = String(b);
    return left < right ? `${left}\0${right}` : `${right}\0${left}`;
}

export function tagNodeId(tag: string): string {
    return `tag:${tag}`;
}

export type TagHubNode = GraphFilterNode & {
    id: string;
    type: 'tag';
    derived: true;
};

export function tagHubs<N extends GraphFilterNode>(
    nodes: N[] = [],
    existing: GraphFilterEdge[] = []
): { nodes: TagHubNode[]; edges: GraphFilterEdge[] } {
    const occupied = new Set<string>();
    for (const node of nodes) {
        if (node?.id != null) occupied.add(String(node.id));
    }

    const groups = new Map<string, { label: string; members: N[] }>();
    for (const node of nodes) {
        if (node == null || node.id == null || node.id === 'you') continue;
        if (node.type === 'tag') continue;
        const tags = Array.isArray(node.tags) ? node.tags : [];
        for (const raw of tags) {
            const tag = normalize(raw);
            if (!tag) continue;
            if (occupied.has(tagNodeId(tag))) continue;
            const label = String(raw).trim() || tag;
            const list = groups.get(tag);
            if (list) list.members.push(node);
            else groups.set(tag, { label, members: [node] });
        }
    }

    const seen = new Set<string>();
    for (const edge of existing) {
        if (edge?.sourceId == null || edge?.targetId == null) continue;
        if (edge.sourceId === edge.targetId) continue;
        seen.add(pairKey(edge.sourceId, edge.targetId));
    }

    const hubs: TagHubNode[] = [];
    const edges: GraphFilterEdge[] = [];
    for (const [tag, group] of groups) {
        const unique: N[] = [];
        const ids = new Set<string | number>();
        for (const node of group.members) {
            if (node.id == null || ids.has(node.id)) continue;
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
            if (node.id == null) continue;
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

export function withTagLinks<
    N extends GraphFilterNode,
    E extends GraphFilterEdge
>(
    graph: { nodes?: N[]; edges?: E[] } | null | undefined,
    enabled: boolean
): { nodes: Array<N | TagHubNode>; edges: Array<E | GraphFilterEdge> } {
    const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
    const edges = Array.isArray(graph?.edges) ? graph.edges : [];
    if (!enabled) return { nodes, edges };
    const hubs = tagHubs(nodes, edges);
    return { nodes: [...nodes, ...hubs.nodes], edges: [...edges, ...hubs.edges] };
}
