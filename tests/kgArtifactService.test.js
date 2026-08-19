const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const tmpRoot = path.join(os.tmpdir(), `goobster-kg-artifact-${Date.now()}`);
process.env.GOOBSTER_DATA_DIR = tmpRoot;
process.env.GOOBSTER_DB_PATH = path.join(tmpRoot, 'test.sqlite');

const db = require('../packages/core/db');
const kgArtifactService = require('../packages/core/services/kgArtifactService');
const knowledgeGraphService = require('../packages/core/services/knowledgeGraphService');
const { retrieveNotes } = require('../packages/core/utils/chat/promptContext');
const artifactStorage = require('../packages/core/utils/kgArtifactStorage');

const GUILD = '900000000000000001';
const USER = '900000000000000002';

beforeAll(async () => {
    await db.run('DELETE FROM kg_provenance');
    await db.run('DELETE FROM kg_artifacts');
    await db.run('DELETE FROM kg_nodes');
});

afterAll(async () => {
    await db.closeConnection?.();
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* */ }
});

describe('kgArtifactService', () => {
    test('saveArtifact stores node, row, and file on disk', async () => {
        const code = 'export function greet() { return "hi"; }';
        const saved = await kgArtifactService.saveArtifact({
            guildId: GUILD,
            userId: USER,
            label: 'greet helper',
            summary: 'Small greeting helper from the user',
            attachment: { name: 'greet.js', content: code, mimeType: 'text/javascript' },
            tags: ['code'],
            confirm: true
        });

        expect(saved.label).toBe('greet helper');
        expect(saved.artifactKind).toBe('code');

        const row = await kgArtifactService.getByLabel({
            guildId: GUILD,
            scopeKey: knowledgeGraphService.resolveScopeKey({ subjectType: 'USER', subjectId: USER }),
            label: 'greet helper'
        });
        expect(row.node.type).toBe('artifact');
        expect(row.artifact.originalName).toBe('greet.js');
        expect(fs.existsSync(artifactStorage.resolveRelativePath(row.artifact.relativePath))).toBe(true);

        const body = await kgArtifactService.readArtifactContent({
            guildId: GUILD,
            scopeKey: knowledgeGraphService.resolveScopeKey({ subjectType: 'USER', subjectId: USER }),
            label: 'greet helper'
        });
        expect(body).toContain('export function greet');
    });

    test('requires confirm before saving', async () => {
        await expect(kgArtifactService.saveArtifact({
            guildId: GUILD,
            userId: USER,
            label: 'secret',
            attachment: { name: 'x.txt', content: 'nope' },
            confirm: false
        })).rejects.toMatchObject({ code: 'CONFIRM_REQUIRED' });
    });

    test('search and lookup recall artifact content', async () => {
        const hits = await kgArtifactService.searchArtifacts({
            guildId: GUILD,
            scopeKey: knowledgeGraphService.resolveScopeKey({ subjectType: 'USER', subjectId: USER }),
            query: 'greet helper',
            limit: 5
        });
        expect(hits.length).toBeGreaterThan(0);

        const notes = await retrieveNotes({
            guildId: GUILD,
            userId: USER,
            query: 'greet',
            depth: 'rich',
            about: 'me'
        });
        expect(notes.graph).toMatch(/greet helper|greet\.js/i);
    });
});
