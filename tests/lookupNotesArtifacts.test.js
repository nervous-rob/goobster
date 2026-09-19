/**
 * lookupNotes finds saved artifacts (fetchWebFile / findImages / saveArtifact).
 *
 * Regression: artifacts were only searched when the ordinary graph lookup
 * came back empty, the graph ranked LIKE hits by salience alone, and the
 * ARTIFACTS block was appended after the graph and clipped off by the
 * budget - so a file named almost verbatim lost to unrelated 0.99-salience
 * concepts. Retrieval here is purely lexical: no embedding backend, no
 * consolidation pass, immediate after save.
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const tmpRoot = path.join(os.tmpdir(), `goobster-lookup-artifacts-${process.pid}-${Date.now()}`);
process.env.GOOBSTER_DATA_DIR = tmpRoot;
process.env.GOOBSTER_DB_PATH = path.join(tmpRoot, 'test.sqlite');

const db = require('../packages/core/db');
const kg = require('../packages/core/services/knowledgeGraphService');
const kgArtifactService = require('../packages/core/services/kgArtifactService');
const fileDiscoveryService = require('../packages/core/services/fileDiscoveryService');
const memoryService = require('../packages/core/services/memoryService');
const embeddingService = require('../packages/core/services/embeddingService');
const toolsRegistry = require('../packages/core/utils/toolsRegistry');
const { retrieveNotes } = require('../packages/core/utils/chat/promptContext');
const lookupRelevance = require('../packages/core/utils/lookupRelevance');
const { dmScopeId } = require('../packages/core/utils/dmScope');

const USER = '920000000000000001';
const OTHER = '920000000000000002';
const DM = dmScopeId(USER);
const GUILD = '920000000000000900';
const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64'
);

const PROJECTS_MD = [
    '# Projects',
    '',
    'Observatory projects are folders with triggers, missions, and deliveries.',
    '',
    '## Deliveries',
    '',
    'The project_trigger_deliveries table records every attempt. A RETRYABLE failure',
    'is retried with exponential backoff; a terminal failure is surfaced in the inbox.',
    ''
].join('\n');

const scopeOf = (userId) => kg.resolveScopeKey({ subjectType: 'USER', subjectId: userId });

async function seedNoise(guildId, userId, count = 12) {
    for (let i = 0; i < count; i++) {
        await kg.upsertNode({
            guildId,
            scopeKey: scopeOf(userId),
            subjectType: 'USER',
            subjectId: userId,
            type: 'concept',
            label: `Concept ${i}`,
            content: `Works on many projects and reads documentation about topic ${i}. ${'Lorem ipsum dolor sit amet. '.repeat(12)}`,
            salience: 0.99,
            confidence: 0.95,
            source: 'monologue'
        });
    }
}

async function lookup(query, { userId = USER, guildId = null, about = 'me' } = {}) {
    return toolsRegistry.execute('lookupNotes', {
        query,
        about,
        interactionContext: { guildId, user: { id: userId }, channelId: 'chan' }
    });
}

function artifactLine(text, label) {
    return text.split('\n').find(line => line.includes('[saved artifact/') && line.includes(`"${label}"`)) || null;
}

beforeAll(async () => {
    await db.run('DELETE FROM kg_provenance');
    await db.run('DELETE FROM kg_artifacts');
    await db.run('DELETE FROM kg_edges');
    await db.run('DELETE FROM kg_nodes');
});

afterAll(async () => {
    await db.closeConnection?.();
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* */ }
});

