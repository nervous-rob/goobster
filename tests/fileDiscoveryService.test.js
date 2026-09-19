/**
 * fileDiscoveryService: the download → classify → save → recall → preview
 * chain behind the findImages / fetchWebFile / showSavedFiles tools. The
 * safeFetch stages are injected so no network is touched; storage runs
 * against a throwaway SQLite file + data dir.
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const tmpRoot = path.join(os.tmpdir(), `goobster-file-discovery-${process.pid}-${Date.now()}`);
process.env.GOOBSTER_DATA_DIR = tmpRoot;
process.env.GOOBSTER_DB_PATH = path.join(tmpRoot, 'test.sqlite');

const db = require('../packages/core/db');
const {
    FileDiscoveryService,
    FileDiscoveryError,
    parseDelimited,
    sniffImageMime,
    displayKindFor
} = require('../packages/core/services/fileDiscoveryService');
const kgArtifactService = require('../packages/core/services/kgArtifactService');
const knowledgeGraphService = require('../packages/core/services/knowledgeGraphService');
const { assessUrl } = require('../packages/core/utils/safeFetch');
const config = require('../packages/core/config/fileDiscoveryConfig');

const GUILD = 'dm:910000000000000001';
const USER = '910000000000000001';
const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64'
);
const CSV = 'city,population,note\nParis,2102650,"capital, France"\nLyon,522250,""\nNice,342669,seaside\n';

/** A fake transfer: routes are { status, headers, body } or { location }. */
function fakeStages(routes) {
    const calls = [];
    return {
        calls,
        deps: {
            assessUrl,
            resolvePinned: async (host) => ({ address: `10.0.0.${host.length}`.replace('10.0.0', '93.184.216'), family: 4 }),
            fetchToFile: async ({ url, destPath, maxBytes, allowedContentTypes, reportRedirects }) => {
                calls.push(url.toString());
                const route = routes[url.toString()];
                if (!route) {
                    const err = new Error(`no route for ${url}`);
                    err.code = 'HTTP_ERROR';
                    throw err;
                }
                if (route.location) {
                    if (!reportRedirects) {
                        const err = new Error('redirect');
                        err.code = 'REDIRECT_REFUSED';
                        throw err;
                    }
                    return { bytes: 0, contentType: null, redirectTo: new URL(route.location, url).toString() };
                }
                const contentType = route.contentType || null;
                if (allowedContentTypes.length > 0
                    && !allowedContentTypes.some(prefix => (contentType || '').startsWith(prefix))) {
                    const err = new Error(`type ${contentType} refused`);
                    err.code = 'TYPE_REFUSED';
                    throw err;
                }
                if (route.body.length > maxBytes) {
                    const err = new Error('too large');
                    err.code = 'TOO_LARGE';
                    throw err;
                }
                fs.writeFileSync(destPath, route.body);
                return { bytes: route.body.length, contentType };
            }
        }
    };
}

beforeAll(async () => {
    await db.run('DELETE FROM kg_provenance');
    await db.run('DELETE FROM kg_artifacts');
    await db.run('DELETE FROM kg_nodes');
});

afterAll(async () => {
    await db.closeConnection?.();
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* */ }
});

