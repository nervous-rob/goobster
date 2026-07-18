/**
 * Unit tests for the per-guild knowledge graph
 * (services/knowledgeGraphService.js), against a throwaway SQLite database.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-kg-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('../db');
const kg = require('../services/knowledgeGraphService');

const GUILD = '300000000000000001';
const OTHER_GUILD = '300000000000000002';

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-shm', '-wal']) {
        fs.rmSync(TEST_DB + suffix, { force: true });
    }
});

beforeEach(() => {
    db.run('DELETE FROM kg_edges', {});
    db.run('DELETE FROM kg_nodes', {});
});

describe('nodes', () => {
    test('creates a node with normalized fields', () => {
        const result = kg.upsertNode({
            guildId: GUILD,
            type: 'person',
            label: '  Rob  ',
            content: 'Runs the minecraft server',
            salience: 1.7 // clamped to 1
        });
        expect(result.created).toBe(true);

        const node = kg.getNode(GUILD, 'rob'); // case-insensitive lookup
        expect(node.label).toBe('Rob');
        expect(node.type).toBe('person');
        expect(node.salience).toBe(1);
    });

    test('upsert updates the existing node instead of duplicating, preserving omitted fields', () => {
        kg.upsertNode({ guildId: GUILD, type: 'concept', label: 'raspberry pi', content: 'tiny computer', salience: 0.4 });
        const second = kg.upsertNode({ guildId: GUILD, label: 'Raspberry Pi', salience: 0.9 });

        expect(second.created).toBe(false);
        expect(db.get('SELECT COUNT(*) AS c FROM kg_nodes').c).toBe(1);

        const node = kg.getNode(GUILD, 'raspberry pi');
        expect(node.salience).toBe(0.9);
        expect(node.content).toBe('tiny computer'); // preserved
        expect(node.type).toBe('concept');          // preserved
    });

    test('invalid node type falls back to concept; invalid input returns null', () => {
        const result = kg.upsertNode({ guildId: GUILD, type: 'vibe', label: 'x' });
        expect(kg.getNode(GUILD, 'x').type).toBe('concept');
        expect(result.created).toBe(true);

        expect(kg.upsertNode({ guildId: GUILD, label: '   ' })).toBeNull();
        expect(kg.upsertNode({ label: 'no guild' })).toBeNull();
    });

    test('nodes are guild-scoped', () => {
        kg.upsertNode({ guildId: GUILD, label: 'shared label' });
        kg.upsertNode({ guildId: OTHER_GUILD, label: 'shared label' });
        expect(db.get('SELECT COUNT(*) AS c FROM kg_nodes').c).toBe(2);
        expect(kg.deleteNode(GUILD, 'shared label')).toBe(1);
        expect(kg.getNode(OTHER_GUILD, 'shared label')).toBeDefined();
    });

    test('searchNodes matches keywords in label and content, most salient first', () => {
        kg.upsertNode({ guildId: GUILD, label: 'deploy pipeline', salience: 0.9 });
        kg.upsertNode({ guildId: GUILD, label: 'game night', content: 'weekly deploy of fun', salience: 0.3 });
        kg.upsertNode({ guildId: GUILD, label: 'unrelated', salience: 1 });

        const results = kg.searchNodes({ guildId: GUILD, query: 'how is the DEPLOY going?' });
        expect(results.map(n => n.label)).toEqual(['deploy pipeline', 'game night']);

        // Short/stop words (<3 chars) are ignored entirely
        expect(kg.searchNodes({ guildId: GUILD, query: 'a b' })).toEqual([]);
    });
});

describe('edges', () => {
    test('link auto-creates stub endpoints and upserts weight on re-link', () => {
        const edge = kg.link({ guildId: GUILD, source: 'goobster', relation: 'runs_on', target: 'raspberry pi', weight: 0.7 });
        expect(edge).not.toBeNull();
        expect(kg.getNode(GUILD, 'goobster')).toBeDefined();
        expect(kg.getNode(GUILD, 'raspberry pi')).toBeDefined();

        kg.link({ guildId: GUILD, source: 'goobster', relation: 'runs_on', target: 'raspberry pi', weight: 0.2 });
        const edges = kg.edgesFor(GUILD, [kg.getNode(GUILD, 'goobster').id]);
        expect(edges).toHaveLength(1);
        expect(edges[0].weight).toBeCloseTo(0.2);
        expect(edges[0].sourceLabel).toBe('goobster');
        expect(edges[0].targetLabel).toBe('raspberry pi');
    });

    test('self-loops and empty relations are rejected', () => {
        expect(kg.link({ guildId: GUILD, source: 'a node', relation: 'is', target: 'A Node' })).toBeNull();
        expect(kg.link({ guildId: GUILD, source: 'a', relation: '', target: 'b' })).toBeNull();
    });

    test('deleting a node cascades its edges', () => {
        kg.link({ guildId: GUILD, source: 'alpha', relation: 'relates_to', target: 'beta' });
        kg.link({ guildId: GUILD, source: 'beta', relation: 'relates_to', target: 'gamma' });
        expect(db.get('SELECT COUNT(*) AS c FROM kg_edges').c).toBe(2);

        kg.deleteNode(GUILD, 'beta');
        expect(db.get('SELECT COUNT(*) AS c FROM kg_edges').c).toBe(0);
        expect(kg.getNode(GUILD, 'alpha')).toBeDefined();
    });

    test('unlink removes a specific relation or all edges between two nodes', () => {
        kg.link({ guildId: GUILD, source: 'a', relation: 'likes', target: 'b' });
        kg.link({ guildId: GUILD, source: 'a', relation: 'fears', target: 'b' });

        expect(kg.unlink({ guildId: GUILD, source: 'a', target: 'b', relation: 'likes' })).toBe(1);
        expect(db.get('SELECT COUNT(*) AS c FROM kg_edges').c).toBe(1);
        expect(kg.unlink({ guildId: GUILD, source: 'a', target: 'b' })).toBe(1);
        expect(db.get('SELECT COUNT(*) AS c FROM kg_edges').c).toBe(0);
    });
});

describe('traversal and rendering', () => {
    beforeEach(() => {
        kg.upsertNode({ guildId: GUILD, type: 'person', label: 'rob', salience: 0.9 });
        kg.upsertNode({ guildId: GUILD, type: 'thing', label: 'pi cluster', content: 'four nodes', salience: 0.8 });
        kg.upsertNode({ guildId: GUILD, type: 'event', label: 'deploy day', salience: 0.6 });
        kg.upsertNode({ guildId: GUILD, label: 'distant idea', salience: 0.1 });
        kg.link({ guildId: GUILD, source: 'rob', relation: 'built', target: 'pi cluster', weight: 0.9 });
        kg.link({ guildId: GUILD, source: 'pi cluster', relation: 'hosts', target: 'deploy day', weight: 0.5 });
    });

    test('getNeighborhood expands hop by hop', () => {
        const oneHop = kg.getNeighborhood({ guildId: GUILD, label: 'rob', depth: 1 });
        expect(oneHop.nodes.map(n => n.label).sort()).toEqual(['pi cluster', 'rob']);
        expect(oneHop.edges).toHaveLength(1);

        const twoHops = kg.getNeighborhood({ guildId: GUILD, label: 'rob', depth: 2 });
        expect(twoHops.nodes.map(n => n.label).sort()).toEqual(['deploy day', 'pi cluster', 'rob']);
        expect(twoHops.edges).toHaveLength(2);

        expect(kg.getNeighborhood({ guildId: GUILD, label: 'nope' })).toEqual({ nodes: [], edges: [] });
    });

    test('describeForPrompt prefers query-relevant nodes and renders edges', () => {
        const text = kg.describeForPrompt({ guildId: GUILD, query: 'talking about the pi cluster today' });
        expect(text).toContain('[thing] "pi cluster"');
        expect(text).toContain('four nodes');
        // Both endpoints of an edge must be in the selected set for it to render
        expect(text).not.toContain('distant idea');

        // No query -> most salient nodes with their interconnections
        const top = kg.describeForPrompt({ guildId: GUILD });
        expect(top).toContain('"rob" --built--> "pi cluster"');

        expect(kg.describeForPrompt({ guildId: OTHER_GUILD })).toBeNull();
    });

    test('getStats and forgetGuild', () => {
        expect(kg.getStats(GUILD)).toEqual({ nodes: 4, edges: 2 });
        expect(kg.forgetGuild(GUILD)).toBe(4);
        expect(kg.getStats(GUILD)).toEqual({ nodes: 0, edges: 0 });
    });
});
