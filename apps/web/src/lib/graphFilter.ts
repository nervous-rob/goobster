/**
 * Client-side constellation filter. Mirrors packages/core/utils/graphFilter.js
 * + graphClusters.js so the Map can hide nodes and group tags without
 * another round-trip. Keep this file in lockstep with the CommonJS copies.
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
    cluster?: string | null;
    parentTag?: string | null;
    rootTag?: string | null;
    memberCount?: number;
    childTags?: string[];
    collapsedHub?: boolean;
    foldedFrom?: string | null;
    memberships?: string[];
    satellite?: boolean;
};

export type GraphFilterEdge = {
    sourceId?: string | number;
    targetId?: string | number;
    relation?: string;
    relationKind?: string;
    weight?: number;
    viaTag?: string;
    derived?: boolean;
    kind?: 'tag' | 'hierarchy' | 'overlap' | string;
    shared?: number;
};

export type GraphFilters = {
    q?: string;
    type?: string;
    tag?: string;
    source?: string;
};

type TagEntry = { name: string; nodeIds: Array<string | number>; count: number };
type HierarchyInfo = {
    parent: string | null;
    children: string[];
    root: string;
    depth: number;
    count: number;
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

function cleanTagName(value: unknown): string | null {
    const text = normalize(value);
    return text || null;
}

function buildTagIndex(nodes: GraphFilterNode[]): Map<string, TagEntry> {
    const index = new Map<string, TagEntry>();
    for (const node of nodes || []) {
        if (!node || node.type === 'tag' || node.id === 'you') continue;
        const seen = new Set<string>();
        for (const raw of node.tags || []) {
            const name = cleanTagName(raw);
            if (!name || seen.has(name)) continue;
            seen.add(name);
            let entry = index.get(name);
            if (!entry) {
                entry = { name, nodeIds: [], count: 0 };
                index.set(name, entry);
            }
            if (node.id != null) entry.nodeIds.push(node.id);
            entry.count += 1;
        }
    }
    return index;
}

function coverage(smaller: TagEntry, larger: TagEntry): number {
    if (!smaller?.count) return 0;
    const largerSet = new Set(larger.nodeIds.map(String));
    let hits = 0;
    for (const id of smaller.nodeIds) {
        if (largerSet.has(String(id))) hits += 1;
    }
    return hits / smaller.count;
}

function buildTagHierarchy(
    tagIndex: Map<string, TagEntry>,
    { minCoverage = 0.6 } = {}
): Record<string, HierarchyInfo> {
    const tags = [...tagIndex.values()].sort((a, b) => a.count - b.count || a.name.localeCompare(b.name));
    const parentOf = new Map<string, string | null>();
    for (const child of tags) {
        let best: TagEntry | null = null;
        for (const candidate of tags) {
            if (candidate.name === child.name) continue;
            if (candidate.count <= child.count) continue;
            if (coverage(child, candidate) < minCoverage) continue;
            if (!best || candidate.count < best.count
                || (candidate.count === best.count && candidate.name < best.name)) {
                best = candidate;
            }
        }
        parentOf.set(child.name, best ? best.name : null);
    }

    const childrenOf = new Map<string, string[]>();
    for (const [name, parent] of parentOf) {
        if (!parent) continue;
        const list = childrenOf.get(parent) || [];
        list.push(name);
        childrenOf.set(parent, list);
    }

    const memo = new Map<string, string>();
    const rootOf = (name: string, stack = new Set<string>()): string => {
        if (memo.has(name)) return memo.get(name) as string;
        if (stack.has(name)) return name;
        const parent = parentOf.get(name);
        if (!parent) {
            memo.set(name, name);
            return name;
        }
        stack.add(name);
        const root = rootOf(parent, stack);
        memo.set(name, root);
        return root;
    };

    const depthOf = (name: string): number => {
        let depth = 0;
        let cursor = name;
        const seen = new Set<string>();
        while (parentOf.get(cursor) && !seen.has(cursor)) {
            seen.add(cursor);
            cursor = parentOf.get(cursor) as string;
            depth += 1;
        }
        return depth;
    };

    const hierarchy: Record<string, HierarchyInfo> = {};
    for (const tag of tags) {
        hierarchy[tag.name] = {
            parent: parentOf.get(tag.name) || null,
            children: (childrenOf.get(tag.name) || []).slice().sort(),
            root: rootOf(tag.name),
            depth: depthOf(tag.name),
            count: tag.count
        };
    }
    return hierarchy;
}

function pickPrimaryRoot(
    tagNames: unknown[] | undefined,
    hierarchy: Record<string, HierarchyInfo>,
    tagIndex: Map<string, TagEntry>
): string | null {
    const names = (tagNames || []).map(cleanTagName).filter((name): name is string => Boolean(name));
    if (names.length === 0) return null;
    let best = names[0];
    let bestScore = -1;
    for (const name of names) {
        const info = hierarchy[name];
        const count = tagIndex.get(name)?.count || 0;
        const depth = info?.depth || 0;
        const score = depth * 1000 + count;
        if (score > bestScore || (score === bestScore && name < best)) {
            best = name;
            bestScore = score;
        }
    }
    return hierarchy[best]?.root || best;
}

export type TagHubNode = GraphFilterNode & {
    id: string;
    type: 'tag';
    derived?: boolean;
};

const COLLAPSE_TAG_THRESHOLD = 10;
const COLLAPSE_NOTE_THRESHOLD = 80;
const DEFAULT_MAX_HUBS = 28;
const MIN_ROOT_HUB = 2;
const MIN_SATELLITE = 3;
const MAX_SECONDARY_SPOKES = 3;
const MAX_OVERLAP_PER_HUB = 4;

function shouldCollapse(noteCount: number, tagCount: number, collapse: boolean | 'auto' = 'auto'): boolean {
    if (collapse === true) return true;
    if (collapse === false) return false;
    return noteCount > COLLAPSE_NOTE_THRESHOLD || tagCount > COLLAPSE_TAG_THRESHOLD;
}

function countByCluster(nodes: GraphFilterNode[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const node of nodes || []) {
        if (!node?.cluster || node.id === 'you' || node.type === 'tag') continue;
        counts.set(node.cluster, (counts.get(node.cluster) || 0) + 1);
    }
    return counts;
}

function noteMemberships(
    tagNames: unknown[] | undefined,
    hierarchy: Record<string, HierarchyInfo>,
    tagIndex: Map<string, TagEntry>
): string[] {
    const names = (tagNames || []).map(cleanTagName).filter((name): name is string => Boolean(name));
    const set = new Set<string>();
    for (const name of names) {
        if (!tagIndex.has(name)) continue;
        set.add(name);
        const root = hierarchy[name]?.root || name;
        if (root) set.add(root);
    }
    return [...set];
}

function pickFallbackHub(
    memberships: string[] | undefined,
    hubSet: Set<string>,
    sizeOf: (name: string) => number
): string | null {
    let best: string | null = null;
    let bestSize = -1;
    for (const name of memberships || []) {
        if (!hubSet.has(name)) continue;
        const size = sizeOf(name);
        if (size > bestSize || (size === bestSize && name < (best || ''))) {
            best = name;
            bestSize = size;
        }
    }
    return best;
}

function pickCollapsedHubs(
    roots: string[],
    sizes: Map<string, number>,
    included: TagEntry[],
    hierarchy: Record<string, HierarchyInfo>,
    maxHubs: number
): string[] {
    const rootHubs = roots.filter((name) => (sizes.get(name) || 0) >= MIN_ROOT_HUB);
    const satellites = included
        .filter((tag) => hierarchy[tag.name]?.parent && tag.count >= MIN_SATELLITE)
        .map((tag) => tag.name);
    const unique = [...new Set([...rootHubs, ...satellites])];
    if (unique.length <= maxHubs) return unique;
    const scored = unique.map((name) => ({
        name,
        satellite: Boolean(hierarchy[name]?.parent),
        size: sizes.get(name) || included.find((tag) => tag.name === name)?.count || 0
    }));
    scored.sort((a, b) => {
        if (a.satellite !== b.satellite) return a.satellite ? 1 : -1;
        return b.size - a.size || a.name.localeCompare(b.name);
    });
    return scored.slice(0, maxHubs).map((item) => item.name);
}

function childrenByRoot(included: TagEntry[], hierarchy: Record<string, HierarchyInfo>): Map<string, string[]> {
    const map = new Map<string, string[]>();
    for (const tag of included) {
        const root = hierarchy[tag.name]?.root || tag.name;
        if (tag.name === root) continue;
        const list = map.get(root) || [];
        list.push(tag.name);
        map.set(root, list);
    }
    for (const [root, list] of map) map.set(root, list.sort());
    return map;
}

function attachTagHubs<
    N extends GraphFilterNode,
    E extends GraphFilterEdge
>(
    nodes: N[] = [],
    edges: E[] = [],
    { minTagSize = 1, collapse = 'auto' as boolean | 'auto', maxHubs = DEFAULT_MAX_HUBS } = {}
): {
    nodes: Array<N | TagHubNode>;
    edges: Array<E | GraphFilterEdge>;
    tags: Array<{ name: string; count: number; parent: string | null; root: string }>;
    clusters: Array<{ id: string; label: string; size: number }>;
    collapsed: boolean;
} {
    const notes = (nodes || []).filter((node) => node && node.type !== 'tag');
    const existingTags = (nodes || []).filter((node) => node && node.type === 'tag');
    const tagIndex = buildTagIndex(notes);
    const hierarchy = buildTagHierarchy(tagIndex);
    const included = [...tagIndex.values()]
        .filter((tag) => tag.count >= minTagSize)
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    const collapsed = shouldCollapse(notes.length, included.length, collapse);

    const sizeOfTag = (name: string) => tagIndex.get(name)?.count || 0;

    let annotated: Array<N | (N & { cluster: string | null; foldedFrom?: string; memberships: string[] })> = notes.map((node) => {
        const memberships = noteMemberships(node.tags, hierarchy, tagIndex);
        const cluster = pickPrimaryRoot(node.tags, hierarchy, tagIndex);
        return { ...node, cluster: cluster || node.cluster || null, memberships };
    });

    const childMap = childrenByRoot(included, hierarchy);
    const sizes = countByCluster(annotated);
    const roots = [...new Set(annotated.map((node) => node.cluster).filter((name): name is string => Boolean(name)))].sort();

    let hubRoots: string[];
    if (collapsed) {
        hubRoots = pickCollapsedHubs(roots, sizes, included, hierarchy, maxHubs);
        const namedSet = new Set(hubRoots);
        annotated = annotated.map((node) => {
            if (node.id === 'you') return node;
            if (node.cluster && namedSet.has(node.cluster)) return node;
            const fallback = pickFallbackHub(node.memberships, namedSet, (name) => (
                sizes.get(name) || sizeOfTag(name)
            ));
            return fallback
                ? { ...node, cluster: fallback, foldedFrom: node.cluster }
                : node;
        });
    } else {
        hubRoots = roots;
    }

    const hubSet = new Set(hubRoots);
    const sizesAfter = countByCluster(annotated);

    const decorateHub = (name: string, base: GraphFilterNode = {}): TagHubNode => {
        const info = hierarchy[name] || { parent: null, root: name, children: [], depth: 0, count: 0 };
        const size = sizesAfter.get(name) || tagIndex.get(name)?.count || 0;
        const children = childMap.get(name) || [];
        const satellite = Boolean(info.parent);
        return {
            ...base,
            id: tagNodeId(name),
            type: 'tag',
            label: base.label || name,
            content: satellite
                ? `${size} note${size === 1 ? ' shares' : 's share'} this · under ${info.parent}`
                : `${size} note${size === 1 ? '' : 's'} in this group${
                    children.length ? ` · includes ${children.slice(0, 5).join(', ')}` : ''
                }`,
            salience: Math.min(1, 0.45 + size * 0.04),
            memberCount: size,
            parentTag: info.parent || null,
            rootTag: info.root || name,
            cluster: info.root || name,
            childTags: children,
            collapsedHub: collapsed && !satellite,
            satellite,
            tags: base.tags?.length ? base.tags : [name]
        };
    };

    const decorateTag = (tag: TagEntry, base: GraphFilterNode = {}): TagHubNode => {
        const info = hierarchy[tag.name] || { parent: null, root: tag.name, children: [], depth: 0, count: 0 };
        return {
            ...base,
            id: tagNodeId(tag.name),
            type: 'tag',
            label: base.label || tag.name,
            content: `${tag.count} note${tag.count === 1 ? ' shares' : 's share'} this`,
            salience: Math.min(1, 0.4 + tag.count * 0.06),
            memberCount: tag.count,
            parentTag: info.parent || null,
            rootTag: info.root || tag.name,
            cluster: info.root || tag.name,
            childTags: childMap.get(tag.name) || info.children || [],
            collapsedHub: false,
            tags: base.tags?.length ? base.tags : [tag.name]
        };
    };

    const hubIds = new Set(hubRoots.map((name) => tagNodeId(name)));

    let tagNodes: TagHubNode[];
    let refreshedTags: Array<N | TagHubNode>;
    if (collapsed) {
        refreshedTags = existingTags
            .filter((node) => hubIds.has(String(node.id)))
            .map((node) => {
                const name = cleanTagName(node.label)
                    || cleanTagName(String(node.id || '').replace(/^tag:/, ''));
                return name && hubSet.has(name) ? decorateHub(name, node) : node;
            });
        const occupied = new Set(refreshedTags.map((node) => node.id));
        tagNodes = hubRoots
            .filter((name) => !occupied.has(tagNodeId(name)))
            .map((name) => decorateHub(name));
    } else {
        const existingTagIds = new Set(existingTags.map((node) => node.id));
        tagNodes = included
            .filter((tag) => !existingTagIds.has(tagNodeId(tag.name)))
            .map((tag) => decorateTag(tag));
        refreshedTags = existingTags.map((node) => {
            const name = cleanTagName(node.label)
                || cleanTagName(String(node.id || '').replace(/^tag:/, ''));
            const tag = name ? tagIndex.get(name) : null;
            return tag ? decorateTag(tag, node) : { ...node, cluster: node.cluster || null };
        });
    }

    const existingPairs = new Set<string>();
    for (const edge of edges || []) {
        if (edge?.sourceId == null || edge?.targetId == null) continue;
        existingPairs.add(pairKey(edge.sourceId, edge.targetId));
    }
    const tagEdges: GraphFilterEdge[] = [];
    const addEdge = (edge: GraphFilterEdge) => {
        if (edge.sourceId == null || edge.targetId == null) return;
        if (edge.sourceId === edge.targetId) return;
        const key = pairKey(edge.sourceId, edge.targetId);
        if (existingPairs.has(key)) return;
        existingPairs.add(key);
        tagEdges.push(edge);
    };

    if (collapsed) {
        const membersByHub = new Map<string, Set<string>>();
        for (const name of hubRoots) membersByHub.set(name, new Set());

        for (const node of annotated) {
            if (node.id === 'you') continue;
            const primary = node.cluster && hubSet.has(node.cluster)
                ? node.cluster
                : pickFallbackHub(node.memberships, hubSet, (name) => (
                    sizesAfter.get(name) || sizeOfTag(name)
                ));
            if (primary) {
                addEdge({
                    sourceId: node.id,
                    targetId: tagNodeId(primary),
                    relation: 'tagged',
                    relationKind: 'associative',
                    weight: 0.9,
                    kind: 'tag'
                });
                membersByHub.get(primary)?.add(String(node.id));
            }
            const extras = (node.memberships || [])
                .filter((name) => name !== primary && hubSet.has(name))
                .sort((a, b) => (sizeOfTag(b) - sizeOfTag(a)) || a.localeCompare(b))
                .slice(0, MAX_SECONDARY_SPOKES);
            for (const name of extras) {
                addEdge({
                    sourceId: node.id,
                    targetId: tagNodeId(name),
                    relation: 'tagged',
                    relationKind: 'associative',
                    weight: 0.4,
                    kind: 'tag'
                });
                membersByHub.get(name)?.add(String(node.id));
            }
        }

        for (const name of hubRoots) {
            const parent = hierarchy[name]?.parent;
            if (!parent || !hubSet.has(parent)) continue;
            addEdge({
                sourceId: tagNodeId(name),
                targetId: tagNodeId(parent),
                relation: 'part_of',
                relationKind: 'associative',
                weight: 0.55,
                kind: 'hierarchy'
            });
        }

        const overlapCandidates: Array<{ left: string; right: string; shared: number }> = [];
        for (let i = 0; i < hubRoots.length; i++) {
            for (let j = i + 1; j < hubRoots.length; j++) {
                const left = hubRoots[i];
                const right = hubRoots[j];
                const a = membersByHub.get(left);
                const b = membersByHub.get(right);
                if (!a?.size || !b?.size) continue;
                let shared = 0;
                for (const id of a) {
                    if (b.has(id)) shared += 1;
                }
                if (shared < 1) continue;
                overlapCandidates.push({ left, right, shared });
            }
        }
        overlapCandidates.sort((a, b) => b.shared - a.shared || a.left.localeCompare(b.left));
        const overlapCount = new Map<string, number>();
        for (const pair of overlapCandidates) {
            const usedLeft = overlapCount.get(pair.left) || 0;
            const usedRight = overlapCount.get(pair.right) || 0;
            if (usedLeft >= MAX_OVERLAP_PER_HUB || usedRight >= MAX_OVERLAP_PER_HUB) continue;
            addEdge({
                sourceId: tagNodeId(pair.left),
                targetId: tagNodeId(pair.right),
                relation: 'overlaps',
                relationKind: 'associative',
                weight: Math.min(0.9, 0.28 + pair.shared * 0.08),
                kind: 'overlap',
                shared: pair.shared
            });
            overlapCount.set(pair.left, usedLeft + 1);
            overlapCount.set(pair.right, usedRight + 1);
        }
    } else {
        for (const node of annotated) {
            if (node.id === 'you') continue;
            const seen = new Set<string>();
            for (const raw of node.tags || []) {
                const name = cleanTagName(raw);
                if (!name || seen.has(name) || !tagIndex.has(name)) continue;
                if ((tagIndex.get(name)?.count || 0) < minTagSize) continue;
                seen.add(name);
                addEdge({
                    sourceId: node.id,
                    targetId: tagNodeId(name),
                    relation: 'tagged',
                    relationKind: 'associative',
                    weight: 0.85,
                    kind: 'tag'
                });
            }
        }
        for (const tag of included) {
            const parent = hierarchy[tag.name]?.parent;
            if (!parent || !tagIndex.has(parent)) continue;
            if ((tagIndex.get(parent)?.count || 0) < minTagSize) continue;
            addEdge({
                sourceId: tagNodeId(tag.name),
                targetId: tagNodeId(parent),
                relation: 'part_of',
                relationKind: 'associative',
                weight: 0.45,
                kind: 'hierarchy'
            });
        }
    }

    const clusterNames = collapsed
        ? hubRoots.slice()
        : [...new Set(included.map((tag) => hierarchy[tag.name]?.root || tag.name))].sort();
    const clusters = clusterNames.map((name) => ({
        id: name,
        label: name,
        size: sizesAfter.get(name) || 0
    }));

    return {
        nodes: [...annotated, ...refreshedTags, ...tagNodes],
        edges: [...(edges || []), ...tagEdges],
        tags: included.map((tag) => ({
            name: tag.name,
            count: tag.count,
            parent: hierarchy[tag.name]?.parent || null,
            root: hierarchy[tag.name]?.root || tag.name
        })),
        clusters,
        collapsed
    };
}

export function tagHubs<N extends GraphFilterNode>(
    nodes: N[] = [],
    existing: GraphFilterEdge[] = []
): { nodes: TagHubNode[]; edges: GraphFilterEdge[] } {
    const result = withTagLinks({ nodes, edges: existing }, true);
    const originalIds = new Set(nodes.map((node) => node.id));
    return {
        nodes: result.nodes.filter((node): node is TagHubNode => (
            node.type === 'tag' && !originalIds.has(node.id)
        )),
        edges: result.edges.filter((edge) => edge.derived)
    };
}

/**
 * Overlay tag hubs and a co-occurrence hierarchy. Notes get a `cluster`
 * (the root tag they belong to) so the renderer can clump and layer them.
 */
export function withTagLinks<
    N extends GraphFilterNode,
    E extends GraphFilterEdge
>(
    graph: { nodes?: N[]; edges?: E[] } | null | undefined,
    enabled: boolean
): {
    nodes: Array<N | TagHubNode>;
    edges: Array<E | GraphFilterEdge>;
    tags?: Array<{ name: string; count: number; parent: string | null; root: string }>;
    clusters?: Array<{ id: string; label: string; size: number }>;
    collapsed?: boolean;
} {
    const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
    const edges = Array.isArray(graph?.edges) ? graph.edges : [];
    if (!enabled) return { nodes, edges, collapsed: false };
    const grouped = attachTagHubs(nodes, edges);
    const originalIds = new Set(nodes.map((node) => node.id));
    return {
        nodes: grouped.nodes.map((node) => {
            if (node.type === 'tag' && !originalIds.has(node.id)) {
                return {
                    ...node,
                    derived: true,
                    source: node.source || 'derived',
                    tags: node.tags?.length ? node.tags : [String(node.label || '')]
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
