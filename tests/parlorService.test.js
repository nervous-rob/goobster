/**
 * Unit tests for the Parlor (services/parlorService.js): persona/note/tag
 * CRUD with ownership checks and caps, the shared kg workspace graph,
 * semantic + keyword retrieval, the multi-persona turn workflow (retrieve ->
 * generate -> write back with legalization), and /forget-me coverage.
 * Runs against a throwaway SQLite database with the AI and embedding
 * backends mocked (no network).
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TEST_DB = path.join(os.tmpdir(), `goobster-parlor-test-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

// Deterministic embeddings: a 3-dim vector counting topic keywords, so
// cosine similarity behaves predictably without a real backend.
function fakeVector(text) {
    const lower = String(text).toLowerCase();
    const count = (word) => (lower.match(new RegExp(word, 'g')) || []).length;
    return Float32Array.from([1 + count('rust'), 1 + count('cook'), 1]);
}

const mockEmbedding = {
    embed: jest.fn(async (text) => ({ vector: fakeVector(text), model: 'test/embed' })),
    embedBatch: jest.fn(async (texts) =>
        texts.map(text => ({ vector: fakeVector(text), model: 'test/embed' }))),
    cosineSimilarity: (a, b) => {
        let dot = 0, na = 0, nb = 0;
        for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
        const d = Math.sqrt(na) * Math.sqrt(nb);
        return d === 0 ? 0 : dot / d;
    }
};
jest.mock('@goobster/core/services/embeddingService', () => mockEmbedding);

const mockAi = {
    chat: jest.fn(),
    generateText: jest.fn(),
    supportsNativeWebSearch: () => false
};
jest.mock('@goobster/core/services/aiService', () => mockAi);

// Persona turns offer tools from the real registry; these wrapped commands
// boot heavy voice/music services at load time (toolsRegistryEconomy pattern).

// The generateImage tool's backend - returns a real temp file so the
// attachment pipeline (capture -> store -> re-serve) can be exercised.
const mockImages = { generateImage: jest.fn() };
jest.mock('@goobster/core/utils/imageDetectionHandler', () => mockImages);

const db = require('@goobster/core/db');
const parlorService = require('@goobster/core/services/parlorService');
const { ParlorError } = require('@goobster/core/services/parlorService');
const privacyService = require('@goobster/core/services/privacyService');

const OWNER = '300000000000000001';
const OTHER = '300000000000000002';

/** Let fire-and-forget async work (embeddings, titles) settle. */
const settle = () => new Promise(resolve => setTimeout(resolve, 25));

/** Assert a ParlorError with the expected code (and optionally status). */
async function expectParlorError(fn, code, status = null) {
    let caught = null;
    try { await fn(); } catch (error) { caught = error; }
    expect(caught).not.toBeNull();
    expect(caught.code).toBe(code);
    if (status !== null) expect(caught.status).toBe(status);
}

beforeEach(async () => {
    for (const table of ['parlor_messages', 'parlor_participants', 'parlor_members',
        'parlor_invites', 'parlor_conversations',
        'parlor_note_tags', 'parlor_tags', 'parlor_notes', 'parlor_personas']) {
        await db.run(`DELETE FROM ${table}`);
    }
    await db.run(`DELETE FROM kg_nodes WHERE scopeKey LIKE 'PARLOR:%'`);
    await db.run(`DELETE FROM kg_tags WHERE scopeKey LIKE 'PARLOR:%'`);
    // Transient in-memory guardrail state must not leak between tests
    parlorService._activeTurns.clear();
    await db.run('DELETE FROM web_rate_events');
    mockAi.chat.mockReset();
    mockAi.generateText.mockReset();
    mockAi.generateText.mockResolvedValue('{"notes": []}');
    mockAi.chat.mockResolvedValue({ content: 'A considered reply.', toolCalls: [] });
});

afterAll(async () => {
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(TEST_DB + suffix); } catch { /* already gone */ }
    }
});

async function makePersona(overrides = {}) {
    return await parlorService.createPersona({
        ownerId: OWNER,
        name: 'The Researcher',
        emoji: '🔬',
        color: '#7c8cff',
        charter: 'You are a careful researcher.',
        ...overrides
    });
}

