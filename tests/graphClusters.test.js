/**
 * Deterministic Map grouping (tag hubs + co-occurrence hierarchy).
 */
const {
    attachTagHubs, buildTagHierarchy, buildTagIndex, pickPrimaryRoot, tagNodeId,
    OTHER_CLUSTER
} = require('@goobster/core/utils/graphClusters');

const A = { id: 'kg:1', type: 'fact', label: 'Rosetta', tags: ['egypt', 'language'] };
const B = { id: 'kg:2', type: 'fact', label: 'Demotic', tags: ['egypt', 'language'] };
const C = { id: 'kg:3', type: 'fact', label: 'Nile', tags: ['egypt'] };
const D = { id: 'kg:4', type: 'fact', label: 'Earl Grey', tags: ['food'] };

describe('tag hierarchy from co-occurrence', () => {
    test('a narrower tag hangs under the smallest broader cover', () => {
        const index = buildTagIndex([A, B, C]);
        const hierarchy = buildTagHierarchy(index);
        expect(hierarchy.language.parent).toBe('egypt');
        expect(hierarchy.egypt.parent).toBeNull();
        expect(hierarchy.language.root).toBe('egypt');
        expect(pickPrimaryRoot(['language', 'egypt'], hierarchy, index)).toBe('egypt');
    });

    test('unrelated tags stay roots', () => {
        const index = buildTagIndex([C, D]);
        const hierarchy = buildTagHierarchy(index);
        expect(hierarchy.egypt.parent).toBeNull();
        expect(hierarchy.food.parent).toBeNull();
    });
});

describe('attachTagHubs', () => {
    test('injects hubs, tagged spokes, hierarchy edges, and cluster ids', () => {
        const stored = [{ sourceId: 'kg:1', targetId: 'kg:2', relation: 'related' }];
        const result = attachTagHubs([A, B, C, D], stored);
        expect(result.nodes.filter((n) => n.type === 'tag').map((n) => n.id).sort())
            .toEqual(['tag:egypt', 'tag:food', 'tag:language']);
        expect(result.nodes.find((n) => n.id === 'kg:1').cluster).toBe('egypt');
        expect(result.nodes.find((n) => n.id === 'kg:4').cluster).toBe('food');
        expect(result.edges).toEqual(expect.arrayContaining([
            stored[0],
            expect.objectContaining({ sourceId: 'kg:1', targetId: 'tag:egypt', kind: 'tag' }),
            expect.objectContaining({ sourceId: 'tag:language', targetId: 'tag:egypt', kind: 'hierarchy' })
        ]));
        expect(result.clusters.map((c) => c.id).sort()).toEqual(['egypt', 'food']);
    });

    test('skips the you anchor and refreshes existing hubs', () => {
        const you = { id: 'you', type: 'person', tags: ['egypt'] };
        const once = attachTagHubs([you, A, B, C], []);
        expect(once.edges.some((e) => e.sourceId === 'you' || e.targetId === 'you')).toBe(false);
        const twice = attachTagHubs(once.nodes, once.edges);
        const language = twice.nodes.find((n) => n.id === 'tag:language');
        expect(language.parentTag).toBe('egypt');
        expect(language.cluster).toBe('egypt');
        expect(twice.nodes.filter((n) => n.type === 'tag')).toHaveLength(
            once.nodes.filter((n) => n.type === 'tag').length
        );
    });

    test('a dense graph collapses to root hubs and one spoke per note', () => {
        const notes = [];
        for (let i = 0; i < 12; i++) {
            notes.push({ id: `e${i}`, tags: ['egypt', i < 6 ? 'language' : 'nile'] });
        }
        for (let i = 0; i < 8; i++) {
            notes.push({ id: `f${i}`, tags: ['food', i < 4 ? 'tea' : 'baking'] });
        }
        for (let i = 0; i < 20; i++) {
            notes.push({ id: `s${i}`, tags: [`solo-${i}`] });
        }
        const result = attachTagHubs(notes, [], { collapse: true, maxHubs: 8 });
        expect(result.collapsed).toBe(true);
        const hubs = result.nodes.filter((n) => n.type === 'tag');
        expect(hubs.map((n) => n.label).sort()).toEqual(['egypt', 'food', 'other']);
        expect(hubs.every((n) => n.collapsedHub)).toBe(true);
        expect(result.nodes.find((n) => n.id === 'e0').cluster).toBe('egypt');
        expect(result.nodes.find((n) => n.id === 's0').cluster).toBe(OTHER_CLUSTER);
        const tagged = result.edges.filter((e) => e.kind === 'tag');
        expect(tagged).toHaveLength(notes.length);
        expect(tagged.filter((e) => e.targetId === 'tag:language')).toHaveLength(0);
        expect(result.edges.filter((e) => e.kind === 'hierarchy')).toHaveLength(0);
        expect(hubs.find((n) => n.id === 'tag:egypt').childTags).toEqual(
            expect.arrayContaining(['language', 'nile'])
        );
    });

    test('a second pass does not duplicate hubs or spokes', () => {
        const once = attachTagHubs([A, B], []);
        const twice = attachTagHubs(once.nodes, once.edges);
        expect(twice.nodes.filter((n) => n.type === 'tag')).toHaveLength(
            once.nodes.filter((n) => n.type === 'tag').length
        );
        expect(twice.edges.filter((e) => e.kind === 'tag')).toHaveLength(
            once.edges.filter((e) => e.kind === 'tag').length
        );
        expect(tagNodeId('Egypt')).toBe('tag:egypt');
    });
});
