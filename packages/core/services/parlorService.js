/**
 * The Parlor: a multi-persona AI workspace in the Goobster web app where
 * conversations become persistent, evolving knowledge.
 *
 * Knowledge: each persona workspace is a knowledge-graph scope
 * (`guildId = dm:<ownerId>`, `scopeKey = PARLOR:<personaId>`) on the same
 * `kg_nodes` / `kg_edges` / `kg_tags` tables as Spitball. Notes are typed
 * nodes; tags cluster them; typed edges are first-class. The Map overlays
 * tag hubs the same way (`withTagLinks`). The Parlor is a different
 * workflow (retrieve → generate → write back), not a second graph model.
 *
 * Every parlor reply follows a fixed workflow so it is based on the
 * persona's CURRENT knowledge state, not only the immediate conversation:
 *  1. Retrieve - semantic search over the persona's notes (per-node
 *     embeddings on `kg_node_embeddings`, bounded brute-force cosine;
 *     keyword fallback when no embedding backend is available).
 *  2. Generate - the persona answers grounded in the retrieved notes; the
 *     note ids used are stored on the message (traceable context).
 *  3. Write back - an ONLY-JSON extraction pass proposes notes and optional
 *     typed links; notes file through createNote, links through the shared
 *     legalizer. The model proposes, the service decides.
 *
 * Ownership: everything is keyed on the web user's Discord snowflake
 * (ownerId). All access checks live here, not in the routes. Errors use
 * ParlorError (HTTP status + machine-readable code, the PanelError
 * contract). Deleted outright by /forget-me (see privacyService).
 *
 * Multi-user discussions: the owner can invite Discord friends into one of
 * their discussions (parlor_invites -> DM with accept/decline buttons, or
 * the invitee's web app invitation list -> parlor_members). Members read
 * the transcript, send messages, and nudge personas; the personas, their
 * workspaces, the seats, and the discussion itself stay the owner's (and
 * AI usage stays attributed to the owner's DM scope). 'user' messages
 * snapshot the speaker (userId/userName) so personas and transcripts can
 * tell members apart.
 */

const db = require('../db');
const { dmScopeId } = require('../utils/dmScope');
const { toGateway, isGatewayUnavailable } = require('../gateway');
const knowledgeGraphService = require('./knowledgeGraphService');
const kgConfig = require('../config/knowledgeGraphConfig');
const { withTagLinks } = require('../utils/graphFilter');

const MAX_PERSONAS_PER_USER = 12;
const MAX_PERSONA_NAME_LENGTH = 48;
const MAX_CHARTER_LENGTH = 2000;
const MAX_EMOJI_LENGTH = 8;
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

const MAX_NOTES_PER_PERSONA = kgConfig.MAX_NODES_PARLOR;
const MAX_NOTE_TITLE_LENGTH = kgConfig.MAX_LABEL_LENGTH;
const MAX_NOTE_CONTENT_LENGTH = kgConfig.MAX_CONTENT_LENGTH;
const MAX_TAGS_PER_NOTE = kgConfig.MAX_TAGS_PER_NODE;
const MAX_TAG_LENGTH = kgConfig.MAX_TAG_LENGTH;

const MAX_PARTICIPANTS_PER_CONVERSATION = 4;
// Humans per discussion, the owner included (multi-user parlors)
const MAX_MEMBERS_PER_CONVERSATION = 4;
const SNOWFLAKE_PATTERN = /^\d{5,20}$/;
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

