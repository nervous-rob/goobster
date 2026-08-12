/**
 * The Parlor: a multi-persona AI workspace in the Goobster web app where
 * conversations become persistent, evolving knowledge.
 *
 * Model (Spitball's tag-first design):
 *  - Each persona a user creates has a private knowledge workspace of NOTES.
 *  - Notes never link to each other directly; TAGS create the relationships
 *    (notes sharing a tag are connected), which keeps the graph emergent and
 *    maintainable instead of a hand-curated web of links.
 *  - Users seed and edit that knowledge directly; personas also extract new
 *    notes from conversations (the write-back step below).
 *
 * Every parlor reply follows a fixed workflow so it is based on the
 * persona's CURRENT knowledge state, not only the immediate conversation:
 *  1. Retrieve - semantic search over the persona's notes (per-note
 *     embeddings, bounded brute-force cosine; keyword fallback when no
 *     embedding backend is available).
 *  2. Generate - the persona answers grounded in the retrieved notes; the
 *     note ids used are stored on the message (traceable context).
 *  3. Write back (ingest + link + index) - an ONLY-JSON extraction pass over
 *     the exchange proposes at most a couple of durable new notes;
 *     deterministic code legalizes them (length caps, per-persona caps,
 *     title dedupe, tag normalization) and the search index is updated by
 *     embedding the new notes. The model proposes, the service decides.
 *
 * Ownership: everything is keyed on the web user's Discord snowflake
 * (ownerId). All access checks live here, not in the routes. Errors use
 * ParlorError (HTTP status + machine-readable code, the PanelError
 * contract). Deleted outright by /forget-me (see privacyService).
 */

const db = require('../db');
const { dmScopeId } = require('../utils/dmScope');

const MAX_PERSONAS_PER_USER = 12;
const MAX_PERSONA_NAME_LENGTH = 48;
const MAX_CHARTER_LENGTH = 2000;
const MAX_EMOJI_LENGTH = 8;
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

const MAX_NOTES_PER_PERSONA = 500;
const MAX_NOTE_TITLE_LENGTH = 120;
const MAX_NOTE_CONTENT_LENGTH = 4000;
const MAX_TAGS_PER_PERSONA = 150;
const MAX_TAGS_PER_NOTE = 8;
const MAX_TAG_LENGTH = 40;

const MAX_PARTICIPANTS_PER_CONVERSATION = 4;
const MAX_MESSAGE_LENGTH = 8000;
const MAX_TITLE_LENGTH = 80;
const CONVERSATION_LIST_LIMIT = 100;
const MESSAGE_PAGE_LIMIT = 200;
const HISTORY_WINDOW = 30;

const RETRIEVAL_TOP_K = 6;
const RETRIEVAL_MIN_SCORE = 0.25;
const WRITEBACK_MAX_NOTES = 2;
const REPLY_MAX_TOKENS = 700;

// Messages shown to the should-respond gate (cheap, so a short tail)
const GATE_HISTORY_WINDOW = 10;

// Tools personas may use during a reply (the shared registry, curated):
// conversation-partner abilities only. Deliberately excluded: manageParlor
// (a persona rewiring the parlor mid-turn would break it), Goobster's own
// memory tools (personas have their own workspaces), and everything
// guild-/channel-/identity-bound (economy, music, tavern, integrations).
// runCode stays in the list but is filtered out automatically by
// getDefinitions when the sandbox is disabled.
const PERSONA_TOOL_NAMES = ['performSearch', 'generateImage', 'runCode', 'rollDice', 'stockQuote'];
// Sequential tool rounds per persona reply (voice-sized, not chat-sized:
// a multi-persona turn runs several loops back to back).
const PERSONA_MAX_TOOL_ROUNDS = 3;

const QUICKSTART_MAX_PROMPT_LENGTH = 2000;
const QUICKSTART_MIN_PERSONAS = 2;
const QUICKSTART_MAX_PERSONAS = 4;
const QUICKSTART_MAX_SEED_NOTES = 3;
// Server-side persona palette (mirrors the client's PERSONA_PALETTE)
const PERSONA_COLORS = [
    '#7c8cff', '#59d18c', '#ffb454', '#ff7ac8', '#54c2ff', '#b18aff', '#ffd166', '#8fe388'
];

const RATE_LIMIT_TURNS = 6;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

/** Machine-readable web app error (the PanelError contract). */
class ParlorError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = 'ParlorError';
        this.status = status;
        this.code = code;
    }
}

