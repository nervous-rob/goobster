/**
 * Client-side constellation filter used by the Spitball Map.
 */
const { filterConstellation, tagLinks, withTagLinks } = require('@goobster/core/utils/graphFilter');

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

describe('tagLinks', () => {
    test('does not invent links when disabled or when tags are unique', () => {
        const stored = [{ sourceId: 'kg:1', targetId: 'kg:2', relation: 'related' }];
        expect(withTagLinks({ nodes: [YOU, ROSETTA, TEA], edges: stored }, false).edges).toHaveLength(1);
        const lonely = { id: 'kg:3', label: 'Solo', tags: ['unique'] };
        expect(tagLinks([YOU, ROSETTA, lonely])).toEqual([]);
    });

    test('cliques a small tag group and skips the you anchor', () => {
        const a = { id: 'kg:a', tags: ['egypt'], salience: 0.4 };
        const b = { id: 'kg:b', tags: ['egypt'], salience: 0.9 };
        const c = { id: 'kg:c', tags: ['egypt'], salience: 0.2 };
        const edges = tagLinks([YOU, a, b, c]);
        expect(edges).toHaveLength(3);
        expect(edges.every((e) => e.derived && e.relation === 'tagged' && e.viaTag === 'egypt')).toBe(true);
        expect(edges.some((e) => e.sourceId === 'you' || e.targetId === 'you')).toBe(false);
    });

    test('stars a large tag group from the most salient note', () => {
        const members = Array.from({ length: 8 }, (_, i) => ({
            id: `kg:${i}`,
            tags: ['food'],
            salience: i === 3 ? 0.99 : 0.1
        }));
        const edges = tagLinks(members);
        expect(edges).toHaveLength(7);
        expect(edges.every((e) => e.sourceId === 'kg:3' || e.targetId === 'kg:3')).toBe(true);
    });

    test('does not duplicate a pair that already has a stored edge', () => {
        const a = { id: 'kg:1', tags: ['egypt'] };
        const b = { id: 'kg:2', tags: ['egypt'] };
        const existing = [{ sourceId: 'kg:1', targetId: 'kg:2', relation: 'related' }];
        expect(tagLinks([a, b], existing)).toEqual([]);
        expect(withTagLinks({ nodes: [a, b], edges: existing }, true).edges).toHaveLength(1);
    });
});