function workspaceCoords(ownerId, personaId) {
    return {
        guildId: dmScopeId(ownerId),
        scopeKey: knowledgeGraphService.parlorScopeKey(personaId)
    };
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
        /**
         * @type {Map<number, { aborted: boolean, abort: () => void, startedBy: string }>}
         * In-flight turn per CONVERSATION (shared discussions must not run
         * two turns at once), remembering which user started it.
         */
        this._activeTurns = new Map();
    }

    get maxInputLength() {
        return MAX_MESSAGE_LENGTH;
    }

    // --- Personas -------------------------------------------------------

    /**
     * The user's personas with workspace counts, newest first.
     * @param {string} ownerId
     */
    async listPersonas(ownerId) {
        const guildId = dmScopeId(ownerId);
        return await db.all(
            `SELECT p.id, p.name, p.emoji, p.color, p.charter, p.voiceId, p.voiceName,
                    p.createdAt, p.updatedAt,
                    (SELECT COUNT(*) FROM kg_nodes n
                      WHERE n.guildId = @guildId AND n.scopeKey = ('PARLOR:' || p.id)) AS noteCount,
                    (SELECT COUNT(*) FROM kg_tags t
                      WHERE t.guildId = @guildId AND t.scopeKey = ('PARLOR:' || p.id)) AS tagCount
             FROM parlor_personas p
             WHERE p.ownerId = @ownerId
             ORDER BY p.id ASC`,
            { ownerId, guildId }
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
    async createPersona({ ownerId, name, emoji, color, charter }) {
        const fields = this._cleanPersonaFields({ name, emoji: emoji ?? null, color: color ?? null, charter });
        const count = (await db.get(
            'SELECT COUNT(*) AS c FROM parlor_personas WHERE ownerId = @ownerId', { ownerId }
        )).c;
        if (count >= MAX_PERSONAS_PER_USER) {
            throw new ParlorError(400, 'PERSONA_CAP',
                `At most ${MAX_PERSONAS_PER_USER} personas per user - retire one first.`);
        }
        try {
            const row = await db.get(
                `INSERT INTO parlor_personas (ownerId, name, emoji, color, charter)
                 VALUES (@ownerId, @name, @emoji, @color, @charter)
                 RETURNING id, name, emoji, color, charter, voiceId, voiceName, createdAt, updatedAt`,
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
    async _requirePersona(ownerId, personaId) {
        const row = await db.get(
            `SELECT id, name, emoji, color, charter, voiceId, voiceName FROM parlor_personas
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
    async updatePersona({ ownerId, personaId, name, emoji, color, charter }) {
        const persona = await this._requirePersona(ownerId, personaId);
        const fields = this._cleanPersonaFields({ name, emoji, color, charter }, { partial: true });
        if (Object.keys(fields).length === 0) {
            throw new ParlorError(400, 'NOTHING_TO_UPDATE', 'Nothing to update.');
        }
        const sets = Object.keys(fields).map(key => `${key} = @${key}`).join(', ');
        try {
            await db.run(
                `UPDATE parlor_personas SET ${sets}, updatedAt = datetime('now') WHERE id = @id`,
                { ...fields, id: persona.id }
            );
        } catch (error) {
            if (String(error.message).includes('UNIQUE')) {
                throw new ParlorError(409, 'NAME_TAKEN', 'You already have a persona with that name.');
            }
            throw error;
        }
        return await this._requirePersona(ownerId, persona.id);
    }

    /**
     * Delete a persona and its whole workspace (notes, tags, and
     * participant seats cascade; transcript attribution nulls, the
     * snapshotted personaName keeps old messages readable).
     * @param {Object} params - { ownerId, personaId }
     */
    async deletePersona({ ownerId, personaId }) {
        const persona = await this._requirePersona(ownerId, personaId);
        const { guildId, scopeKey } = workspaceCoords(ownerId, persona.id);
        await knowledgeGraphService.deleteScope({ guildId, scopeKey });
        await db.run('DELETE FROM parlor_personas WHERE id = @id', { id: persona.id });
        return { deleted: true };
    }

    /** The live shared ElevenLabs TTS service, when the bot has one (lazy -
     *  serviceManager boots the whole voice stack, so only touch it when a
     *  voice feature is actually used). */
    _ttsService() {
        try {
            const { voiceService } = require('./serviceManager');
            const tts = voiceService?.tts;
            return tts && !tts.disabled ? tts : null;
        } catch {
            return null;
        }
    }

    /**
     * Set (or clear) a persona's ElevenLabs voice for Parlor Live. The
     * voice is resolved through elevenLabsTTSService.resolveVoice at save
     * time - a misspelled name fails HERE, at edit time, never mid-session -
     * and both the id and the display name are stored (the name is a
     * snapshot for the picker UI).
     * @param {Object} params - { ownerId, personaId, voice, tts? }
     *   voice: a voice name or id; empty/null clears back to the default.
     *   tts: injectable TTS service for tests (defaults to the live one).
     * @returns {Promise<Object>} the updated persona
     */
    async setPersonaVoice({ ownerId, personaId, voice, tts = null }) {
        const persona = await this._requirePersona(ownerId, personaId);
        const query = String(voice ?? '').trim();

        let voiceId = null;
        let voiceName = null;
        if (query) {
            const service = tts || this._ttsService();
            if (!service) {
                throw new ParlorError(503, 'TTS_UNAVAILABLE',
                    'Persona voices need an ElevenLabs API key on this server.');
            }
            try {
                const resolved = await service.resolveVoice(query);
                voiceId = resolved.id;
                voiceName = resolved.name || query;
            } catch (error) {
                throw new ParlorError(400, 'BAD_VOICE', error.message);
            }
        }
        await db.run(
            `UPDATE parlor_personas SET voiceId = @voiceId, voiceName = @voiceName,
                    updatedAt = datetime('now') WHERE id = @id`,
            { voiceId, voiceName, id: persona.id }
        );
        return await this._requirePersona(ownerId, persona.id);
    }

    // --- Notes (kg_* scope PARLOR:<personaId>) ----------------------------

    async _workspace(ownerId, personaId) {
        const persona = await this._requirePersona(ownerId, personaId);
        await this._migratePersonaWorkspace(ownerId, persona);
        return { persona, ...workspaceCoords(ownerId, persona.id) };
    }

    /**
     * One-time copy of legacy parlor_notes into the shared graph.
     * Preserves ids so grounding chips on old messages still resolve.
     */
    async _migratePersonaWorkspace(ownerId, persona) {
        const { guildId, scopeKey } = workspaceCoords(ownerId, persona.id);
        const leftover = await db.get(
            'SELECT COUNT(*) AS c FROM parlor_notes WHERE personaId = @personaId',
            { personaId: persona.id }
        );
        if (!leftover?.c) return;
        const existing = await db.get(
            'SELECT COUNT(*) AS c FROM kg_nodes WHERE guildId = @guildId AND scopeKey = @scopeKey',
            { guildId, scopeKey }
        );
        if (existing?.c) {
            await db.run('DELETE FROM parlor_notes WHERE personaId = @personaId', { personaId: persona.id });
            return;
        }

        const notes = await db.all(
            `SELECT id, title, content, source, sourceConversationId, embedding, dims, model
             FROM parlor_notes WHERE personaId = @personaId ORDER BY id`,
            { personaId: persona.id }
        );
        const tagsByNote = new Map();
        if (notes.length) {
            const { placeholders, params } = inList(notes.map((n) => n.id));
            const rows = await db.all(
                `SELECT nt.noteId, t.name FROM parlor_note_tags nt
                 JOIN parlor_tags t ON t.id = nt.tagId
                 WHERE nt.noteId IN (${placeholders})`,
                params
            );
            for (const row of rows) {
                if (!tagsByNote.has(row.noteId)) tagsByNote.set(row.noteId, []);
                tagsByNote.get(row.noteId).push(row.name);
            }
        }

        for (const note of notes) {
            const clash = await knowledgeGraphService.getNode(guildId, note.title, scopeKey);
            let nodeId;
            if (clash) {
                nodeId = clash.id;
            } else {
                try {
                    await db.run(
                        `INSERT INTO kg_nodes (
                            id, guildId, scopeKey, type, label, content, source, subjectType, subjectId
                         ) VALUES (
                            @id, @guildId, @scopeKey, 'concept', @label, @content, @source, 'USER', @ownerId
                         )`,
                        {
                            id: note.id,
                            guildId,
                            scopeKey,
                            label: note.title,
                            content: note.content,
                            source: note.source === 'conversation' ? 'conversation' : 'user',
                            ownerId
                        }
                    );
                    nodeId = note.id;
                } catch {
                    const created = await knowledgeGraphService.upsertNode({
                        guildId,
                        scopeKey,
                        subjectType: 'USER',
                        subjectId: ownerId,
                        type: 'concept',
                        label: note.title,
                        content: note.content,
                        source: note.source === 'conversation' ? 'conversation' : 'user'
                    });
                    nodeId = created?.id;
                }
            }
            if (!nodeId) continue;
            const tags = tagsByNote.get(note.id) || [];
            if (tags.length) {
                await knowledgeGraphService.addTagsToNode({
                    guildId, scopeKey, label: note.title, tags
                });
            }
            if (note.sourceConversationId) {
                await knowledgeGraphService.addProvenance({
                    nodeId,
                    sourceKind: 'parlor_conversation',
                    sourceId: note.sourceConversationId
                });
            }
            if (note.embedding && note.dims && note.model) {
                await knowledgeGraphService.setNodeEmbedding({
                    nodeId,
                    embedding: note.embedding,
                    dims: note.dims,
                    model: note.model
                });
            }
        }
        await db.run('DELETE FROM parlor_notes WHERE personaId = @personaId', { personaId: persona.id });
    }

    _shapeParlorNote(node, tags = [], conversationId = null) {
        if (!node) return null;
        return {
            id: node.id,
            title: node.label,
            content: node.content || '',
            source: node.source === 'conversation' ? 'conversation' : 'user',
            sourceConversationId: conversationId,
            tags,
            createdAt: node.createdAt,
            updatedAt: node.updatedAt
        };
    }

    async _tagsForNotes(noteIds) {
        return knowledgeGraphService.getTagRecordsForNodes(noteIds);
    }

    async _conversationIdsForNotes(noteIds) {
        const map = new Map();
        if (!noteIds.length) return map;
        const provenance = await knowledgeGraphService._provenanceForNodes(noteIds);
        for (const [nodeId, rows] of provenance) {
            const hit = (rows || []).find((row) => row.sourceKind === 'parlor_conversation');
            if (hit) map.set(nodeId, hit.sourceId);
        }
        return map;
    }

    /**
     * Browse a persona's notes (optionally filtered by tag or keyword),
     * most recently updated first, each with its tags.
     * @param {Object} params - { ownerId, personaId, tagId?, q? }
     */
    async listNotes({ ownerId, personaId, tagId = null, q = null }) {
        const { guildId, scopeKey } = await this._workspace(ownerId, personaId);
        const params = { guildId, scopeKey, limit: MAX_NOTES_PER_PERSONA };
        let where = 'n.guildId = @guildId AND n.scopeKey = @scopeKey';
        if (tagId) {
            where += ' AND EXISTS (SELECT 1 FROM kg_node_tags nt WHERE nt.nodeId = n.id AND nt.tagId = @tagId)';
            params.tagId = Number(tagId);
        }
        if (q) {
            where += ' AND (n.label LIKE @q ESCAPE \'#\' OR n.content LIKE @q ESCAPE \'#\')';
            params.q = `%${String(q).trim().replace(/[#%_]/g, '#$&')}%`;
        }
        const notes = await db.all(
            `SELECT n.* FROM kg_nodes n WHERE ${where}
             ORDER BY n.updatedAt DESC, n.id DESC LIMIT @limit`,
            params
        );
        const tags = await this._tagsForNotes(notes.map((n) => n.id));
        const conversations = await this._conversationIdsForNotes(notes.map((n) => n.id));
        return notes.map((note) => this._shapeParlorNote(
            note,
            tags.get(note.id) || [],
            conversations.get(note.id) ?? null
        ));
    }

    /** A note the user owns (via its persona), or a 404. */
    async _requireNote(ownerId, noteId) {
        const node = await db.get('SELECT * FROM kg_nodes WHERE id = @id', { id: Number(noteId) });
        const prefix = 'PARLOR:';
        if (!node || node.guildId !== dmScopeId(ownerId) || !String(node.scopeKey).startsWith(prefix)) {
            throw new ParlorError(404, 'NO_SUCH_NOTE', 'No such note.');
        }
        const personaId = Number(String(node.scopeKey).slice(prefix.length));
        await this._requirePersona(ownerId, personaId);
        return { ...node, personaId, title: node.label };
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
     * Create a note in a persona's workspace. The embedding is computed
     * fire-and-forget (a note is usable for keyword retrieval immediately;
     * semantic search picks it up once the vector lands).
     * @param {Object} params - { ownerId, personaId, title, content, tags?, source?, sourceConversationId? }
     */
    async createNote({ ownerId, personaId, title, content, tags = [], source = 'user', sourceConversationId = null }) {
        const { guildId, scopeKey } = await this._workspace(ownerId, personaId);
        const fields = this._cleanNoteFields({ title, content });
        const count = (await db.get(
            'SELECT COUNT(*) AS c FROM kg_nodes WHERE guildId = @guildId AND scopeKey = @scopeKey',
            { guildId, scopeKey }
        )).c;
        if (count >= MAX_NOTES_PER_PERSONA) {
            throw new ParlorError(400, 'NOTE_CAP',
                `This workspace is full (${MAX_NOTES_PER_PERSONA} notes) - prune before adding more.`);
        }
        const clash = await knowledgeGraphService.getNode(guildId, fields.title, scopeKey);
        if (clash) {
            throw new ParlorError(409, 'TITLE_TAKEN',
                'This workspace already has a note with that title.');
        }
        const kgSource = source === 'conversation' ? 'conversation' : 'user';
        const created = await knowledgeGraphService.upsertNode({
            guildId,
            scopeKey,
            subjectType: 'USER',
            subjectId: ownerId,
            type: 'concept',
            label: fields.title,
            content: fields.content,
            source: kgSource
        });
        if (!created?.id) {
            throw new ParlorError(500, 'NOTE_WRITE_FAILED', 'Could not file that note.');
        }
        const cleanedTags = [...new Set(
            (Array.isArray(tags) ? tags : []).map(cleanTagName).filter(Boolean)
        )].slice(0, MAX_TAGS_PER_NOTE);
        if (cleanedTags.length) {
            await knowledgeGraphService.setTagsOnNode({
                guildId, scopeKey, label: fields.title, tags: cleanedTags
            });
        }
        if (sourceConversationId) {
            await knowledgeGraphService.addProvenance({
                nodeId: created.id,
                sourceKind: 'parlor_conversation',
                sourceId: Number(sourceConversationId)
            });
        }
        this._embedNotes([created.id]);
        const fresh = await db.get('SELECT * FROM kg_nodes WHERE id = @id', { id: created.id });
        const tagRows = (await this._tagsForNotes([created.id])).get(created.id) || [];
        return this._shapeParlorNote(fresh, tagRows, sourceConversationId || null);
    }

    /**
     * Edit a note (partial: title, content, and/or tags). Content edits
     * re-embed.
     * @param {Object} params - { ownerId, noteId, title?, content?, tags? }
     */
    async updateNote({ ownerId, noteId, title, content, tags }) {
        const note = await this._requireNote(ownerId, noteId);
        const fields = this._cleanNoteFields({ title, content }, { partial: true });
        if (Object.keys(fields).length === 0 && tags === undefined) {
            throw new ParlorError(400, 'NOTHING_TO_UPDATE', 'Nothing to update.');
        }
        const { guildId, scopeKey } = workspaceCoords(ownerId, note.personaId);
        const nextLabel = fields.title !== undefined ? fields.title : note.label;
        if (fields.title && fields.title.toLowerCase() !== String(note.label).toLowerCase()) {
            const clash = await knowledgeGraphService.getNode(guildId, fields.title, scopeKey);
            if (clash && clash.id !== note.id) {
                throw new ParlorError(409, 'TITLE_TAKEN',
                    'This workspace already has a note with that title.');
            }
        }
        const nextContent = fields.content !== undefined ? fields.content : note.content;
        await db.run(
            `UPDATE kg_nodes SET
                 label = @label, content = @content, updatedAt = CURRENT_TIMESTAMP
             WHERE id = @id`,
            { id: note.id, label: nextLabel, content: nextContent }
        );
        if (Array.isArray(tags)) {
            const cleanedTags = [...new Set(tags.map(cleanTagName).filter(Boolean))].slice(0, MAX_TAGS_PER_NOTE);
            await knowledgeGraphService.setTagsOnNode({
                guildId, scopeKey, label: nextLabel, tags: cleanedTags
            });
        }
        this._embedNotes([note.id]);
        const updated = await db.get('SELECT * FROM kg_nodes WHERE id = @id', { id: note.id });
        const tagRows = (await this._tagsForNotes([note.id])).get(note.id) || [];
        const conversations = await this._conversationIdsForNotes([note.id]);
        return this._shapeParlorNote(updated, tagRows, conversations.get(note.id) ?? null);
    }

    /**
     * Delete a note (tag links cascade; orphaned tags are pruned).
     * @param {Object} params - { ownerId, noteId }
     */
    async deleteNote({ ownerId, noteId }) {
        const note = await this._requireNote(ownerId, noteId);
        const { guildId, scopeKey } = workspaceCoords(ownerId, note.personaId);
        await db.run('DELETE FROM kg_nodes WHERE id = @id', { id: note.id });
        await db.run(
            `DELETE FROM kg_tags
             WHERE guildId = @guildId AND scopeKey = @scopeKey
               AND id NOT IN (SELECT tagId FROM kg_node_tags)`,
            { guildId, scopeKey }
        );
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
            const rows = await db.all(
                `SELECT n.id, n.label AS title, n.content
                 FROM kg_nodes n
                 LEFT JOIN kg_node_embeddings e ON e.nodeId = n.id
                 WHERE n.id IN (${placeholders}) AND e.nodeId IS NULL`,
                params
            );
            if (rows.length === 0) return;
            const results = await embeddingService.embedBatch(
                rows.map(row => `${row.title}\n${row.content}`)
            );
            for (let i = 0; i < rows.length; i++) {
                const { vector, model } = results[i];
                await knowledgeGraphService.setNodeEmbedding({
                    nodeId: rows[i].id,
                    embedding: vectorToBuffer(vector),
                    dims: vector.length,
                    model
                });
            }
        })().catch(() => { /* keyword fallback covers unembedded notes */ });
    }

    // --- Tags -------------------------------------------------------------

    /**
     * A persona's tags with note counts, busiest first.
     * @param {Object} params - { ownerId, personaId }
     */
    async listTags({ ownerId, personaId }) {
        const { guildId, scopeKey } = await this._workspace(ownerId, personaId);
        return knowledgeGraphService.listScopeTags({ guildId, scopeKey });
    }

    /**
     * Suggest tags for note text: existing workspace tags first (concept
     * reuse is the whole point of tag-first), new ones only when warranted.
     * Degrades to an empty list without an AI provider - never an error.
     * @param {Object} params - { ownerId, personaId, title, content }
     * @returns {Promise<string[]>}
     */
    async suggestTags({ ownerId, personaId, title, content }) {
        const persona = await this._requirePersona(ownerId, personaId);
        const text = `${String(title || '')}\n${String(content || '')}`.trim();
        if (!text) return [];
        const existing = (await this.listTags({ ownerId, personaId: persona.id })).map(t => t.name);
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
    async getWorkspaceGraph({ ownerId, personaId }) {
        const { persona, guildId, scopeKey } = await this._workspace(ownerId, personaId);
        const view = await knowledgeGraphService.getScopeGraphView({
            guildId,
            scopeKey,
            kind: 'parlor'
        });
        const graph = withTagLinks(view, true);
        return {
            persona: { id: persona.id, name: persona.name },
            nodes: graph.nodes,
            edges: graph.edges,
            counts: view.counts
        };
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
        const { guildId, scopeKey } = await this._workspace(ownerId, personaId);
        const text = String(query || '').trim();
        if (!text) return [];
        const bounded = Math.max(1, Math.min(Number(limit) || RETRIEVAL_TOP_K, 20));
        const notes = await db.all(
            `SELECT n.id, n.label AS title, n.content, e.embedding, e.dims, e.model, n.updatedAt
             FROM kg_nodes n
             LEFT JOIN kg_node_embeddings e ON e.nodeId = n.id
             WHERE n.guildId = @guildId AND n.scopeKey = @scopeKey
             LIMIT @limit`,
            { guildId, scopeKey, limit: MAX_NOTES_PER_PERSONA }
        );
        if (notes.length === 0) return [];
        const tagsByNote = await this._tagsForNotes(notes.map((n) => n.id));

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
    async _participantsFor(conversationIds) {
        const map = new Map();
        if (conversationIds.length === 0) return map;
        const { placeholders, params } = inList(conversationIds);
        const rows = await db.all(
            `SELECT pp.conversationId, p.id, p.name, p.emoji, p.color, p.voiceId
             FROM parlor_participants pp JOIN parlor_personas p ON p.id = pp.personaId
             WHERE pp.conversationId IN (${placeholders})
             ORDER BY pp.joinedAt, p.id`,
            params
        );
        for (const row of rows) {
            if (!map.has(row.conversationId)) map.set(row.conversationId, []);
            map.get(row.conversationId).push({
                id: row.id, name: row.name, emoji: row.emoji, color: row.color, voiceId: row.voiceId
            });
        }
        return map;
    }

    /**
     * The user's parlor discussions - their own plus ones they joined as a
     * member - most recently active first. Each row carries the caller's
     * role and the human members, so the client can render shared
     * discussions distinctly.
     * @param {string} userId
     */
    async listConversations(userId) {
        const rows = await db.all(
            `SELECT c.id, c.title, c.ownerId, c.createdAt, c.lastMessageAt,
                    CASE WHEN c.ownerId = @userId THEN 'owner' ELSE 'member' END AS role,
                    (SELECT COUNT(*) FROM parlor_messages m WHERE m.conversationId = c.id) AS messageCount
             FROM parlor_conversations c
             WHERE c.ownerId = @userId
                OR EXISTS (SELECT 1 FROM parlor_members mm
                           WHERE mm.conversationId = c.id AND mm.userId = @userId)
             ORDER BY COALESCE(c.lastMessageAt, c.createdAt) DESC, c.id DESC
             LIMIT @limit`,
            { userId, limit: CONVERSATION_LIST_LIMIT }
        );
        const participants = await this._participantsFor(rows.map(r => r.id));
        const members = await this._membersFor(rows.map(r => r.id));
        // Members see the host by name (the owner is not in parlor_members;
        // their name comes from the snapshots we already hold) - the client's
        // @-mention autocomplete needs a name for every human at the table.
        const otherOwners = [...new Set(
            rows.filter(row => row.ownerId !== userId).map(row => row.ownerId)
        )];
        const ownerNames = otherOwners.length > 0 ? await this._displayNames(otherOwners) : new Map();
        return rows.map(row => ({
            ...row,
            ownerName: ownerNames.get(row.ownerId)?.values().next().value || null,
            participants: participants.get(row.id) || [],
            members: members.get(row.id) || []
        }));
    }

    /**
     * Start a discussion with one or more personas.
     * @param {Object} params - { ownerId, personaIds }
     */
    async createConversation({ ownerId, personaIds }) {
        const ids = [...new Set((Array.isArray(personaIds) ? personaIds : []).map(Number))];
        if (ids.length === 0) {
            throw new ParlorError(400, 'NO_PARTICIPANTS', 'Pick at least one persona for the discussion.');
        }
        if (ids.length > MAX_PARTICIPANTS_PER_CONVERSATION) {
            throw new ParlorError(400, 'TOO_MANY_PARTICIPANTS',
                `At most ${MAX_PARTICIPANTS_PER_CONVERSATION} personas per discussion.`);
        }
        const personas = await Promise.all(ids.map(async id => await this._requirePersona(ownerId, id)));
        const conversation = await db.transaction(async () => {
            const row = await db.get(
                `INSERT INTO parlor_conversations (ownerId) VALUES (@ownerId)
                 RETURNING id, title, createdAt, lastMessageAt`,
                { ownerId }
            );
            for (const persona of personas) {
                await db.run(
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
    async _requireConversation(ownerId, conversationId) {
        const row = await db.get(
            `SELECT id, title, ownerId FROM parlor_conversations
             WHERE id = @conversationId AND ownerId = @ownerId`,
            { conversationId: Number(conversationId), ownerId }
        );
        if (!row) throw new ParlorError(404, 'NO_SUCH_CONVERSATION', 'No such discussion.');
        return row;
    }

    /**
     * A conversation the user owns OR joined as a member, or a 404 (a
     * stranger cannot tell a foreign discussion from a missing one).
     * @returns {{ id: number, title: string|null, ownerId: string, role: 'owner'|'member' }}
     */
    async _requireConversationAccess(userId, conversationId) {
        const row = await db.get(
            `SELECT c.id, c.title, c.ownerId,
                    CASE WHEN c.ownerId = @userId THEN 'owner' ELSE 'member' END AS role
             FROM parlor_conversations c
             WHERE c.id = @conversationId
               AND (c.ownerId = @userId OR EXISTS (
                    SELECT 1 FROM parlor_members m
                    WHERE m.conversationId = c.id AND m.userId = @userId))`,
            { conversationId: Number(conversationId), userId }
        );
        if (!row) throw new ParlorError(404, 'NO_SUCH_CONVERSATION', 'No such discussion.');
        return row;
    }

    /**
     * Public access check for other services (Parlor Live's WebSocket
     * join): the conversation the user owns or joined, or a 404.
     */
    async requireConversationAccess(userId, conversationId) {
        return await this._requireConversationAccess(userId, conversationId);
    }

    /** Persona seats (with voice ids) for one conversation - the live
     *  session's roster and STT keyterm source. Caller must have checked
     *  access. */
    async listParticipants(conversationId) {
        return (await this._participantsFor([Number(conversationId)])).get(Number(conversationId)) || [];
    }

    /** Accepted human members for a set of conversations. @returns {Map<number, Array>} */
    async _membersFor(conversationIds) {
        const map = new Map();
        if (conversationIds.length === 0) return map;
        const { placeholders, params } = inList(conversationIds);
        const rows = await db.all(
            `SELECT conversationId, userId, userName, joinedAt FROM parlor_members
             WHERE conversationId IN (${placeholders})
             ORDER BY joinedAt, userId`,
            params
        );
        for (const row of rows) {
            if (!map.has(row.conversationId)) map.set(row.conversationId, []);
            map.get(row.conversationId).push({
                userId: row.userId, userName: row.userName, joinedAt: row.joinedAt
            });
        }
        return map;
    }

    /**
     * Rename a discussion.
     * @param {Object} params - { ownerId, conversationId, title }
     */
    async renameConversation({ ownerId, conversationId, title }) {
        const clean = String(title ?? '').trim().slice(0, MAX_TITLE_LENGTH);
        if (!clean) throw new ParlorError(400, 'BAD_TITLE', 'Title cannot be empty.');
        const conversation = await this._requireConversation(ownerId, conversationId);
        await db.run('UPDATE parlor_conversations SET title = @clean WHERE id = @id',
            { clean, id: conversation.id });
        return { id: conversation.id, title: clean };
    }

    /**
     * Delete a discussion (messages and participant seats cascade). The
     * personas and everything they learned stay - knowledge outliving the
     * conversation is the point.
     * @param {Object} params - { ownerId, conversationId }
     */
    async deleteConversation({ ownerId, conversationId }) {
        const conversation = await this._requireConversation(ownerId, conversationId);
        await db.run('DELETE FROM parlor_conversations WHERE id = @id', { id: conversation.id });
        return { deleted: true };
    }

    /**
     * Add or remove a persona seat on a discussion.
     * @param {Object} params - { ownerId, conversationId, personaId, present }
     */
    async setParticipant({ ownerId, conversationId, personaId, present }) {
        const conversation = await this._requireConversation(ownerId, conversationId);
        const persona = await this._requirePersona(ownerId, personaId);
        if (present) {
            const count = (await db.get(
                'SELECT COUNT(*) AS c FROM parlor_participants WHERE conversationId = @id',
                { id: conversation.id }
            )).c;
            const already = await db.get(
                `SELECT 1 AS ok FROM parlor_participants
                 WHERE conversationId = @conversationId AND personaId = @personaId`,
                { conversationId: conversation.id, personaId: persona.id }
            );
            if (!already && count >= MAX_PARTICIPANTS_PER_CONVERSATION) {
                throw new ParlorError(400, 'TOO_MANY_PARTICIPANTS',
                    `At most ${MAX_PARTICIPANTS_PER_CONVERSATION} personas per discussion.`);
            }
            await db.run(
                `INSERT INTO parlor_participants (conversationId, personaId)
                 VALUES (@conversationId, @personaId) ON CONFLICT DO NOTHING`,
                { conversationId: conversation.id, personaId: persona.id }
            );
        } else {
            await db.run(
                `DELETE FROM parlor_participants
                 WHERE conversationId = @conversationId AND personaId = @personaId`,
                { conversationId: conversation.id, personaId: persona.id }
            );
        }
        return {
            participants: (await this._participantsFor([conversation.id])).get(conversation.id) || []
        };
    }

    // --- Human members & invitations (multi-user parlors) --------------------

    /** An invite row joined to its (surviving) conversation, or null. */
    async _inviteById(inviteId) {
        return await db.get(
            `SELECT i.id, i.conversationId, i.inviterId, i.inviterName, i.inviteeId,
                    i.status, i.createdAt, c.title, c.ownerId
             FROM parlor_invites i
             JOIN parlor_conversations c ON c.id = i.conversationId
             WHERE i.id = @inviteId`,
            { inviteId: Number(inviteId) }
        );
    }

    /** Accepted members + owner for one conversation (owner not in parlor_members). */
    async _memberCount(conversationId) {
        return 1 + (await db.get(
            'SELECT COUNT(*) AS c FROM parlor_members WHERE conversationId = @conversationId',
            { conversationId }
        )).c;
    }

    /**
     * Fire one portal event (eventBusService) at every human of a shared
     * discussion - the owner plus the accepted members - so their open web
     * sessions refetch without polling. Payloads carry ids and refetch
     * hints only, never content. Fire-and-forget: an event bus problem
     * must never break the parlor action that emitted it.
     * @param {Object} params - { conversationId, kind, exclude?, include?, extra? }
     */
    async _notifyHumans({ conversationId, kind, exclude = null, include = [], extra = {} }) {
        try {
            const owner = (await db.get(
                'SELECT ownerId FROM parlor_conversations WHERE id = @conversationId',
                { conversationId }
            ))?.ownerId;
            const members = await db.all(
                'SELECT userId FROM parlor_members WHERE conversationId = @conversationId',
                { conversationId }
            );
            const recipients = new Set(
                [owner, ...members.map(row => row.userId), ...include].filter(Boolean).map(String)
            );
            if (exclude) recipients.delete(String(exclude));
            const eventBus = require('./eventBusService');
            for (const userId of recipients) {
                eventBus.publish(kind, { userId, conversationId, ...extra });
            }
        } catch { /* events are cosmetic - the action already succeeded */ }
    }

    /**
     * The human roster of one discussion: the owner, the accepted members,
     * and (for the owner only) the pending invitations.
     * @param {Object} params - { userId, conversationId }
     */
    async listMembers({ userId, conversationId }) {
        const conversation = await this._requireConversationAccess(userId, conversationId);
        const members = (await this._membersFor([conversation.id])).get(conversation.id) || [];
        const invites = conversation.role === 'owner'
            ? await db.all(
                `SELECT id, inviteeId, inviteeName, status, createdAt FROM parlor_invites
                 WHERE conversationId = @conversationId AND status = 'pending'
                 ORDER BY id`,
                { conversationId: conversation.id }
            )
            : [];
        return {
            ownerId: conversation.ownerId,
            role: conversation.role,
            maxMembers: MAX_MEMBERS_PER_CONVERSATION,
            members,
            invites
        };
    }

    /**
     * Pending invitations addressed to this user (the web app's
     * "Invitations" list - the path that works even when Discord DMs are
     * closed).
     * @param {string} userId
     */
    async listInvites(userId) {
        return await db.all(
            `SELECT i.id, i.conversationId, i.inviterId, i.inviterName, i.createdAt, c.title
             FROM parlor_invites i
             JOIN parlor_conversations c ON c.id = i.conversationId
             WHERE i.inviteeId = @userId AND i.status = 'pending'
             ORDER BY i.id DESC`,
            { userId }
        );
    }

    /**
     * People the owner could invite into this discussion: their Discord
     * friends (the roster the Activity synced) first, then the people they
     * share a server with - minus whoever is already seated at the table or
     * holding a pending invitation. The source for the invite picker, so
     * nobody has to paste a snowflake.
     * @param {Object} params - { gateway, ownerId, conversationId, q? }
     * @returns {Promise<{people: Array, friendsSynced: boolean, syncedAt: string|null}>}
     */
    async listInvitable({ gateway = null, client = null, ownerId, conversationId, q = null }) {
        const conversation = await this._requireConversation(ownerId, conversationId);
        const exclude = [
            conversation.ownerId,
            ...(await db.all(
                'SELECT userId FROM parlor_members WHERE conversationId = @conversationId',
                { conversationId: conversation.id }
            )).map(row => row.userId),
            ...(await db.all(
                `SELECT inviteeId FROM parlor_invites
                 WHERE conversationId = @conversationId AND status = 'pending'`,
                { conversationId: conversation.id }
            )).map(row => row.inviteeId)
        ];
        const friendService = require('./friendService');
        return await friendService.listInvitable({ gateway: gateway || client, userId: ownerId, q, exclude });
    }

    /**
     * Invite a Discord friend into one of the owner's discussions. Creates
     * the pending invite, then (when a Discord client is provided) resolves
     * the user and DMs them accept/decline buttons. A failed DM (privacy
     * settings) is not an error - the invite still shows up in the friend's
     * web app invitation list.
     * @param {Object} params - { gateway?, ownerId, ownerName?, conversationId, inviteeId }
     * @returns {Promise<{ invite: Object, dmSent: boolean, inviteeName: string|null }>}
     */
    async invite({ gateway = null, client = null, ownerId, ownerName = null, conversationId, inviteeId }) {
        const conversation = await this._requireConversation(ownerId, conversationId);
        const invitee = String(inviteeId ?? '').trim();
        if (!SNOWFLAKE_PATTERN.test(invitee)) {
            throw new ParlorError(400, 'BAD_USER_ID',
                'That does not look like a Discord user id (a 5-20 digit number).');
        }
        if (invitee === ownerId) {
            throw new ParlorError(400, 'CANNOT_INVITE_SELF', 'You are already the host of this discussion.');
        }
        const alreadyMember = await db.get(
            `SELECT 1 AS ok FROM parlor_members
             WHERE conversationId = @conversationId AND userId = @invitee`,
            { conversationId: conversation.id, invitee }
        );
        if (alreadyMember) {
            throw new ParlorError(409, 'ALREADY_MEMBER', 'They already joined this discussion.');
        }
        const alreadyInvited = await db.get(
            `SELECT 1 AS ok FROM parlor_invites
             WHERE conversationId = @conversationId AND inviteeId = @invitee AND status = 'pending'`,
            { conversationId: conversation.id, invitee }
        );
        if (alreadyInvited) {
            throw new ParlorError(409, 'ALREADY_INVITED', 'They already have a pending invitation.');
        }
        const pendingCount = (await db.get(
            `SELECT COUNT(*) AS c FROM parlor_invites
             WHERE conversationId = @conversationId AND status = 'pending'`,
            { conversationId: conversation.id }
        )).c;
        if (await this._memberCount(conversation.id) + pendingCount >= MAX_MEMBERS_PER_CONVERSATION) {
            throw new ParlorError(400, 'DISCUSSION_FULL',
                `At most ${MAX_MEMBERS_PER_CONVERSATION} people per discussion (counting pending invitations).`);
        }

        // Resolve the friend through Discord when we can - a typo'd id
        // should fail loudly instead of leaving a ghost invitation. An
        // unreachable gateway (bot down) degrades to the no-resolution
        // path: the invite is created, just not resolved or DMed.
        const resolvedGateway = toGateway(gateway || client);
        let inviteeUser = null;
        if (resolvedGateway) {
            let reachable = true;
            try {
                inviteeUser = await resolvedGateway.getUser(invitee);
            } catch (error) {
                if (!isGatewayUnavailable(error)) throw error;
                reachable = false;
            }
            if (reachable && !inviteeUser) {
                throw new ParlorError(404, 'NO_SUCH_USER', 'No Discord user with that id.');
            }
            if (inviteeUser?.bot) {
                throw new ParlorError(400, 'CANNOT_INVITE_BOT', 'Bots cannot join parlor discussions.');
            }
        }

        const inviteeName = inviteeUser
            ? (inviteeUser.globalName || inviteeUser.username)
            : null;
        const invite = await db.get(
            `INSERT INTO parlor_invites (conversationId, inviterId, inviterName, inviteeId, inviteeName)
             VALUES (@conversationId, @inviterId, @inviterName, @inviteeId, @inviteeName)
             RETURNING id, conversationId, inviterId, inviterName, inviteeId, inviteeName, status, createdAt`,
            {
                conversationId: conversation.id,
                inviterId: ownerId,
                inviterName: ownerName || null,
                inviteeId: invitee,
                inviteeName
            }
        );

        let dmSent = false;
        if (inviteeUser) {
            // Fire-and-report (the dmSent:false convention): DMs closed -
            // the invite still shows in their web app.
            const delivery = await resolvedGateway.sendDm(invitee, this._inviteMessage({
                inviteId: invite.id,
                inviterName: ownerName,
                title: conversation.title
            }));
            dmSent = delivery.ok === true;
        }
        // The invitee's open web session refetches its invitation list
        try {
            require('./eventBusService').publish('parlor-invite', {
                userId: invitee, conversationId: conversation.id
            });
        } catch { /* cosmetic */ }
        return { invite, dmSent, inviteeName };
    }

    /** The invitation DM: an embed plus accept/decline buttons. */
    _inviteMessage({ inviteId, inviterName, title }) {
        const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
        let appUrl = null;
        try {
            const publicUrl = require('../../../config.json').webapp?.publicUrl;
            if (typeof publicUrl === 'string' && publicUrl) {
                appUrl = `${publicUrl.replace(/\/+$/, '')}/app/`;
            }
        } catch { /* no config.json (tests) - skip the link */ }

        const embed = new EmbedBuilder()
            .setColor(0x7c8cff)
            .setTitle('🛋️ An invitation to the Parlor')
            .setDescription(
                `**${inviterName || 'A friend'}** invited you to join their parlor discussion` +
                `${title ? ` **"${title}"**` : ''} - a salon where you talk ideas over with their cast of AI personas.\n\n` +
                'Accept to join; you can read the discussion and take part from the web app' +
                `${appUrl ? ` at ${appUrl}` : ''} (Parlor tab).`
            );
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`accept_parlorinvite_${inviteId}`)
                .setLabel('Accept').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`decline_parlorinvite_${inviteId}`)
                .setLabel('Decline').setStyle(ButtonStyle.Secondary)
        );
        return { embeds: [embed], components: [row] };
    }

    /**
     * Accept or decline one of MY pending invitations (web app path; the
     * Discord DM buttons land here too via handleInviteButton).
     * @param {Object} params - { userId, userName?, inviteId, accept }
     * @returns {{ status: string, conversationId: number, title: string|null }}
     */
    async respondInvite({ userId, userName = null, inviteId, accept }) {
        const invite = await this._inviteById(inviteId);
        if (!invite || invite.inviteeId !== userId) {
            throw new ParlorError(404, 'NO_SUCH_INVITE', 'No such invitation.');
        }
        if (invite.status !== 'pending') {
            throw new ParlorError(409, 'INVITE_SETTLED', 'This invitation was already settled.');
        }
        const result = await db.transaction(async () => {
            if (accept) {
                if (await this._memberCount(invite.conversationId) >= MAX_MEMBERS_PER_CONVERSATION) {
                    throw new ParlorError(400, 'DISCUSSION_FULL',
                        `This discussion is full (${MAX_MEMBERS_PER_CONVERSATION} people).`);
                }
                await db.run(
                    `INSERT INTO parlor_members (conversationId, userId, userName, invitedBy)
                     VALUES (@conversationId, @userId, @userName, @invitedBy) ON CONFLICT DO NOTHING`,
                    {
                        conversationId: invite.conversationId,
                        userId,
                        userName: userName || null,
                        invitedBy: invite.inviterId
                    }
                );
            }
            const status = accept ? 'accepted' : 'declined';
            await db.run(
                `UPDATE parlor_invites SET status = @status, respondedAt = datetime('now')
                 WHERE id = @id`,
                { status, id: invite.id }
            );
            return { status, conversationId: invite.conversationId, title: invite.title };
        });
        // Everyone at the table (the responder included - a Discord DM
        // button may have settled this, and their web session should
        // follow) refetches the roster and conversation list.
        await this._notifyHumans({
            conversationId: invite.conversationId,
            kind: 'parlor-members',
            include: [userId],
            extra: { invalidate: [`parlor-members:${invite.conversationId}`] }
        });
        return result;
    }

    /**
     * Withdraw a pending invitation (owner only).
     * @param {Object} params - { ownerId, inviteId }
     */
    async revokeInvite({ ownerId, inviteId }) {
        const invite = await this._inviteById(inviteId);
        if (!invite || invite.ownerId !== ownerId) {
            throw new ParlorError(404, 'NO_SUCH_INVITE', 'No such invitation.');
        }
        if (invite.status !== 'pending') {
            throw new ParlorError(409, 'INVITE_SETTLED', 'This invitation was already settled.');
        }
        await db.run(
            `UPDATE parlor_invites SET status = 'revoked', respondedAt = datetime('now')
             WHERE id = @id`,
            { id: invite.id }
        );
        // The invitation disappears from the invitee's list live
        try {
            require('./eventBusService').publish('parlor-invite', {
                userId: invite.inviteeId, conversationId: invite.conversationId
            });
        } catch { /* cosmetic */ }
        return { revoked: true };
    }

    /**
     * Remove a member from a shared discussion: the owner can remove
     * anyone; a member can remove themself (leave). Their past messages
     * stay in the transcript (name snapshotted), like a persona's.
     * @param {Object} params - { userId, conversationId, memberId }
     */
    async removeMember({ userId, conversationId, memberId }) {
        const conversation = await this._requireConversationAccess(userId, conversationId);
        const target = String(memberId ?? '').trim();
        if (conversation.role !== 'owner' && target !== userId) {
            throw new ParlorError(403, 'NOT_OWNER', 'Only the host can remove other people.');
        }
        const removed = (await db.run(
            `DELETE FROM parlor_members
             WHERE conversationId = @conversationId AND userId = @target`,
            { conversationId: conversation.id, target }
        )).changes;
        if (removed === 0) {
            throw new ParlorError(404, 'NO_SUCH_MEMBER', 'They are not a member of this discussion.');
        }
        // The removed person (already out of parlor_members) is included
        // explicitly so their session drops the discussion live.
        await this._notifyHumans({
            conversationId: conversation.id,
            kind: 'parlor-members',
            include: [target],
            extra: { invalidate: [`parlor-members:${conversation.id}`] }
        });
        return {
            left: target === userId,
            members: (await this._membersFor([conversation.id])).get(conversation.id) || []
        };
    }

    /**
     * Settle an invitation from its Discord DM buttons
     * (accept_parlorinvite_<id> / decline_parlorinvite_<id>, routed by
     * events/interactionCreate.js). Updates the DM message in place so the
     * buttons disappear once the invitation is settled.
     * @param {string} action - 'accept' | 'decline'
     * @param {string|number} inviteId
     * @param {Object} interaction - the Discord button interaction
     */
    async handleInviteButton(action, inviteId, interaction) {
        const invite = await this._inviteById(inviteId);
        const settle = async (line) => {
            await interaction.update({
                embeds: interaction.message?.embeds || [],
                content: line,
                components: []
            });
        };
        if (!invite) {
            await settle('This invitation is no longer valid (the discussion may have been deleted).');
            return;
        }
        if (interaction.user.id !== invite.inviteeId) {
            await interaction.reply({ content: '❌ This invitation is not addressed to you.', ephemeral: true });
            return;
        }
        try {
            const result = await this.respondInvite({
                userId: interaction.user.id,
                userName: interaction.user.globalName || interaction.user.username || null,
                inviteId: invite.id,
                accept: action === 'accept'
            });
            await settle(result.status === 'accepted'
                ? `🛋️ You joined${invite.title ? ` "${invite.title}"` : ' the discussion'} - open the web app's Parlor tab to take part.`
                : 'Invitation declined.');
        } catch (error) {
            if (error instanceof ParlorError) {
                await settle(`❌ ${error.message}`);
                return;
            }
            throw error;
        }
    }

    /**
     * Transcript page, oldest first. Persona messages carry their grounding
     * (the notes retrieved before generation) as resolvable references.
     * Members read the same transcript as the owner; grounding titles
     * resolve against the OWNER's workspaces (whose personas they are) and
     * attachments are re-registered to the viewer so the owner-bound file
     * route serves them to whoever is legitimately looking.
     * @param {Object} params - { userId, conversationId, limit?, beforeId? }
     */
    async getMessages({ userId, conversationId, limit = MESSAGE_PAGE_LIMIT, beforeId = null }) {
        const conversation = await this._requireConversationAccess(userId, conversationId);
        const bounded = Math.max(1, Math.min(Number(limit) || MESSAGE_PAGE_LIMIT, MESSAGE_PAGE_LIMIT));
        const params = { conversationId: conversation.id, limit: bounded };
        if (beforeId) params.beforeId = Number(beforeId);
        const rows = await db.all(
            `SELECT id, role, personaId, personaName, content, contextNoteIds, attachments,
                    userId, userName, createdAt
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
            const noteRows = await db.all(
                `SELECT n.id, n.label AS title FROM kg_nodes n
                 WHERE n.guildId = @guildId AND n.scopeKey LIKE 'PARLOR:%'
                   AND n.id IN (${placeholders})`,
                { guildId: dmScopeId(conversation.ownerId), ...params }
            );
            for (const note of noteRows) noteTitles.set(note.id, note.title);
        }
        const messages = [];
        for (const row of rows) {
            messages.push({
                id: row.id,
                role: row.role,
                personaId: row.personaId,
                personaName: row.personaName,
                userId: row.userId,
                userName: row.userName,
                content: row.content,
                createdAt: row.createdAt,
                grounding: this._parseNoteIds(row.contextNoteIds)
                    .filter(id => noteTitles.has(id))
                    .map(id => ({ id, title: noteTitles.get(id) })),
                attachments: await this._serveAttachments(row.attachments, userId)
            });
        }
        return messages;
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
        const existing = await this.listPersonas(ownerId);
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
                persona = await this.createPersona({
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
                    await this.createNote({
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

        const conversation = await this.createConversation({
            ownerId,
            personaIds: created.map(p => p.id)
        });
        const title = String(design?.title || '').replace(/["\n]/g, '').trim().slice(0, MAX_TITLE_LENGTH);
        if (title) {
            await this.renameConversation({ ownerId, conversationId: conversation.id, title });
            conversation.title = title;
        }
        const opening = String(design?.opening || '').trim().slice(0, MAX_MESSAGE_LENGTH) || null;

        return {
            conversation,
            personas: (await this.listPersonas(ownerId)).filter(p => created.some(c => c.id === p.id)),
            seededNotes,
            opening
        };
    }

    // --- The turn -------------------------------------------------------------

    /** Sliding-window rate limit; throws 429 when exceeded. */
    async _checkRateLimit(ownerId) {
        const { consumeWindow } = require('../utils/slidingWindowLimit');
        const ok = await consumeWindow({
            scope: 'parlor',
            subject: ownerId,
            max: RATE_LIMIT_TURNS,
            windowMs: RATE_LIMIT_WINDOW_MS
        });
        if (!ok) {
            throw new ParlorError(429, 'RATE_LIMITED',
                `Slow down - at most ${RATE_LIMIT_TURNS} parlor turns per minute.`);
        }
    }

    /**
     * Request that the user's in-flight parlor turn stop (checked between
     * personas and between workflow steps; the current generation finishes).
     * @param {string} userId - the user who started the turn
     * @returns {boolean} whether a turn was active
     */
    stopTurn(userId) {
        let stopped = false;
        for (const turn of this._activeTurns.values()) {
            if (turn.startedBy === userId) {
                turn.abort();
                stopped = true;
            }
        }
        return stopped;
    }

    /** Throw TURN_IN_FLIGHT when the conversation or the user is busy. */
    _requireIdleTurn(conversationId, userId) {
        if (this._activeTurns.has(conversationId)) {
            throw new ParlorError(409, 'TURN_IN_FLIGHT',
                'The parlor is already thinking - wait for the current turn to finish.');
        }
        for (const turn of this._activeTurns.values()) {
            if (turn.startedBy === userId) {
                throw new ParlorError(409, 'TURN_IN_FLIGHT',
                    'The parlor is already thinking - wait for the current turn to finish.');
            }
        }
    }

    /**
     * Fire-and-forget discussion titling (webChatService's pattern): cheap
     * fallback immediately, model-written replacement when available.
     */
    async _autoTitle({ conversationId, ownerId, userMessage }) {
        const fallback = userMessage.replace(/\s+/g, ' ').trim().slice(0, 48)
            + (userMessage.length > 48 ? '…' : '');
        await db.run(
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
                await db.run('UPDATE parlor_conversations SET title = @clean WHERE id = @id',
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
     * Members of a shared discussion send turns exactly like the owner; the
     * personas, their workspaces, and the AI usage attribution stay the
     * OWNER's, and the stored user message snapshots who actually spoke.
     *
     * @param {Object} params - { userId, userName, conversationId, message, gateway? }
     * @returns {{ run: (events?: Object) => Promise<void>, abort: () => void, conversationId: number }}
     */
    async startTurn({ userId, userName, conversationId, message, gateway = null, client = null }) {
        const text = String(message ?? '').trim();
        if (!text) throw new ParlorError(400, 'EMPTY_MESSAGE', 'Message cannot be empty.');
        if (text.length > MAX_MESSAGE_LENGTH) {
            throw new ParlorError(400, 'MESSAGE_TOO_LONG',
                `Message is too long (max ${MAX_MESSAGE_LENGTH} characters).`);
        }
        const conversation = await this._requireConversationAccess(userId, conversationId);
        const ownerId = conversation.ownerId;
        const participants = (await this._participantsFor([conversation.id])).get(conversation.id) || [];
        if (participants.length === 0) {
            throw new ParlorError(400, 'NO_PARTICIPANTS',
                'This discussion has no personas - add one first.');
        }
        this._requireIdleTurn(conversation.id, userId);
        await this._checkRateLimit(userId);

        const turnState = { aborted: false, abort: () => { turnState.aborted = true; }, startedBy: userId };
        this._activeTurns.set(conversation.id, turnState);
        const service = this;

        return {
            conversationId: conversation.id,
            abort: turnState.abort,
            run: async (events = {}) => {
                try {
                    const userMessage = await db.get(
                        `INSERT INTO parlor_messages (conversationId, role, content, userId, userName)
                         VALUES (@conversationId, 'user', @content, @userId, @userName)
                         RETURNING id, role, content, userId, userName, createdAt`,
                        {
                            conversationId: conversation.id, content: text,
                            userId, userName: userName || null
                        }
                    );
                    await db.run(
                        `UPDATE parlor_conversations SET lastMessageAt = datetime('now') WHERE id = @id`,
                        { id: conversation.id }
                    );
                    if (!conversation.title) {
                        await this._autoTitle({ conversationId: conversation.id, ownerId, userMessage: text });
                    }
                    try { events.onUserMessage?.({ ...userMessage, grounding: [] }); } catch { /* never break the turn */ }
                    // Other humans in a shared discussion see the message
                    // land immediately (personas may generate for a while)
                    await service._notifyTurn(conversation.id, userId);
                    // @-mentions of the other humans: best-effort and off
                    // the turn's critical path (a DM can take a second and
                    // must never delay the personas).
                    service._notifyMentions({
                        gateway: gateway || client,
                        conversation,
                        actorId: userId,
                        actorName: userName || null,
                        text,
                        messageId: userMessage.id
                    }).catch(() => { /* mentions are cosmetic - the message landed */ });

                    const repliedIds = new Set();
                    let anySpoke = false;
                    // Shared = another human is seated (_memberCount includes
                    // the owner, so > 1). Used only to lift the "somebody
                    // must answer" force-fallback below - the AI gate still
                    // decides who speaks.
                    const sharedHumans = (await service._memberCount(conversation.id)) > 1;
                    for (const participant of participants) {
                        if (turnState.aborted) break;
                        const outcome = await service._runPersonaTurn({
                            ownerId, ownerName: userName,
                            conversationId: conversation.id,
                            personaId: participant.id,
                            turnState, events, repliedIds
                        });
                        if (outcome !== 'passed') {
                            anySpoke = true;
                            repliedIds.add(participant.id);
                        }
                    }
                    // Private salon: if every gate declines, the first seat
                    // answers anyway so the user never gets silence. Shared
                    // discussion: that requirement is lifted - humans may be
                    // talking to each other, and an empty turn is fine.
                    if (!anySpoke && !turnState.aborted && !sharedHumans) {
                        await service._runPersonaTurn({
                            ownerId, ownerName: userName,
                            conversationId: conversation.id,
                            personaId: participants[0].id,
                            turnState, events, forced: true
                        });
                    }
                } finally {
                    this._activeTurns.delete(conversation.id);
                    await service._notifyTurn(conversation.id, userId);
                }
            }
        };
    }

    /** Tell the OTHER humans of a shared discussion its transcript moved. */
    async _notifyTurn(conversationId, actorId) {
        await this._notifyHumans({
            conversationId,
            kind: 'parlor-turn',
            exclude: actorId,
            extra: { invalidate: [`parlor-messages:${conversationId}`] }
        });
    }

    // --- @-mentions of humans in a shared discussion --------------------------

    /**
     * Deliver "@Name" mentions in one user message to the OTHER humans of
     * the discussion. Delivery is presence-shaped: someone online in the
     * web portal gets a portal notification (a 'parlor-mention' event their
     * open session renders as a clickable notice); someone offline gets a
     * Discord DM with a link to the discussion. Only humans actually seated
     * at the table can be mentioned - a mention is a nudge inside a shared
     * space, never a way to message strangers. Best-effort end to end: a
     * failed lookup or closed DMs must never break the turn.
     * @param {Object} params - { gateway?, conversation, actorId, actorName?, text, messageId? }
     */
    async _notifyMentions({ gateway = null, conversation, actorId, actorName = null, text, messageId = null }) {
        if (!text || !text.includes('@')) return;
        const targets = await this._mentionTargets({
            conversationId: conversation.id,
            ownerId: conversation.ownerId,
            actorId,
            text
        });
        if (targets.length === 0) return;

        const title = (await db.get(
            'SELECT title FROM parlor_conversations WHERE id = @id',
            { id: conversation.id }
        ))?.title || null;
        const fromName = actorName || 'Someone';
        const presence = require('./presenceService');
        const eventBus = require('./eventBusService');
        const online = await presence.onlineIds(targets);
        const resolvedGateway = toGateway(gateway);

        for (const target of targets) {
            if (online.has(target)) {
                // Identity hints only (who, where) - never the message text.
                eventBus.publish('parlor-mention', {
                    userId: target,
                    conversationId: conversation.id,
                    messageId,
                    fromUserId: actorId,
                    fromName,
                    title
                });
            } else if (resolvedGateway) {
                // Fire-and-report like invites: closed DMs are not an error,
                // and the message is waiting in the transcript either way.
                await resolvedGateway.sendDm(target, this._mentionMessage({
                    fromName, title, conversationId: conversation.id
                }));
            }
        }
    }

    /**
     * Which of the discussion's OTHER humans this message @-mentions.
     * Matching is display-name based (case-insensitive, names may contain
     * spaces) against every name we have seen for each human - their member
     * snapshot, their spoken messages here, their web login, their friend-
     * roster appearances - plus their raw id, so "@Frieda" works no matter
     * which surface supplied the name.
     * @param {Object} params - { conversationId, ownerId, actorId, text }
     * @returns {Promise<string[]>} mentioned user ids (never the actor)
     */
    async _mentionTargets({ conversationId, ownerId, actorId, text }) {
        const members = await db.all(
            'SELECT userId FROM parlor_members WHERE conversationId = @conversationId',
            { conversationId }
        );
        const humans = [...new Set(
            [ownerId, ...members.map(row => row.userId)].map(String)
        )].filter(id => id !== String(actorId));
        if (humans.length === 0) return [];

        const names = await this._displayNames(humans, conversationId);
        const targets = [];
        for (const userId of humans) {
            const candidates = [userId, ...(names.get(userId) || [])];
            const mentioned = candidates.some(name => {
                const escaped = String(name).trim();
                if (!escaped) return false;
                const pattern = escaped.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                // "@" then the name, not embedded in a longer word/handle
                return new RegExp(`(^|[^\\w@])@${pattern}(?!\\w)`, 'iu').test(text);
            });
            if (mentioned) targets.push(userId);
        }
        return targets;
    }

    /**
     * Every display name we know for these users: parlor member snapshots,
     * names on their messages in this discussion (when one is given), their
     * web-session login name, and their appearances in friend rosters. All
     * are snapshots the user already shows under - no new lookups, no
     * gateway needed.
     * @returns {Promise<Map<string, Set<string>>>}
     */
    async _displayNames(userIds, conversationId = null) {
        const map = new Map(userIds.map(id => [String(id), new Set()]));
        const { placeholders, params } = inList(userIds);
        const add = (userId, name) => {
            const clean = String(name || '').trim();
            if (clean) map.get(String(userId))?.add(clean);
        };
        for (const row of await db.all(
            `SELECT userId, userName FROM parlor_members
             WHERE userId IN (${placeholders}) AND userName IS NOT NULL`,
            params
        )) add(row.userId, row.userName);
        if (conversationId) {
            for (const row of await db.all(
                `SELECT DISTINCT userId, userName FROM parlor_messages
                 WHERE conversationId = @conversationId AND userId IN (${placeholders})
                   AND userName IS NOT NULL`,
                { ...params, conversationId }
            )) add(row.userId, row.userName);
        }
        for (const row of await db.all(
            `SELECT userId, userName FROM web_sessions
             WHERE userId IN (${placeholders}) AND userName IS NOT NULL`,
            params
        )) add(row.userId, row.userName);
        for (const row of await db.all(
            `SELECT friendId, friendName FROM user_friends
             WHERE friendId IN (${placeholders}) AND friendName IS NOT NULL`,
            params
        )) add(row.friendId, row.friendName);
        return map;
    }

    /** The mention DM: who mentioned you, where, and a link to the chat. */
    _mentionMessage({ fromName, title, conversationId }) {
        const { EmbedBuilder } = require('discord.js');
        let chatUrl = null;
        try {
            const publicUrl = require('../../../config.json').webapp?.publicUrl;
            if (typeof publicUrl === 'string' && publicUrl) {
                chatUrl = `${publicUrl.replace(/\/+$/, '')}/app/parlor/${conversationId}`;
            }
        } catch { /* no config.json (tests) - skip the link */ }

        const embed = new EmbedBuilder()
            .setColor(0x7c8cff)
            .setTitle('🛋️ You were mentioned in the Parlor')
            .setDescription(
                `**${fromName || 'Someone'}** mentioned you in the parlor discussion` +
                `${title ? ` **"${title}"**` : ''}.\n\n` +
                (chatUrl
                    ? `Jump back in: ${chatUrl}`
                    : 'Open the web app (Parlor tab) to jump back in.')
            );
        return { embeds: [embed] };
    }

    /**
     * Manually trigger ONE persona to respond right now - no new user
     * message, no should-respond gate, even if they just spoke. The lever
     * behind the participant-chip "speak" action (storytelling rounds,
     * long-form planning, "what does the skeptic think?"). Members of a
     * shared discussion can nudge too.
     * @param {Object} params - { userId, userName, conversationId, personaId }
     * @returns {{ run: (events?: Object) => Promise<void>, abort: () => void, conversationId: number, persona: Object }}
     */
    async startPersonaTurn({ userId, userName, conversationId, personaId }) {
        const conversation = await this._requireConversationAccess(userId, conversationId);
        const ownerId = conversation.ownerId;
        const persona = await this._requirePersona(ownerId, personaId);
        const seated = await db.get(
            `SELECT 1 AS ok FROM parlor_participants
             WHERE conversationId = @conversationId AND personaId = @personaId`,
            { conversationId: conversation.id, personaId: persona.id }
        );
        if (!seated) {
            throw new ParlorError(400, 'NOT_SEATED',
                `${persona.name} is not part of this discussion - add them first.`);
        }
        this._requireIdleTurn(conversation.id, userId);
        await this._checkRateLimit(userId);

        const turnState = { aborted: false, abort: () => { turnState.aborted = true; }, startedBy: userId };
        this._activeTurns.set(conversation.id, turnState);
        const service = this;

        return {
            conversationId: conversation.id,
            persona: { id: persona.id, name: persona.name, emoji: persona.emoji, color: persona.color },
            abort: turnState.abort,
            run: async (events = {}) => {
                try {
                    await service._runPersonaTurn({
                        ownerId, ownerName: userName,
                        conversationId: conversation.id,
                        personaId: persona.id,
                        turnState, events, forced: true
                    });
                } finally {
                    this._activeTurns.delete(conversation.id);
                    await service._notifyTurn(conversation.id, userId);
                }
            }
        };
    }

    /**
     * Whether text plainly addresses a persona by name. Two shapes count:
     * a bare word-boundary match ("Ada, what do you think?") and an
     * explicit @-mention ("@Ada what do you think?") - the same form the
     * composer autocomplete inserts for humans and personas. The first
     * word of a multi-word name ("Mara, SRE" → "Mara") is also accepted.
     */
    _mentionsPersona(text, personaName) {
        const candidates = new Set([String(personaName || '').trim()]);
        // "Mara, SRE" is usually addressed as just "Mara"
        const firstWord = String(personaName || '').split(/[\s,]+/)[0];
        if (firstWord && firstWord.length >= 3) candidates.add(firstWord);
        for (const candidate of candidates) {
            if (!candidate) continue;
            const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            // Explicit @-mention (composer autocomplete / "@Name" habit)
            if (new RegExp(`(^|[^\\w@])@${escaped}(?!\\w)`, 'iu').test(text)) return true;
            // Bare name with word boundaries ("Ada, thoughts?")
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
                    ? `[${entry.userName || ownerName || 'the user'}]: ${entry.content.slice(0, 400)}`
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
     * user-bound authenticated /api/app/files route). Files are registered
     * to the VIEWER, so members of a shared discussion get URLs their own
     * session can fetch. Files that no longer exist on disk drop out
     * quietly.
     * @param {string|null} json - stored JSON array of file paths
     * @param {string} viewerId - the user the transcript is being served to
     * @returns {Array<{url: string, name: string}>}
     */
    async _serveAttachments(json, viewerId) {
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
            const registered = await webChatService.registerFile(filePath, viewerId);
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
        const persona = await this._requirePersona(ownerId, personaId);
        try { events.onPersonaStart?.({ id: persona.id, name: persona.name, emoji: persona.emoji, color: persona.color, voiceId: persona.voiceId }); } catch { /* ignore */ }

        try {
            const history = (await db.all(
                `SELECT role, personaId, personaName, userName, content FROM parlor_messages
                 WHERE conversationId = @conversationId
                 ORDER BY id DESC LIMIT @limit`,
                { conversationId, limit: HISTORY_WINDOW }
            )).reverse();
            const lastUser = [...history].reverse().find(m => m.role === 'user');

            // 0. Consider: in a group discussion, decide whether this persona
            //    actually has something to say (a solo persona, a manual
            //    nudge, and the everyone-declined fallback skip the gate).
            //    Shared multi-human discussions still use this gate - they
            //    just don't force a speaker when everyone declines.
            if (!forced) {
                const participants = (await this._participantsFor([conversationId])).get(conversationId) || [];
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
            const functionDefs = await toolsRegistry.getDefinitions(PERSONA_TOOL_NAMES, { isWeb: true });
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

            const stored = await db.get(
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
            await db.run(
                `UPDATE parlor_conversations SET lastMessageAt = datetime('now') WHERE id = @id`,
                { id: conversationId }
            );
            try {
                events.onPersonaMessage?.({
                    ...stored,
                    grounding: retrieved.map(n => ({ id: n.id, title: n.title })),
                    // The SSE stream belongs to whoever started the turn
                    attachments: await this._serveAttachments(
                        collector.files.length > 0 ? JSON.stringify(collector.files) : null,
                        turnState.startedBy || ownerId)
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
            '- Several humans may share this discussion (each labeled by name). Address people by name when it helps, and treat every one of them as your host.',
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
                // Shared discussions have several humans; the snapshotted
                // per-message name keeps the speakers distinguishable.
                messages.push({
                    role: 'user',
                    content: `[${entry.userName || ownerName || 'the user'}]: ${entry.content}`
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
            const { guildId, scopeKey } = workspaceCoords(ownerId, persona.id);
            const existingTitles = (await db.all(
                `SELECT label AS title FROM kg_nodes
                 WHERE guildId = @guildId AND scopeKey = @scopeKey
                 ORDER BY updatedAt DESC LIMIT 60`,
                { guildId, scopeKey }
            )).map(r => r.title);
            const existingTags = (await this.listTags({ ownerId, personaId: persona.id }))
                .slice(0, 40).map(t => t.name);

            const response = await aiService.generateText(
                `You are the knowledge-keeper for the persona "${persona.name}" in Goobster's knowledge graph. ` +
                `After the exchange below, extract at most ${WRITEBACK_MAX_NOTES} NEW durable notes worth keeping ` +
                'long-term: stable facts, decisions, preferences, or ideas - never chit-chat, never the reply itself. ' +
                'An empty list is usually the right answer. Never restate a note that already exists. ' +
                'Optionally propose typed links between note titles (new or existing) when a real relationship is clear.\n\n' +
                `EXISTING NOTE TITLES: ${existingTitles.length > 0 ? existingTitles.join(' | ') : '(none)'}\n` +
                `EXISTING TAGS (prefer reusing): ${existingTags.length > 0 ? existingTags.join(', ') : '(none)'}\n\n` +
                `EXCHANGE:\n[user]: ${userText.slice(0, 2000)}\n[${persona.name}]: ${replyText.slice(0, 2000)}\n\n` +
                'Respond with ONLY JSON: {"notes": [{"title": "short unique title", "content": "1-3 sentences", "tags": ["concept"]}], ' +
                '"links": [{"source": "note title", "target": "note title", "relation": "related_to"}]}',
                { max_tokens: 500, usageContext: { guildId: dmScopeId(ownerId), userId: ownerId } }
            );
            const parsed = parseJsonObject(response);
            proposed = parsed || { notes: [], links: [] };
        } catch {
            return [];
        }

        const created = [];
        const notes = Array.isArray(proposed?.notes) ? proposed.notes : [];
        for (const raw of notes.slice(0, WRITEBACK_MAX_NOTES)) {
            try {
                const note = await this.createNote({
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
        const links = Array.isArray(proposed?.links) ? proposed.links : [];
        if (links.length) {
            const { guildId, scopeKey } = workspaceCoords(ownerId, persona.id);
            try {
                await knowledgeGraphService.applyMutations({
                    guildId,
                    scopeKey,
                    subjectType: 'USER',
                    subjectId: ownerId,
                    source: 'conversation',
                    limits: kgConfig.LIMITS.parlor,
                    provenance: conversationId
                        ? { sourceKind: 'parlor_conversation', sourceId: conversationId }
                        : null,
                    mutations: { link: links }
                });
            } catch { /* a failed link costs connectivity, not the notes */ }
        }
        return created;
    }
}

module.exports = new ParlorService();
module.exports.ParlorError = ParlorError;
