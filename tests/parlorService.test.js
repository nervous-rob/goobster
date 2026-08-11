/**
 * Unit tests for the Parlor (services/parlorService.js): persona/note/tag
 * CRUD with ownership checks and caps, the tag-first workspace graph,
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
jest.mock('../services/embeddingService', () => mockEmbedding);

const mockAi = {
    chat: jest.fn(),
    generateText: jest.fn()
};
jest.mock('../services/aiService', () => mockAi);

const db = require('../db');
const parlorService = require('../services/parlorService');
const { ParlorError } = require('../services/parlorService');
const privacyService = require('../services/privacyService');

const OWNER = '300000000000000001';
const OTHER = '300000000000000002';

/** Let fire-and-forget async work (embeddings, titles) settle. */
const settle = () => new Promise(resolve => setTimeout(resolve, 25));

/** Assert a ParlorError with the expected code (and optionally status). */
function expectParlorError(fn, code, status = null) {
    let caught = null;
    try { fn(); } catch (error) { caught = error; }
    expect(caught).not.toBeNull();
    expect(caught.code).toBe(code);
    if (status !== null) expect(caught.status).toBe(status);
}

beforeEach(() => {
    for (const table of ['parlor_messages', 'parlor_participants', 'parlor_conversations',
        'parlor_note_tags', 'parlor_tags', 'parlor_notes', 'parlor_personas']) {
        db.run(`DELETE FROM ${table}`);
    }
    // Transient in-memory guardrail state must not leak between tests
    parlorService._recentTurns.clear();
    parlorService._activeTurns.clear();
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

function makePersona(overrides = {}) {
    return parlorService.createPersona({
        ownerId: OWNER,
        name: 'The Researcher',
        emoji: '🔬',
        color: '#7c8cff',
        charter: 'You are a careful researcher.',
        ...overrides
    });
}

describe('personas', () => {
    test('create, list, update, delete', () => {
        const persona = makePersona();
        expect(persona.id).toBeGreaterThan(0);
        expect(persona.noteCount).toBe(0);

        const listed = parlorService.listPersonas(OWNER);
        expect(listed).toHaveLength(1);
        expect(listed[0].name).toBe('The Researcher');

        const updated = parlorService.updatePersona({
            ownerId: OWNER, personaId: persona.id, name: 'The Scientist'
        });
        expect(updated.name).toBe('The Scientist');

        parlorService.deletePersona({ ownerId: OWNER, personaId: persona.id });
        expect(parlorService.listPersonas(OWNER)).toHaveLength(0);
    });

    test('names are unique per owner (case-insensitive)', () => {
        makePersona();
        expectParlorError(() => makePersona({ name: 'the researcher' }), 'NAME_TAKEN', 409);
    });

    test('persona cap is enforced', () => {
        for (let i = 0; i < 12; i++) makePersona({ name: `Persona ${i}` });
        expectParlorError(() => makePersona({ name: 'One Too Many' }), 'PERSONA_CAP');
    });

    test('other users cannot touch a persona', () => {
        const persona = makePersona();
        expectParlorError(() => parlorService.updatePersona({
            ownerId: OTHER, personaId: persona.id, name: 'Stolen'
        }), 'NO_SUCH_PERSONA', 404);
        expect(() => parlorService.deletePersona({ ownerId: OTHER, personaId: persona.id }))
            .toThrow(ParlorError);
    });

    test('bad color is rejected', () => {
        expectParlorError(() => makePersona({ color: 'red' }), 'BAD_COLOR');
    });

    test('deleting a persona cascades its workspace', () => {
        const persona = makePersona();
        parlorService.createNote({
            ownerId: OWNER, personaId: persona.id,
            title: 'A note', content: 'Content', tags: ['alpha', 'beta']
        });
        parlorService.deletePersona({ ownerId: OWNER, personaId: persona.id });
        expect(db.get('SELECT COUNT(*) AS c FROM parlor_notes').c).toBe(0);
        expect(db.get('SELECT COUNT(*) AS c FROM parlor_tags').c).toBe(0);
        expect(db.get('SELECT COUNT(*) AS c FROM parlor_note_tags').c).toBe(0);
    });
});

describe('notes and tags', () => {
    test('create with tags; tags normalize, dedupe, and count', () => {
        const persona = makePersona();
        const note = parlorService.createNote({
            ownerId: OWNER, personaId: persona.id,
            title: 'Rust ownership', content: 'The borrow checker enforces aliasing rules.',
            tags: ['  Rust ', 'systems', 'rust']
        });
        expect(note.tags.map(t => t.name).sort()).toEqual(['rust', 'systems']);

        const tags = parlorService.listTags({ ownerId: OWNER, personaId: persona.id });
        expect(tags).toHaveLength(2);
        expect(tags.every(t => t.noteCount === 1)).toBe(true);
    });

    test('titles are unique per workspace', () => {
        const persona = makePersona();
        parlorService.createNote({
            ownerId: OWNER, personaId: persona.id, title: 'Same', content: 'One'
        });
        expectParlorError(() => parlorService.createNote({
            ownerId: OWNER, personaId: persona.id, title: 'same', content: 'Two'
        }), 'TITLE_TAKEN', 409);
    });

    test('update replaces tags and prunes orphans', () => {
        const persona = makePersona();
        const note = parlorService.createNote({
            ownerId: OWNER, personaId: persona.id,
            title: 'Note', content: 'Content', tags: ['old']
        });
        const updated = parlorService.updateNote({
            ownerId: OWNER, noteId: note.id, tags: ['new']
        });
        expect(updated.tags.map(t => t.name)).toEqual(['new']);
        const tags = parlorService.listTags({ ownerId: OWNER, personaId: persona.id });
        expect(tags.map(t => t.name)).toEqual(['new']); // 'old' pruned
    });

    test('delete note prunes orphaned tags', () => {
        const persona = makePersona();
        const keep = parlorService.createNote({
            ownerId: OWNER, personaId: persona.id, title: 'Keep', content: 'x', tags: ['shared']
        });
        const drop = parlorService.createNote({
            ownerId: OWNER, personaId: persona.id, title: 'Drop', content: 'x', tags: ['shared', 'solo']
        });
        parlorService.deleteNote({ ownerId: OWNER, noteId: drop.id });
        const tags = parlorService.listTags({ ownerId: OWNER, personaId: persona.id });
        expect(tags.map(t => t.name)).toEqual(['shared']);
        expect(parlorService.listNotes({ ownerId: OWNER, personaId: persona.id })
            .map(n => n.id)).toEqual([keep.id]);
    });

    test('note ownership is enforced through the persona', () => {
        const persona = makePersona();
        const note = parlorService.createNote({
            ownerId: OWNER, personaId: persona.id, title: 'Mine', content: 'x'
        });
        expectParlorError(() => parlorService.updateNote({ ownerId: OTHER, noteId: note.id, content: 'theft' }), 'NO_SUCH_NOTE', 404);
    });

    test('tag filter and keyword filter in listNotes', () => {
        const persona = makePersona();
        parlorService.createNote({
            ownerId: OWNER, personaId: persona.id, title: 'Alpha', content: 'about rust', tags: ['lang']
        });
        parlorService.createNote({
            ownerId: OWNER, personaId: persona.id, title: 'Beta', content: 'about cooking', tags: ['food']
        });
        const tags = parlorService.listTags({ ownerId: OWNER, personaId: persona.id });
        const foodTag = tags.find(t => t.name === 'food');
        const filtered = parlorService.listNotes({
            ownerId: OWNER, personaId: persona.id, tagId: foodTag.id
        });
        expect(filtered.map(n => n.title)).toEqual(['Beta']);
        const searched = parlorService.listNotes({ ownerId: OWNER, personaId: persona.id, q: 'rust' });
        expect(searched.map(n => n.title)).toEqual(['Alpha']);
    });
});

describe('workspace graph', () => {
    test('tag-first shape: tag + note nodes, note->tag edges only', () => {
        const persona = makePersona();
        parlorService.createNote({
            ownerId: OWNER, personaId: persona.id, title: 'One', content: 'x', tags: ['shared']
        });
        parlorService.createNote({
            ownerId: OWNER, personaId: persona.id, title: 'Two', content: 'x', tags: ['shared', 'extra']
        });
        const graph = parlorService.getWorkspaceGraph({ ownerId: OWNER, personaId: persona.id });
        const tagNodes = graph.nodes.filter(n => n.type === 'tag');
        const noteNodes = graph.nodes.filter(n => n.type === 'note');
        expect(tagNodes).toHaveLength(2);
        expect(noteNodes).toHaveLength(2);
        expect(graph.edges).toHaveLength(3); // One->shared, Two->shared, Two->extra
        expect(graph.edges.every(e => e.sourceId.startsWith('n') && e.targetId.startsWith('t'))).toBe(true);
        // The shared tag is more salient than the single-note tag
        const shared = tagNodes.find(n => n.label === 'shared');
        const extra = tagNodes.find(n => n.label === 'extra');
        expect(shared.salience).toBeGreaterThan(extra.salience);
    });
});

describe('retrieval', () => {
    test('semantic search ranks the on-topic note first', async () => {
        const persona = makePersona();
        parlorService.createNote({
            ownerId: OWNER, personaId: persona.id,
            title: 'Rust ownership', content: 'rust rust rust borrow checker'
        });
        parlorService.createNote({
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
        const persona = makePersona();
        parlorService.createNote({
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
    test('create requires owned personas and caps participants', () => {
        const a = makePersona({ name: 'A' });
        const b = makePersona({ name: 'B' });
        const conversation = parlorService.createConversation({
            ownerId: OWNER, personaIds: [a.id, b.id]
        });
        expect(conversation.participants.map(p => p.name)).toEqual(['A', 'B']);

        expectParlorError(() => parlorService.createConversation({ ownerId: OWNER, personaIds: [] }), 'NO_PARTICIPANTS');
        expectParlorError(() => parlorService.createConversation({ ownerId: OTHER, personaIds: [a.id] }), 'NO_SUCH_PERSONA');

        const many = [];
        for (let i = 0; i < 5; i++) many.push(makePersona({ name: `P${i}` }).id);
        expectParlorError(() => parlorService.createConversation({ ownerId: OWNER, personaIds: many }), 'TOO_MANY_PARTICIPANTS');
    });

    test('participants can be added and removed', () => {
        const a = makePersona({ name: 'A' });
        const b = makePersona({ name: 'B' });
        const conversation = parlorService.createConversation({ ownerId: OWNER, personaIds: [a.id] });
        let { participants } = parlorService.setParticipant({
            ownerId: OWNER, conversationId: conversation.id, personaId: b.id, present: true
        });
        expect(participants.map(p => p.name)).toEqual(['A', 'B']);
        ({ participants } = parlorService.setParticipant({
            ownerId: OWNER, conversationId: conversation.id, personaId: a.id, present: false
        }));
        expect(participants.map(p => p.name)).toEqual(['B']);
    });

    test('rename and delete (messages cascade, personas survive)', () => {
        const persona = makePersona();
        const conversation = parlorService.createConversation({ ownerId: OWNER, personaIds: [persona.id] });
        parlorService.renameConversation({
            ownerId: OWNER, conversationId: conversation.id, title: 'Big ideas'
        });
        db.run(
            `INSERT INTO parlor_messages (conversationId, role, content) VALUES (@id, 'user', 'hi')`,
            { id: conversation.id }
        );
        parlorService.deleteConversation({ ownerId: OWNER, conversationId: conversation.id });
        expect(db.get('SELECT COUNT(*) AS c FROM parlor_messages').c).toBe(0);
        expect(parlorService.listPersonas(OWNER)).toHaveLength(1);
    });
});

describe('the turn workflow', () => {
    test('retrieve -> generate -> write back, with traceable grounding', async () => {
        const persona = makePersona({ name: 'Ada' });
        parlorService.createNote({
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

        const conversation = parlorService.createConversation({ ownerId: OWNER, personaIds: [persona.id] });
        const events = { learned: [], personaMessages: [], userMessages: [], starts: [] };
        const turn = parlorService.startTurn({
            ownerId: OWNER, ownerName: 'Rob',
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
        const notes = parlorService.listNotes({ ownerId: OWNER, personaId: persona.id });
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
        const stored = parlorService.getMessages({ ownerId: OWNER, conversationId: conversation.id });
        expect(stored.map(m => m.role)).toEqual(['user', 'persona']);
        expect(stored[1].grounding.map(g => g.title)).toContain('Rust ownership');

        // Auto-title (fallback immediately, model title async)
        await settle();
        const listed = parlorService.listConversations(OWNER);
        expect(listed[0].title).toBe('Rust Memory Safety');
    });

    test('every participant replies in seat order and sees prior replies', async () => {
        const a = makePersona({ name: 'First' });
        const b = makePersona({ name: 'Second' });
        const conversation = parlorService.createConversation({ ownerId: OWNER, personaIds: [a.id, b.id] });

        const replies = { First: 'First speaks.', Second: 'Second responds to First.' };
        mockAi.chat.mockImplementation(async (messages) => {
            const system = messages[0].content;
            const name = system.includes('"First"') ? 'First' : 'Second';
            return { content: replies[name], toolCalls: [] };
        });

        const order = [];
        const turn = parlorService.startTurn({
            ownerId: OWNER, ownerName: 'Rob',
            conversationId: conversation.id, message: 'Discuss.'
        });
        await turn.run({ onPersonaStart: (p) => order.push(p.name) });
        expect(order).toEqual(['First', 'Second']);

        // The second persona's window contained the first one's reply as a
        // labeled user message.
        const secondCall = mockAi.chat.mock.calls[1][0];
        const labeled = secondCall.find(m => m.role === 'user' && m.content.startsWith('[First]:'));
        expect(labeled).toBeDefined();

        const stored = parlorService.getMessages({ ownerId: OWNER, conversationId: conversation.id });
        expect(stored.map(m => m.personaName)).toEqual([null, 'First', 'Second']);
    });

    test('a failed generation reports an error message and the turn survives', async () => {
        const a = makePersona({ name: 'Broken' });
        const b = makePersona({ name: 'Fine' });
        const conversation = parlorService.createConversation({ ownerId: OWNER, personaIds: [a.id, b.id] });
        mockAi.chat
            .mockRejectedValueOnce(new Error('provider exploded'))
            .mockResolvedValueOnce({ content: 'Still here.', toolCalls: [] });

        const messages = [];
        const turn = parlorService.startTurn({
            ownerId: OWNER, ownerName: 'Rob',
            conversationId: conversation.id, message: 'Hello?'
        });
        await turn.run({ onPersonaMessage: (m) => messages.push(m) });

        expect(messages).toHaveLength(2);
        expect(messages[0].isError).toBe(true);
        expect(messages[0].content).toContain('provider exploded');
        expect(messages[1].content).toBe('Still here.');
        // The failed reply is not persisted; the good one is.
        const stored = parlorService.getMessages({ ownerId: OWNER, conversationId: conversation.id });
        expect(stored.filter(m => m.role === 'persona')).toHaveLength(1);
    });

    test('one turn in flight per user; empty and oversized messages rejected', async () => {
        const persona = makePersona();
        const conversation = parlorService.createConversation({ ownerId: OWNER, personaIds: [persona.id] });

        expectParlorError(() => parlorService.startTurn({
            ownerId: OWNER, ownerName: 'Rob', conversationId: conversation.id, message: '  '
        }), 'EMPTY_MESSAGE');
        expectParlorError(() => parlorService.startTurn({
            ownerId: OWNER, ownerName: 'Rob', conversationId: conversation.id,
            message: 'x'.repeat(8001)
        }), 'MESSAGE_TOO_LONG');

        const turn = parlorService.startTurn({
            ownerId: OWNER, ownerName: 'Rob', conversationId: conversation.id, message: 'hi'
        });
        expectParlorError(() => parlorService.startTurn({
            ownerId: OWNER, ownerName: 'Rob', conversationId: conversation.id, message: 'again'
        }), 'TURN_IN_FLIGHT', 409);
        await turn.run();
    });

    test('write-back legalization: caps, duplicate titles, malformed JSON', async () => {
        const persona = makePersona({ name: 'Keeper' });
        parlorService.createNote({
            ownerId: OWNER, personaId: persona.id, title: 'Existing note', content: 'x'
        });
        const conversation = parlorService.createConversation({ ownerId: OWNER, personaIds: [persona.id] });

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
        const turn = parlorService.startTurn({
            ownerId: OWNER, ownerName: 'Rob', conversationId: conversation.id, message: 'Teach me.'
        });
        await turn.run({ onLearned: (l) => learned.push(l) });

        // Only the fresh, in-cap note landed
        expect(learned).toHaveLength(1);
        expect(learned[0].notes.map(n => n.title)).toEqual(['Fresh insight']);

        // Malformed JSON never throws
        mockAi.generateText.mockResolvedValue('not json at all');
        const turn2 = parlorService.startTurn({
            ownerId: OWNER, ownerName: 'Rob', conversationId: conversation.id, message: 'More.'
        });
        await expect(turn2.run()).resolves.toBeUndefined();
    });
});

describe('tag suggestions', () => {
    test('legalizes model output and degrades to empty without a provider', async () => {
        const persona = makePersona();
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

describe('privacy (/forget-me)', () => {
    test('erasure deletes the whole parlor and the audit proves it', async () => {
        const persona = makePersona();
        parlorService.createNote({
            ownerId: OWNER, personaId: persona.id, title: 'Note', content: 'x', tags: ['tag']
        });
        const conversation = parlorService.createConversation({ ownerId: OWNER, personaIds: [persona.id] });
        db.run(
            `INSERT INTO parlor_messages (conversationId, role, content) VALUES (@id, 'user', 'hello')`,
            { id: conversation.id }
        );
        // Another user's parlor must survive
        const otherPersona = parlorService.createPersona({
            ownerId: OTHER, name: 'Bystander', charter: 'Unrelated.'
        });

        const report = privacyService.buildUserReport({ guildId: 'dm:' + OWNER, userId: OWNER });
        expect(report.parlor).toEqual({ personas: 1, notes: 1, discussions: 1 });

        const counts = privacyService.forgetUser({ userId: OWNER });
        expect(counts.parlor).toBe(2); // 1 persona + 1 conversation (cascades)

        const audit = privacyService.auditUser({ userId: OWNER });
        expect(audit.byTable.parlor_personas).toBe(0);
        expect(audit.byTable.parlor_conversations).toBe(0);
        for (const table of ['parlor_notes', 'parlor_tags', 'parlor_note_tags', 'parlor_messages', 'parlor_participants']) {
            expect(db.get(`SELECT COUNT(*) AS c FROM ${table}`).c).toBe(0);
        }
        expect(parlorService.listPersonas(OTHER).map(p => p.id)).toEqual([otherPersona.id]);
    });
});
