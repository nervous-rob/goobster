/**
 * The operator runbooks (documentation/operator_runbooks.md) are part of what
 * Goobster knows about himself: the page must parse cleanly, be seeded into
 * the real corpus, be found by `consultDocs` for each procedure it covers,
 * and a feature-tagged doc must still be annotated (never hidden) when its
 * feature is off. Uses the repository's real documentation, a throwaway
 * database and no embedding backend, so it needs no keys or network.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TEST_DB = path.join(os.tmpdir(), `goobster-operator-runbooks-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;
process.env.GOOBSTER_SELF_DOCS_EMBEDDINGS = '0';
process.env.GOOBSTER_SELF_DOCS_SOURCES = 'README.md,documentation';
process.env.GOOBSTER_SELF_DOCS_OPERATOR_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-runbooks-operator-'));

const db = require('@goobster/core/db');
const { features } = require('@goobster/core/features/featureState');
const selfDocsService = require('@goobster/core/services/selfDocsService');
const toolsRegistry = require('@goobster/core/utils/toolsRegistry');

const REPO_ROOT = path.join(__dirname, '..');
const RUNBOOKS = 'documentation/operator_runbooks.md';
const EXPECTED_SECTIONS = [
    'Before you start',
    'Getting started',
    'Feature and configuration reference',
    'Service ownership',
    'Network access',
    'Backup and recovery',
    'Migration and rollback',
    'Upgrade',
    'Uninstall',
    'Owner decisions still open',
    'Known issues found by the walk-through',
    'How this was verified'
];

function sectionPaths(chunks) {
    return new Set(chunks.map(c => c.headingPath.split(' > ')[1]).filter(Boolean));
}

afterAll(async () => {
    features._resetForTests();
    await db.closeConnection();
    fs.rmSync(process.env.GOOBSTER_SELF_DOCS_OPERATOR_DIR, { recursive: true, force: true });
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(TEST_DB + suffix); } catch { /* already gone */ }
    }
});

describe('the operator runbooks page', () => {
    const text = fs.readFileSync(path.join(REPO_ROOT, RUNBOOKS), 'utf8');
    const doc = selfDocsService.parseDoc(text, { relPath: RUNBOOKS });

    test('parses with a title, a kind and no warnings', () => {
        expect(doc.title).toMatch(/^Operator runbooks/);
        expect(doc.kind).toBe('guide');
        expect(doc.warnings).toEqual([]);
        expect(doc.summary.length).toBeGreaterThan(40);
        expect(doc.useWhen).toBeTruthy();
    });

    test('has every procedure heading the operator guides promise', () => {
        const sections = sectionPaths(doc.chunks);
        for (const heading of EXPECTED_SECTIONS) expect(sections).toContain(heading);
    });

    test('is part of the repository corpus and the corpus validates', () => {
        const corpus = selfDocsService.validateCorpus({
            sources: ['README.md', 'documentation'],
            operatorDir: null,
            workspaceRoot: REPO_ROOT
        });
        expect(corpus.problems).toEqual([]);
        const files = selfDocsService.collectSources({
            sources: ['README.md', 'documentation'],
            operatorDir: null,
            workspaceRoot: REPO_ROOT
        });
        expect(files.map(f => f.relPath)).toContain(RUNBOOKS);
    });

    test('links only to documents that exist', () => {
        const links = [...text.matchAll(/\]\(([a-z0-9_./-]+\.md)(?:#[^)]*)?\)/gi)].map(m => m[1]);
        expect(links.length).toBeGreaterThan(5);
        for (const link of links) {
            expect(fs.existsSync(path.join(REPO_ROOT, 'documentation', link))).toBe(true);
        }
    });
});

describe('the runbooks in the seeded corpus', () => {
    beforeAll(async () => {
        features._resetForTests({ env: {} });
        selfDocsService.invalidateCache();
        selfDocsService._seededOnce = false;
        await db.run('DELETE FROM self_docs');
        const result = await selfDocsService.seed();
        expect(result.docs).toBeGreaterThan(50);
    });

    afterEach(() => features._resetForTests({ env: {} }));

    const TOPICS = [
        ['install on Linux headless with an answers file', 'Getting started'],
        ['turn a feature off with features.set and lifecycle.apply', 'Feature and configuration reference'],
        ['which ports are open and how to reach the manager over the network', 'Network access'],
        ['restore a backup then resume the paused instance', 'Backup and recovery'],
        ['roll back a Postgres migration', 'Migration and rollback'],
        ['uninstall and delete the data with the installation id', 'Uninstall']
    ];

    test.each(TOPICS)('search for "%s" returns the runbook section "%s"', async (query, section) => {
        const { results } = await selfDocsService.search({ query, limit: 8 });
        const hit = results.find(r => r.relPath === RUNBOOKS && r.headingPath.split(' > ')[1] === section);
        expect(hit).toBeTruthy();
    });

    test('the doc is listed and a section can be read by name', async () => {
        const listed = await selfDocsService.listDocs();
        expect(listed.map(d => d.relPath)).toContain(RUNBOOKS);
        const read = await selfDocsService.readDoc({ ref: 'operator_runbooks', section: 'Uninstall' });
        expect(read.sectionMatched).toBe(true);
        expect(read.window.content).toContain('--delete-data');
        expect(read.window.content).toContain('CONFIRMATION_REQUIRED');
    });

    test('consultDocs search through the tool surfaces the runbook', async () => {
        const out = await toolsRegistry.execute('consultDocs', { action: 'search', query: 'uninstall delete-data confirm' });
        expect(String(out)).toContain('slug="documentation/operator_runbooks"');
    });

    test('a feature-tagged doc is annotated, not hidden, when its feature is off', async () => {
        const active = await selfDocsService.readDoc({ ref: 'music_lab', limit: 3 });
        expect(active.doc.feature).toBe('music');
        expect(active.doc.unavailable).toBeNull();

        features._resetForTests({ env: { GOOBSTER_FEATURE_MUSIC: 'off' } });
        const off = await selfDocsService.readDoc({ ref: 'music_lab', limit: 3 });
        expect(off.doc.unavailable).toMatchObject({ feature: 'music', reason: 'turned off by a host environment setting' });
        const { results } = await selfDocsService.search({ query: 'music lab', limit: 3 });
        expect(results.some(r => r.relPath === 'documentation/music_lab.md' && r.unavailable)).toBe(true);
    });

    test('the runbooks carry no feature tag, so they are never annotated', async () => {
        features._resetForTests({ env: { GOOBSTER_FEATURE_MUSIC: 'off', GOOBSTER_FEATURE_KNOWLEDGE: 'off' } });
        const read = await selfDocsService.readDoc({ ref: 'operator_runbooks', limit: 3 });
        expect(read.doc.feature).toBeFalsy();
        expect(read.doc.unavailable).toBeNull();
    });
});
