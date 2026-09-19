/**
 * The findImages / fetchWebFile / showSavedFiles tools end to end against a
 * throwaway SQLite file: search + download are stubbed on the singleton
 * services (no network), everything after that - knowledge-base rows, disk
 * storage, channel.send payloads, generatedFiles entries, and the caption
 * plumbing the web portal reads back - is real.
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const tmpRoot = path.join(os.tmpdir(), `goobster-files-tool-${process.pid}-${Date.now()}`);
process.env.GOOBSTER_DATA_DIR = tmpRoot;
process.env.GOOBSTER_DB_PATH = path.join(tmpRoot, 'test.sqlite');

const db = require('../packages/core/db');
const toolsRegistry = require('@goobster/core/utils/toolsRegistry');
const imageSearchService = require('@goobster/core/services/imageSearchService');
const fileDiscoveryService = require('@goobster/core/services/fileDiscoveryService');
const webChatService = require('@goobster/core/services/webChatService');

const USER = '920000000000000001';
const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64'
);
const JPG_LIKE = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
const CSV = 'year,rainfall_mm\n2021,812\n2022,640\n2023,905\n';

function fakeInteraction({ guildId = null } = {}) {
    const sent = [];
    return {
        sent,
        interaction: {
            user: { id: USER, username: 'rob' },
            guildId,
            channelId: `web:${USER}:abc`,
            channel: { id: `web:${USER}:abc`, send: async (payload) => { sent.push(payload); return { id: 'm1' }; } }
        }
    };
}

const jacketCandidate = {
    title: 'U.S. Army M1943 uniform',
    imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/a/a1/M1943_Field_Jacket.jpg',
    pageUrl: 'https://commons.wikimedia.org/wiki/File:M1943_Field_Jacket.jpg',
    width: 300, height: 380, mime: 'image/jpeg',
    description: 'A photo of an M-1943 Field Jacket.',
    credit: 'Carl Wouters', license: 'CC BY-SA 3.0', provider: 'Wikipedia'
};
const capCandidate = {
    title: 'German WW2 M43 field cap',
    imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/9c/cap.jpg/1024px-cap.jpg',
    pageUrl: 'https://commons.wikimedia.org/wiki/File:cap.jpg',
    width: 1024, height: 1536, mime: 'image/jpeg',
    description: null, credit: 'Wolfmann', license: 'CC BY-SA 4.0', provider: 'Wikimedia Commons'
};

beforeAll(async () => {
    await db.run('DELETE FROM kg_provenance');
    await db.run('DELETE FROM kg_artifacts');
    await db.run('DELETE FROM kg_nodes');
    await db.run('DELETE FROM web_generated_files');
});

afterEach(() => jest.restoreAllMocks());

afterAll(async () => {
    await db.closeConnection?.();
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* */ }
});

describe('registry', () => {
    test('the three file tools are offered in Discord, the portal, and automations', async () => {
        for (const ctx of [{}, { isWeb: true }, { isAutomation: true }]) {
            const names = (await toolsRegistry.getDefinitions(undefined, ctx)).map(d => d.name);
            expect(names).toEqual(expect.arrayContaining(['findImages', 'fetchWebFile', 'showSavedFiles']));
        }
    });
});

