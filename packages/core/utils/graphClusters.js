/**
 * Deterministic Map grouping for the knowledge graph.
 *
 * Tags Goobster already maintains (via research, weave, and user edits)
 * become the grouping the Map uses when many notes are on screen:
 *   - tag hubs (synthetic nodes notes spring toward)
 *   - a parent/child hierarchy from co-occurrence (a narrower tag hangs
 *     under the smallest broader tag that covers most of its members)
 *   - a root cluster id per note, used by the renderer for hulls and the
 *     soft third axis
 *
 * Pure, no I/O (the attentionScore / researchSources separation). The
 * hierarchy is derived at view time so it cannot drift from the tags.
 */

function tagNodeId(name) {
    return `tag:${String(name || '').trim().toLowerCase()}`;
}

function cleanTagName(value) {
    const text = String(value || '').trim().toLowerCase();
    return text || null;
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

/**
 * Inject tag-hub nodes, tagged/hierarchy edges, and cluster ids.
 * Existing nodes/edges are not mutated.
 * @returns {{nodes, edges, tags, clusters, hierarchy}}
 */
function attachTagHubs(nodes = [], edges = [], { minTagSize = 1 } = {}) {
    const notes = (nodes || []).filter(node => node && node.type !== 'tag');
    const existingTags = (nodes || []).filter(node => node && node.type === 'tag');
    const existingTagIds = new Set(existingTags.map(node => node.id));
    const tagIndex = buildTagIndex(notes);
    const hierarchy = buildTagHierarchy(tagIndex);
    const included = [...tagIndex.values()].filter(tag => tag.count >= minTagSize);

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
            tags: base.tags?.length ? base.tags : [tag.name]
        };
    };

    const tagNodes = included
        .filter(tag => !existingTagIds.has(tagNodeId(tag.name)))
        .map(tag => decorateTag(tag));

    const refreshedTags = existingTags.map((node) => {
        const name = cleanTagName(node.label)
            || cleanTagName(String(node.id || '').replace(/^tag:/, ''));
        const tag = name ? tagIndex.get(name) : null;
        return tag ? decorateTag(tag, node) : { ...node, cluster: node.cluster || null };
    });

    const annotated = notes.map(node => {
        const cluster = pickPrimaryRoot(node.tags, hierarchy, tagIndex);
        return { ...node, cluster: cluster || node.cluster || null };
    });

    const existingPairs = new Set();
    for (const edge of edges || []) {
        if (edge?.sourceId == null || edge?.targetId == null) continue;
        const left = String(edge.sourceId);
        const right = String(edge.targetId);
        existingPairs.add(left < right ? `${left}\0${right}` : `${right}\0${left}`);
    }
    const addEdge = (edge) => {
        const left = String(edge.sourceId);
        const right = String(edge.targetId);
        if (left === right) return;
        const key = left < right ? `${left}\0${right}` : `${right}\0${left}`;
        if (existingPairs.has(key)) return;
        existingPairs.add(key);
        tagEdges.push(edge);
    };

    const tagEdges = [];
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

    const clusterNames = [...new Set(included.map(tag => hierarchy[tag.name]?.root || tag.name))].sort();
    const clusters = clusterNames.map(name => ({
        id: name,
        label: name,
        size: tagIndex.get(name)?.count || included
            .filter(tag => (hierarchy[tag.name]?.root || tag.name) === name)
            .reduce((sum, tag) => sum + tag.count, 0)
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
        hierarchy
    };
}

module.exports = {
    tagNodeId,
    cleanTagName,
    buildTagIndex,
    buildTagHierarchy,
    pickPrimaryRoot,
    attachTagHubs,
    coverage
};
