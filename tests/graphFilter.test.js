/**
 * Client-side constellation filter used by the Spitball Map.
 */
const { filterConstellation } = require('@goobster/core/utils/graphFilter');

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