describe('findImages', () => {
    test('searches, downloads, saves with notes + origin, displays with a caption, and records history entries', async () => {
        jest.spyOn(imageSearchService, 'search').mockResolvedValue({
            candidates: [jacketCandidate, capCandidate], providersTried: ['wikipedia', 'commons'], errors: []
        });
        const download = jest.spyOn(fileDiscoveryService, 'download').mockImplementation(async (url) => ({
            buffer: url.includes('cap') ? JPG_LIKE : PNG, contentType: 'image/jpeg', finalUrl: url, hops: 0
        }));
        const { interaction, sent } = fakeInteraction();

        const result = await toolsRegistry.execute('findImages', {
            query: 'M1943 field jacket',
            count: 2,
            notes: 'WWII US Army field jacket the user collects.',
            tags: ['WW2', 'Uniforms'],
            interactionContext: interaction
        });

        expect(download).toHaveBeenCalledTimes(2);
        expect(download.mock.calls[0][1]).toEqual({ allowedContentTypes: ['image/'] });
        expect(result).toContain('Saved and displayed 2 image(s) for "M1943 field jacket"');
        expect(result).toContain('1. "M1943 field jacket" — image');
        expect(result).toContain('U.S. Army M1943 uniform — Carl Wouters, CC BY-SA 3.0 — via Wikipedia');
        expect(result).toContain('2. "M1943 field jacket (2)"');
        expect(result).toContain('do not paste image URLs');

        // Displayed through channel.send with the Discord alt-text field
        // plus the portal-only hints discord.js ignores
        expect(sent).toHaveLength(2);
        expect(sent[0].files[0]).toMatchObject({
            name: 'M1943_Field_Jacket.png',
            description: 'U.S. Army M1943 uniform — Carl Wouters, CC BY-SA 3.0 — via Wikipedia',
            sourceUrl: 'https://commons.wikimedia.org/wiki/File:M1943_Field_Jacket.jpg',
            kind: 'image'
        });
        expect(fs.existsSync(sent[0].files[0].attachment)).toBe(true);

        // History entries are objects the chat pipeline persists verbatim
        expect(interaction.generatedFiles).toHaveLength(2);
        expect(interaction.generatedFiles[0]).toEqual({
            path: sent[0].files[0].attachment,
            name: 'M1943_Field_Jacket.png',
            caption: 'U.S. Army M1943 uniform — Carl Wouters, CC BY-SA 3.0 — via Wikipedia',
            sourceUrl: 'https://commons.wikimedia.org/wiki/File:M1943_Field_Jacket.jpg',
            kind: 'image'
        });

        // Knowledge base: artifact nodes under the user's DM scope with notes, tags, and origin
        const rows = await db.all(
            `SELECT n.label, n.content, n.type, a.artifactKind, a.metadataJson, a.extractedText
             FROM kg_nodes n JOIN kg_artifacts a ON a.nodeId = n.id
             WHERE n.guildId = @guildId ORDER BY n.id`,
            { guildId: `dm:${USER}` }
        );
        expect(rows.map(r => r.label)).toEqual(['M1943 field jacket', 'M1943 field jacket (2)']);
        expect(rows[0].type).toBe('artifact');
        expect(rows[0].artifactKind).toBe('image');
        expect(rows[0].content).toContain('WWII US Army field jacket the user collects.');
        expect(JSON.parse(rows[0].metadataJson)).toMatchObject({ provider: 'Wikipedia', license: 'CC BY-SA 3.0' });
        expect(rows[0].extractedText).toContain('A photo of an M-1943 Field Jacket.');
        const tags = await db.all(
            `SELECT t.name FROM kg_tags t JOIN kg_node_tags nt ON nt.tagId = t.id
             JOIN kg_nodes n ON n.id = nt.nodeId WHERE n.label = 'M1943 field jacket'`
        );
        expect(tags.map(t => t.name).sort()).toEqual(['found-on-web', 'image', 'uniforms', 'ww2']);
    });

    test('a download failure skips that candidate and moves on; total failure is reported, not thrown', async () => {
        jest.spyOn(imageSearchService, 'search').mockResolvedValue({
            candidates: [{ ...capCandidate, imageUrl: 'https://upload.wikimedia.org/broken.jpg' }, { ...capCandidate, title: 'Working cap' }],
            providersTried: ['commons'], errors: []
        });
        jest.spyOn(fileDiscoveryService, 'download').mockImplementation(async (url) => {
            if (url.includes('broken')) { const e = new Error('The server answered 404.'); e.code = 'HTTP_ERROR'; throw e; }
            return { buffer: JPG_LIKE, contentType: 'image/jpeg', finalUrl: url, hops: 0 };
        });
        const { interaction, sent } = fakeInteraction();
        const result = await toolsRegistry.execute('findImages', { query: 'M43 cap', count: 1, interactionContext: interaction });
        expect(sent).toHaveLength(1);
        expect(result).toContain('Saved and displayed 1 image(s)');
        expect(result).toContain('already in the knowledge base'); // same bytes as the cap saved above
        expect(result).toContain('Skipped: German WW2 M43 field cap: The server answered 404.');

        jest.spyOn(fileDiscoveryService, 'download').mockRejectedValue(Object.assign(new Error('timeout'), { code: 'TIMEOUT' }));
        const failed = await toolsRegistry.execute('findImages', { query: 'M43 cap', interactionContext: fakeInteraction().interaction });
        expect(failed).toMatch(/none could be downloaded/);
    });

    test('no candidates → a plain "nothing found" observation naming the providers', async () => {
        jest.spyOn(imageSearchService, 'search').mockResolvedValue({ candidates: [], providersTried: ['wikipedia', 'commons'], errors: ['commons: 503'] });
        const result = await toolsRegistry.execute('findImages', { query: 'zxqv', interactionContext: fakeInteraction().interaction });
        expect(result).toContain('No images found for "zxqv" (searched wikipedia, commons)');
        expect(result).toContain('commons: 503');
    });

    test('refuses outside a conversation', async () => {
        expect(await toolsRegistry.execute('findImages', { query: 'x' })).toMatch(/inside a conversation/);
        expect(await toolsRegistry.execute('findImages', { query: '   ', interactionContext: fakeInteraction().interaction })).toMatch(/needs a query/);
    });
});