/** Float32Array -> BLOB and back (memoryService's storage convention). */
function vectorToBuffer(vector) {
    return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

function bufferToVector(buffer, dims) {
    const copy = Buffer.from(buffer);
    return new Float32Array(copy.buffer, copy.byteOffset, dims);
}

/** Lowercased word tokens (length >= 3) for the keyword fallback. */
function keywordTokens(text) {
    return new Set(
        String(text || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(t => t.length >= 3)
    );
}

/** First JSON object in a model response, or null (monologue pattern). */
function parseJsonObject(response) {
    const match = String(response || '').match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
        const parsed = JSON.parse(match[0]);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
        return null;
    }
}

/** Normalize one tag name: lowercase, collapsed whitespace, bounded. */
function cleanTagName(name) {
    return String(name || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, MAX_TAG_LENGTH);
}

/**
 * Named-parameter IN() list (the db layer binds @name params only).
 * @param {Array} values
 * @param {string} prefix
 * @returns {{ placeholders: string, params: Object }}
 */
function inList(values, prefix = 'in') {
    const params = {};
    const placeholders = values.map((value, index) => {
        params[`${prefix}${index}`] = value;
        return `@${prefix}${index}`;
    });
    return { placeholders: placeholders.join(','), params };
}

class ParlorService {
    constructor() {
        /** @type {Map<string, { aborted: boolean, abort: () => void }>} in-flight turn per user */
        this._activeTurns = new Map();
        /** @type {Map<string, number[]>} ownerId -> recent turn timestamps (transient, re-derivable) */
        this._recentTurns = new Map();
    }

    get maxInputLength() {
        return MAX_MESSAGE_LENGTH;
    }

    // --- Personas -------------------------------------------------------

    /**
     * The user's personas with workspace counts, newest first.
     * @param {string} ownerId
     */
    listPersonas(ownerId) {
        return db.all(
            `SELECT p.id, p.name, p.emoji, p.color, p.charter, p.createdAt, p.updatedAt,
                    (SELECT COUNT(*) FROM parlor_notes n WHERE n.personaId = p.id) AS noteCount,
                    (SELECT COUNT(*) FROM parlor_tags t WHERE t.personaId = p.id) AS tagCount
             FROM parlor_personas p
             WHERE p.ownerId = @ownerId
             ORDER BY p.id ASC`,
            { ownerId }
        );
    }

    /** Validate persona fields shared by create/update. */
    _cleanPersonaFields({ name, emoji, color, charter }, { partial = false } = {}) {
        const out = {};
        if (!partial || name !== undefined) {
            out.name = String(name ?? '').trim().slice(0, MAX_PERSONA_NAME_LENGTH);
            if (!out.name) throw new ParlorError(400, 'BAD_NAME', 'Persona name cannot be empty.');
        }
        if (!partial || charter !== undefined) {
            out.charter = String(charter ?? '').trim().slice(0, MAX_CHARTER_LENGTH);
            if (!out.charter) {
                throw new ParlorError(400, 'BAD_CHARTER',
                    'Every persona needs a charter - who it is and how it thinks.');
            }
        }
        if (emoji !== undefined) {
            out.emoji = String(emoji ?? '').trim().slice(0, MAX_EMOJI_LENGTH) || null;
        }
        if (color !== undefined) {
            const clean = String(color ?? '').trim();
            if (clean && !COLOR_PATTERN.test(clean)) {
                throw new ParlorError(400, 'BAD_COLOR', 'Color must be a #rrggbb hex value.');
            }
            out.color = clean || null;
        }
        return out;
    }

    /**
     * Create a persona.
     * @param {Object} params - { ownerId, name, emoji, color, charter }
     */
    createPersona({ ownerId, name, emoji, color, charter }) {
        const fields = this._cleanPersonaFields({ name, emoji: emoji ?? null, color: color ?? null, charter });
        const count = db.get(
            'SELECT COUNT(*) AS c FROM parlor_personas WHERE ownerId = @ownerId', { ownerId }
        ).c;
        if (count >= MAX_PERSONAS_PER_USER) {
            throw new ParlorError(400, 'PERSONA_CAP',
                `At most ${MAX_PERSONAS_PER_USER} personas per user - retire one first.`);
        }
        try {
            const row = db.get(
                `INSERT INTO parlor_personas (ownerId, name, emoji, color, charter)
                 VALUES (@ownerId, @name, @emoji, @color, @charter)
                 RETURNING id, name, emoji, color, charter, createdAt, updatedAt`,
                { ownerId, ...fields }
            );
            return { ...row, noteCount: 0, tagCount: 0 };
        } catch (error) {
            if (String(error.message).includes('UNIQUE')) {
                throw new ParlorError(409, 'NAME_TAKEN', 'You already have a persona with that name.');
            }
            throw error;
        }
    }

    /** A persona the user owns, or a 404. */
    _requirePersona(ownerId, personaId) {
        const row = db.get(
            `SELECT id, name, emoji, color, charter FROM parlor_personas
             WHERE id = @personaId AND ownerId = @ownerId`,
            { personaId: Number(personaId), ownerId }
        );
        if (!row) throw new ParlorError(404, 'NO_SUCH_PERSONA', 'No such persona.');
        return row;
    }

    /**
     * Update persona fields (partial).
     * @param {Object} params - { ownerId, personaId, name?, emoji?, color?, charter? }
     */
    updatePersona({ ownerId, personaId, name, emoji, color, charter }) {
        const persona = this._requirePersona(ownerId, personaId);
        const fields = this._cleanPersonaFields({ name, emoji, color, charter }, { partial: true });
        if (Object.keys(fields).length === 0) {
            throw new ParlorError(400, 'NOTHING_TO_UPDATE', 'Nothing to update.');
        }
        const sets = Object.keys(fields).map(key => `${key} = @${key}`).join(', ');
        try {
            db.run(
                `UPDATE parlor_personas SET ${sets}, updatedAt = datetime('now') WHERE id = @id`,
                { ...fields, id: persona.id }
            );
        } catch (error) {
            if (String(error.message).includes('UNIQUE')) {
                throw new ParlorError(409, 'NAME_TAKEN', 'You already have a persona with that name.');
            }
            throw error;
        }
        return this._requirePersona(ownerId, persona.id);
    }

    /**
     * Delete a persona and its whole workspace (notes, tags, and
     * participant seats cascade; transcript attribution nulls, the
     * snapshotted personaName keeps old messages readable).
     * @param {Object} params - { ownerId, personaId }
     */
    deletePersona({ ownerId, personaId }) {
        const persona = this._requirePersona(ownerId, personaId);
        db.run('DELETE FROM parlor_personas WHERE id = @id', { id: persona.id });
        return { deleted: true };
    }

    // --- Notes ------------------------------------------------------------

    /** Tags per note for a set of note ids. @returns {Map<number, Array>} */
    _tagsForNotes(noteIds) {
        const map = new Map();
        if (noteIds.length === 0) return map;
        const { placeholders, params } = inList(noteIds);
        const rows = db.all(
            `SELECT nt.noteId, t.id, t.name
             FROM parlor_note_tags nt JOIN parlor_tags t ON t.id = nt.tagId
             WHERE nt.noteId IN (${placeholders})
             ORDER BY t.name`,
            params
        );
        for (const row of rows) {
            if (!map.has(row.noteId)) map.set(row.noteId, []);
            map.get(row.noteId).push({ id: row.id, name: row.name });
        }
        return map;
    }

    /**
     * Browse a persona's notes (optionally filtered by tag or keyword),
     * most recently updated first, each with its tags.
     * @param {Object} params - { ownerId, personaId, tagId?, q? }
     */
    listNotes({ ownerId, personaId, tagId = null, q = null }) {
        const persona = this._requirePersona(ownerId, personaId);
        const params = { personaId: persona.id, limit: MAX_NOTES_PER_PERSONA };
        let where = 'n.personaId = @personaId';
        if (tagId) {
            where += ' AND EXISTS (SELECT 1 FROM parlor_note_tags nt WHERE nt.noteId = n.id AND nt.tagId = @tagId)';
            params.tagId = Number(tagId);
        }
        if (q) {
            where += ' AND (n.title LIKE @q OR n.content LIKE @q)';
            params.q = `%${String(q).trim()}%`;
        }
        const notes = db.all(
            `SELECT n.id, n.title, n.content, n.source, n.sourceConversationId,
                    n.createdAt, n.updatedAt
             FROM parlor_notes n WHERE ${where}
             ORDER BY n.updatedAt DESC, n.id DESC LIMIT @limit`,
            params
        );
        const tags = this._tagsForNotes(notes.map(n => n.id));
        return notes.map(note => ({ ...note, tags: tags.get(note.id) || [] }));
    }

    /** A note the user owns (via its persona), or a 404. */
    _requireNote(ownerId, noteId) {
        const row = db.get(
            `SELECT n.id, n.personaId, n.title, n.content, n.source
             FROM parlor_notes n JOIN parlor_personas p ON p.id = n.personaId
             WHERE n.id = @noteId AND p.ownerId = @ownerId`,
            { noteId: Number(noteId), ownerId }
        );
        if (!row) throw new ParlorError(404, 'NO_SUCH_NOTE', 'No such note.');
        return row;
    }

    /** Validate note title/content. */
    _cleanNoteFields({ title, content }, { partial = false } = {}) {
        const out = {};
        if (!partial || title !== undefined) {
            out.title = String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE_TITLE_LENGTH);
            if (!out.title) throw new ParlorError(400, 'BAD_TITLE', 'Note title cannot be empty.');
        }
        if (!partial || content !== undefined) {
            out.content = String(content ?? '').trim().slice(0, MAX_NOTE_CONTENT_LENGTH);
            if (!out.content) throw new ParlorError(400, 'BAD_CONTENT', 'Note content cannot be empty.');
        }
        return out;
    }

    /**
     * Replace a note's tag links (inside the caller's transaction). Tag
     * rows are created as needed, bounded by the per-persona tag cap;
     * orphaned tags are pruned so the graph never accumulates dead nodes.
     * @param {number} personaId
     * @param {number} noteId
     * @param {string[]} tagNames
     */
    _setNoteTags(personaId, noteId, tagNames) {
        const cleaned = [...new Set(
            (Array.isArray(tagNames) ? tagNames : []).map(cleanTagName).filter(Boolean)
        )].slice(0, MAX_TAGS_PER_NOTE);

        db.run('DELETE FROM parlor_note_tags WHERE noteId = @noteId', { noteId });
        for (const name of cleaned) {
            let tag = db.get(
                'SELECT id FROM parlor_tags WHERE personaId = @personaId AND name = @name',
                { personaId, name }
            );
            if (!tag) {
                const count = db.get(
                    'SELECT COUNT(*) AS c FROM parlor_tags WHERE personaId = @personaId',
                    { personaId }
                ).c;
                if (count >= MAX_TAGS_PER_PERSONA) continue; // silently drop past the cap
                tag = db.get(
                    `INSERT INTO parlor_tags (personaId, name) VALUES (@personaId, @name)
                     RETURNING id`,
                    { personaId, name }
                );
            }
            db.run(
                'INSERT OR IGNORE INTO parlor_note_tags (noteId, tagId) VALUES (@noteId, @tagId)',
                { noteId, tagId: tag.id }
            );
        }
        db.run(
            `DELETE FROM parlor_tags WHERE personaId = @personaId
             AND id NOT IN (SELECT tagId FROM parlor_note_tags)`,
            { personaId }
        );
    }

    /**
     * Create a note in a persona's workspace. The embedding is computed
     * fire-and-forget (a note is usable for keyword retrieval immediately;
     * semantic search picks it up once the vector lands).
     * @param {Object} params - { ownerId, personaId, title, content, tags?, source?, sourceConversationId? }
     */
    createNote({ ownerId, personaId, title, content, tags = [], source = 'user', sourceConversationId = null }) {
        const persona = this._requirePersona(ownerId, personaId);
        const fields = this._cleanNoteFields({ title, content });
        const count = db.get(
            'SELECT COUNT(*) AS c FROM parlor_notes WHERE personaId = @personaId',
            { personaId: persona.id }
        ).c;
        if (count >= MAX_NOTES_PER_PERSONA) {
            throw new ParlorError(400, 'NOTE_CAP',
                `This workspace is full (${MAX_NOTES_PER_PERSONA} notes) - prune before adding more.`);
        }
        const note = db.transaction(() => {
            let row;
            try {
                row = db.get(
                    `INSERT INTO parlor_notes (personaId, title, content, source, sourceConversationId)
                     VALUES (@personaId, @title, @content, @source, @sourceConversationId)
                     RETURNING id, title, content, source, sourceConversationId, createdAt, updatedAt`,
                    {
                        personaId: persona.id,
                        ...fields,
                        source: source === 'conversation' ? 'conversation' : 'user',
                        sourceConversationId
                    }
                );
            } catch (error) {
                if (String(error.message).includes('UNIQUE')) {
                    throw new ParlorError(409, 'TITLE_TAKEN',
                        'This workspace already has a note with that title.');
                }
                throw error;
            }
            this._setNoteTags(persona.id, row.id, tags);
            return row;
        });
        this._embedNotes([note.id]);
        return { ...note, tags: this._tagsForNotes([note.id]).get(note.id) || [] };
    }

    /**
     * Edit a note (partial: title, content, and/or tags). Content edits
     * re-embed.
     * @param {Object} params - { ownerId, noteId, title?, content?, tags? }
     */
    updateNote({ ownerId, noteId, title, content, tags }) {
        const note = this._requireNote(ownerId, noteId);
        const fields = this._cleanNoteFields({ title, content }, { partial: true });
        if (Object.keys(fields).length === 0 && tags === undefined) {
            throw new ParlorError(400, 'NOTHING_TO_UPDATE', 'Nothing to update.');
        }
        db.transaction(() => {
            if (Object.keys(fields).length > 0) {
                const sets = Object.keys(fields).map(key => `${key} = @${key}`).join(', ');
                try {
                    db.run(
                        `UPDATE parlor_notes
                         SET ${sets}, updatedAt = datetime('now'),
                             embedding = NULL, dims = NULL, model = NULL
                         WHERE id = @id`,
                        { ...fields, id: note.id }
                    );
                } catch (error) {
                    if (String(error.message).includes('UNIQUE')) {
                        throw new ParlorError(409, 'TITLE_TAKEN',
                            'This workspace already has a note with that title.');
                    }
                    throw error;
                }
            }
            if (tags !== undefined) {
                this._setNoteTags(note.personaId, note.id, tags);
            }
        });
        this._embedNotes([note.id]);
        const updated = db.get(
            `SELECT id, title, content, source, sourceConversationId, createdAt, updatedAt
             FROM parlor_notes WHERE id = @id`,
            { id: note.id }
        );
        return { ...updated, tags: this._tagsForNotes([note.id]).get(note.id) || [] };
    }

    /**
     * Delete a note (tag links cascade; orphaned tags are pruned).
     * @param {Object} params - { ownerId, noteId }
     */
    deleteNote({ ownerId, noteId }) {
        const note = this._requireNote(ownerId, noteId);
        db.transaction(() => {
            db.run('DELETE FROM parlor_notes WHERE id = @id', { id: note.id });
            db.run(
                `DELETE FROM parlor_tags WHERE personaId = @personaId
                 AND id NOT IN (SELECT tagId FROM parlor_note_tags)`,
                { personaId: note.personaId }
            );
        });
        return { deleted: true };
    }

    /**
     * Compute and store embeddings for notes that lack one. Fire-and-forget
     * (never blocks or fails the write path - the memory-write rule); notes
     * remain reachable through the keyword fallback until the vector lands.
     * @param {number[]} noteIds
     */
    _embedNotes(noteIds) {
        (async () => {
            const embeddingService = require('./embeddingService');
            const { placeholders, params } = inList(noteIds);
            const rows = db.all(
                `SELECT id, title, content FROM parlor_notes
                 WHERE id IN (${placeholders}) AND embedding IS NULL`,
                params
            );
            if (rows.length === 0) return;
            const results = await embeddingService.embedBatch(
                rows.map(row => `${row.title}\n${row.content}`)
            );
            for (let i = 0; i < rows.length; i++) {
                const { vector, model } = results[i];
                db.run(
                    `UPDATE parlor_notes SET embedding = @embedding, dims = @dims, model = @model
                     WHERE id = @id`,
                    { embedding: vectorToBuffer(vector), dims: vector.length, model, id: rows[i].id }
                );
            }
        })().catch(() => { /* keyword fallback covers unembedded notes */ });
    }

    // --- Tags -------------------------------------------------------------

    /**
     * A persona's tags with note counts, busiest first.
     * @param {Object} params - { ownerId, personaId }
     */
    listTags({ ownerId, personaId }) {
        const persona = this._requirePersona(ownerId, personaId);
        return db.all(
            `SELECT t.id, t.name,
                    (SELECT COUNT(*) FROM parlor_note_tags nt WHERE nt.tagId = t.id) AS noteCount
             FROM parlor_tags t WHERE t.personaId = @personaId
             ORDER BY noteCount DESC, t.name ASC`,
            { personaId: persona.id }
        );
    }

    /**
     * Suggest tags for note text: existing workspace tags first (concept
     * reuse is the whole point of tag-first), new ones only when warranted.
     * Degrades to an empty list without an AI provider - never an error.
     * @param {Object} params - { ownerId, personaId, title, content }
     * @returns {Promise<string[]>}
     */
    async suggestTags({ ownerId, personaId, title, content }) {
        const persona = this._requirePersona(ownerId, personaId);
        const text = `${String(title || '')}\n${String(content || '')}`.trim();
        if (!text) return [];
        const existing = this.listTags({ ownerId, personaId: persona.id }).map(t => t.name);
        try {
            const aiService = require('./aiService');
            const response = await aiService.generateText(
                'Suggest 2-5 short concept tags for this note in a tag-first knowledge base. ' +
                'STRONGLY prefer reusing existing tags when they fit; invent a new tag only for a ' +
                'genuinely new concept. Tags are lowercase noun phrases, 1-3 words.\n\n' +
                `EXISTING TAGS: ${existing.length > 0 ? existing.join(', ') : '(none yet)'}\n\n` +
                `NOTE:\n${text.slice(0, 1500)}\n\n` +
                'Respond with ONLY JSON: {"tags": ["tag one", "tag two"]}',
                { max_tokens: 100, usageContext: { guildId: dmScopeId(ownerId), userId: ownerId } }
            );
            const parsed = parseJsonObject(response);
            const tags = Array.isArray(parsed?.tags) ? parsed.tags : [];
            return [...new Set(tags.map(cleanTagName).filter(Boolean))].slice(0, MAX_TAGS_PER_NOTE);
        } catch {
            return [];
        }
    }

    // --- The workspace graph ------------------------------------------------

    /**
     * The persona's knowledge graph for visualization: tag nodes sized by
     * how many notes share the concept, note nodes, and note->tag edges
     * (the tag-first rule: notes connect only through shared tags).
     * @param {Object} params - { ownerId, personaId }
     */
    getWorkspaceGraph({ ownerId, personaId }) {
        const persona = this._requirePersona(ownerId, personaId);
        const notes = db.all(
            `SELECT id, title, content, source, updatedAt FROM parlor_notes
             WHERE personaId = @personaId ORDER BY updatedAt DESC LIMIT @limit`,
            { personaId: persona.id, limit: MAX_NOTES_PER_PERSONA }
        );
        const tags = this.listTags({ ownerId, personaId: persona.id });
        const links = db.all(
            `SELECT nt.noteId, nt.tagId FROM parlor_note_tags nt
             JOIN parlor_notes n ON n.id = nt.noteId
             WHERE n.personaId = @personaId`,
            { personaId: persona.id }
        );

        const nodes = [
            ...tags.map(tag => ({
                id: `t${tag.id}`,
                type: 'tag',
                label: tag.name,
                content: `${tag.noteCount} note${tag.noteCount === 1 ? ' shares' : 's share'} this concept`,
                salience: Math.min(1, 0.45 + tag.noteCount * 0.08)
            })),
            ...notes.map(note => ({
                id: `n${note.id}`,
                type: 'note',
                label: note.title,
                content: note.content.slice(0, 400),
                source: note.source,
                salience: 0.35
            }))
        ];
        const noteIds = new Set(notes.map(n => n.id));
        const tagIds = new Set(tags.map(t => t.id));
        const edges = links
            .filter(l => noteIds.has(l.noteId) && tagIds.has(l.tagId))
            .map(l => ({ sourceId: `n${l.noteId}`, targetId: `t${l.tagId}`, relation: 'tagged', weight: 0.6 }));

        return { persona: { id: persona.id, name: persona.name }, nodes, edges };
    }

    // --- Retrieval ----------------------------------------------------------

    /**
     * Semantic search over one persona's workspace (embedding cosine when
     * available, keyword overlap otherwise). Public API for the workspace
     * search box; also the retrieval step of every parlor turn.
     * @param {Object} params - { ownerId, personaId, query, limit? }
     * @returns {Promise<Array<{id, title, content, tags, score}>>}
     */
    async searchNotes({ ownerId, personaId, query, limit = RETRIEVAL_TOP_K }) {
        const persona = this._requirePersona(ownerId, personaId);
        const text = String(query || '').trim();
        if (!text) return [];
        const bounded = Math.max(1, Math.min(Number(limit) || RETRIEVAL_TOP_K, 20));
        const notes = db.all(
            `SELECT id, title, content, embedding, dims, model, updatedAt
             FROM parlor_notes WHERE personaId = @personaId LIMIT @limit`,
            { personaId: persona.id, limit: MAX_NOTES_PER_PERSONA }
        );
        if (notes.length === 0) return [];
        const tagsByNote = this._tagsForNotes(notes.map(n => n.id));

        let scored;
        try {
            const embeddingService = require('./embeddingService');
            const { cosineSimilarity } = embeddingService;
            const { vector, model } = await embeddingService.embed(text.slice(0, 2000));
            scored = notes
                .filter(note => note.embedding && note.model === model && note.dims === vector.length)
                .map(note => ({
                    note,
                    score: cosineSimilarity(vector, bufferToVector(note.embedding, note.dims))
                }))
                .filter(entry => entry.score >= RETRIEVAL_MIN_SCORE);
        } catch {
            scored = null; // no embedding backend - keyword fallback below
        }

        if (!scored || scored.length === 0) {
            const queryTokens = keywordTokens(text);
            scored = notes.map(note => {
                const noteTokens = keywordTokens(
                    `${note.title} ${note.content} ${(tagsByNote.get(note.id) || []).map(t => t.name).join(' ')}`
                );
                let hits = 0;
                for (const token of queryTokens) if (noteTokens.has(token)) hits++;
                return { note, score: queryTokens.size > 0 ? hits / queryTokens.size : 0 };
            }).filter(entry => entry.score > 0);
        }

        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, bounded).map(({ note, score }) => ({
            id: note.id,
            title: note.title,
            content: note.content,
            tags: tagsByNote.get(note.id) || [],
            score: Math.round(score * 1000) / 1000
        }));
    }

    // --- Conversations --------------------------------------------------------

    /** Participant rows (persona summaries) for a set of conversations. */
    _participantsFor(conversationIds) {
        const map = new Map();
        if (conversationIds.length === 0) return map;
        const { placeholders, params } = inList(conversationIds);
        const rows = db.all(
            `SELECT pp.conversationId, p.id, p.name, p.emoji, p.color
             FROM parlor_participants pp JOIN parlor_personas p ON p.id = pp.personaId
             WHERE pp.conversationId IN (${placeholders})
             ORDER BY pp.joinedAt, p.id`,
            params
        );
        for (const row of rows) {
            if (!map.has(row.conversationId)) map.set(row.conversationId, []);
            map.get(row.conversationId).push({
                id: row.id, name: row.name, emoji: row.emoji, color: row.color
            });
        }
        return map;
    }

    /**
     * The user's parlor discussions, most recently active first.
     * @param {string} ownerId
     */
    listConversations(ownerId) {
        const rows = db.all(
            `SELECT c.id, c.title, c.createdAt, c.lastMessageAt,
                    (SELECT COUNT(*) FROM parlor_messages m WHERE m.conversationId = c.id) AS messageCount
             FROM parlor_conversations c
             WHERE c.ownerId = @ownerId
             ORDER BY COALESCE(c.lastMessageAt, c.createdAt) DESC, c.id DESC
             LIMIT @limit`,
            { ownerId, limit: CONVERSATION_LIST_LIMIT }
        );
        const participants = this._participantsFor(rows.map(r => r.id));
        return rows.map(row => ({ ...row, participants: participants.get(row.id) || [] }));
    }

    /**
     * Start a discussion with one or more personas.
     * @param {Object} params - { ownerId, personaIds }
     */
    createConversation({ ownerId, personaIds }) {
        const ids = [...new Set((Array.isArray(personaIds) ? personaIds : []).map(Number))];
        if (ids.length === 0) {
            throw new ParlorError(400, 'NO_PARTICIPANTS', 'Pick at least one persona for the discussion.');
        }
        if (ids.length > MAX_PARTICIPANTS_PER_CONVERSATION) {
            throw new ParlorError(400, 'TOO_MANY_PARTICIPANTS',
                `At most ${MAX_PARTICIPANTS_PER_CONVERSATION} personas per discussion.`);
        }
        const personas = ids.map(id => this._requirePersona(ownerId, id));
        const conversation = db.transaction(() => {
            const row = db.get(
                `INSERT INTO parlor_conversations (ownerId) VALUES (@ownerId)
                 RETURNING id, title, createdAt, lastMessageAt`,
                { ownerId }
            );
            for (const persona of personas) {
                db.run(
                    `INSERT INTO parlor_participants (conversationId, personaId)
                     VALUES (@conversationId, @personaId)`,
                    { conversationId: row.id, personaId: persona.id }
                );
            }
            return row;
        });
        return {
            ...conversation,
            messageCount: 0,
            participants: personas.map(p => ({ id: p.id, name: p.name, emoji: p.emoji, color: p.color }))
        };
    }

    /** A conversation the user owns, or a 404. */
    _requireConversation(ownerId, conversationId) {
        const row = db.get(
            `SELECT id, title FROM parlor_conversations
             WHERE id = @conversationId AND ownerId = @ownerId`,
            { conversationId: Number(conversationId), ownerId }
        );
        if (!row) throw new ParlorError(404, 'NO_SUCH_CONVERSATION', 'No such discussion.');
        return row;
    }

    /**
     * Rename a discussion.
     * @param {Object} params - { ownerId, conversationId, title }
     */
    renameConversation({ ownerId, conversationId, title }) {
        const clean = String(title ?? '').trim().slice(0, MAX_TITLE_LENGTH);
        if (!clean) throw new ParlorError(400, 'BAD_TITLE', 'Title cannot be empty.');
        const conversation = this._requireConversation(ownerId, conversationId);
        db.run('UPDATE parlor_conversations SET title = @clean WHERE id = @id',
            { clean, id: conversation.id });
        return { id: conversation.id, title: clean };
    }

    /**
     * Delete a discussion (messages and participant seats cascade). The
     * personas and everything they learned stay - knowledge outliving the
     * conversation is the point.
     * @param {Object} params - { ownerId, conversationId }
     */
    deleteConversation({ ownerId, conversationId }) {
        const conversation = this._requireConversation(ownerId, conversationId);
        db.run('DELETE FROM parlor_conversations WHERE id = @id', { id: conversation.id });
        return { deleted: true };
    }

    /**
     * Add or remove a persona seat on a discussion.
     * @param {Object} params - { ownerId, conversationId, personaId, present }
     */
    setParticipant({ ownerId, conversationId, personaId, present }) {
        const conversation = this._requireConversation(ownerId, conversationId);
        const persona = this._requirePersona(ownerId, personaId);
        if (present) {
            const count = db.get(
                'SELECT COUNT(*) AS c FROM parlor_participants WHERE conversationId = @id',
                { id: conversation.id }
            ).c;
            const already = db.get(
                `SELECT 1 AS ok FROM parlor_participants
                 WHERE conversationId = @conversationId AND personaId = @personaId`,
                { conversationId: conversation.id, personaId: persona.id }
            );
            if (!already && count >= MAX_PARTICIPANTS_PER_CONVERSATION) {
                throw new ParlorError(400, 'TOO_MANY_PARTICIPANTS',
                    `At most ${MAX_PARTICIPANTS_PER_CONVERSATION} personas per discussion.`);
            }
            db.run(
                `INSERT OR IGNORE INTO parlor_participants (conversationId, personaId)
                 VALUES (@conversationId, @personaId)`,
                { conversationId: conversation.id, personaId: persona.id }
            );
        } else {
            db.run(
                `DELETE FROM parlor_participants
                 WHERE conversationId = @conversationId AND personaId = @personaId`,
                { conversationId: conversation.id, personaId: persona.id }
            );
        }
        return {
            participants: this._participantsFor([conversation.id]).get(conversation.id) || []
        };
    }

    /**
     * Transcript page, oldest first. Persona messages carry their grounding
     * (the notes retrieved before generation) as resolvable references.
     * @param {Object} params - { ownerId, conversationId, limit?, beforeId? }
     */
    getMessages({ ownerId, conversationId, limit = MESSAGE_PAGE_LIMIT, beforeId = null }) {
        const conversation = this._requireConversation(ownerId, conversationId);
        const bounded = Math.max(1, Math.min(Number(limit) || MESSAGE_PAGE_LIMIT, MESSAGE_PAGE_LIMIT));
        const params = { conversationId: conversation.id, limit: bounded };
        if (beforeId) params.beforeId = Number(beforeId);
        const rows = db.all(
            `SELECT id, role, personaId, personaName, content, contextNoteIds, attachments, createdAt
             FROM parlor_messages
             WHERE conversationId = @conversationId ${beforeId ? 'AND id < @beforeId' : ''}
             ORDER BY id DESC LIMIT @limit`,
            params
        );
        rows.reverse();
        // Resolve grounding note refs in one pass (deleted notes drop out)
        const allNoteIds = new Set();
        for (const row of rows) {
            for (const id of this._parseNoteIds(row.contextNoteIds)) allNoteIds.add(id);
        }
        const noteTitles = new Map();
        if (allNoteIds.size > 0) {
            const { placeholders, params } = inList([...allNoteIds]);
            const noteRows = db.all(
                `SELECT n.id, n.title FROM parlor_notes n
                 JOIN parlor_personas p ON p.id = n.personaId
                 WHERE p.ownerId = @ownerId AND n.id IN (${placeholders})`,
                { ownerId, ...params }
            );
            for (const note of noteRows) noteTitles.set(note.id, note.title);
        }
        return rows.map(row => ({
            id: row.id,
            role: row.role,
            personaId: row.personaId,
            personaName: row.personaName,
            content: row.content,
            createdAt: row.createdAt,
            grounding: this._parseNoteIds(row.contextNoteIds)
                .filter(id => noteTitles.has(id))
                .map(id => ({ id, title: noteTitles.get(id) })),
            attachments: this._serveAttachments(row.attachments, ownerId)
        }));
    }

    _parseNoteIds(json) {
        if (!json) return [];
        try {
            const parsed = JSON.parse(json);
            return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isFinite) : [];
        } catch {
            return [];
        }
    }

    // --- Quickstart -------------------------------------------------------------

    /**
     * Bootstrap a whole salon from one prompt: an AI concierge designs a
     * small cast of personas (with charters and seed notes) for the topic,
     * deterministic code legalizes and creates everything through the
     * normal CRUD paths (all caps and dedupe rules apply), and a discussion
     * is opened with the new cast. The model proposes, the service decides.
     * @param {Object} params - { ownerId, prompt }
     * @returns {Promise<{conversation: Object, personas: Array, seededNotes: number, opening: string|null}>}
     */
    async quickstart({ ownerId, prompt }) {
        const topic = String(prompt ?? '').trim();
        if (!topic) {
            throw new ParlorError(400, 'EMPTY_PROMPT', 'Tell the concierge what the salon should be about.');
        }
        if (topic.length > QUICKSTART_MAX_PROMPT_LENGTH) {
            throw new ParlorError(400, 'PROMPT_TOO_LONG',
                `Keep the brief under ${QUICKSTART_MAX_PROMPT_LENGTH} characters.`);
        }
        const existing = this.listPersonas(ownerId);
        const remaining = MAX_PERSONAS_PER_USER - existing.length;
        if (remaining < QUICKSTART_MIN_PERSONAS) {
            throw new ParlorError(400, 'PERSONA_CAP',
                'Not enough room for a new cast - retire some personas first.');
        }

        let design;
        try {
            const aiService = require('./aiService');
            const response = await aiService.generateText(
                'You are the concierge of Goobster\'s Parlor, a salon where a user discusses ideas with a ' +
                'small cast of AI personas, each keeping its own private knowledge workspace. The user wants ' +
                `a salon about:\n\n"${topic}"\n\n` +
                `Design ${QUICKSTART_MIN_PERSONAS}-${Math.min(QUICKSTART_MAX_PERSONAS, remaining)} personas with genuinely DIFFERENT ways of thinking about this ` +
                '(different disciplines, temperaments, or stakes - disagreement is the point). For each:\n' +
                '- "name": short and evocative (a role, archetype, or plausible human name)\n' +
                '- "emoji": one fitting emoji\n' +
                '- "charter": 2-4 sentences in second person ("You are...") - who they are, how they think, what they care about\n' +
                `- "notes": 1-${QUICKSTART_MAX_SEED_NOTES} seed notes of starting knowledge or stance for the topic ` +
                '(each: a short unique "title", 1-3 sentence "content", and 1-4 lowercase concept "tags"; reuse tags across notes and personas where concepts overlap)\n' +
                'Also give the discussion a short "title" (3-6 words) and an "opening": a first message the user could send to kick things off.\n' +
                (existing.length > 0
                    ? `Persona names already taken (do not reuse): ${existing.map(p => p.name).join(', ')}\n`
                    : '') +
                'Respond with ONLY JSON in exactly this shape:\n' +
                '{"title": "...", "opening": "...", "personas": [{"name": "...", "emoji": "...", "charter": "...", ' +
                '"notes": [{"title": "...", "content": "...", "tags": ["..."]}]}]}',
                { max_tokens: 1800, usageContext: { guildId: dmScopeId(ownerId), userId: ownerId } }
            );
            design = parseJsonObject(response);
        } catch (error) {
            throw new ParlorError(503, 'QUICKSTART_UNAVAILABLE',
                `The concierge couldn't draft a salon (${error.message}). You can still create personas by hand.`);
        }
        const proposals = Array.isArray(design?.personas) ? design.personas : [];
        if (proposals.length === 0) {
            throw new ParlorError(502, 'BAD_DESIGN',
                'The concierge came back empty-handed - try rephrasing the brief.');
        }

        // Legalize + create through the normal paths (caps, dedupe, tag
        // normalization, and embedding indexing all apply automatically).
        const created = [];
        let seededNotes = 0;
        for (const raw of proposals.slice(0, Math.min(QUICKSTART_MAX_PERSONAS, remaining))) {
            let persona;
            try {
                persona = this.createPersona({
                    ownerId,
                    name: raw?.name,
                    emoji: raw?.emoji,
                    color: PERSONA_COLORS[(existing.length + created.length) % PERSONA_COLORS.length],
                    charter: raw?.charter
                });
            } catch {
                continue; // bad fields or duplicate name - skip this proposal
            }
            created.push(persona);
            for (const note of (Array.isArray(raw?.notes) ? raw.notes : []).slice(0, QUICKSTART_MAX_SEED_NOTES)) {
                try {
                    this.createNote({
                        ownerId,
                        personaId: persona.id,
                        title: note?.title,
                        content: note?.content,
                        tags: Array.isArray(note?.tags) ? note.tags : []
                    });
                    seededNotes++;
                } catch {
                    // duplicate title or empty fields - skip quietly
                }
            }
        }
        if (created.length === 0) {
            throw new ParlorError(502, 'BAD_DESIGN',
                'None of the proposed personas were usable - try rephrasing the brief.');
        }

        const conversation = this.createConversation({
            ownerId,
            personaIds: created.map(p => p.id)
        });
        const title = String(design?.title || '').replace(/["\n]/g, '').trim().slice(0, MAX_TITLE_LENGTH);
        if (title) {
            this.renameConversation({ ownerId, conversationId: conversation.id, title });
            conversation.title = title;
        }
        const opening = String(design?.opening || '').trim().slice(0, MAX_MESSAGE_LENGTH) || null;

        return {
            conversation,
            personas: this.listPersonas(ownerId).filter(p => created.some(c => c.id === p.id)),
            seededNotes,
            opening
        };
    }

    // --- The turn -------------------------------------------------------------

    /** Sliding-window rate limit; throws 429 when exceeded. */
    _checkRateLimit(ownerId) {
        const now = Date.now();
        const stamps = (this._recentTurns.get(ownerId) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
        if (stamps.length >= RATE_LIMIT_TURNS) {
            throw new ParlorError(429, 'RATE_LIMITED',
                `Slow down - at most ${RATE_LIMIT_TURNS} parlor turns per minute.`);
        }
        stamps.push(now);
        this._recentTurns.set(ownerId, stamps);
    }

    /**
     * Request that the user's in-flight parlor turn stop (checked between
     * personas and between workflow steps; the current generation finishes).
     * @param {string} ownerId
     * @returns {boolean} whether a turn was active
     */
    stopTurn(ownerId) {
        const active = this._activeTurns.get(ownerId);
        if (!active) return false;
        active.abort();
        return true;
    }

    /**
     * Fire-and-forget discussion titling (webChatService's pattern): cheap
     * fallback immediately, model-written replacement when available.
     */
    _autoTitle({ conversationId, ownerId, userMessage }) {
        const fallback = userMessage.replace(/\s+/g, ' ').trim().slice(0, 48)
            + (userMessage.length > 48 ? '…' : '');
        db.run(
            'UPDATE parlor_conversations SET title = @fallback WHERE id = @id AND title IS NULL',
            { fallback, id: conversationId }
        );
        (async () => {
            const aiService = require('./aiService');
            const title = await aiService.generateText(
                'Write a very short title (3-5 words, no quotes, no trailing punctuation) for a ' +
                `discussion that starts with this message:\n\n${userMessage.slice(0, 500)}`,
                { max_tokens: 16, usageContext: { guildId: dmScopeId(ownerId), userId: ownerId } }
            );
            const clean = String(title || '').replace(/["\n]/g, '').trim().slice(0, MAX_TITLE_LENGTH);
            if (clean) {
                db.run('UPDATE parlor_conversations SET title = @clean WHERE id = @id',
                    { clean, id: conversationId });
            }
        })().catch(() => { /* fallback title already in place */ });
    }

    /**
     * Validate and reserve one parlor turn: store the user message, then
     * run every participating persona's respond workflow in seat order.
     * Validation errors throw synchronously (before any SSE stream starts).
     *
     * run(events) fires:
     *  - onUserMessage(message)             the stored user message
     *  - onPersonaStart(persona)            a persona began its workflow
     *  - onPersonaPass({ personaName, reason })  the gate decided to stay quiet
     *  - onDelta(text)                      streamed token delta (current persona)
     *  - onPersonaTool({ tools })           a tool round began (draft resets)
     *  - onPersonaMessage(message)          a completed persona reply (with grounding)
     *  - onLearned({ personaId, notes })    the write-back filed new notes
     *
     * The user never gets silence: when every participant's gate declines,
     * the first participant is re-run forced.
     *
     * @param {Object} params - { ownerId, ownerName, conversationId, message }
     * @returns {{ run: (events?: Object) => Promise<void>, abort: () => void, conversationId: number }}
     */
    startTurn({ ownerId, ownerName, conversationId, message }) {
        const text = String(message ?? '').trim();
        if (!text) throw new ParlorError(400, 'EMPTY_MESSAGE', 'Message cannot be empty.');
        if (text.length > MAX_MESSAGE_LENGTH) {
            throw new ParlorError(400, 'MESSAGE_TOO_LONG',
                `Message is too long (max ${MAX_MESSAGE_LENGTH} characters).`);
        }
        const conversation = this._requireConversation(ownerId, conversationId);
        const participants = this._participantsFor([conversation.id]).get(conversation.id) || [];
        if (participants.length === 0) {
            throw new ParlorError(400, 'NO_PARTICIPANTS',
                'This discussion has no personas - add one first.');
        }
        if (this._activeTurns.has(ownerId)) {
            throw new ParlorError(409, 'TURN_IN_FLIGHT',
                'The parlor is already thinking - wait for the current turn to finish.');
        }
        this._checkRateLimit(ownerId);

        const turnState = { aborted: false, abort: () => { turnState.aborted = true; } };
        this._activeTurns.set(ownerId, turnState);
        const service = this;

        return {
            conversationId: conversation.id,
            abort: turnState.abort,
            run: async (events = {}) => {
                try {
                    const userMessage = db.get(
                        `INSERT INTO parlor_messages (conversationId, role, content)
                         VALUES (@conversationId, 'user', @content)
                         RETURNING id, role, content, createdAt`,
                        { conversationId: conversation.id, content: text }
                    );
                    db.run(
                        `UPDATE parlor_conversations SET lastMessageAt = datetime('now') WHERE id = @id`,
                        { id: conversation.id }
                    );
                    if (!conversation.title) {
                        this._autoTitle({ conversationId: conversation.id, ownerId, userMessage: text });
                    }
                    try { events.onUserMessage?.({ ...userMessage, grounding: [] }); } catch { /* never break the turn */ }

                    const repliedIds = new Set();
                    let anySpoke = false;
                    for (const participant of participants) {
                        if (turnState.aborted) break;
                        const outcome = await service._runPersonaTurn({
                            ownerId, ownerName,
                            conversationId: conversation.id,
                            personaId: participant.id,
                            turnState, events, repliedIds
                        });
                        if (outcome !== 'passed') {
                            anySpoke = true;
                            repliedIds.add(participant.id);
                        }
                    }
                    // Everyone declined - somebody still owes the user an
                    // answer, so the first seat speaks anyway.
                    if (!anySpoke && !turnState.aborted) {
                        await service._runPersonaTurn({
                            ownerId, ownerName,
                            conversationId: conversation.id,
                            personaId: participants[0].id,
                            turnState, events, forced: true
                        });
                    }
                } finally {
                    this._activeTurns.delete(ownerId);
                }
            }
        };
    }

    /**
     * Manually trigger ONE persona to respond right now - no new user
     * message, no should-respond gate, even if they just spoke. The lever
     * behind the participant-chip "speak" action (storytelling rounds,
     * long-form planning, "what does the skeptic think?").
     * @param {Object} params - { ownerId, ownerName, conversationId, personaId }
     * @returns {{ run: (events?: Object) => Promise<void>, abort: () => void, conversationId: number, persona: Object }}
     */
    startPersonaTurn({ ownerId, ownerName, conversationId, personaId }) {
        const conversation = this._requireConversation(ownerId, conversationId);
        const persona = this._requirePersona(ownerId, personaId);
        const seated = db.get(
            `SELECT 1 AS ok FROM parlor_participants
             WHERE conversationId = @conversationId AND personaId = @personaId`,
            { conversationId: conversation.id, personaId: persona.id }
        );
        if (!seated) {
            throw new ParlorError(400, 'NOT_SEATED',
                `${persona.name} is not part of this discussion - add them first.`);
        }
        if (this._activeTurns.has(ownerId)) {
            throw new ParlorError(409, 'TURN_IN_FLIGHT',
                'The parlor is already thinking - wait for the current turn to finish.');
        }
        this._checkRateLimit(ownerId);

        const turnState = { aborted: false, abort: () => { turnState.aborted = true; } };
        this._activeTurns.set(ownerId, turnState);
        const service = this;

        return {
            conversationId: conversation.id,
            persona: { id: persona.id, name: persona.name, emoji: persona.emoji, color: persona.color },
            abort: turnState.abort,
            run: async (events = {}) => {
                try {
                    await service._runPersonaTurn({
                        ownerId, ownerName,
                        conversationId: conversation.id,
                        personaId: persona.id,
                        turnState, events, forced: true
                    });
                } finally {
                    this._activeTurns.delete(ownerId);
                }
            }
        };
    }

    /** Whether text plainly addresses a persona by name (word-boundary). */
    _mentionsPersona(text, personaName) {
        const candidates = new Set([String(personaName || '').trim()]);
        // "Mara, SRE" is usually addressed as just "Mara"
        const firstWord = String(personaName || '').split(/[\s,]+/)[0];
        if (firstWord && firstWord.length >= 3) candidates.add(firstWord);
        for (const candidate of candidates) {
            if (!candidate) continue;
            const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            if (new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, 'iu').test(text)) {
                return true;
            }
        }
        return false;
    }

    /**
     * The should-respond gate: before generating, a cheap ONLY-JSON call
     * decides whether this persona has something genuinely worth saying
     * this turn (multi-persona salons shouldn't have everyone answer
     * everything). Deterministic pre-pass: a direct name-mention always
     * speaks. Legalization is deliberately permissive - only an explicit
     * `"respond": false` silences; a broken gate never mutes a persona.
     * @returns {Promise<{respond: boolean, reason: string|null}>}
     */
    async _shouldRespond({ ownerId, ownerName, persona, participants, history, repliedIds }) {
        const lastUser = [...history].reverse().find(m => m.role === 'user');
        if (lastUser && this._mentionsPersona(lastUser.content, persona.name)) {
            return { respond: true, reason: 'addressed directly' };
        }
        try {
            const aiService = require('./aiService');
            const tail = history.slice(-GATE_HISTORY_WINDOW).map(entry =>
                entry.role === 'user'
                    ? `[${ownerName || 'the user'}]: ${entry.content.slice(0, 400)}`
                    : `[${entry.personaName || 'persona'}]: ${entry.content.slice(0, 400)}`
            ).join('\n');
            const others = participants
                .filter(p => p.id !== persona.id)
                .map(p => `${p.name}${repliedIds.has(p.id) ? ' (already replied this turn)' : ''}`);

            const response = await aiService.generateText(
                `You decide whether the persona "${persona.name}" should speak next in a salon discussion.\n\n` +
                `THEIR CHARTER: ${persona.charter.slice(0, 500)}\n` +
                `OTHERS AT THE TABLE: ${others.join(', ') || '(nobody else)'}\n\n` +
                `RECENT DISCUSSION (newest last):\n${tail}\n\n` +
                `Should "${persona.name}" speak now? Speak when directly addressed, when the charter gives them ` +
                'something genuinely new to add, or when they would push back on what was just said. Stay quiet ' +
                'when the message is clearly aimed at someone else, when others already covered it, or when they ' +
                'would only agree and repeat.\n' +
                'Respond with ONLY JSON: {"respond": true|false, "reason": "<one short sentence>"}',
                { max_tokens: 60, usageContext: { guildId: dmScopeId(ownerId), userId: ownerId } }
            );
            const parsed = parseJsonObject(response);
            return {
                respond: parsed?.respond !== false,
                reason: String(parsed?.reason || '').trim().slice(0, 140) || null
            };
        } catch {
            return { respond: true, reason: null };
        }
    }

    /**
     * The interaction-context handed to tools during one persona reply:
     * identifies the requesting user, looks like a web channel (so the
     * sandbox's web scope applies), and captures tool file output
     * (generated images, sandbox charts) instead of sending to Discord.
     * @param {Object} params - { ownerId, ownerName, conversationId, collector }
     */
    _buildPersonaToolContext({ ownerId, ownerName, conversationId, collector }) {
        const channelId = `web:parlor:${ownerId}:${conversationId}`;
        return {
            guildId: null,
            guild: null,
            member: null,
            channelId,
            user: { id: ownerId, username: ownerName || `user_${ownerId}` },
            channel: {
                id: channelId,
                isThread: () => false,
                sendTyping: async () => {},
                send: async (payload) => {
                    for (const file of Array.isArray(payload?.files) ? payload.files : []) {
                        const filePath = typeof file === 'string' ? file : file?.attachment;
                        if (typeof filePath === 'string') collector.files.push(filePath);
                    }
                    return { id: `parlor-tool-${Date.now()}` };
                }
            }
        };
    }

    /**
     * Serve stored attachment paths through the web file registry (the
     * owner-bound authenticated /api/app/files route). Files that no
     * longer exist on disk drop out quietly.
     * @param {string|null} json - stored JSON array of file paths
     * @param {string} ownerId
     * @returns {Array<{url: string, name: string}>}
     */
    _serveAttachments(json, ownerId) {
        if (!json) return [];
        let paths;
        try {
            paths = JSON.parse(json);
        } catch {
            return [];
        }
        if (!Array.isArray(paths)) return [];
        const webChatService = require('./webChatService');
        const served = [];
        for (const filePath of paths) {
            if (typeof filePath !== 'string') continue;
            const registered = webChatService.registerFile(filePath, ownerId);
            if (registered) served.push(registered);
        }
        return served;
    }

    /**
     * One persona's respond workflow: consider (the should-respond gate,
     * unless forced) -> retrieve -> generate (through the shared bounded
     * agent loop, so personas can search the web, generate images, run
     * sandboxed code, etc. in character) -> write back.
     * A failure emits an error message event and moves on to the next
     * persona - one bad generation never kills the whole salon.
     * @returns {Promise<'replied'|'passed'|'error'>}
     */
    async _runPersonaTurn({ ownerId, ownerName, conversationId, personaId, turnState, events, forced = false, repliedIds = new Set() }) {
        const persona = this._requirePersona(ownerId, personaId);
        try { events.onPersonaStart?.({ id: persona.id, name: persona.name, emoji: persona.emoji, color: persona.color }); } catch { /* ignore */ }

        try {
            const history = db.all(
                `SELECT role, personaId, personaName, content FROM parlor_messages
                 WHERE conversationId = @conversationId
                 ORDER BY id DESC LIMIT @limit`,
                { conversationId, limit: HISTORY_WINDOW }
            ).reverse();
            const lastUser = [...history].reverse().find(m => m.role === 'user');

            // 0. Consider: in a group discussion, decide whether this persona
            //    actually has something to say (a solo persona, a manual
            //    nudge, and the everyone-declined fallback skip the gate).
            if (!forced) {
                const participants = this._participantsFor([conversationId]).get(conversationId) || [];
                if (participants.length > 1) {
                    const decision = await this._shouldRespond({
                        ownerId, ownerName, persona, participants, history, repliedIds
                    });
                    if (turnState.aborted) return 'passed';
                    if (!decision.respond) {
                        try {
                            events.onPersonaPass?.({
                                personaId: persona.id,
                                personaName: persona.name,
                                reason: decision.reason
                            });
                        } catch { /* ignore */ }
                        return 'passed';
                    }
                }
            }

            // 1. Retrieve: the persona's current knowledge state, relevant slice
            const retrieved = await this.searchNotes({
                ownerId, personaId: persona.id,
                query: lastUser ? lastUser.content : '',
                limit: RETRIEVAL_TOP_K
            });
            if (turnState.aborted) return 'passed';

            // 2. Generate through the shared agent loop (never a parallel
            //    tool loop), grounded in the retrieved notes. Native web
            //    search rides along when the provider supports it.
            const aiService = require('./aiService');
            const toolsRegistry = require('../utils/toolsRegistry');
            const { runAgentLoop } = require('../utils/chat/agentOrchestrator');
            const functionDefs = toolsRegistry.getDefinitions(PERSONA_TOOL_NAMES, { isWeb: true });
            const collector = { files: [] };
            const messages = this._buildPersonaMessages({
                persona, ownerName, history, retrieved, hasTools: functionDefs.length > 0
            });
            const result = await runAgentLoop({
                messages,
                chatOptions: {
                    max_tokens: REPLY_MAX_TOKENS,
                    webSearch: aiService.supportsNativeWebSearch(),
                    usageContext: { guildId: dmScopeId(ownerId), userId: ownerId }
                },
                functionDefs,
                interactionContext: this._buildPersonaToolContext({
                    ownerId, ownerName, conversationId, collector
                }),
                onDelta: (delta) => {
                    try { events.onDelta?.(delta); } catch { /* never break the turn */ }
                },
                onToolRound: (round, toolCalls) => {
                    // A tool round means the streamed preamble is superseded
                    // by the next model round - the client resets its draft.
                    try {
                        events.onPersonaTool?.({
                            personaId: persona.id,
                            tools: toolCalls.map(call => call.name)
                        });
                    } catch { /* never break the turn */ }
                },
                shouldAbort: () => turnState.aborted,
                maxToolRounds: PERSONA_MAX_TOOL_ROUNDS
            });
            // Models sometimes imitate the history's speaker labels; the
            // byline is the interface's job, so strip a self-label prefix.
            const escapedName = persona.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const content = String(result?.content || '')
                .replace(new RegExp(`^\\s*\\[?${escapedName}\\]?\\s*:\\s*`, 'i'), '')
                .trim();
            if (!content && collector.files.length === 0) {
                throw new Error('The provider returned an empty reply.');
            }

            const stored = db.get(
                `INSERT INTO parlor_messages (conversationId, role, personaId, personaName, content, contextNoteIds, attachments)
                 VALUES (@conversationId, 'persona', @personaId, @personaName, @content, @contextNoteIds, @attachments)
                 RETURNING id, role, personaId, personaName, content, createdAt`,
                {
                    conversationId,
                    personaId: persona.id,
                    personaName: persona.name,
                    content: content || '(see attachment)',
                    contextNoteIds: JSON.stringify(retrieved.map(n => n.id)),
                    attachments: collector.files.length > 0 ? JSON.stringify(collector.files) : null
                }
            );
            db.run(
                `UPDATE parlor_conversations SET lastMessageAt = datetime('now') WHERE id = @id`,
                { id: conversationId }
            );
            try {
                events.onPersonaMessage?.({
                    ...stored,
                    grounding: retrieved.map(n => ({ id: n.id, title: n.title })),
                    attachments: this._serveAttachments(
                        collector.files.length > 0 ? JSON.stringify(collector.files) : null, ownerId)
                });
            } catch { /* never break the turn */ }

            // 3. Write back: ingest durable knowledge from the exchange,
            //    link it through tags, and update the search index.
            if (!turnState.aborted) {
                const learned = await this._writeBack({
                    ownerId, persona, conversationId,
                    userText: lastUser ? lastUser.content : '',
                    replyText: content
                });
                if (learned.length > 0) {
                    try { events.onLearned?.({ personaId: persona.id, personaName: persona.name, notes: learned }); } catch { /* ignore */ }
                }
            }
        } catch (error) {
            try {
                events.onPersonaMessage?.({
                    id: null,
                    role: 'persona',
                    personaId: persona.id,
                    personaName: persona.name,
                    content: `${persona.name} couldn't gather their thoughts (${error.message}).`,
                    grounding: [],
                    isError: true
                });
            } catch { /* ignore */ }
        }
    }

    /**
     * Provider-contract messages for one persona reply: charter + workspace
     * context as the system prompt, the discussion window as user/assistant
     * turns (other speakers arrive as labeled user messages).
     */
    _buildPersonaMessages({ persona, ownerName, history, retrieved, hasTools = false }) {
        const workspaceBlock = retrieved.length > 0
            ? retrieved.map(note =>
                `[note #${note.id}] ${note.title}` +
                `${note.tags.length > 0 ? ` (tags: ${note.tags.map(t => t.name).join(', ')})` : ''}: ${note.content}`
            ).join('\n')
            : '(nothing relevant retrieved - your workspace does not cover this yet)';

        const system = [
            `You are "${persona.name}", one of the resident thinkers in Goobster's Parlor - a salon where a user converses with a small cast of personas, each keeping its own private knowledge workspace.`,
            '',
            'YOUR CHARTER (who you are and how you think - stay in character):',
            persona.charter,
            '',
            'YOUR KNOWLEDGE WORKSPACE (notes retrieved for this turn - your current knowledge state):',
            workspaceBlock,
            '',
            'RULES:',
            '- Ground your reply in the workspace notes when they are relevant, and refer to them naturally ("my notes on X say...").',
            '- When the workspace does not cover something, say so honestly instead of inventing notes.',
            '- Other personas may also reply in this discussion (their messages are labeled). Engage with what they said; disagree freely - distinct perspectives are the point of the parlor.',
            '- Write your reply directly - never prefix it with your own name or a [Name]: label (the interface already shows who is speaking).',
            '- Keep replies focused: a few short paragraphs at most. Markdown is supported.',
            '',
            'RENDERING (the parlor renders rich replies):',
            '- LaTeX math renders beautifully: use \\( ... \\) for inline math and \\[ ... \\] or $$ ... $$ for display math. Prefer LaTeX over ASCII art for any formula.',
            '- Mini-apps: a fenced ```html code block containing ONE complete, self-contained HTML document (all CSS and JS inline, no external network resources) renders as a live, interactive, sandboxed app right in the discussion. When the user asks you to build something visual, interactive, or playable - a demo, visualization, simulator, calculator, game, or mock-up - put the full document in such a block instead of describing it, attaching a file, or linking anywhere. The few-short-paragraphs rule does not apply to that code block.',
            ...(hasTools ? [
                '',
                'TOOLS: You can use the tools offered to you (web search, image generation, sandboxed code, and so on) whenever they genuinely help the discussion - look up current facts instead of guessing, chart the numbers you are arguing about, illustrate an idea. Use them THE WAY YOUR CHARTER WOULD: a researcher verifies sources and cites what the search found, an engineer runs the calculation, an artist paints the concept. Generated images and files are shown to the user automatically with your reply. Never mention tool names or internal mechanics - narrate what you did in character ("I went looking...", "I sketched it...").'
            ] : [])
        ].join('\n');

        const messages = [{ role: 'system', content: system }];
        for (const entry of history) {
            if (entry.role === 'persona' && entry.personaId === persona.id) {
                messages.push({ role: 'assistant', content: entry.content });
            } else if (entry.role === 'persona') {
                messages.push({
                    role: 'user',
                    content: `[${entry.personaName || 'another persona'}]: ${entry.content}`
                });
            } else {
                messages.push({
                    role: 'user',
                    content: `[${ownerName || 'the user'}]: ${entry.content}`
                });
            }
        }
        return messages;
    }

    /**
     * The write-back step: an ONLY-JSON extraction pass proposes durable
     * notes from the exchange; deterministic code legalizes and stores them
     * (source 'conversation'), links tags, and updates the search index.
     * Never throws - a failed write-back costs learning, not the reply.
     * @returns {Promise<Array<{id, title}>>} the notes actually created
     */
    async _writeBack({ ownerId, persona, conversationId, userText, replyText }) {
        let proposed;
        try {
            const aiService = require('./aiService');
            const existingTitles = db.all(
                `SELECT title FROM parlor_notes WHERE personaId = @personaId
                 ORDER BY updatedAt DESC LIMIT 60`,
                { personaId: persona.id }
            ).map(r => r.title);
            const existingTags = this.listTags({ ownerId, personaId: persona.id })
                .slice(0, 40).map(t => t.name);

            const response = await aiService.generateText(
                `You are the knowledge-keeper for the persona "${persona.name}" in a tag-first knowledge base. ` +
                `After the exchange below, extract at most ${WRITEBACK_MAX_NOTES} NEW durable notes worth keeping ` +
                'long-term: stable facts, decisions, preferences, or ideas - never chit-chat, never the reply itself. ' +
                'An empty list is usually the right answer. Never restate a note that already exists.\n\n' +
                `EXISTING NOTE TITLES: ${existingTitles.length > 0 ? existingTitles.join(' | ') : '(none)'}\n` +
                `EXISTING TAGS (prefer reusing): ${existingTags.length > 0 ? existingTags.join(', ') : '(none)'}\n\n` +
                `EXCHANGE:\n[user]: ${userText.slice(0, 2000)}\n[${persona.name}]: ${replyText.slice(0, 2000)}\n\n` +
                'Respond with ONLY JSON: {"notes": [{"title": "short unique title", "content": "1-3 sentences", "tags": ["concept"]}]}',
                { max_tokens: 400, usageContext: { guildId: dmScopeId(ownerId), userId: ownerId } }
            );
            const parsed = parseJsonObject(response);
            proposed = Array.isArray(parsed?.notes) ? parsed.notes : [];
        } catch {
            return [];
        }

        const created = [];
        for (const raw of proposed.slice(0, WRITEBACK_MAX_NOTES)) {
            try {
                const note = this.createNote({
                    ownerId,
                    personaId: persona.id,
                    title: raw?.title,
                    content: raw?.content,
                    tags: Array.isArray(raw?.tags) ? raw.tags : [],
                    source: 'conversation',
                    sourceConversationId: conversationId
                });
                created.push({ id: note.id, title: note.title });
            } catch {
                // duplicate title, cap reached, or empty fields - skip quietly
            }
        }
        return created;
    }
}

module.exports = new ParlorService();
module.exports.ParlorError = ParlorError;
