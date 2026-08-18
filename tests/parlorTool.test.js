/**
 * The manageParlor chat tool (utils/toolsRegistry.js): Goobster operating
 * a user's Parlor on their behalf - personas, workspace notes, discussions,
 * and the one-prompt quickstart. Everything must act on the REQUESTING
 * user's parlor only, surface ParlorError as friendly text (never throw),
 * and expose no delete actions.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-parlor-tool-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

// These wrapped commands boot heavy voice/music services at load time; the
// parlor tool only needs the registry itself (toolsRegistryEconomy pattern).

const mockEmbedding = {
    embed: jest.fn(async () => ({ vector: Float32Array.from([1, 1, 1]), model: 'test/embed' })),
    embedBatch: jest.fn(async (texts) =>
        texts.map(() => ({ vector: Float32Array.from([1, 1, 1]), model: 'test/embed' }))),
    cosineSimilarity: () => 1
};
jest.mock('@goobster/core/services/embeddingService', () => mockEmbedding);

const mockAi = { chat: jest.fn(), generateText: jest.fn() };
jest.mock('@goobster/core/services/aiService', () => mockAi);

const db = require('@goobster/core/db');
const toolsRegistry = require('@goobster/core/utils/toolsRegistry');
const parlorService = require('@goobster/core/services/parlorService');

const USER = '700000000000000001';
const OTHER = '700000000000000002';

const context = (userId = USER) => ({
    interactionContext: {
        guildId: null,
        user: { id: userId, username: 'rob', bot: false },
        client: { user: { id: '700000000000000099', username: 'Goobster', bot: true } }
    }
});

const run = (args, userId = USER) =>
    toolsRegistry.execute('manageParlor', { ...args, ...context(userId) });

beforeEach(() => {
    for (const table of ['parlor_messages', 'parlor_participants', 'parlor_conversations',
        'parlor_note_tags', 'parlor_tags', 'parlor_notes', 'parlor_personas']) {
        db.run(`DELETE FROM ${table}`);
    }
    mockAi.generateText.mockReset();
    mockAi.generateText.mockResolvedValue('{"notes": []}');
});

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(TEST_DB + suffix); } catch { /* already gone */ }
    }
});

test('manageParlor is offered to the model (and has no delete actions)', () => {
    const definition = toolsRegistry.getDefinitions().find(d => d.name === 'manageParlor');
    expect(definition).toBeDefined();
    const actions = definition.parameters.properties.action.enum;
    expect(actions).toContain('quickstart');
    expect(actions.some(a => a.includes('delete'))).toBe(false);
});

test('overview of an empty parlor points at quickstart', async () => {
    const result = await run({ action: 'overview' });
    expect(result).toContain('empty');
    expect(result).toContain('quickstart');
});

test('create-persona / update-persona / create-note / list-notes round trip', async () => {
    const created = await run({
        action: 'create-persona', name: 'The Archivist', emoji: '📚',
        charter: 'You keep meticulous records and cite them.'
    });
    expect(created).toContain('The Archivist');
    const persona = parlorService.listPersonas(USER)[0];

    const updated = await run({ action: 'update-persona', personaId: persona.id, name: 'The Librarian' });
    expect(updated).toContain('The Librarian');

    const filed = await run({
        action: 'create-note', personaId: persona.id,
        title: 'Filing system', content: 'Everything gets a tag.', tags: ['Organization']
    });
    expect(filed).toContain('Filing system');
    expect(filed).toContain('organization'); // normalized tag echoed back

    const browsed = await run({ action: 'list-notes', personaId: persona.id });
    expect(browsed).toContain('Filing system');

    const note = parlorService.listNotes({ ownerId: USER, personaId: persona.id })[0];
    const edited = await run({ action: 'update-note', noteId: note.id, content: 'Tags connect notes.' });
    expect(edited).toContain('Tags connect notes.');
});

test('semantic list-notes uses the search path', async () => {
    const persona = parlorService.createPersona({
        ownerId: USER, name: 'Scout', charter: 'You look things up.'
    });
    parlorService.createNote({
        ownerId: USER, personaId: persona.id, title: 'Only note', content: 'Something searchable.'
    });
    await new Promise(resolve => setTimeout(resolve, 25)); // embeddings land
    const result = await run({ action: 'list-notes', personaId: persona.id, query: 'searchable' });
    expect(result).toContain('Only note');
});

test('conversation management: create, rename, seats', async () => {
    const a = parlorService.createPersona({ ownerId: USER, name: 'A', charter: 'x' });
    const b = parlorService.createPersona({ ownerId: USER, name: 'B', charter: 'x' });

    const created = await run({ action: 'create-conversation', personaIds: [a.id] });
    expect(created).toContain('Discussion #');
    const conversation = parlorService.listConversations(USER)[0];

    const renamed = await run({
        action: 'rename-conversation', conversationId: conversation.id, title: 'Big plans'
    });
    expect(renamed).toContain('Big plans');

    const added = await run({
        action: 'add-participant', conversationId: conversation.id, personaId: b.id
    });
    expect(added).toContain('A + B');
    const removed = await run({
        action: 'remove-participant', conversationId: conversation.id, personaId: a.id
    });
    expect(removed).toContain('B');
    expect(removed).not.toContain('A +');
});

test('quickstart assembles a salon from one brief', async () => {
    mockAi.generateText.mockResolvedValueOnce(JSON.stringify({
        title: 'Garden Salon',
        opening: 'What grows here?',
        personas: [
            { name: 'The Botanist', emoji: '🌿', charter: 'You know plants.', notes: [{ title: 'Soil', content: 'Loam wins.', tags: ['garden'] }] },
            { name: 'The Planner', emoji: '🗓️', charter: 'You schedule.', notes: [] }
        ]
    }));
    const result = await run({ action: 'quickstart', prompt: 'planning a vegetable garden' });
    expect(result).toContain('Garden Salon');
    expect(result).toContain('The Botanist');
    expect(result).toContain('What grows here?');
    expect(parlorService.listPersonas(USER)).toHaveLength(2);
    expect(parlorService.listConversations(USER)).toHaveLength(1);
});

test('errors surface as friendly text, never throws', async () => {
    const missing = await run({ action: 'update-persona', personaId: 9999, name: 'Ghost' });
    expect(missing).toContain('🛋️');
    expect(missing).toContain('No such persona');

    const noPrompt = await run({ action: 'quickstart' });
    expect(noPrompt).toContain('❌');

    const unknown = await run({ action: 'overview' }, undefined);
    // no user id at all
    const noUser = await toolsRegistry.execute('manageParlor', {
        action: 'overview', interactionContext: {}
    });
    expect(noUser).toContain('❌');
    expect(unknown).toBeDefined();
});

test('the tool only ever touches the requesting user\'s parlor', async () => {
    const persona = parlorService.createPersona({
        ownerId: OTHER, name: 'Private', charter: 'Not yours.'
    });
    const result = await run({ action: 'update-persona', personaId: persona.id, name: 'Hijack' });
    expect(result).toContain('No such persona');
    expect(parlorService.listPersonas(OTHER)[0].name).toBe('Private');

    const overview = await run({ action: 'overview' });
    expect(overview).not.toContain('Private');
});