describe('fetchWebFile', () => {
    test('fetches a CSV, saves it under the label, displays it as a table, and previews its shape', async () => {
        jest.spyOn(fileDiscoveryService, 'download').mockResolvedValue({
            buffer: Buffer.from(CSV), contentType: 'text/plain', finalUrl: 'https://data.example.org/rain/annual.csv', hops: 1
        });
        const { interaction, sent } = fakeInteraction();
        const result = await toolsRegistry.execute('fetchWebFile', {
            url: 'https://short.example.org/rain',
            label: 'Annual rainfall',
            notes: 'Yearly totals the user wanted to chart.',
            interactionContext: interaction
        });
        expect(result).toContain('Saved "Annual rainfall" — csv annual.csv');
        expect(result).toContain('source: https://data.example.org/rain/annual.csv');
        expect(result).toContain('~3 data rows × 2 columns');
        expect(result).toContain('Columns: year, rainfall_mm');
        expect(result).toContain('2021 | 812');
        expect(sent[0].files[0]).toMatchObject({ name: 'annual.csv', kind: 'csv', sourceUrl: 'https://data.example.org/rain/annual.csv' });
        expect(interaction.generatedFiles[0]).toMatchObject({ name: 'annual.csv', kind: 'csv' });
        const row = await db.get(
            `SELECT a.artifactKind, a.extractedText, a.metadataJson FROM kg_nodes n JOIN kg_artifacts a ON a.nodeId = n.id WHERE n.label = 'Annual rainfall'`
        );
        expect(row.artifactKind).toBe('document');
        expect(row.extractedText).toContain('2023,905');
        expect(JSON.parse(row.metadataJson)).toMatchObject({ displayKind: 'csv', credit: 'data.example.org' });
    });

    test('download and classification failures come back as observations with the error code', async () => {
        jest.spyOn(fileDiscoveryService, 'download').mockRejectedValue(Object.assign(new Error('Only https:// URLs can be fetched.'), { code: 'HTTPS_ONLY' }));
        const { interaction } = fakeInteraction();
        expect(await toolsRegistry.execute('fetchWebFile', { url: 'http://x', label: 'x', interactionContext: interaction }))
            .toBe('❌ Could not fetch that file (HTTPS_ONLY): Only https:// URLs can be fetched.');

        jest.spyOn(fileDiscoveryService, 'download').mockResolvedValue({
            buffer: Buffer.from('<!doctype html><html><body>hi</body></html>'), contentType: 'text/html', finalUrl: 'https://x.example.org/', hops: 0
        });
        expect(await toolsRegistry.execute('fetchWebFile', { url: 'https://x.example.org/', label: 'page', interactionContext: interaction }))
            .toMatch(/IS_WEB_PAGE.*web page, not a file/);
        expect(await toolsRegistry.execute('fetchWebFile', { url: 'https://x.example.org/', label: '  ', interactionContext: interaction }))
            .toMatch(/needs a short label/);
    });
});

