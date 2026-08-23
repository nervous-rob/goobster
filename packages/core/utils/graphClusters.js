/**
 * Deterministic Map grouping for the knowledge graph.
 *
 * Tags Goobster already maintains (via research, weave, and user edits)
 * become the grouping the Map uses when many notes are on screen.
 *
 * Small graphs keep every tag as a hub (Parlor's tag-first shape) plus
 * a parent/child hierarchy from co-occurrence. Dense graphs keep the
 * large root clusters, leave smaller groups in as satellite hubs, and
 * interconnect them: parent/child `part_of` edges plus `overlaps` edges
 * where notes (or shared tags) sit in more than one group. Notes spring
 * strongly to their primary cluster and weakly to the others they share.
 *
 * Pure, no I/O. Nothing here is written to kg_nodes / kg_tags.
 */

const OTHER_CLUSTER = '__other__';
const COLLAPSE_TAG_THRESHOLD = 10;
const COLLAPSE_NOTE_THRESHOLD = 80;
const DEFAULT_MAX_HUBS = 28;
const MIN_ROOT_HUB = 2;
const MIN_SATELLITE = 3;
const MAX_SECONDARY_SPOKES = 3;
const MAX_OVERLAP_PER_HUB = 4;

function tagNodeId(name) {
    return `tag:${String(name || '').trim().toLowerCase()}`;
}

function cleanTagName(value) {
    const text = String(value || '').trim().toLowerCase();
    return text || null;
}

function shouldCollapse(noteCount, tagCount, collapse = 'auto') {
    if (collapse === true) return true;
    if (collapse === false) return false;
    return Number(tagCount) > COLLAPSE_TAG_THRESHOLD
        || Number(noteCount) > COLLAPSE_NOTE_THRESHOLD;
}

/**
 * @param {Array<{id: *, tags?: string[]}>} nodes
 * @returns {Map<string, {name: string, nodeIds: Array, count: number}>}
 */
function buildTagIndex(nodes) {
    const index = new Map();
    for (const node of nodes || []) {
        if (!node || node.type === 'tag' || node.id === 'you') continue;
        const seen = new Set();
        for (const raw of node.tags || []) {
            const name = cleanTagName(raw);
            if (!name || seen.has(name)) continue;
            seen.add(name);
            let entry = index.get(name);
            if (!entry) {
                entry = { name, nodeIds: [], count: 0 };
                index.set(name, entry);
            }
            entry.nodeIds.push(node.id);
            entry.count += 1;
        }
    }
    return index;
}

/**
 * Coverage of smaller by larger: fraction of smaller's members that also
 * sit on the larger tag. Used to decide "B is a kind of A".
 */
function coverage(smaller, larger) {
    if (!smaller?.count) return 0;
    const largerSet = new Set(larger.nodeIds);
    let hits = 0;
    for (const id of smaller.nodeIds) {
        if (largerSet.has(id)) hits += 1;
    }
    return hits / smaller.count;
}

/**
 * Parent of B is the smallest tag A that is strictly larger and covers
 * at least `minCoverage` of B's members. Roots have parent = null.
 * @returns {Object<string, {parent: string|null, children: string[], root: string, depth: number}>}
 */