describe('personas', () => {
    test('create, list, update, delete', async () => {
        const persona = await makePersona();
        expect(persona.id).toBeGreaterThan(0);
        expect(persona.noteCount).toBe(0);

        const listed = await parlorService.listPersonas(OWNER);
        expect(listed).toHaveLength(1);
        expect(listed[0].name).toBe('The Researcher');

        const updated = await parlorService.updatePersona({
            ownerId: OWNER, personaId: persona.id, name: 'The Scientist'
        });
        expect(updated.name).toBe('The Scientist');

        await parlorService.deletePersona({ ownerId: OWNER, personaId: persona.id });
        expect(await parlorService.listPersonas(OWNER)).toHaveLength(0);
    });

    test('names are unique per owner (case-insensitive)', async () => {
        await makePersona();
        await expectParlorError(async () => await makePersona({ name: 'the researcher' }), 'NAME_TAKEN', 409);
    });

    test('persona cap is enforced', async () => {
        for (let i = 0; i < 12; i++) await makePersona({ name: `Persona ${i}` });
        await expectParlorError(async () => await makePersona({ name: 'One Too Many' }), 'PERSONA_CAP');
    });

    test('other users cannot touch a persona', async () => {
        const persona = await makePersona();
        await expectParlorError(async () => await parlorService.updatePersona({
            ownerId: OTHER, personaId: persona.id, name: 'Stolen'
        }), 'NO_SUCH_PERSONA', 404);
        await expect((async () => await parlorService.deletePersona({ ownerId: OTHER, personaId: persona.id }))())
            .rejects.toThrow(ParlorError);
    });

    test('bad color is rejected', async () => {
        await expectParlorError(async () => await makePersona({ color: 'red' }), 'BAD_COLOR');
    });

    test('deleting a persona cascades its workspace', async () => {
        const persona = await makePersona();
        await parlorService.createNote({
            ownerId: OWNER, personaId: persona.id,
            title: 'A note', content: 'Content', tags: ['alpha', 'beta']
        });
        await parlorService.deletePersona({ ownerId: OWNER, personaId: persona.id });
        expect((await db.get(
            `SELECT COUNT(*) AS c FROM kg_nodes WHERE scopeKey LIKE 'PARLOR:%'`
        )).c).toBe(0);
        expect((await db.get(
            `SELECT COUNT(*) AS c FROM kg_tags WHERE scopeKey LIKE 'PARLOR:%'`
        )).c).toBe(0);
    });
});

describe('notes and tags', () => {
    test('create with tags; tags normalize, dedupe, and count', async () => {
        const persona = await makePersona();
        const note = await parlorService.createNote({
            ownerId: OWNER, personaId: persona.id,
            title: 'Rust ownership', content: 'The borrow checker enforces aliasing rules.',
            tags: ['  Rust ', 'systems', 'rust']
        });
        expect(note.tags.map(t => t.name).sort()).toEqual(['rust', 'systems']);

        const tags = await parlorService.listTags({ ownerId: OWNER, personaId: persona.id });
        expect(tags).toHaveLength(2);
        expect(tags.every(t => t.noteCount === 1)).toBe(true);
    });

    test('titles are unique per workspace', async () => {
        const persona = await makePersona();
        await parlorService.createNote({
            ownerId: OWNER, personaId: persona.id, title: 'Same', content: 'One'
        });
        await expectParlorError(async () => await parlorService.createNote({
            ownerId: OWNER, personaId: persona.id, title: 'same', content: 'Two'
        }), 'TITLE_TAKEN', 409);
    });

    test('update replaces tags and prunes orphans', async () => {
        const persona = await makePersona();
        const note = await parlorService.createNote({
            ownerId: OWNER, personaId: persona.id,
            title: 'Note', content: 'Content', tags: ['old']
        });
        const updated = await parlorService.updateNote({
            ownerId: OWNER, noteId: note.id, tags: ['new']
        });
        expect(updated.tags.map(t => t.name)).toEqual(['new']);
        const tags = await parlorService.listTags({ ownerId: OWNER, personaId: persona.id });
        expect(tags.map(t => t.name)).toEqual(['new']); // 'old' pruned
    });

    test('delete note prunes orphaned tags', async () => {
        const persona = await makePersona();
        const keep = await parlorService.createNote({
            ownerId: OWNER, personaId: persona.id, title: 'Keep', content: 'x', tags: ['shared']
        });
        const drop = await parlorService.createNote({
            ownerId: OWNER, personaId: persona.id, title: 'Drop', content: 'x', tags: ['shared', 'solo']
        });
        await parlorService.deleteNote({ ownerId: OWNER, noteId: drop.id });
        const tags = await parlorService.listTags({ ownerId: OWNER, personaId: persona.id });
        expect(tags.map(t => t.name)).toEqual(['shared']);
        expect((await parlorService.listNotes({ ownerId: OWNER, personaId: persona.id }))
            .map(n => n.id)).toEqual([keep.id]);
    });

    test('note ownership is enforced through the persona', async () => {
        const persona = await makePersona();
        const note = await parlorService.createNote({
            ownerId: OWNER, personaId: persona.id, title: 'Mine', content: 'x'
        });
        await expectParlorError(async () => await parlorService.updateNote({ ownerId: OTHER, noteId: note.id, content: 'theft' }), 'NO_SUCH_NOTE', 404);
    });

    test('tag filter and keyword filter in listNotes', async () => {
        const persona = await makePersona();
        await parlorService.createNote({
            ownerId: OWNER, personaId: persona.id, title: 'Alpha', content: 'about rust', tags: ['lang']
        });
        await parlorService.createNote({
            ownerId: OWNER, personaId: persona.id, title: 'Beta', content: 'about cooking', tags: ['food']
        });
        const tags = await parlorService.listTags({ ownerId: OWNER, personaId: persona.id });
        const foodTag = tags.find(t => t.name === 'food');
        const filtered = await parlorService.listNotes({
            ownerId: OWNER, personaId: persona.id, tagId: foodTag.id
        });
        expect(filtered.map(n => n.title)).toEqual(['Beta']);
        const searched = await parlorService.listNotes({ ownerId: OWNER, personaId: persona.id, q: 'rust' });
        expect(searched.map(n => n.title)).toEqual(['Alpha']);
    });
});

