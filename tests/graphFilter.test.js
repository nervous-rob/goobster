/**
 * Client-side constellation filter used by the Spitball Map.
 */
const { filterConstellation, tagHubs, withTagLinks } = require('@goobster/core/utils/graphFilter');

const YOU = {
    id: 'you',
    type: 'person',
    label: 'You',
    content: 'anchor',
    source: 'user',
    tags: []
};
const ROSETTA = {
    id: 'kg:1',
    type: 'artifact',
    label: 'Rosetta Stone',
    content: 'A bilingual decree from Ptolemaic Egypt',
    source: 'research',
    tags: ['egypt', 'language']
};
const TEA = {
    id: 'kg:2',
    type: 'fact',
    label: 'Earl Grey',
    content: 'Prefers tea',
    source: 'user',
    tags: ['food']
};
const EDGES = [
    { sourceId: 'you', targetId: 'kg:1', relation: 'knows' },
    { sourceId: 'kg:1', targetId: 'kg:2', relation: 'related' }
];

describe('filterConstellation', () => {
    const graph = { nodes: [YOU, ROSETTA, TEA], edges: EDGES };

    test('returns the full graph when no filters are set', () => {
        const result = filterConstellation(graph, {});
        expect(result.nodes).toHaveLength(3);
        expect(result.edges).toHaveLength(2);
    });

    test('keeps the you anchor when everything else is filtered out', () => {
        const result = filterConstellation(graph, { q: 'zzzz' });
        expect(result.nodes.map((n) => n.id)).toEqual(['you']);
        expect(result.edges).toEqual([]);
    });

    test('filters by type, tag, source, and search text', () => {
        expect(filterConstellation(graph, { type: 'artifact' }).nodes.map((n) => n.id))
            .toEqual(['you', 'kg:1']);
        expect(filterConstellation(graph, { tag: 'food' }).nodes.map((n) => n.id))
            .toEqual(['you', 'kg:2']);
        expect(filterConstellation(graph, { source: 'research' }).nodes.map((n) => n.id))
            .toEqual(['you', 'kg:1']);
        expect(filterConstellation(graph, { q: 'bilingual' }).nodes.map((n) => n.id))
            .toEqual(['you', 'kg:1']);
        expect(filterConstellation(graph, { q: 'egypt' }).nodes.map((n) => n.id))
            .toEqual(['you', 'kg:1']);
    });

    test('drops edges whose endpoints left the visible set', () => {
        const result = filterConstellation(graph, { type: 'artifact' });
        expect(result.edges).toEqual([
            { sourceId: 'you', targetId: 'kg:1', relation: 'knows' }
        ]);
    });
});

describe('tagHubs', () => {
    test('does not invent hubs when disabled', () => {
        const stored = [{ sourceId: 'kg:1', targetId: 'kg:2', relation: 'related' }];
        const off = withTagLinks({ nodes: [YOU, ROSETTA, TEA], edges: stored }, false);
        expect(off.nodes).toHaveLength(3);
        expect(off.edges).toHaveLength(1);
    });

    test('places a hub for a unique tag and skips the you anchor', () => {
        const lonely = { id: 'kg:3', label: 'Solo', tags: ['unique'] };
        const { nodes, edges } = tagHubs([YOU, ROSETTA, lonely]);
        expect(nodes.map((n) => n.id).sort()).toEqual(['tag:egypt', 'tag:language', 'tag:unique']);
        expect(nodes.every((n) => n.type === 'tag' && n.derived)).toBe(true);
        expect(edges.every((e) => e.relation === 'tagged' && e.derived)).toBe(true);
        expect(edges.some((e) => e.sourceId === 'you' || e.targetId === 'you')).toBe(false);
        expect(edges.filter((e) => e.targetId === 'tag:unique')).toEqual([
            expect.objectContaining({ sourceId: 'kg:3', relation: 'tagged' })
        ]);
    });

    test('routes a small tag group through one hub instead of a clique', () => {
        const a = { id: 'kg:a', tags: ['egypt'], salience: 0.4 };
        const b = { id: 'kg:b', tags: ['egypt'], salience: 0.9 };
        const c = { id: 'kg:c', tags: ['egypt'], salience: 0.2 };
        const { nodes, edges } = tagHubs([YOU, a, b, c]);
        expect(nodes).toHaveLength(1);
        expect(nodes[0]).toMatchObject({ id: 'tag:egypt', type: 'tag', derived: true });
        expect(edges).toHaveLength(3);
        expect(edges.every((e) => e.targetId === 'tag:egypt' && e.relation === 'tagged')).toBe(true);
        expect(new Set(edges.map((e) => e.sourceId))).toEqual(new Set(['kg:a', 'kg:b', 'kg:c']));
    });

    test('keeps one hub for a large tag group', () => {
        const members = Array.from({ length: 8 }, (_, i) => ({
            id: `kg:${i}`,
            tags: ['food'],
            salience: i === 3 ? 0.99 : 0.1
        }));
        const { nodes, edges } = tagHubs(members);
        expect(nodes).toHaveLength(1);
        expect(nodes[0].id).toBe('tag:food');
        expect(edges).toHaveLength(8);
        expect(edges.every((e) => e.targetId === 'tag:food')).toBe(true);
    });

    test('keeps stored note-to-note edges and adds spokes to the hub', () => {
        const a = { id: 'kg:1', tags: ['egypt'] };
        const b = { id: 'kg:2', tags: ['egypt'] };
        const existing = [{ sourceId: 'kg:1', targetId: 'kg:2', relation: 'related' }];
        const result = withTagLinks({ nodes: [a, b], edges: existing }, true);
        expect(result.nodes.filter((n) => n.type === 'tag')).toHaveLength(1);
        expect(result.edges).toHaveLength(3);
        expect(result.edges).toEqual(expect.arrayContaining([
            existing[0],
            expect.objectContaining({ sourceId: 'kg:1', targetId: 'tag:egypt', relation: 'tagged' }),
            expect.objectContaining({ sourceId: 'kg:2', targetId: 'tag:egypt', relation: 'tagged' })
        ]));
    });

    test('does not add a second hub when the graph is already augmented', () => {
        const once = withTagLinks({ nodes: [ROSETTA], edges: [] }, true);
        const twice = withTagLinks(once, true);
        expect(twice.nodes.filter((n) => n.type === 'tag')).toHaveLength(2);
        expect(twice.edges.filter((e) => e.relation === 'tagged')).toHaveLength(2);
    });
});