function buildTagHierarchy(tagIndex, { minCoverage = 0.6 } = {}) {
    const tags = [...tagIndex.values()].sort((a, b) => a.count - b.count || a.name.localeCompare(b.name));
    const parentOf = new Map();
    for (const child of tags) {
        let best = null;
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

    const childrenOf = new Map();
    for (const [name, parent] of parentOf) {
        if (!parent) continue;
        if (!childrenOf.has(parent)) childrenOf.set(parent, []);
        childrenOf.get(parent).push(name);
    }

    const memo = new Map();
    const rootOf = (name, stack = new Set()) => {
        if (memo.has(name)) return memo.get(name);
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

    const depthOf = (name) => {
        let depth = 0;
        let cursor = name;
        const seen = new Set();
        while (parentOf.get(cursor) && !seen.has(cursor)) {
            seen.add(cursor);
            cursor = parentOf.get(cursor);
            depth += 1;
        }
        return depth;
    };

    const hierarchy = {};
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

function noteMemberships(tagNames, hierarchy, tagIndex) {
    const names = (tagNames || []).map(cleanTagName).filter(Boolean);
    const set = new Set();
    for (const name of names) {
        if (!tagIndex.has(name)) continue;
        set.add(name);
        const root = hierarchy[name]?.root || name;
        if (root) set.add(root);
    }
    return [...set];
}

function pickFallbackHub(memberships, hubSet, sizeOf) {
    let best = null;
    let bestSize = -1;
    for (const name of memberships || []) {
        if (!hubSet.has(name)) continue;
        const size = sizeOf(name);
        if (size > bestSize || (size === bestSize && name < best)) {
            best = name;
            bestSize = size;
        }
    }
    return best;
}

function pickCollapsedHubs(roots, sizes, included, hierarchy, maxHubs) {
    const rootHubs = roots.filter(name => (sizes.get(name) || 0) >= MIN_ROOT_HUB);
    const satellites = included
        .filter(tag => hierarchy[tag.name]?.parent && tag.count >= MIN_SATELLITE)
        .map(tag => tag.name);
    const unique = [...new Set([...rootHubs, ...satellites])];
    if (unique.length <= maxHubs) return unique;

    const scored = unique.map(name => ({
        name,
        satellite: Boolean(hierarchy[name]?.parent),
        size: sizes.get(name) || included.find(tag => tag.name === name)?.count || 0
    }));
    scored.sort((a, b) => {
        if (a.satellite !== b.satellite) return a.satellite ? 1 : -1;
        return b.size - a.size || a.name.localeCompare(b.name);
    });
    return scored.slice(0, maxHubs).map(item => item.name);
}

function pickPrimaryRoot(tagNames, hierarchy, tagIndex) {
    const names = (tagNames || []).map(cleanTagName).filter(Boolean);
    if (names.length === 0) return null;
    let best = names[0];
    let bestScore = -1;
    for (const name of names) {
        const info = hierarchy[name];
        const count = tagIndex.get(name)?.count || 0;
        const depth = info?.depth || 0;
        // Prefer the most specific (deepest) tag; break ties on popularity.
        const score = depth * 1000 + count;
        if (score > bestScore || (score === bestScore && name < best)) {
            best = name;
            bestScore = score;
        }
    }
    return hierarchy[best]?.root || best;
}

function countByCluster(nodes) {
    const counts = new Map();
    for (const node of nodes || []) {
        if (!node?.cluster || node.id === 'you' || node.type === 'tag') continue;
        counts.set(node.cluster, (counts.get(node.cluster) || 0) + 1);
    }
    return counts;
}

function childrenByRoot(included, hierarchy) {
    const map = new Map();
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

function pairKey(a, b) {
    const left = String(a);
    const right = String(b);
    return left < right ? `${left}\0${right}` : `${right}\0${left}`;
}

function isSyntheticTag(node) {
    return Boolean(node && node.type === 'tag'
        && (node.derived || String(node.id || '').startsWith('tag:')));
}

/**
 * Inject tag-hub nodes, tagged/hierarchy edges, and cluster ids.
 * Existing nodes/edges are not mutated.
 * @returns {{nodes, edges, tags, clusters, hierarchy, collapsed}}
 */
function attachTagHubs(nodes = [], edges = [], {
    minTagSize = 1,
    collapse = 'auto',
    maxHubs = DEFAULT_MAX_HUBS
} = {}) {
    const notes = (nodes || []).filter(node => node && node.type !== 'tag');
    const existingTags = (nodes || []).filter(node => node && node.type === 'tag');
    const tagIndex = buildTagIndex(notes);
    const hierarchy = buildTagHierarchy(tagIndex);
    const included = [...tagIndex.values()]
        .filter(tag => tag.count >= minTagSize)
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    const collapsed = shouldCollapse(notes.length, included.length, collapse);

    const sizeOfTag = (name) => (
        tagIndex.get(name)?.count || 0
    );

    let annotated = notes.map(node => {
        const memberships = noteMemberships(node.tags, hierarchy, tagIndex);
        const cluster = pickPrimaryRoot(node.tags, hierarchy, tagIndex);
        return {
            ...node,
            cluster: cluster || node.cluster || null,
            memberships
        };
    });

    const childMap = childrenByRoot(included, hierarchy);
    const sizes = countByCluster(annotated);
    const roots = [...new Set(annotated
        .map(node => node.cluster)
        .filter(Boolean))].sort();

    let hubRoots;
    if (collapsed) {
        hubRoots = pickCollapsedHubs(roots, sizes, included, hierarchy, maxHubs);
        const hubSet = new Set(hubRoots);
        annotated = annotated.map(node => {
            if (node.id === 'you') return node;
            if (node.cluster && hubSet.has(node.cluster)) return node;
            const fallback = pickFallbackHub(node.memberships, hubSet, (name) => (
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

    const decorateHub = (name, base = {}) => {
        const info = hierarchy[name] || {};
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

    const decorateTag = (tag, base = {}) => {
        const info = hierarchy[tag.name] || {};
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

    const hubIds = new Set(hubRoots.map(name => tagNodeId(name)));

    let tagNodes;
    let refreshedTags;
    if (collapsed) {
        refreshedTags = existingTags
            .filter(node => hubIds.has(node.id))
            .map((node) => {
                const name = cleanTagName(node.label)
                    || cleanTagName(String(node.id || '').replace(/^tag:/, ''));
                return name && hubSet.has(name) ? decorateHub(name, node) : node;
            });
        const occupied = new Set(refreshedTags.map(node => node.id));
        tagNodes = hubRoots
            .filter(name => !occupied.has(tagNodeId(name)))
            .map(name => decorateHub(name));
    } else {
        const existingTagIds = new Set(existingTags.map(node => node.id));
        tagNodes = included
            .filter(tag => !existingTagIds.has(tagNodeId(tag.name)))
            .map(tag => decorateTag(tag));
        refreshedTags = existingTags.map((node) => {
            const name = cleanTagName(node.label)
                || cleanTagName(String(node.id || '').replace(/^tag:/, ''));
            const tag = name ? tagIndex.get(name) : null;
            return tag ? decorateTag(tag, node) : { ...node, cluster: node.cluster || null };
        });
    }

    const existingPairs = new Set();
    for (const edge of edges || []) {
        if (edge?.sourceId == null || edge?.targetId == null) continue;
        existingPairs.add(pairKey(edge.sourceId, edge.targetId));
    }
    const tagEdges = [];
    const addEdge = (edge) => {
        if (edge.sourceId == null || edge.targetId == null) return;
        if (String(edge.sourceId) === String(edge.targetId)) return;
        const key = pairKey(edge.sourceId, edge.targetId);
        if (existingPairs.has(key)) return;
        existingPairs.add(key);
        tagEdges.push(edge);
    };

    if (collapsed) {
        const membersByHub = new Map();
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
                .filter(name => name !== primary && hubSet.has(name))
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

        const overlapCandidates = [];
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
        const overlapCount = new Map();
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
            const seen = new Set();
            for (const raw of node.tags || []) {
                const name = cleanTagName(raw);
                if (!name || seen.has(name) || !tagIndex.has(name)) continue;
                if ((tagIndex.get(name).count || 0) < minTagSize) continue;
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
            if ((tagIndex.get(parent).count || 0) < minTagSize) continue;
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
        : [...new Set(included.map(tag => hierarchy[tag.name]?.root || tag.name))].sort();
    const clusters = clusterNames.map(name => ({
        id: name,
        label: name,
        size: sizesAfter.get(name) || 0
    }));

    return {
        nodes: [...annotated, ...refreshedTags, ...tagNodes],
        edges: [...(edges || []), ...tagEdges],
        tags: included.map(tag => ({
            name: tag.name,
            count: tag.count,
            parent: hierarchy[tag.name]?.parent || null,
            root: hierarchy[tag.name]?.root || tag.name
        })),
        clusters,
        hierarchy,
        collapsed
    };
}

module.exports = {
    tagNodeId,
    cleanTagName,
    buildTagIndex,
    buildTagHierarchy,
    pickPrimaryRoot,
    attachTagHubs,
    shouldCollapse,
    coverage,
    OTHER_CLUSTER,
    COLLAPSE_TAG_THRESHOLD,
    COLLAPSE_NOTE_THRESHOLD,
    DEFAULT_MAX_HUBS,
    isSyntheticTag
};
