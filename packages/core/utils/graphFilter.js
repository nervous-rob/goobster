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

/** Small tag groups get a full clique; larger ones get a star so 40 "food" notes don't become 780 lines. */
const TAG_CLIQUE_LIMIT = 6;

function pairKey(a, b) {
    const left = String(a);
    const right = String(b);
    return left < right ? `${left}\0${right}` : `${right}\0${left}`;
}

function salienceOf(node) {
    const n = Number(node?.salience);
    return Number.isFinite(n) ? n : 0;
}

/**
 * Visual-only edges for notes that share a tag. Never written to kg_edges.
 * The `you` anchor is skipped. Duplicate pairs (two shared tags, or a pair
 * that already has a real edge) collapse to one line.
 *
 * @param {object[]} nodes
 * @param {object[]} [existing]
 * @returns {object[]}
 */
function tagLinks(nodes = [], existing = []) {
    const groups = new Map();
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

    const seen = new Set();
    for (const edge of existing) {
        if (edge?.sourceId == null || edge?.targetId == null) continue;
        if (edge.sourceId === edge.targetId) continue;
        seen.add(pairKey(edge.sourceId, edge.targetId));
    }

    const edges = [];
    for (const [tag, members] of groups) {
        const unique = [];
        const ids = new Set();
        for (const node of members) {
            if (ids.has(node.id)) continue;
            ids.add(node.id);
            unique.push(node);
        }
        if (unique.length < 2) continue;
        unique.sort((a, b) => salienceOf(b) - salienceOf(a) || String(a.id).localeCompare(String(b.id)));

        const pairs = [];
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

/**
 * Overlay tag links on a (possibly filtered) constellation. Off by default.
 * @param {{ nodes?: object[], edges?: object[] }} graph
 * @param {boolean} enabled
 */
function withTagLinks(graph, enabled) {
    const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
    const edges = Array.isArray(graph?.edges) ? graph.edges : [];
    if (!enabled) return { nodes, edges };
    return { nodes, edges: edges.concat(tagLinks(nodes, edges)) };
}

module.exports = { filterConstellation, tagLinks, withTagLinks, TAG_CLIQUE_LIMIT };