describe('showSavedFiles', () => {
    test('finds saved files by words, re-displays them with captions, and filters by kind', async () => {
        const { interaction, sent } = fakeInteraction();
        const result = await toolsRegistry.execute('showSavedFiles', { query: 'M1943 jacket', kind: 'image', limit: 1, interactionContext: interaction });
        expect(result).toContain('Displayed 1 saved file(s):');
        expect(result).toContain('"M1943 field jacket" — image M1943_Field_Jacket.png — U.S. Army M1943 uniform — Carl Wouters');
        expect(result).toContain('Notes: WWII US Army field jacket the user collects.');
        expect(sent[0].files[0]).toMatchObject({ name: 'M1943_Field_Jacket.png', kind: 'image', description: expect.stringContaining('Carl Wouters') });
        expect(interaction.generatedFiles[0]).toMatchObject({ kind: 'image', caption: expect.stringContaining('Carl Wouters') });

        const csv = fakeInteraction();
        const csvResult = await toolsRegistry.execute('showSavedFiles', { kind: 'csv', interactionContext: csv.interaction });
        expect(csvResult).toContain('"Annual rainfall" — csv annual.csv');
        expect(csv.sent[0].files[0]).toMatchObject({ name: 'annual.csv', kind: 'csv' });
    });

    test('nothing matching → tells the model to offer a search instead of inventing', async () => {
        const result = await toolsRegistry.execute('showSavedFiles', { query: 'unicorn spreadsheet', interactionContext: fakeInteraction().interaction });
        expect(result).toContain('No saved files matching "unicorn spreadsheet"');
        expect(result).toContain('instead of inventing');
        expect(await toolsRegistry.execute('showSavedFiles', { query: 'x' })).toMatch(/inside a conversation/);
    });
});

describe('portal plumbing', () => {
    test('_emitMessage forwards caption / sourceUrl / kind from the send payload', async () => {
        const filePath = path.join(tmpRoot, 'emit.png');
        fs.writeFileSync(filePath, PNG);
        const messages = [];
        await webChatService._emitMessage({ onMessage: (m) => messages.push(m) }, {
            files: [{ attachment: filePath, name: 'emit.png', description: 'A caption', sourceUrl: 'https://commons.wikimedia.org/wiki/File:x.jpg', kind: 'image' }]
        }, USER);
        expect(messages).toHaveLength(1);
        expect(messages[0].attachments[0]).toMatchObject({
            url: expect.stringMatching(/^\/api\/app\/files\/[0-9a-f]{32}$/),
            name: 'emit.png', caption: 'A caption', sourceUrl: 'https://commons.wikimedia.org/wiki/File:x.jpg', kind: 'image'
        });
        // Non-http sourceUrls and odd kinds are dropped, captions bounded
        messages.length = 0;
        await webChatService._emitMessage({ onMessage: (m) => messages.push(m) }, {
            files: [{ attachment: filePath, name: 'emit.png', description: 'x'.repeat(500), sourceUrl: 'javascript:alert(1)', kind: 'weird kind!' }]
        }, USER);
        expect(messages[0].attachments[0].caption).toHaveLength(400);
        expect(messages[0].attachments[0]).not.toHaveProperty('sourceUrl');
        expect(messages[0].attachments[0]).not.toHaveProperty('kind');
    });

    test('_attachmentsFromMetadata restores the hints the chat pipeline persisted', async () => {
        const filePath = path.join(tmpRoot, 'hist.csv');
        fs.writeFileSync(filePath, CSV);
        const attachments = await webChatService._attachmentsFromMetadata(JSON.stringify({
            attachments: [
                { path: filePath, name: 'hist.csv', caption: 'Rain', sourceUrl: 'https://data.example.org/a.csv', kind: 'csv' },
                { path: path.join(tmpRoot, 'gone.csv'), name: 'gone.csv' }
            ]
        }), USER);
        expect(attachments).toEqual([expect.objectContaining({ name: 'hist.csv', caption: 'Rain', sourceUrl: 'https://data.example.org/a.csv', kind: 'csv' })]);
    });
});
