/**
 * Self-knowledge (services/selfDocsService.js + the consultDocs tool):
 * front-matter parsing, heading-aware chunking, idempotent hash-compared
 * seeding, keyword and hybrid retrieval with an injected embedder, reading
 * and listing, the tool's formatting, and validation of the real corpus.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-selfdocs-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

// The corpus under test is a fixture tree, not the repository docs. The
// config module reads these at load time, so they must be set before the
// service (or the registry) is required.
const FIXTURE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-selfdocs-'));
const DOCS_DIR = path.join(FIXTURE_ROOT, 'docs');
const OPERATOR_DIR = path.join(FIXTURE_ROOT, 'operator-notes');
fs.mkdirSync(path.join(DOCS_DIR, 'skills'), { recursive: true });
fs.mkdirSync(OPERATOR_DIR, { recursive: true });
process.env.GOOBSTER_SELF_DOCS_SOURCES = DOCS_DIR;
process.env.GOOBSTER_SELF_DOCS_OPERATOR_DIR = OPERATOR_DIR;
process.env.GOOBSTER_SELF_DOCS_EMBEDDINGS = '1';

// Deterministic 4-dim embeddings keyed by topic words. "cooking" and
// "kitchen" share a dimension so a query with no lexical overlap can still
// find its document semantically.
function fakeVector(text) {
    const t = String(text).toLowerCase();
    return Float32Array.from([
        /kitchen|cooking/.test(t) ? 1 : 0,
        /telescope/.test(t) ? 1 : 0,
        /sandbox/.test(t) ? 1 : 0,
        0.05
    ]);
}
const embedState = { fail: false, model: 'test/mock' };
jest.mock('@goobster/core/services/embeddingService', () => {
    const actual = jest.requireActual('@goobster/core/services/embeddingService');
    return {
        embed: jest.fn(async (text) => {
            if (embedState.fail) throw new Error('no embedding backend');
            return { vector: fakeVector(text), model: embedState.model };
        }),
        embedBatch: jest.fn(async (texts) => {
            if (embedState.fail) throw new Error('no embedding backend');
            return texts.map(text => ({ vector: fakeVector(text), model: embedState.model }));
        }),
        getBackend: () => 'mock',
        getModelId: () => embedState.model,
        cosineSimilarity: actual.cosineSimilarity
    };
});

const db = require('@goobster/core/db');
const selfDocsService = require('@goobster/core/services/selfDocsService');
const { parseDoc, chunkMarkdown, tokenize } = selfDocsService;
const toolsRegistry = require('@goobster/core/utils/toolsRegistry');

const REPO_ROOT = path.join(__dirname, '..');

function writeDoc(relPath, text) {
    const abs = path.join(DOCS_DIR, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
}

// Sections are padded past the merge threshold so each one stays its own
// chunk, the way real feature docs do.
const FILLER = 'Further detail follows in this section for completeness. '.repeat(20);

const SANDBOX_DOC = `# Code Sandbox

The sandbox runs short snippets in isolation.

${FILLER}

## Enabling it

Set \`sandbox.enabled\` to true in config.json. The sandbox is disabled until you turn it on.

${FILLER}

## Limits

Runs are resource-limited: CPU seconds, memory, and wall time.

${FILLER}
`;

const TELESCOPE_DOC = `---
title: Telescope Guide
kind: guide
summary: How to point the telescope.
tags: [Telescope, optics]
---

# Telescope

Point the telescope at the sky and focus.

${FILLER}

## Cleaning

Use a soft cloth. Never touch the mirror.

${FILLER}
`;

const KITCHEN_SKILL = `---
title: Kitchen safety
kind: skill
summary: Keep the kitchen safe while cooking.
when: Somebody is about to cook.
---

# Kitchen safety

Turn the stove off when you leave the kitchen.
`;

async function resetCorpus() {
    fs.rmSync(DOCS_DIR, { recursive: true, force: true });
    fs.mkdirSync(path.join(DOCS_DIR, 'skills'), { recursive: true });
    fs.rmSync(OPERATOR_DIR, { recursive: true, force: true });
    fs.mkdirSync(OPERATOR_DIR, { recursive: true });
    writeDoc('code_sandbox.md', SANDBOX_DOC);
    writeDoc('telescope_guide.md', TELESCOPE_DOC);
    writeDoc('skills/kitchen.md', KITCHEN_SKILL);
    await db.run('DELETE FROM self_docs');
    selfDocsService.invalidateCache();
    selfDocsService._seededOnce = false;
}

afterAll(async () => {
    await db.closeConnection();
    fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true });
    for (const suffix of ['', '-wal', '-shm']) {
        fs.rmSync(TEST_DB + suffix, { force: true });
    }
});

beforeEach(async () => {
    embedState.fail = false;
    embedState.model = 'test/mock';
    await resetCorpus();
});

describe('parseDoc', () => {
    test('reads front matter and falls back to the first heading', () => {
        const doc = parseDoc(TELESCOPE_DOC, { relPath: 'docs/telescope_guide.md' });
        expect(doc.slug).toBe('docs/telescope_guide');
        expect(doc.title).toBe('Telescope Guide');
        expect(doc.kind).toBe('guide');
        expect(doc.summary).toBe('How to point the telescope.');
        expect(doc.tags).toEqual(['telescope', 'optics']);
        expect(doc.warnings).toEqual([]);

        const plain = parseDoc(SANDBOX_DOC, { relPath: 'documentation/code_sandbox.md' });
        expect(plain.title).toBe('Code Sandbox');
        expect(plain.kind).toBe('reference');
        expect(plain.summary).toBe('The sandbox runs short snippets in isolation.');
    });

    test('infers kind from the path and warns on unknown kinds and summary-less skills', () => {
        expect(parseDoc('# x\nbody', { relPath: 'documentation/skills/x.md' }).kind).toBe('skill');
        expect(parseDoc('# x\nbody', { relPath: 'documentation/adr/0001.md' }).kind).toBe('decision');
        expect(parseDoc('# x\nbody', { relPath: 'documentation/projects_redesign_plan.md' }).kind).toBe('decision');
        expect(parseDoc('# x\nbody', { relPath: 'documentation/development_standards.md' }).kind).toBe('standards');
        expect(parseDoc('# x\nbody', { relPath: 'documentation/raspberry_pi_guide.md' }).kind).toBe('guide');

        const odd = parseDoc('---\nkind: poem\n---\n# T\nbody', { relPath: 'documentation/t.md' });
        expect(odd.kind).toBe('reference');
        expect(odd.warnings[0]).toMatch(/unknown kind "poem"/);

        const skill = parseDoc('# S\nbody', { relPath: 'documentation/skills/s.md' });
        expect(skill.warnings).toContain('skill docs need a front-matter summary');
    });

    test('survives malformed front matter', () => {
        const doc = parseDoc('---\ntitle: [unclosed\n---\n# Real title\nbody', { relPath: 'a.md' });
        expect(doc.title).toBe('Real title');
        expect(doc.warnings[0]).toMatch(/^front matter:/);
    });
});

describe('chunkMarkdown', () => {
    test('splits at headings with a breadcrumb and never inside fenced code', () => {
        const body = [
            '# Guide', 'intro paragraph that is long enough to stand on its own '.repeat(20),
            '## Setup', 'setup text '.repeat(150),
            '```bash', '# not a heading', 'echo hi', '```',
            '### Detail', 'detail text '.repeat(150),
            '## Usage', 'usage text '.repeat(150)
        ].join('\n');
        const chunks = chunkMarkdown(body, { title: 'Guide', chunkChars: 1800 });
        const paths = chunks.map(c => c.headingPath);
        expect(paths).toContain('Guide');
        expect(paths).toContain('Guide > Setup');
        expect(paths).toContain('Guide > Setup > Detail');
        expect(paths).toContain('Guide > Usage');
        const setup = chunks.find(c => c.headingPath === 'Guide > Setup');
        expect(setup.content).toContain('# not a heading');
        expect(paths).not.toContain('Guide > Setup > not a heading');
    });

    test('merges small sections and splits oversized ones on paragraphs', () => {
        const tiny = ['# T', '## A', 'one', '## B', 'two', '## C', 'three'].join('\n');
        expect(chunkMarkdown(tiny, { title: 'T', chunkChars: 1800 })).toHaveLength(1);

        const paragraphs = Array.from({ length: 12 }, (_, i) => `paragraph ${i} ${'word '.repeat(80)}`);
        const huge = ['# T', '## Big', ...paragraphs.flatMap(p => [p, ''])].join('\n');
        const chunks = chunkMarkdown(huge, { title: 'T', chunkChars: 1000 });
        expect(chunks.length).toBeGreaterThan(3);
        // The bare "# T" line merges into the first piece and keeps the shared prefix.
        expect(chunks[0].headingPath).toBe('T');
        for (const chunk of chunks.slice(1)) {
            expect(chunk.headingPath).toBe('T > Big');
        }
        for (const chunk of chunks) {
            expect(chunk.content.length).toBeLessThanOrEqual(1600);
        }
        expect(chunks.map(c => c.content).join('\n\n')).toContain('paragraph 11');
    });

    test('tokenize stems and splits identifiers', () => {
        expect(tokenize('enabling enabled enable')).toEqual(['enabl', 'enabl', 'enabl']);
        expect(tokenize('runCode')).toEqual(['runcod', 'run', 'code']);
        expect(tokenize('memory_embeddings')).toEqual(['memory_embedding', 'memory', 'embedding']);
        expect(tokenize('the automations')).toEqual(['automation']);
    });
});

describe('seeding', () => {
    test('seeds every doc, is idempotent, and tracks edits and removals', async () => {
        const first = await selfDocsService.seed();
        expect(first.acquired).toBe(true);
        expect(first.docs).toBe(3);
        expect(first.inserted).toBe(first.chunks);
        expect(first.updated).toBe(0);

        const again = await selfDocsService.seed();
        expect(again.inserted).toBe(0);
        expect(again.updated).toBe(0);
        expect(again.deleted).toBe(0);
        expect(again.unchanged).toBe(first.chunks);

        // Embed, then edit one section: only that chunk loses its vector.
        await selfDocsService.backfillEmbeddings();
        const before = await db.all('SELECT slug, chunkIndex, model FROM self_docs ORDER BY slug, chunkIndex');
        expect(before.every(r => r.model === 'test/mock')).toBe(true);

        writeDoc('code_sandbox.md', SANDBOX_DOC.replace('Runs are resource-limited', 'Runs are strictly resource-limited'));
        const edited = await selfDocsService.seed();
        expect(edited.updated).toBeGreaterThanOrEqual(1);
        const after = await db.all('SELECT slug, chunkIndex, model, content FROM self_docs WHERE slug = @slug ORDER BY chunkIndex', { slug: 'docs/code_sandbox' });
        const changed = after.filter(r => r.content.includes('strictly'));
        expect(changed).toHaveLength(1);
        expect(changed[0].model).toBeNull();
        expect(after.filter(r => r.model === 'test/mock').length + changed.length).toBe(after.length);

        fs.rmSync(path.join(DOCS_DIR, 'telescope_guide.md'));
        const removed = await selfDocsService.seed();
        expect(removed.docs).toBe(2);
        expect(removed.deleted).toBeGreaterThanOrEqual(1);
        const slugs = (await db.all('SELECT DISTINCT slug FROM self_docs')).map(r => r.slug).sort();
        expect(slugs).toEqual(['docs/code_sandbox', 'docs/skills/kitchen']);
    });

    test('a shrinking document drops its trailing chunks', async () => {
        await selfDocsService.seed();
        const count = (await db.get('SELECT COUNT(*) AS n FROM self_docs WHERE slug = @slug', { slug: 'docs/code_sandbox' })).n;
        writeDoc('code_sandbox.md', '# Code Sandbox\n\nOne line now.\n');
        await selfDocsService.seed();
        const rows = await db.all('SELECT chunkIndex, content FROM self_docs WHERE slug = @slug', { slug: 'docs/code_sandbox' });
        expect(rows).toHaveLength(1);
        expect(Number(count)).toBeGreaterThanOrEqual(1);
        expect(rows[0].content).toContain('One line now');
    });

    test('operator notes are seeded under the operator prefix and metadata refreshes', async () => {
        fs.writeFileSync(path.join(OPERATOR_DIR, 'prod-box.md'), '# Production box\n\nThe Pi lives in the closet.\n');
        await selfDocsService.seed();
        const row = await db.get('SELECT slug, kind, title FROM self_docs WHERE slug = @slug', { slug: 'operator/prod-box' });
        expect(row.title).toBe('Production box');
        expect(row.kind).toBe('reference');

        fs.writeFileSync(path.join(OPERATOR_DIR, 'prod-box.md'), '---\ntitle: Production box\nkind: guide\n---\n# Production box\n\nThe Pi lives in the closet.\n');
        const result = await selfDocsService.seed();
        // Content (and hash) unchanged -> no chunk rewrite, but kind refreshed.
        expect(result.updated).toBe(0);
        const refreshed = await db.get('SELECT kind FROM self_docs WHERE slug = @slug', { slug: 'operator/prod-box' });
        expect(refreshed.kind).toBe('guide');
    });

    test('ensureSeeded fills an empty table once and stays cheap afterwards', async () => {
        expect(Number((await db.get('SELECT COUNT(*) AS n FROM self_docs')).n)).toBe(0);
        await selfDocsService.ensureSeeded();
        expect(Number((await db.get('SELECT COUNT(*) AS n FROM self_docs')).n)).toBeGreaterThan(0);
        await db.run('DELETE FROM self_docs');
        await selfDocsService.ensureSeeded();
        expect(Number((await db.get('SELECT COUNT(*) AS n FROM self_docs')).n)).toBe(0);
    });

    test('validateCorpus reports problems without touching the database', () => {
        writeDoc('skills/bad.md', '# No summary\nbody');
        const report = selfDocsService.validateCorpus();
        expect(report.ok).toBe(false);
        expect(report.problems).toEqual(expect.arrayContaining([expect.stringMatching(/skills\/bad\.md: skill docs need a front-matter summary/)]));
    });
});

describe('embeddings', () => {
    test('backfill embeds only rows missing a vector for the current model and reports backend failures', async () => {
        await selfDocsService.seed();
        const done = await selfDocsService.backfillEmbeddings({ batchSize: 2 });
        expect(done.error).toBeNull();
        expect(done.remaining).toBe(0);
        expect(done.embedded).toBeGreaterThan(0);

        const noop = await selfDocsService.backfillEmbeddings();
        expect(noop.embedded).toBe(0);

        embedState.model = 'test/other';
        embedState.fail = true;
        const failed = await selfDocsService.backfillEmbeddings();
        expect(failed.embedded).toBe(0);
        expect(failed.error).toBe('no embedding backend');
        expect(failed.remaining).toBeGreaterThan(0);
    });

    test('search stays on keyword ranking when no vectors match the query model', async () => {
        await selfDocsService.seed();
        const result = await selfDocsService.search({ query: 'telescope' });
        expect(result.mode).toBe('keyword');
        expect(result.results[0].slug).toBe('docs/telescope_guide');
    });
});

describe('search', () => {
    test('ranks the matching section first and respects kind filters', async () => {
        await selfDocsService.seed();
        const result = await selfDocsService.search({ query: 'how do I enable the sandbox' });
        expect(result.results[0].slug).toBe('docs/code_sandbox');
        expect(result.results[0].content).toContain('sandbox.enabled');

        const skills = await selfDocsService.search({ query: 'sandbox', kind: 'skill' });
        expect(skills.results).toEqual([]);
        const guides = await selfDocsService.search({ query: 'telescope cleaning', kind: 'guide' });
        expect([...new Set(guides.results.map(r => r.slug))]).toEqual(['docs/telescope_guide']);
        expect(guides.results[0].headingPath).toBe('Telescope Guide > Cleaning');

        expect((await selfDocsService.search({ query: '   ' })).mode).toBe('none');
    });

    test('fuses semantic hits so a query with no shared words still finds its doc', async () => {
        await selfDocsService.seed();
        await selfDocsService.backfillEmbeddings();
        const result = await selfDocsService.search({ query: 'cooking' });
        expect(result.mode).toBe('hybrid');
        expect(result.results.map(r => r.slug)).toContain('docs/skills/kitchen');
        const kitchen = result.results.find(r => r.slug === 'docs/skills/kitchen');
        expect(kitchen.lexical).toBe(0);
        expect(kitchen.cosine).toBeGreaterThan(0.9);
    });

    test('a failing embedder degrades to keyword ranking instead of throwing', async () => {
        await selfDocsService.seed();
        await selfDocsService.backfillEmbeddings();
        embedState.fail = true;
        const result = await selfDocsService.search({ query: 'telescope' });
        expect(result.mode).toBe('keyword');
        expect(result.results[0].slug).toBe('docs/telescope_guide');
    });
});

describe('read and list', () => {
    test('listDocs orders by kind and exposes skill metadata', async () => {
        await selfDocsService.seed();
        const all = await selfDocsService.listDocs();
        expect(all.map(d => d.kind)).toEqual(['guide', 'reference', 'skill']);
        const skills = await selfDocsService.listDocs({ kind: 'skill' });
        expect(skills).toHaveLength(1);
        expect(skills[0]).toMatchObject({ title: 'Kitchen safety', useWhen: 'Somebody is about to cook.', summary: 'Keep the kitchen safe while cooking.' });
    });

    test('readDoc resolves slug, path, or title and narrows to a section', async () => {
        await selfDocsService.seed();
        const bySlug = await selfDocsService.readDoc({ ref: 'docs/code_sandbox' });
        expect(bySlug.doc.title).toBe('Code Sandbox');
        expect(bySlug.window.content).toContain('## Limits');

        const byTitle = await selfDocsService.readDoc({ ref: 'code sandbox', section: 'limits' });
        expect(byTitle.sectionMatched).toBe(true);
        expect(byTitle.window.content).toContain('resource-limited');
        expect(byTitle.window.content).not.toContain('## Enabling it');

        const byFile = await selfDocsService.readDoc({ ref: 'telescope_guide.md', section: 'nope' });
        expect(byFile.doc.slug).toBe('docs/telescope_guide');
        expect(byFile.sectionMatched).toBe(false);
        expect(byFile.sections).toContain('Telescope Guide > Cleaning');

        expect(await selfDocsService.readDoc({ ref: 'unrelated nonsense' })).toBeNull();

        const paged = await selfDocsService.readDoc({ ref: 'docs/code_sandbox', limit: 2 });
        expect(paged.window.truncated).toBe(true);
        expect(paged.window.nextOffset).toBe(3);
    });
});

describe('consultDocs tool', () => {
    test('is registered after lookupNotes and offered on every surface', async () => {
        expect(toolsRegistry.TOOL_ORDER.indexOf('consultDocs')).toBe(toolsRegistry.TOOL_ORDER.indexOf('lookupNotes') + 1);
        for (const context of [{}, { isWeb: true }, { isAutomation: true }]) {
            const names = (await toolsRegistry.getDefinitions(undefined, context)).map(def => def.name);
            expect(names).toContain('consultDocs');
        }
        const [definition] = await toolsRegistry.getDefinitions(['consultDocs']);
        expect(definition.parameters.properties.action.enum).toEqual(['search', 'read', 'list']);
        expect(definition.parameters.properties.kind.enum).toContain('skill');
    });

    test('search results cite the doc, breadcrumb, and slug; empty results warn against inventing', async () => {
        await selfDocsService.seed();
        const hit = await toolsRegistry.execute('consultDocs', { query: 'enable the sandbox' });
        expect(hit).toContain('Code Sandbox > Enabling it');
        expect(hit).toContain('slug="docs/code_sandbox"');
        expect(hit).toContain('sandbox.enabled');

        const miss = await toolsRegistry.execute('consultDocs', { action: 'search', query: 'zebra quantum accordion' });
        expect(miss).toMatch(/nothing in your documentation matches/);
        expect(miss).toMatch(/Do not invent/);
    });

    test('list groups by kind and shows when a skill applies', async () => {
        await selfDocsService.seed();
        const listing = await toolsRegistry.execute('consultDocs', { action: 'list', kind: 'skill' });
        expect(listing).toContain('## skill guide');
        expect(listing).toContain('Kitchen safety (slug: docs/skills/kitchen)');
        expect(listing).toContain('Use when: Somebody is about to cook.');
        expect(listing).not.toContain('Telescope Guide');
    });

    test('read returns a window and explains a missing section or document', async () => {
        await selfDocsService.seed();
        const read = await toolsRegistry.execute('consultDocs', { action: 'read', slug: 'Telescope Guide', section: 'Cleaning' });
        expect(read).toContain('DOCS — Telescope Guide (guide, docs/telescope_guide.md)');
        expect(read).toContain('Section filter: "Cleaning"');
        expect(read).toContain('Never touch the mirror');

        const wholeDoc = await toolsRegistry.execute('consultDocs', { action: 'read', slug: 'telescope', section: 'Nonexistent' });
        expect(wholeDoc).toMatch(/No section matches "Nonexistent"; showing the whole document/);

        const missing = await toolsRegistry.execute('consultDocs', { action: 'read', slug: 'does-not-exist' });
        expect(missing).toMatch(/no document matches/);
    });

    test('seeds lazily when the table is empty', async () => {
        expect(Number((await db.get('SELECT COUNT(*) AS n FROM self_docs')).n)).toBe(0);
        const listing = await toolsRegistry.execute('consultDocs', { action: 'list' });
        expect(listing).toContain('Code Sandbox');
    });
});

describe('the shipped corpus', () => {
    test('parses cleanly and ships the three skill guides', () => {
        const report = selfDocsService.validateCorpus({
            sources: ['README.md', 'documentation'],
            operatorDir: null,
            workspaceRoot: REPO_ROOT
        });
        expect(report.problems).toEqual([]);
        expect(report.ok).toBe(true);
        expect(report.docs).toBeGreaterThanOrEqual(40);

        const docs = selfDocsService.loadCorpus({ sources: ['documentation/skills'], operatorDir: null, workspaceRoot: REPO_ROOT });
        const skills = docs.filter(d => d.kind === 'skill');
        expect(skills.map(d => d.title).sort()).toEqual(['Project examples', 'Troubleshooting tactics', 'Working guidelines']);
        for (const skill of skills) {
            expect(skill.summary).toBeTruthy();
            expect(skill.useWhen).toBeTruthy();
        }
        // The self-knowledge spec and the standards doc describe this feature.
        const all = selfDocsService.loadCorpus({ sources: ['documentation'], operatorDir: null, workspaceRoot: REPO_ROOT });
        expect(all.some(d => d.slug === 'documentation/self_knowledge' && d.kind === 'guide')).toBe(true);
    });
});