describe('workspace graph', () => {
    test('same graph shape as Spitball: notes plus tag hubs and tagged spokes', async () => {
        const persona = await makePersona();
        await parlorService.createNote({
            ownerId: OWNER, personaId: persona.id, title: 'One', content: 'x', tags: ['shared']
        });
        await parlorService.createNote({
            ownerId: OWNER, personaId: persona.id, title: 'Two', content: 'x', tags: ['shared', 'extra']
        });
        const graph = await parlorService.getWorkspaceGraph({ ownerId: OWNER, personaId: persona.id });
        const tagNodes = graph.nodes.filter(n => n.type === 'tag');
        const noteNodes = graph.nodes.filter(n => n.type !== 'tag');
        expect(tagNodes.map(n => n.id).sort()).toEqual(['tag:extra', 'tag:shared']);
        expect(noteNodes).toHaveLength(2);
        expect(noteNodes.every(n => String(n.id).startsWith('kg:'))).toBe(true);
        expect(graph.edges).toHaveLength(3); // One->shared, Two->shared, Two->extra
        expect(graph.edges.every(e => e.relation === 'tagged' && e.derived)).toBe(true);
        const shared = tagNodes.find(n => n.label === 'shared');
        const extra = tagNodes.find(n => n.label === 'extra');
        expect(shared.salience).toBeGreaterThan(extra.salience);
    });

    test('stored typed edges sit alongside tag hubs', async () => {
        const persona = await makePersona();
        await parlorService.createNote({
            ownerId: OWNER, personaId: persona.id, title: 'Cause', content: 'x', tags: ['science']
        });
        await parlorService.createNote({
            ownerId: OWNER, personaId: persona.id, title: 'Effect', content: 'x', tags: ['science']
        });
        const kg = require('@goobster/core/services/knowledgeGraphService');
        const { dmScopeId } = require('@goobster/core/utils/dmScope');
        await kg.link({
            guildId: dmScopeId(OWNER),
            scopeKey: kg.parlorScopeKey(persona.id),
            subjectType: 'USER',
            subjectId: OWNER,
            source: 'Cause',
            target: 'Effect',
            relation: 'leads_to',
            relationKind: 'causal'
        });
        const graph = await parlorService.getWorkspaceGraph({ ownerId: OWNER, personaId: persona.id });
        expect(graph.edges.some(e => e.relation === 'leads_to')).toBe(true);
        expect(graph.edges.filter(e => e.relation === 'tagged')).toHaveLength(2);
    });
});

describe('retrieval', () => {
    test('semantic search ranks the on-topic note first', async () => {
        const persona = await makePersona();
        await parlorService.createNote({
            ownerId: OWNER, personaId: persona.id,
            title: 'Rust ownership', content: 'rust rust rust borrow checker'
        });
        await parlorService.createNote({
            ownerId: OWNER, personaId: persona.id,
            title: 'Sourdough', content: 'cook cook cook flour water salt'
        });
        await settle(); // let the fire-and-forget embeddings land

        const results = await parlorService.searchNotes({
            ownerId: OWNER, personaId: persona.id, query: 'tell me about rust memory safety'
        });
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].title).toBe('Rust ownership');
    });

    test('keyword fallback works when the embedding backend fails', async () => {
        const persona = await makePersona();
        await parlorService.createNote({
            ownerId: OWNER, personaId: persona.id,
            title: 'Sourdough starter', content: 'Feed the starter daily with flour.'
        });
        await settle();
        mockEmbedding.embed.mockRejectedValueOnce(new Error('backend down'));
        const results = await parlorService.searchNotes({
            ownerId: OWNER, personaId: persona.id, query: 'how do I feed my sourdough starter?'
        });
        expect(results.map(r => r.title)).toEqual(['Sourdough starter']);
    });
});

describe('conversations', () => {
    test('create requires owned personas and caps participants', async () => {
        const a = await makePersona({ name: 'A' });
        const b = await makePersona({ name: 'B' });
        const conversation = await parlorService.createConversation({
            ownerId: OWNER, personaIds: [a.id, b.id]
        });
        expect(conversation.participants.map(p => p.name)).toEqual(['A', 'B']);

        await expectParlorError(async () => await parlorService.createConversation({ ownerId: OWNER, personaIds: [] }), 'NO_PARTICIPANTS');
        await expectParlorError(async () => await parlorService.createConversation({ ownerId: OTHER, personaIds: [a.id] }), 'NO_SUCH_PERSONA');

        const many = [];
        for (let i = 0; i < 5; i++) many.push((await makePersona({ name: `P${i}` })).id);
        await expectParlorError(async () => await parlorService.createConversation({ ownerId: OWNER, personaIds: many }), 'TOO_MANY_PARTICIPANTS');
    });

    test('participants can be added and removed', async () => {
        const a = await makePersona({ name: 'A' });
        const b = await makePersona({ name: 'B' });
        const conversation = await parlorService.createConversation({ ownerId: OWNER, personaIds: [a.id] });
        let { participants } = await parlorService.setParticipant({
            ownerId: OWNER, conversationId: conversation.id, personaId: b.id, present: true
        });
        expect(participants.map(p => p.name)).toEqual(['A', 'B']);
        ({ participants } = await parlorService.setParticipant({
            ownerId: OWNER, conversationId: conversation.id, personaId: a.id, present: false
        }));
        expect(participants.map(p => p.name)).toEqual(['B']);
    });

    test('rename and delete (messages cascade, personas survive)', async () => {
        const persona = await makePersona();
        const conversation = await parlorService.createConversation({ ownerId: OWNER, personaIds: [persona.id] });
        await parlorService.renameConversation({
            ownerId: OWNER, conversationId: conversation.id, title: 'Big ideas'
        });
        await db.run(
            `INSERT INTO parlor_messages (conversationId, role, content) VALUES (@id, 'user', 'hi')`,
            { id: conversation.id }
        );
        await parlorService.deleteConversation({ ownerId: OWNER, conversationId: conversation.id });
        expect((await db.get('SELECT COUNT(*) AS c FROM parlor_messages')).c).toBe(0);
        expect(await parlorService.listPersonas(OWNER)).toHaveLength(1);
    });
});