describe('lookupRelevance (pure ranking helpers)', () => {
    test('tiers: exact label/file name > strong > phrase > partial', () => {
        const exactLabel = lookupRelevance.scoreCandidate({ query: 'Observatory projects documentation projects.md', label: 'Observatory projects documentation projects.md' });
        const exactFile = lookupRelevance.scoreCandidate({ query: 'projects.md', label: 'anything', fileName: 'projects.md' });
        const strong = lookupRelevance.scoreCandidate({ query: 'that projects.md file', label: 'x', fileName: 'projects.md' });
        const phrase = lookupRelevance.scoreCandidate({ query: 'RETRYABLE backoff', label: 'x', texts: [PROJECTS_MD] });
        const partial = lookupRelevance.scoreCandidate({ query: 'projects tea', label: 'Concept', texts: ['works on many projects'], salience: 0.99 });
        expect(exactLabel.tier).toBe(lookupRelevance.TIER.exact);
        expect(exactFile.tier).toBe(lookupRelevance.TIER.exact);
        expect(strong.tier).toBe(lookupRelevance.TIER.strong);
        expect(phrase.tier).toBe(lookupRelevance.TIER.phrase);
        expect(partial.tier).toBe(lookupRelevance.TIER.partial);
        expect(exactLabel.score).toBeGreaterThan(strong.score);
        expect(strong.score).toBeGreaterThan(phrase.score);
        expect(phrase.score).toBeGreaterThan(partial.score);
    });

    test('salience never outranks a clear relevance tier', () => {
        const relevant = lookupRelevance.scoreCandidate({ query: 'projects.md', fileName: 'projects.md', salience: 0.1, confidence: 0.1 });
        const salient = lookupRelevance.scoreCandidate({ query: 'projects.md', label: 'Concept', texts: ['many projects'], salience: 1, confidence: 1 });
        expect(relevant.score).toBeGreaterThan(salient.score);
    });

    test('excerptAround is bounded and centred on the match', () => {
        const filler = 'alpha beta gamma delta epsilon '.repeat(120);
        const text = `${filler}the needle phrase sits here ${filler}`;
        const excerpt = lookupRelevance.excerptAround(text, { query: 'needle phrase', maxChars: 160 });
        expect(excerpt.length).toBeLessThanOrEqual(162);
        expect(excerpt).toContain('needle phrase');
        expect(excerpt.startsWith('…')).toBe(true);
        expect(excerpt.endsWith('…')).toBe(true);
        const idx = excerpt.indexOf('needle phrase');
        expect(idx).toBeGreaterThan(30);
        expect(excerpt.length - idx).toBeGreaterThan(30);
    });

    test('excerptAround falls back to the head when nothing matches', () => {
        const excerpt = lookupRelevance.excerptAround('x '.repeat(500), { query: 'zzz', maxChars: 50 });
        expect(excerpt.length).toBeLessThanOrEqual(51);
        expect(excerpt.endsWith('…')).toBe(true);
    });
});