describe('download (injected safeFetch stages)', () => {
    test('returns the body, content type, and final URL', async () => {
        const { deps, calls } = fakeStages({
            'https://files.example.org/data.csv': { contentType: 'text/csv', body: Buffer.from(CSV) }
        });
        const svc = new FileDiscoveryService(deps);
        const result = await svc.download('https://files.example.org/data.csv');
        expect(result.buffer.toString('utf8')).toBe(CSV);
        expect(result.contentType).toBe('text/csv');
        expect(result.finalUrl).toBe('https://files.example.org/data.csv');
        expect(result.hops).toBe(0);
        expect(calls).toHaveLength(1);
    });

    test('follows a bounded redirect chain, re-vetting every hop', async () => {
        const { deps, calls } = fakeStages({
            'https://short.example.org/x': { location: 'https://cdn.example.org/real.png' },
            'https://cdn.example.org/real.png': { contentType: 'image/png', body: PNG }
        });
        const svc = new FileDiscoveryService(deps);
        const result = await svc.download('https://short.example.org/x');
        expect(result.finalUrl).toBe('https://cdn.example.org/real.png');
        expect(result.hops).toBe(1);
        expect(calls).toEqual(['https://short.example.org/x', 'https://cdn.example.org/real.png']);
    });

    test('a redirect to a non-https or forbidden target fails at assessment, never at connect', async () => {
        const { deps, calls } = fakeStages({
            'https://short.example.org/meta': { location: 'http://169.254.169.254/latest/' }
        });
        const svc = new FileDiscoveryService(deps);
        await expect(svc.download('https://short.example.org/meta'))
            .rejects.toMatchObject({ code: 'HTTPS_ONLY' });
        expect(calls).toEqual(['https://short.example.org/meta']);
    });

    test('gives up after MAX_REDIRECTS hops', async () => {
        const routes = {};
        for (let i = 0; i <= config.MAX_REDIRECTS + 1; i++) {
            routes[`https://loop.example.org/${i}`] = { location: `https://loop.example.org/${i + 1}` };
        }
        const svc = new FileDiscoveryService(fakeStages(routes).deps);
        await expect(svc.download('https://loop.example.org/0'))
            .rejects.toMatchObject({ code: 'TOO_MANY_REDIRECTS' });
    });

    test('plain http and credentialed URLs are refused before any transfer', async () => {
        const { deps, calls } = fakeStages({});
        const svc = new FileDiscoveryService(deps);
        await expect(svc.download('http://files.example.org/a.csv')).rejects.toMatchObject({ code: 'HTTPS_ONLY' });
        await expect(svc.download('https://user:pw@files.example.org/a.csv')).rejects.toMatchObject({ code: 'NO_CREDENTIALS' });
        expect(calls).toHaveLength(0);
    });

    test('surfaces the transfer stage error codes (type refusal, size cap)', async () => {
        const { deps } = fakeStages({
            'https://files.example.org/page': { contentType: 'text/html', body: Buffer.from('<html></html>') },
            'https://files.example.org/huge.bin': { contentType: 'application/octet-stream', body: Buffer.alloc(config.MAX_FILE_BYTES + 1) }
        });
        const svc = new FileDiscoveryService(deps);
        await expect(svc.download('https://files.example.org/page', { allowedContentTypes: ['image/'] }))
            .rejects.toMatchObject({ code: 'TYPE_REFUSED' });
        await expect(svc.download('https://files.example.org/huge.bin'))
            .rejects.toMatchObject({ code: 'TOO_LARGE' });
    });
});