describe('the turn workflow', () => {
    test('retrieve -> generate -> write back, with traceable grounding', async () => {
        const persona = await makePersona({ name: 'Ada' });
        await parlorService.createNote({
            ownerId: OWNER, personaId: persona.id,
            title: 'Rust ownership', content: 'rust rust rust borrow checker', tags: ['rust']
        });
        await settle();

        mockAi.chat.mockResolvedValue({ content: 'My notes on Rust say the borrow checker rules.', toolCalls: [] });
        // First generateText call is the auto-title; the write-back matcher
        // keys on prompt content instead of call order.
        mockAi.generateText.mockImplementation(async (prompt) => {
            if (prompt.includes('knowledge-keeper')) {
                return '{"notes": [{"title": "User is learning Rust", "content": "They asked about memory safety.", "tags": ["rust", "user context"]}]}';
            }
            return 'Rust Memory Safety';
        });

        const conversation = await parlorService.createConversation({ ownerId: OWNER, personaIds: [persona.id] });
        const events = { learned: [], personaMessages: [], userMessages: [], starts: [] };
        const turn = await parlorService.startTurn({
            userId: OWNER, userName: 'Rob',
            conversationId: conversation.id,
            message: 'What do you know about rust memory safety?'
        });
        await turn.run({
            onUserMessage: (m) => events.userMessages.push(m),
            onPersonaStart: (p) => events.starts.push(p.name),
            onPersonaMessage: (m) => events.personaMessages.push(m),
            onLearned: (l) => events.learned.push(l)
        });

        expect(events.starts).toEqual(['Ada']);
        expect(events.userMessages).toHaveLength(1);
        expect(events.personaMessages).toHaveLength(1);
        const reply = events.personaMessages[0];
        expect(reply.personaName).toBe('Ada');
        expect(reply.grounding.map(g => g.title)).toContain('Rust ownership');

        // Write back: the extracted note landed with source 'conversation'
        expect(events.learned).toHaveLength(1);
        expect(events.learned[0].notes[0].title).toBe('User is learning Rust');
        const notes = await parlorService.listNotes({ ownerId: OWNER, personaId: persona.id });
        const learnedNote = notes.find(n => n.title === 'User is learning Rust');
        expect(learnedNote.source).toBe('conversation');
        expect(learnedNote.sourceConversationId).toBe(conversation.id);
        expect(learnedNote.tags.map(t => t.name).sort()).toEqual(['rust', 'user context']);

        // The generation prompt carried the charter and the retrieved note
        const [messages] = mockAi.chat.mock.calls[0];
        expect(messages[0].role).toBe('system');
        expect(messages[0].content).toContain('careful researcher');
        expect(messages[0].content).toContain('Rust ownership');

        // Transcript persisted with grounding resolvable
        const stored = await parlorService.getMessages({ userId: OWNER, conversationId: conversation.id });
        expect(stored.map(m => m.role)).toEqual(['user', 'persona']);
        expect(stored[1].grounding.map(g => g.title)).toContain('Rust ownership');

        // Auto-title (fallback immediately, model title async)
        await settle();
        const listed = await parlorService.listConversations(OWNER);
        expect(listed[0].title).toBe('Rust Memory Safety');
    });

    test('every participant replies in seat order and sees prior replies', async () => {
        const a = await makePersona({ name: 'First' });
        const b = await makePersona({ name: 'Second' });
        const conversation = await parlorService.createConversation({ ownerId: OWNER, personaIds: [a.id, b.id] });

        const replies = { First: 'First speaks.', Second: 'Second responds to First.' };
        mockAi.chat.mockImplementation(async (messages) => {
            const system = messages[0].content;
            const name = system.includes('"First"') ? 'First' : 'Second';
            return { content: replies[name], toolCalls: [] };
        });

        const order = [];
        const turn = await parlorService.startTurn({
            userId: OWNER, userName: 'Rob',
            conversationId: conversation.id, message: 'Discuss.'
        });
        await turn.run({ onPersonaStart: (p) => order.push(p.name) });
        expect(order).toEqual(['First', 'Second']);

        // The second persona's window contained the first one's reply as a
        // labeled user message.
        const secondCall = mockAi.chat.mock.calls[1][0];
        const labeled = secondCall.find(m => m.role === 'user' && m.content.startsWith('[First]:'));
        expect(labeled).toBeDefined();

        const stored = await parlorService.getMessages({ userId: OWNER, conversationId: conversation.id });
        expect(stored.map(m => m.personaName)).toEqual([null, 'First', 'Second']);
    });

    test('a failed generation reports an error message and the turn survives', async () => {
        const a = await makePersona({ name: 'Broken' });
        const b = await makePersona({ name: 'Fine' });
        const conversation = await parlorService.createConversation({ ownerId: OWNER, personaIds: [a.id, b.id] });
        mockAi.chat
            .mockRejectedValueOnce(new Error('provider exploded'))
            .mockResolvedValueOnce({ content: 'Still here.', toolCalls: [] });

        const messages = [];
        const turn = await parlorService.startTurn({
            userId: OWNER, userName: 'Rob',
            conversationId: conversation.id, message: 'Hello?'
        });
        await turn.run({ onPersonaMessage: (m) => messages.push(m) });

        expect(messages).toHaveLength(2);
        expect(messages[0].isError).toBe(true);
        expect(messages[0].content).toContain('provider exploded');
        expect(messages[1].content).toBe('Still here.');
        // The failed reply is not persisted; the good one is.
        const stored = await parlorService.getMessages({ userId: OWNER, conversationId: conversation.id });
        expect(stored.filter(m => m.role === 'persona')).toHaveLength(1);
    });

    test('a self-label prefix is stripped from persona replies', async () => {
        const persona = await makePersona({ name: 'Ada' });
        const conversation = await parlorService.createConversation({ ownerId: OWNER, personaIds: [persona.id] });
        mockAi.chat.mockResolvedValue({ content: '[Ada]: The byline is not my job.', toolCalls: [] });

        const messages = [];
        const turn = await parlorService.startTurn({
            userId: OWNER, userName: 'Rob',
            conversationId: conversation.id, message: 'Say something.'
        });
        await turn.run({ onPersonaMessage: (m) => messages.push(m) });
        expect(messages[0].content).toBe('The byline is not my job.');
    });

    test('one turn in flight per user; empty and oversized messages rejected', async () => {
        const persona = await makePersona();
        const conversation = await parlorService.createConversation({ ownerId: OWNER, personaIds: [persona.id] });

        await expectParlorError(async () => await parlorService.startTurn({
            userId: OWNER, userName: 'Rob', conversationId: conversation.id, message: '  '
        }), 'EMPTY_MESSAGE');
        await expectParlorError(async () => await parlorService.startTurn({
            userId: OWNER, userName: 'Rob', conversationId: conversation.id,
            message: 'x'.repeat(8001)
        }), 'MESSAGE_TOO_LONG');

        const turn = await parlorService.startTurn({
            userId: OWNER, userName: 'Rob', conversationId: conversation.id, message: 'hi'
        });
        await expectParlorError(async () => await parlorService.startTurn({
            userId: OWNER, userName: 'Rob', conversationId: conversation.id, message: 'again'
        }), 'TURN_IN_FLIGHT', 409);
        await turn.run();
    });

    test('personas get the curated tool subset through the shared agent loop', async () => {
        const persona = await makePersona({ name: 'Gambler' });
        const conversation = await parlorService.createConversation({ ownerId: OWNER, personaIds: [persona.id] });

        // Round 0: the model requests a dice roll; round 1: it answers.
        mockAi.chat
            .mockResolvedValueOnce({
                content: 'Let me roll for it.',
                toolCalls: [{ id: 't1', name: 'rollDice', arguments: '{"expression":"d20"}' }]
            })
            .mockResolvedValueOnce({ content: 'The dice have spoken.', toolCalls: [] });

        const toolEvents = [];
        const messages = [];
        const turn = await parlorService.startTurn({
            userId: OWNER, userName: 'Rob',
            conversationId: conversation.id, message: 'Roll a d20 for luck.'
        });
        await turn.run({
            onPersonaTool: (payload) => toolEvents.push(payload),
            onPersonaMessage: (m) => messages.push(m)
        });

        expect(toolEvents).toEqual([{ personaId: persona.id, tools: ['rollDice'] }]);
        expect(messages[0].content).toBe('The dice have spoken.');

        // The offered subset is curated: conversation-partner tools only,
        // and never manageParlor (a persona must not rewire the parlor).
        const options = mockAi.chat.mock.calls[0][1];
        const offered = options.functions.map(f => f.name);
        expect(offered).toContain('performSearch');
        expect(offered).toContain('generateImage');
        expect(offered).toContain('rollDice');
        expect(offered).not.toContain('manageParlor');
        expect(offered).not.toContain('tradeStock');
        expect(offered).not.toContain('rememberFact');
        expect(offered).not.toContain('playTrack');

        // The tool result reached the second round as a tool message
        const secondRound = mockAi.chat.mock.calls[1][0];
        const toolMessage = secondRound.find(m => m.role === 'tool' && m.name === 'rollDice');
        expect(toolMessage).toBeDefined();
        expect(toolMessage.content).toContain('🎲');

        // And the system prompt teaches in-character tool use
        expect(mockAi.chat.mock.calls[0][0][0].content).toContain('THE WAY YOUR CHARTER WOULD');
    });

    test('tool-generated images are captured, persisted, and re-served', async () => {
        const persona = await makePersona({ name: 'Painter' });
        const conversation = await parlorService.createConversation({ ownerId: OWNER, personaIds: [persona.id] });

        const imagePath = path.join(os.tmpdir(), `parlor-test-image-${process.pid}.png`);
        fs.writeFileSync(imagePath, 'not-a-real-png');
        mockImages.generateImage.mockResolvedValue(imagePath);

        mockAi.chat
            .mockResolvedValueOnce({
                content: '',
                toolCalls: [{ id: 't1', name: 'generateImage', arguments: '{"prompt":"a cozy parlor"}' }]
            })
            .mockResolvedValueOnce({ content: 'I painted it for you.', toolCalls: [] });

        const messages = [];
        const turn = await parlorService.startTurn({
            userId: OWNER, userName: 'Rob',
            conversationId: conversation.id, message: 'Paint the parlor.'
        });
        await turn.run({ onPersonaMessage: (m) => messages.push(m) });

        // Live event carried a servable owner-bound URL
        expect(messages[0].attachments).toHaveLength(1);
        expect(messages[0].attachments[0].url).toMatch(/^\/api\/app\/files\//);

        // Persisted on the message row and re-served on history reads
        const stored = await parlorService.getMessages({ userId: OWNER, conversationId: conversation.id });
        const reply = stored.find(m => m.role === 'persona');
        expect(reply.attachments).toHaveLength(1);
        expect(reply.attachments[0].url).toMatch(/^\/api\/app\/files\//);

        fs.unlinkSync(imagePath);
    });

    test('write-back legalization: caps, duplicate titles, malformed JSON', async () => {
        const persona = await makePersona({ name: 'Keeper' });
        await parlorService.createNote({
            ownerId: OWNER, personaId: persona.id, title: 'Existing note', content: 'x'
        });
        const conversation = await parlorService.createConversation({ ownerId: OWNER, personaIds: [persona.id] });

        mockAi.generateText.mockImplementation(async (prompt) => {
            if (prompt.includes('knowledge-keeper')) {
                // Three notes proposed (cap is 2), one a duplicate title
                return JSON.stringify({
                    notes: [
                        { title: 'Existing note', content: 'dupe', tags: [] },
                        { title: 'Fresh insight', content: 'kept', tags: ['idea'] },
                        { title: 'Third wheel', content: 'over the cap', tags: [] }
                    ]
                });
            }
            return 'Title';
        });

        const learned = [];
        const turn = await parlorService.startTurn({
            userId: OWNER, userName: 'Rob', conversationId: conversation.id, message: 'Teach me.'
        });
        await turn.run({ onLearned: (l) => learned.push(l) });

        // Only the fresh, in-cap note landed
        expect(learned).toHaveLength(1);
        expect(learned[0].notes.map(n => n.title)).toEqual(['Fresh insight']);

        // Malformed JSON never throws
        mockAi.generateText.mockResolvedValue('not json at all');
        const turn2 = await parlorService.startTurn({
            userId: OWNER, userName: 'Rob', conversationId: conversation.id, message: 'More.'
        });
        await expect(turn2.run()).resolves.toBeUndefined();
    });
});

describe('tag suggestions', () => {
    test('legalizes model output and degrades to empty without a provider', async () => {
        const persona = await makePersona();
        mockAi.generateText.mockResolvedValueOnce('{"tags": ["  Distributed Systems ", "raft", "RAFT", 42]}');
        const tags = await parlorService.suggestTags({
            ownerId: OWNER, personaId: persona.id, title: 'Raft', content: 'consensus'
        });
        expect(tags).toEqual(['distributed systems', 'raft', '42']);

        mockAi.generateText.mockRejectedValueOnce(new Error('no provider'));
        const none = await parlorService.suggestTags({
            ownerId: OWNER, personaId: persona.id, title: 'Raft', content: 'consensus'
        });
        expect(none).toEqual([]);
    });
});

describe('the should-respond gate', () => {
    /** Route gate prompts by persona name; everything else is write-back/title. */
    function mockGate(decisions) {
        mockAi.generateText.mockImplementation(async (prompt) => {
            if (prompt.includes('decide whether the persona')) {
                for (const [name, respond] of Object.entries(decisions)) {
                    if (prompt.includes(`"${name}"`)) {
                        return JSON.stringify({ respond, reason: respond ? 'has a take' : 'nothing to add' });
                    }
                }
                return '{"respond": true}';
            }
            return '{"notes": []}';
        });
    }

    test('a persona can decline in a group discussion', async () => {
        const talker = await makePersona({ name: 'Talker' });
        await makePersona({ name: 'Quiet' });
        const conversation = await parlorService.createConversation({
            ownerId: OWNER, personaIds: (await parlorService.listPersonas(OWNER)).map(p => p.id)
        });
        mockGate({ Talker: true, Quiet: false });

        const passes = [];
        const messages = [];
        const turn = await parlorService.startTurn({
            userId: OWNER, userName: 'Rob',
            conversationId: conversation.id, message: 'General question for the table.'
        });
        await turn.run({
            onPersonaPass: (p) => passes.push(p),
            onPersonaMessage: (m) => messages.push(m)
        });

        expect(passes.map(p => p.personaName)).toEqual(['Quiet']);
        expect(passes[0].reason).toBe('nothing to add');
        expect(messages.map(m => m.personaName)).toEqual(['Talker']);
        // Passes leave no transcript rows - only the actual reply persists
        const stored = await parlorService.getMessages({ userId: OWNER, conversationId: conversation.id });
        expect(stored.filter(m => m.role === 'persona').map(m => m.personaName)).toEqual(['Talker']);
        expect(talker.id).toBeDefined();
    });

    test('a direct name-mention bypasses the gate entirely', async () => {
        await makePersona({ name: 'Alpha' });
        await makePersona({ name: 'Bravo' });
        const conversation = await parlorService.createConversation({
            ownerId: OWNER, personaIds: (await parlorService.listPersonas(OWNER)).map(p => p.id)
        });
        mockGate({ Alpha: false, Bravo: false }); // the gate would silence both

        const passes = [];
        const messages = [];
        const turn = await parlorService.startTurn({
            userId: OWNER, userName: 'Rob',
            conversationId: conversation.id, message: 'Bravo, what do you think?'
        });
        await turn.run({
            onPersonaPass: (p) => passes.push(p),
            onPersonaMessage: (m) => messages.push(m)
        });

        expect(messages.map(m => m.personaName)).toEqual(['Bravo']);
        expect(passes.map(p => p.personaName)).toEqual(['Alpha']);
        // Bravo was never asked - the mention pre-pass answered for them
        const gatePrompts = mockAi.generateText.mock.calls
            .map(c => c[0]).filter(p => p.includes('decide whether the persona'));
        expect(gatePrompts).toHaveLength(1);
        expect(gatePrompts[0]).toContain('"Alpha"');
    });

    test('when everyone declines, the first seat answers anyway', async () => {
        await makePersona({ name: 'First' });
        await makePersona({ name: 'Second' });
        const conversation = await parlorService.createConversation({
            ownerId: OWNER, personaIds: (await parlorService.listPersonas(OWNER)).map(p => p.id)
        });
        mockGate({ First: false, Second: false });

        const passes = [];
        const messages = [];
        const turn = await parlorService.startTurn({
            userId: OWNER, userName: 'Rob',
            conversationId: conversation.id, message: 'Anyone?'
        });
        await turn.run({
            onPersonaPass: (p) => passes.push(p),
            onPersonaMessage: (m) => messages.push(m)
        });

        expect(passes.map(p => p.personaName)).toEqual(['First', 'Second']);
        expect(messages.map(m => m.personaName)).toEqual(['First']); // forced fallback
    });

    test('solo discussions and broken gates never silence a persona', async () => {
        const solo = await makePersona({ name: 'Solo' });
        const conversation = await parlorService.createConversation({ ownerId: OWNER, personaIds: [solo.id] });
        const messages = [];
        const turn = await parlorService.startTurn({
            userId: OWNER, userName: 'Rob',
            conversationId: conversation.id, message: 'Hello.'
        });
        await turn.run({ onPersonaMessage: (m) => messages.push(m) });
        expect(messages).toHaveLength(1);
        // No gate call happened for a single-participant discussion
        const gatePrompts = mockAi.generateText.mock.calls
            .map(c => c[0]).filter(p => p.includes('decide whether the persona'));
        expect(gatePrompts).toHaveLength(0);
        // And a gate that returns garbage defaults to speaking (only an
        // explicit false silences) - covered by the default '{"notes": []}'
        // mock in the multi-persona tests above.
    });
});

describe('manual persona trigger', () => {
    test('startPersonaTurn runs one forced persona, no user message, back to back', async () => {
        const a = await makePersona({ name: 'Narrator' });
        const b = await makePersona({ name: 'Critic' });
        const conversation = await parlorService.createConversation({ ownerId: OWNER, personaIds: [a.id, b.id] });
        // The gate would decline everyone - forced turns must skip it
        mockAi.generateText.mockImplementation(async (prompt) =>
            prompt.includes('decide whether the persona') ? '{"respond": false}' : '{"notes": []}');

        const messages = [];
        const passes = [];
        const turn = await parlorService.startPersonaTurn({
            userId: OWNER, userName: 'Rob',
            conversationId: conversation.id, personaId: b.id
        });
        expect(turn.persona.name).toBe('Critic');
        await turn.run({
            onPersonaMessage: (m) => messages.push(m),
            onPersonaPass: (p) => passes.push(p)
        });
        expect(passes).toHaveLength(0);
        expect(messages.map(m => m.personaName)).toEqual(['Critic']);

        // Immediately again - "even if they just responded"
        const again = await parlorService.startPersonaTurn({
            userId: OWNER, userName: 'Rob',
            conversationId: conversation.id, personaId: b.id
        });
        await again.run({ onPersonaMessage: (m) => messages.push(m) });
        expect(messages.map(m => m.personaName)).toEqual(['Critic', 'Critic']);

        // No user rows were created; both replies persisted
        const stored = await parlorService.getMessages({ userId: OWNER, conversationId: conversation.id });
        expect(stored.map(m => m.role)).toEqual(['persona', 'persona']);
    });

    test('validation: seat required, ownership, and the turn lock', async () => {
        const seated = await makePersona({ name: 'Seated' });
        const bench = await makePersona({ name: 'Benched' });
        const conversation = await parlorService.createConversation({ ownerId: OWNER, personaIds: [seated.id] });

        await expectParlorError(async () => await parlorService.startPersonaTurn({
            userId: OWNER, userName: 'Rob', conversationId: conversation.id, personaId: bench.id
        }), 'NOT_SEATED');
        await expectParlorError(async () => await parlorService.startPersonaTurn({
            userId: OTHER, userName: 'Eve', conversationId: conversation.id, personaId: seated.id
        }), 'NO_SUCH_CONVERSATION', 404);

        const turn = await parlorService.startPersonaTurn({
            userId: OWNER, userName: 'Rob', conversationId: conversation.id, personaId: seated.id
        });
        await expectParlorError(async () => await parlorService.startPersonaTurn({
            userId: OWNER, userName: 'Rob', conversationId: conversation.id, personaId: seated.id
        }), 'TURN_IN_FLIGHT', 409);
        await turn.run();
    });
});

describe('quickstart', () => {
    const design = {
        title: 'Home Lab Salon',
        opening: 'Where should we start?',
        personas: [
            {
                name: 'The Skeptic', emoji: '🤨', charter: 'You doubt everything until it survives scrutiny.',
                notes: [{ title: 'Prior art', content: 'Most home labs die of complexity.', tags: ['Home Lab'] }]
            },
            {
                name: 'The Builder', emoji: '🔨', charter: 'You build the simplest thing that works.',
                notes: [
                    { title: 'Parts list', content: 'A Pi and a managed switch.', tags: ['home lab', 'hardware'] },
                    { title: 'Parts list', content: 'duplicate title - must be skipped', tags: [] }
                ]
            },
            { name: '', charter: '' } // unusable proposal - must be skipped
        ]
    };

    test('one prompt creates a legalized cast, seed notes, and a titled discussion', async () => {
        mockAi.generateText.mockResolvedValueOnce(JSON.stringify(design));
        const result = await parlorService.quickstart({
            ownerId: OWNER, prompt: 'help me plan a home lab'
        });

        expect(result.conversation.title).toBe('Home Lab Salon');
        expect(result.opening).toBe('Where should we start?');
        expect(result.personas.map(p => p.name)).toEqual(['The Skeptic', 'The Builder']);
        expect(result.seededNotes).toBe(2); // the duplicate title was skipped

        const conversations = await parlorService.listConversations(OWNER);
        expect(conversations[0].participants.map(p => p.name)).toEqual(['The Skeptic', 'The Builder']);

        const skeptic = result.personas.find(p => p.name === 'The Skeptic');
        const notes = await parlorService.listNotes({ ownerId: OWNER, personaId: skeptic.id });
        expect(notes.map(n => n.title)).toEqual(['Prior art']);
        expect(notes[0].tags.map(t => t.name)).toEqual(['home lab']); // normalized

        // The design prompt reached the concierge with the topic in it
        const conciergePrompt = mockAi.generateText.mock.calls[0][0];
        expect(conciergePrompt).toContain('help me plan a home lab');
    });

    test('existing persona names are passed to the concierge and duplicates skipped', async () => {
        await makePersona({ name: 'The Skeptic' });
        mockAi.generateText.mockResolvedValueOnce(JSON.stringify(design));
        const result = await parlorService.quickstart({ ownerId: OWNER, prompt: 'home lab' });
        // 'The Skeptic' already exists -> skipped; only The Builder lands
        expect(result.personas.map(p => p.name)).toEqual(['The Builder']);
        const conciergePrompt = mockAi.generateText.mock.calls[0][0];
        expect(conciergePrompt).toContain('already taken');
        expect(conciergePrompt).toContain('The Skeptic');
    });

    test('validation and failure modes', async () => {
        await expect(parlorService.quickstart({ ownerId: OWNER, prompt: '   ' }))
            .rejects.toMatchObject({ code: 'EMPTY_PROMPT', status: 400 });

        mockAi.generateText.mockRejectedValueOnce(new Error('provider down'));
        await expect(parlorService.quickstart({ ownerId: OWNER, prompt: 'a topic' }))
            .rejects.toMatchObject({ code: 'QUICKSTART_UNAVAILABLE', status: 503 });

        mockAi.generateText.mockResolvedValueOnce('not json at all');
        await expect(parlorService.quickstart({ ownerId: OWNER, prompt: 'a topic' }))
            .rejects.toMatchObject({ code: 'BAD_DESIGN', status: 502 });
    });

    test('needs room for at least two new personas', async () => {
        for (let i = 0; i < 11; i++) await makePersona({ name: `P${i}` });
        await expect(parlorService.quickstart({ ownerId: OWNER, prompt: 'a topic' }))
            .rejects.toMatchObject({ code: 'PERSONA_CAP' });
    });
});

describe('privacy (/forget-me)', () => {
    test('erasure deletes the whole parlor and the audit proves it', async () => {
        const persona = await makePersona();
        await parlorService.createNote({
            ownerId: OWNER, personaId: persona.id, title: 'Note', content: 'x', tags: ['tag']
        });
        const conversation = await parlorService.createConversation({ ownerId: OWNER, personaIds: [persona.id] });
        await db.run(
            `INSERT INTO parlor_messages (conversationId, role, content) VALUES (@id, 'user', 'hello')`,
            { id: conversation.id }
        );
        // Another user's parlor must survive
        const otherPersona = await parlorService.createPersona({
            ownerId: OTHER, name: 'Bystander', charter: 'Unrelated.'
        });

        const report = await privacyService.buildUserReport({ guildId: 'dm:' + OWNER, userId: OWNER });
        expect(report.parlor).toEqual({
            personas: 1, notes: 1, discussions: 1, sharedDiscussions: 0, pendingInvites: 0
        });

        const counts = await privacyService.forgetUser({ userId: OWNER });
        expect(counts.parlor).toBe(2); // 1 persona + 1 conversation (cascades)

        const audit = await privacyService.auditUser({ userId: OWNER });
        expect(audit.byTable.parlor_personas).toBe(0);
        expect(audit.byTable.parlor_conversations).toBe(0);
        for (const table of ['parlor_notes', 'parlor_tags', 'parlor_note_tags', 'parlor_messages', 'parlor_participants']) {
            expect((await db.get(`SELECT COUNT(*) AS c FROM ${table}`)).c).toBe(0);
        }
        expect((await parlorService.listPersonas(OTHER)).map(p => p.id)).toEqual([otherPersona.id]);
    });
});