describe('lookupNotes finds saved artifacts', () => {
    let saved;

    beforeAll(async () => {
        await seedNoise(DM, USER);
        saved = await kgArtifactService.saveArtifact({
            guildId: DM,
            userId: USER,
            label: 'Observatory projects documentation projects.md',
            summary: 'Fetched from the repo docs. Explains project triggers and deliveries.',
            attachment: { name: 'projects.md', content: PROJECTS_MD, mimeType: 'text/markdown' },
            tags: ['docs'],
            confirm: true
        });
    });

    test('1 + 5: the exact label finds it, immediately after saving', async () => {
        const out = await lookup('Observatory projects documentation projects.md');
        const line = artifactLine(out, saved.label);
        expect(line).not.toBeNull();
        expect(line).toContain('file projects.md');
        expect(line).toContain('markdown');
        expect(line).toContain('notes: Fetched from the repo docs');
        expect(line).toContain(`id ${saved.nodeId}`);
        expect(line).toContain('showSavedFiles(query="Observatory projects documentation projects.md")');
    });

    test('2: a distinctive phrase from extractedText finds it', async () => {
        const out = await lookup('project_trigger_deliveries RETRYABLE backoff');
        const line = artifactLine(out, saved.label);
        expect(line).not.toBeNull();
        expect(line).toContain('excerpt:');
        expect(line).toContain('project_trigger_deliveries');
        expect(line).toContain('RETRYABLE');
    });

    test('3: the original file name finds it', async () => {
        const out = await lookup('projects.md');
        expect(artifactLine(out, saved.label)).not.toBeNull();
    });

    test('7: the exact match outranks unrelated nodes with salience 0.99', async () => {
        const out = await lookup('Observatory projects documentation projects.md');
        const lines = out.split('\n');
        const artifactIdx = lines.findIndex(l => l.includes('[saved artifact/'));
        const conceptIdx = lines.findIndex(l => l.includes('[concept] "Concept'));
        expect(artifactIdx).toBeGreaterThan(-1);
        expect(conceptIdx === -1 || artifactIdx < conceptIdx).toBe(true);

        const scoped = await retrieveNotes({
            guildId: DM, userId: USER, query: 'projects.md', depth: 'rich', includeMemories: false
        });
        expect(scoped.artifacts[0].label).toBe(saved.label);
        expect(scoped.artifacts[0].relevanceTier).toBe(lookupRelevance.TIER.exact);
        // The graph slice still carries ordinary notes - salience is not
        // removed from retrieval, it just stops overriding relevance.
        expect(scoped.graph).toContain('[concept] "Concept');
    });

    test('6: retrieval works with no embedding backend and no memories', async () => {
        // Memory recall is disabled outright (no embedding backend) and the
        // embedder itself rejects - neither may keep the artifact from surfacing.
        const enabled = jest.spyOn(memoryService, 'isEnabled').mockReturnValue(false);
        const embed = jest.spyOn(embeddingService, 'embed').mockRejectedValue(new Error('no embedding backend'));
        const recall = jest.spyOn(memoryService, 'recall');
        try {
            const out = await lookup('Observatory projects documentation projects.md');
            expect(artifactLine(out, saved.label)).not.toBeNull();
            const results = await Promise.all(recall.mock.results.map(r => r.value));
            expect(results.every(rows => Array.isArray(rows) && rows.length === 0)).toBe(true);
        } finally {
            enabled.mockRestore();
            embed.mockRestore();
            recall.mockRestore();
        }
    });

    test('8: excerpts are bounded and centred around the match', async () => {
        const filler = 'The quick brown fox jumps over the lazy dog. '.repeat(160);
        const long = `${filler}Deployment note: rotate the ZEBRA_TOKEN secret quarterly. ${filler}`;
        const big = await kgArtifactService.saveArtifact({
            guildId: DM,
            userId: USER,
            label: 'ops runbook',
            summary: 'Long operations runbook.',
            attachment: { name: 'runbook.txt', content: long, mimeType: 'text/plain' },
            confirm: true
        });
        const out = await lookup('ZEBRA_TOKEN secret');
        const line = artifactLine(out, big.label);
        expect(line).not.toBeNull();
        expect(line).toContain('ZEBRA_TOKEN');
        expect(line.length).toBeLessThan(1400);
        expect(out.length).toBeLessThan(3600);
        const excerpt = line.split('excerpt: ')[1];
        expect(excerpt.startsWith('…')).toBe(true);
        expect(excerpt.indexOf('ZEBRA_TOKEN')).toBeGreaterThan(100);
    });

    test('4: a found image is found by label, notes, description, and origin metadata', async () => {
        const classified = fileDiscoveryService.classify({
            url: 'https://upload.example.org/Pillars_of_Creation.png', contentType: 'image/png', buffer: PNG
        });
        const { saved: image } = await fileDiscoveryService.saveFound({
            guildId: DM,
            userId: USER,
            buffer: PNG,
            ...classified,
            label: 'Pillars of Creation (JWST)',
            notes: 'Saved for the JWST Atlas project the user is building.',
            origin: {
                sourceUrl: 'https://upload.example.org/Pillars_of_Creation.png',
                pageUrl: 'https://commons.example.org/wiki/File:Pillars_of_Creation.png',
                title: 'Pillars of Creation NIRCam',
                description: 'Eagle Nebula star-forming region imaged by the James Webb Space Telescope.',
                credit: 'NASA, ESA, CSA, STScI',
                license: 'Public domain',
                provider: 'Wikimedia Commons'
            }
        });
        const row = await kgArtifactService.getByLabel({ guildId: DM, scopeKey: scopeOf(USER), label: image.label });
        expect(row.artifact.artifactKind).toBe('image');

        for (const query of [
            'Pillars of Creation image JWST Atlas',
            'JWST Atlas project',
            'Eagle Nebula star-forming region',
            'Pillars of Creation NIRCam'
        ]) {
            const out = await lookup(query);
            const line = artifactLine(out, image.label);
            expect(line).not.toBeNull();
            expect(line).toContain('[saved artifact/image]');
            expect(line).not.toContain('kg-artifacts/');
        }

        // Metadata that appears nowhere in the note body is still searchable
        // (title/description/credit/license/provider only - never URLs).
        const metaOnly = await kgArtifactService.saveArtifact({
            guildId: DM,
            userId: USER,
            label: 'nebula photo',
            summary: 'A photo the user liked.',
            attachment: { name: 'nebula.png', buffer: PNG, mimeType: 'image/png' },
            metadata: { title: 'Horsehead Nebula', credit: 'ESO', sourceUrl: 'https://cdn.example.org/secret-path/x.png' },
            confirm: true
        });
        expect(artifactLine(await lookup('Horsehead Nebula'), metaOnly.label)).not.toBeNull();
        expect(await lookup('secret-path')).not.toContain('nebula photo');
    });

    test('11: ordinary notes and memories still come back alongside artifacts', async () => {
        await kg.upsertNode({
            guildId: DM,
            scopeKey: scopeOf(USER),
            type: 'fact',
            label: 'tea',
            content: 'Prefers Earl Grey',
            salience: 0.9,
            source: 'tool'
        });
        const recall = jest.spyOn(memoryService, 'recall').mockResolvedValue([
            { content: 'Asked for oat milk in the tea last time', authorName: 'rob', createdAt: '2026-09-01 10:00:00' }
        ]);
        try {
            const out = await lookup('tea preference');
            expect(out).toContain('Earl Grey');
            expect(out).toContain('oat milk');
            expect(out).not.toContain('[saved artifact/');
        } finally {
            recall.mockRestore();
        }
    });

    test('reports nothing rather than unrelated high-salience notes when nothing matches', async () => {
        const out = await lookup('xylophone quartz');
        expect(out).toContain('Nothing on file');
        expect(out).not.toContain('Concept');
    });

    test('9: personal artifacts do not leak to other users or into server lookups', async () => {
        const inGuild = await kgArtifactService.saveArtifact({
            guildId: GUILD,
            userId: USER,
            label: 'private salary sheet',
            summary: 'Personal payroll export.',
            attachment: { name: 'salary.csv', content: 'month,amount\nJan,1\n', mimeType: 'text/csv' },
            confirm: true
        });

        const mine = await lookup('private salary sheet', { guildId: GUILD, about: 'me' });
        expect(artifactLine(mine, inGuild.label)).not.toBeNull();

        const theirs = await lookup('private salary sheet', { guildId: GUILD, userId: OTHER, about: 'me' });
        expect(theirs).not.toContain('salary');

        const server = await lookup('private salary sheet', { guildId: GUILD, about: 'server' });
        expect(server).not.toContain('salary');

        const otherDm = await lookup('Observatory projects documentation projects.md', { userId: OTHER });
        expect(otherDm).not.toContain('projects.md');
    });

    test('10: deleted artifacts no longer appear', async () => {
        const gone = await kgArtifactService.saveArtifact({
            guildId: DM,
            userId: USER,
            label: 'temporary scratch notes',
            summary: 'Scratch.',
            attachment: { name: 'scratch.md', content: '# scratch\nquokka census figures\n', mimeType: 'text/markdown' },
            confirm: true
        });
        expect(artifactLine(await lookup('quokka census'), gone.label)).not.toBeNull();

        await kg.deleteNode(DM, gone.label, scopeOf(USER));
        expect(await db.get('SELECT id FROM kg_artifacts WHERE nodeId = @id', { id: gone.nodeId })).toBeFalsy();
        expect(await lookup('quokka census')).not.toContain('temporary scratch notes');
    });
});