describe('classify', () => {
    const svc = new FileDiscoveryService(fakeStages({}).deps);

    test('sniffed image bytes win over the declared type and fix the extension', () => {
        const out = svc.classify({ url: 'https://x.example.org/photo', contentType: 'application/octet-stream', buffer: PNG, preferredName: 'M1943 field jacket' });
        expect(out).toEqual({ fileName: 'm1943-field-jacket.png', mimeType: 'image/png', artifactKind: 'image', displayKind: 'image' });
        const renamed = svc.classify({ url: 'https://x.example.org/pic.jpg', contentType: 'image/jpeg', buffer: PNG });
        expect(renamed.fileName).toBe('pic.png');
    });

    test('a declared image whose bytes are not an image is refused', () => {
        expect(() => svc.classify({ url: 'https://x.example.org/a.png', contentType: 'image/png', buffer: Buffer.from('not really an image at all') }))
            .toThrow(FileDiscoveryError);
        expect(() => svc.classify({ url: 'https://x.example.org/a.png', contentType: 'image/png', buffer: Buffer.from('not really an image at all') }))
            .toThrow(/not a PNG/);
    });

    test('web pages and SVG are refused whatever the header says', () => {
        expect(() => svc.classify({ url: 'https://x.example.org/data.csv', contentType: 'text/csv', buffer: Buffer.from('<!DOCTYPE html><html><body>login</body></html>') }))
            .toThrow(/web page/);
        expect(() => svc.classify({ url: 'https://x.example.org/logo.svg', contentType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>') }))
            .toThrow(/SVG/);
        expect(() => svc.classify({ url: 'https://x.example.org/x.txt', contentType: 'text/plain', buffer: Buffer.from('<?xml version="1.0"?><svg></svg>') }))
            .toThrow(/SVG/);
    });

    test('octet-stream is accepted only with a known data extension', () => {
        const csv = svc.classify({ url: 'https://x.example.org/dl/report.csv', contentType: 'application/octet-stream', buffer: Buffer.from(CSV) });
        expect(csv).toMatchObject({ fileName: 'report.csv', mimeType: 'text/csv', artifactKind: 'document', displayKind: 'csv' });
        expect(() => svc.classify({ url: 'https://x.example.org/dl/blob', contentType: 'application/octet-stream', buffer: Buffer.from(CSV) }))
            .toThrow(/no recognizable extension/);
        expect(() => svc.classify({ url: 'https://x.example.org/tool.exe', contentType: 'application/x-msdownload', buffer: Buffer.from('MZ....') }))
            .toThrow(/not accepted/);
    });

    test('text/plain CSV keeps its csv extension; a bare URL gets one from the type', () => {
        const raw = svc.classify({ url: 'https://raw.example.org/repo/main/cities.csv', contentType: 'text/plain', buffer: Buffer.from(CSV) });
        expect(raw).toMatchObject({ fileName: 'cities.csv', displayKind: 'csv' });
        const bare = svc.classify({ url: 'https://api.example.org/export?format=json', contentType: 'application/json', buffer: Buffer.from('{"a":1}'), preferredName: 'API export' });
        expect(bare).toMatchObject({ fileName: 'api-export.json', artifactKind: 'code', displayKind: 'code' });
        const md = svc.classify({ url: 'https://x.example.org/README.md', contentType: 'text/markdown', buffer: Buffer.from('# Hi') });
        expect(md).toMatchObject({ fileName: 'README.md', artifactKind: 'markdown', displayKind: 'markdown' });
    });

    test('helpers: sniffImageMime and displayKindFor', () => {
        expect(sniffImageMime(PNG)).toBe('image/png');
        expect(sniffImageMime(Buffer.from('GIF89a' + '\u0000'.repeat(10)))).toBe('image/gif');
        expect(sniffImageMime(Buffer.from('hello world, not an image'))).toBeNull();
        expect(displayKindFor({ artifactKind: 'document', fileName: 'a.tsv' })).toBe('csv');
        expect(displayKindFor({ artifactKind: 'document', fileName: 'a.txt' })).toBe('document');
        expect(displayKindFor({ artifactKind: 'image', fileName: 'a.png' })).toBe('image');
    });
});

describe('saveFound → recall → preview (SQLite + data dir)', () => {
    const svc = new FileDiscoveryService(fakeStages({}).deps);
    const scopeKey = () => knowledgeGraphService.resolveScopeKey({ subjectType: 'USER', subjectId: USER });

    test('saves an image as an artifact node with notes, tags, and origin metadata', async () => {
        const classified = svc.classify({ url: 'https://upload.example.org/M1943_Field_Jacket.jpg', contentType: 'image/png', buffer: PNG });
        const { saved, duplicate } = await svc.saveFound({
            guildId: GUILD,
            userId: USER,
            buffer: PNG,
            ...classified,
            label: 'M1943 field jacket',
            notes: 'US Army WWII field jacket the user asked about.',
            tags: ['ww2', 'uniforms'],
            origin: {
                sourceUrl: 'https://upload.example.org/M1943_Field_Jacket.jpg',
                pageUrl: 'https://commons.example.org/wiki/File:M1943_Field_Jacket.jpg',
                title: 'M1943 Field Jacket',
                description: 'A photo of an M-1943 Field Jacket.',
                credit: 'Carl Wouters',
                license: 'CC BY-SA 3.0',
                provider: 'Wikimedia Commons'
            }
        });
        expect(duplicate).toBe(false);
        expect(saved.label).toBe('M1943 field jacket');
        expect(saved.displayKind).toBe('image');
        expect(saved.caption).toBe('M1943 Field Jacket — Carl Wouters, CC BY-SA 3.0 — via Wikimedia Commons');
        expect(saved.sourceUrl).toBe('https://commons.example.org/wiki/File:M1943_Field_Jacket.jpg');
        expect(fs.existsSync(saved.absolutePath)).toBe(true);

        const row = await kgArtifactService.getByLabel({ guildId: GUILD, scopeKey: scopeKey(), label: 'M1943 field jacket' });
        expect(row.node.type).toBe('artifact');
        expect(row.node.content).toContain('US Army WWII field jacket');
        expect(row.node.content).toContain('Credit: M1943 Field Jacket — Carl Wouters');
        expect(JSON.parse(row.artifact.metadataJson)).toMatchObject({
            provider: 'Wikimedia Commons', license: 'CC BY-SA 3.0', displayKind: 'image'
        });
        // The caption doubles as the searchable text of an image
        expect(row.artifact.extractedText).toContain('M-1943 Field Jacket');

        const tags = await db.all(
            `SELECT t.name FROM kg_tags t JOIN kg_node_tags nt ON nt.tagId = t.id WHERE nt.nodeId = @id`,
            { id: row.node.id }
        );
        expect(tags.map(t => t.name).sort()).toEqual(expect.arrayContaining(['found-on-web', 'image', 'uniforms', 'ww2']));
    });

    test('the same bytes saved again are recognized as a duplicate (shown, not re-saved)', async () => {
        const before = await kgArtifactService.countScope(GUILD, scopeKey());
        const classified = svc.classify({ url: 'https://elsewhere.example.org/same.png', contentType: 'image/png', buffer: PNG });
        const { saved, duplicate } = await svc.saveFound({
            guildId: GUILD, userId: USER, buffer: PNG, ...classified, label: 'jacket again', origin: {}
        });
        expect(duplicate).toBe(true);
        expect(saved.label).toBe('M1943 field jacket');
        expect(await kgArtifactService.countScope(GUILD, scopeKey())).toBe(before);
    });

    test('an existing concept node with the same label is not converted into the artifact', async () => {
        await knowledgeGraphService.upsertNode({
            guildId: GUILD, scopeKey: scopeKey(), subjectType: 'USER', subjectId: USER,
            type: 'concept', label: 'French cities', content: 'The user is planning a trip.', salience: 0.5, confidence: 0.8, source: 'tool'
        });
        const classified = svc.classify({ url: 'https://data.example.org/cities.csv', contentType: 'text/csv', buffer: Buffer.from(CSV) });
        const { saved } = await svc.saveFound({
            guildId: GUILD, userId: USER, buffer: Buffer.from(CSV), ...classified,
            label: 'French cities', notes: 'Population table.', origin: { sourceUrl: 'https://data.example.org/cities.csv', pageUrl: 'https://data.example.org/cities.csv', credit: 'data.example.org' }
        });
        expect(saved.label).toBe('French cities (file)');
        expect(saved.displayKind).toBe('csv');
        const concept = await knowledgeGraphService.getNode(GUILD, 'French cities', scopeKey());
        expect(concept.type).toBe('concept');
    });

    test('recall finds saved files by words, filters by kind, and skips files gone from disk', async () => {
        const byWord = await svc.recall({ guildId: GUILD, userId: USER, query: 'M1943 jacket photo', limit: 2 });
        expect(byWord.files.map(f => f.label)).toEqual(['M1943 field jacket']);
        expect(byWord.files[0].caption).toContain('Carl Wouters');
        expect(byWord.files[0].absolutePath).toMatch(/\.png$/);

        const csvOnly = await svc.recall({ guildId: GUILD, userId: USER, query: '', kind: 'csv', limit: 4 });
        expect(csvOnly.files.map(f => f.label)).toEqual(['French cities (file)']);

        const recent = await svc.recall({ guildId: GUILD, userId: USER, query: '', kind: 'any', limit: 4 });
        expect(recent.files.map(f => f.label)).toEqual(['French cities (file)', 'M1943 field jacket']);

        // Delete the CSV from disk: recall reports it as missing instead of returning a dead path
        fs.unlinkSync(csvOnly.files[0].absolutePath);
        const after = await svc.recall({ guildId: GUILD, userId: USER, query: 'cities population', kind: 'csv', limit: 2 });
        expect(after.files).toHaveLength(0);
        expect(after.missing).toBe(1);
    });

    test('preview describes CSV shape, text head, and image caption for the model', () => {
        const csv = svc.preview({ buffer: Buffer.from(CSV), displayKind: 'csv', fileName: 'cities.csv' });
        expect(csv).toContain('~3 data rows × 3 columns');
        expect(csv).toContain('Columns: city, population, note');
        expect(csv).toContain('Paris | 2102650 | capital, France');

        const text = svc.preview({ buffer: Buffer.from('# Title\n\nbody\n'), displayKind: 'markdown', fileName: 'README.md' });
        expect(text).toMatch(/^markdown README.md \(3 lines\):\n# Title/);

        const long = svc.preview({ buffer: Buffer.from('x'.repeat(config.PREVIEW_CHARS + 50)), displayKind: 'document', fileName: 'big.txt' });
        expect(long.endsWith('…')).toBe(true);

        expect(svc.preview({ displayKind: 'image', fileName: 'a.png', caption: 'Jacket — CC' })).toBe('Image (a.png): Jacket — CC');
        expect(svc.preview({ displayKind: 'pdf', fileName: 'spec.pdf', extractedText: 'Section 1' })).toContain('Section 1');
    });
});

describe('parseDelimited', () => {
    test('handles quoted commas, doubled quotes, CRLF, and the row cap', () => {
        const rows = parseDelimited('a,b\r\n"x, y","say ""hi"""\r\n1,2\n3,4\n', { maxRows: 2 });
        expect(rows[0]).toEqual(['a', 'b']);
        expect(rows[1]).toEqual(['x, y', 'say "hi"']);
        expect(rows.length).toBeLessThanOrEqual(3);
        expect(parseDelimited('a\tb\n1\t2\n', { delimiter: '\t' })[1]).toEqual(['1', '2']);
    });
});


describe('untrusted active filenames', () => {
    test.each(['html', 'htm', 'xhtml', 'xht', 'svg', 'svgz'])('normalizes a text/plain .%s fragment to .txt', (ext) => {
        const svc = new FileDiscoveryService();
        const result = svc.classify({
            url: `https://example.org/report.${ext}`, contentType: 'text/plain',
            buffer: Buffer.from('<script>window.marker = true;</script>')
        });
        expect(result).toMatchObject({ fileName: 'report.txt', mimeType: 'text/plain', artifactKind: 'document' });
    });
});
