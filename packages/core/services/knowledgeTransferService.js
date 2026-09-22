/**
 * Explicit transfers (ADR 0010, documentation/knowledge_and_memory.md):
 * the deterministic service actions behind Save note, Add to project and
 * Use in discussion. No model call routes any of them.
 *
 *  - saveMessageAsNote   an assistant reply -> a saved personal note
 *  - addNoteToProject    a personal note -> a project, as a read-time
 *                        reference (private project the caller owns) or a
 *                        published copy (shared project)
 *  - useNoteInDiscussion a personal note -> a transcript message in a
 *                        discussion the caller belongs to
 *
 * Every move is one row in knowledge_transfers: who, from what, to where,
 * how, and who could read the destination at that moment. kg_provenance is
 * untouched. Erasure: forgetUser / countUserData (privacyService).
 */

const db = require('../db');
const logger = require('../utils/logger');
const knowledgeGraphService = require('./knowledgeGraphService');
const kgConfig = require('../config/knowledgeGraphConfig');
const { dmScopeId } = require('../utils/dmScope');

const { MAX_LABEL_LENGTH, MAX_CONTENT_LENGTH, MAX_TAGS_PER_NODE } = kgConfig;

/** How much of a copied note a discussion message carries (well under the parlor cap). */
const DISCUSSION_MESSAGE_MAX = 4000;

class KnowledgeTransferError extends Error {
    constructor(status, code, message, details = null) {
        super(message);
        this.name = 'KnowledgeTransferError';
        this.status = status;
        this.code = code;
        if (details) this.details = details;
    }
}

function personalCoords(userId) {
    return { guildId: dmScopeId(userId), scopeKey: `USER:${userId}` };
}

function inList(values, prefix = 'in') {
    const params = {};
    const placeholders = values.map((value, index) => {
        params[`${prefix}${index}`] = value;
        return `@${prefix}${index}`;
    });
    return { placeholders: placeholders.join(','), params };
}

function parseAudience(json) {
    if (!json) return null;
    try { return JSON.parse(json); } catch { return null; }
}

function cleanTags(tags) {
    const list = Array.isArray(tags) ? tags : String(tags || '').split(/[,;]/);
    return [...new Set(
        list.map(t => String(t || '').trim().toLowerCase()).filter(Boolean)
    )].slice(0, MAX_TAGS_PER_NODE);
}

/**
 * A title for a saved answer: its first Markdown heading, else its first
 * sentence or line with inline markup stripped, bounded to the label cap.
 */
function suggestLabel(text, fallback = 'Saved answer') {
    const source = String(text || '');
    const heading = source.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/m);
    let candidate = heading ? heading[1] : '';
    if (!candidate) {
        const firstLine = source
            .split('\n')
            .map(line => line.replace(/^(?:\s*(?:[-*•>]|\d+[.)])\s+)+/, '').trim())
            .find(line => line.length > 0) || '';
        const sentence = firstLine.match(/^(.+?[.!?])(\s|$)/);
        candidate = sentence ? sentence[1] : firstLine;
    }
    candidate = candidate
        .replace(/`{1,3}([^`]*)`{1,3}/g, '$1')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/\*([^*]+)\*/g, '$1')
        .replace(/__([^_]+)__/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/\s+/g, ' ')
        .replace(/[:\s]+$/, '')
        .trim();
    if (!candidate) return fallback;
    if (candidate.length <= MAX_LABEL_LENGTH) return candidate;
    return `${candidate.slice(0, MAX_LABEL_LENGTH - 1).trimEnd()}…`;
}

class KnowledgeTransferService {
    // --- Sources -----------------------------------------------------------

    /**
     * A personal note the caller owns, with its tags, or 404. Distilled
     * memory (`curation = 'memory'`) is refused when `knowledgeOnly` is set:
     * the picker only offers what the person kept (ADR 0008), and the
     * server draws the same line.
     */
    async _requirePersonalNote(userId, nodeId, { knowledgeOnly = true } = {}) {
        const coords = personalCoords(userId);
        const node = await db.get(
            `SELECT * FROM kg_nodes
             WHERE id = @id AND guildId = @guildId AND scopeKey = @scopeKey`,
            { id: Number(nodeId), ...coords }
        );
        if (!node) throw new KnowledgeTransferError(404, 'NOT_FOUND', 'Note not found.');
        if (knowledgeOnly && node.curation === 'memory') {
            throw new KnowledgeTransferError(400, 'NOT_KNOWLEDGE',
                'This is distilled personal memory, not a note you kept. Keep it as a note first if you want to share it.');
        }
        const tags = (await knowledgeGraphService.getTagsForNodes([node.id])).get(node.id) || [];
        return { ...node, tags };
    }

    /**
     * An assistant reply in a web conversation the caller owns, or 404.
     * Incognito turns never reach this table, so nothing incognito can be
     * saved from here.
     */
    async _requireAssistantMessage(userId, conversationId, messageId) {
        const row = await db.get(
            `SELECT m.id, m.message, m.isBot, m.createdAt, wc.id AS conversationId, wc.title
             FROM messages m
             JOIN guild_conversations gc ON gc.id = m.guildConversationId
             JOIN web_conversations wc ON wc.channelId = gc.channelId AND wc.userId = @userId
             WHERE m.id = @messageId AND wc.id = @conversationId AND gc.guildId = @scope`,
            {
                userId,
                messageId: Number(messageId),
                conversationId: Number(conversationId),
                scope: dmScopeId(userId)
            }
        );
        if (!row) throw new KnowledgeTransferError(404, 'NOT_FOUND', 'No such message.');
        if (!row.isBot) {
            throw new KnowledgeTransferError(400, 'NOT_AN_ANSWER',
                'Only an answer from the assistant can be saved as a note.');
        }
        return row;
    }

    // --- Audiences ---------------------------------------------------------

    /**
     * Who can read a project right now: the owner, accepted members and,
     * when a dashboard share link exists, anyone holding it. `private` is
     * the reference-mode precondition (ADR 0010 §3).
     * @param {{ id:number, ownerId:string }} project
     */
    async projectAudience(project) {
        const members = await db.all(
            `SELECT userId, userName FROM project_members
             WHERE projectId = @projectId ORDER BY joinedAt ASC, userId ASC`,
            { projectId: project.id }
        );
        const shared = Boolean(await db.get(
            'SELECT 1 AS ok FROM observatory_share_links WHERE projectId = @projectId',
            { projectId: project.id }
        ));
        return {
            kind: 'project',
            ownerId: project.ownerId,
            ownerName: await this._displayName(project.ownerId),
            members: await this._namedMembers(members),
            memberIds: [project.ownerId, ...members.map(m => m.userId)],
            shared,
            private: members.length === 0 && !shared
        };
    }

    /** Who reads a discussion: its owner and every accepted member. */
    async discussionAudience(conversation) {
        const members = await db.all(
            `SELECT userId, userName FROM parlor_members
             WHERE conversationId = @conversationId ORDER BY joinedAt, userId`,
            { conversationId: conversation.id }
        );
        return {
            kind: 'discussion',
            ownerId: conversation.ownerId,
            ownerName: await this._displayName(conversation.ownerId),
            members: await this._namedMembers(members),
            memberIds: [conversation.ownerId, ...members.map(m => m.userId)],
            shared: false,
            private: members.length === 0
        };
    }

    /**
     * An audience names people, not ids: the stored member name first, then
     * the same nickname / principal lookup the project owner gets.
     */
    async _namedMembers(rows) {
        const out = [];
        for (const row of rows) {
            out.push({ userId: row.userId, userName: row.userName || await this._displayName(row.userId) });
        }
        return out;
    }

    async _displayName(userId) {
        if (!userId) return null;
        return (await require('./projectService')._displayName(userId)) || null;
    }

    // --- Actions -----------------------------------------------------------

    /**
     * Save an assistant reply as a personal note: curation `saved`, source
     * `user`, in the caller's own scope, with the message as provenance.
     * The caller may override title, text and tags; text is capped at the
     * note content limit and the result says whether it was trimmed.
     * @param {Object} params - { userId, conversationId, messageId, label?, content?, tags? }
     * @returns {Promise<{ note: Object, transfer: Object, truncated: boolean }>}
     */
    async saveMessageAsNote({ userId, conversationId, messageId, label = null, content = null, tags = [] } = {}) {
        const message = await this._requireAssistantMessage(userId, conversationId, messageId);
        const fullText = content !== null && content !== undefined
            ? String(content)
            : String(message.message || '');
        const trimmedText = fullText.trim();
        if (!trimmedText) {
            throw new KnowledgeTransferError(400, 'EMPTY', 'There is nothing to save in that answer.');
        }
        const truncated = trimmedText.length > MAX_CONTENT_LENGTH;
        const cleanLabel = String(label || '').trim()
            || suggestLabel(trimmedText, message.title ? `Answer from "${message.title}"` : 'Saved answer');
        const coords = personalCoords(userId);
        const note = await knowledgeGraphService.createUserNote({
            guildId: coords.guildId,
            userId,
            label: cleanLabel,
            content: trimmedText.slice(0, MAX_CONTENT_LENGTH),
            type: 'concept',
            tags: cleanTags(tags)
        });
        const transferId = await db.insert(
            `INSERT INTO knowledge_transfers
                (userId, sourceKind, sourceConversationId, sourceMessageId, sourceLabel,
                 targetKind, targetId, mode, copyNodeId, audienceJson)
             VALUES
                (@userId, 'chat_message', @conversationId, @messageId, @sourceLabel,
                 'note', @nodeId, 'copy', @nodeId, @audienceJson)`,
            {
                userId,
                conversationId: message.conversationId,
                messageId: message.id,
                sourceLabel: message.title || null,
                nodeId: note.id,
                audienceJson: JSON.stringify({ kind: 'personal', ownerId: userId, memberIds: [userId], shared: false })
            }
        );
        return {
            note,
            truncated,
            transfer: await this._transferById(transferId)
        };
    }

    /**
     * Add a personal note to a project the caller can see.
     *  - mode 'reference': only for a private project the caller owns; a
     *    ledger row, nothing written to the project scope.
     *  - mode 'copy': a snapshot node in PROJECT:<id>, tags copied; the
     *    response names the audience. Republishing updates the same copy.
     * @param {Object} params - { userId, nodeId, project, owner?, mode }
     */
    async addNoteToProject({ userId, nodeId, project, owner = null, mode = 'copy' } = {}) {
        const result = await db.transaction(() => this._addNoteToProject({ userId, nodeId, project, owner, mode }));
        if (result.mode === 'copy') {
            try {
                require('./eventBusService').publish('project-changed', {
                    userId, projectId: result.project.id, slug: result.project.slug, kind: 'knowledge'
                });
            } catch { /* cosmetic */ }
        }
        return result;
    }

    async _addNoteToProject({ userId, nodeId, project, owner, mode }) {
        const cleanMode = mode === 'reference' ? 'reference' : 'copy';
        const projectService = require('./projectService');
        const row = await projectService.resolveProject({ userId, project, owner });
        // Serialize transfers into this project, including first publication.
        // SQLite's write transaction already provides this exclusion.
        if (db.engine === 'postgres') {
            await db.get('SELECT id FROM observatory_projects WHERE id = @id FOR UPDATE', { id: row.id });
        }
        const note = await this._requirePersonalNote(userId, nodeId);
        const audience = await this.projectAudience(row);

        if (cleanMode === 'reference') {
            if (row.role !== 'owner' || !audience.private) {
                throw new KnowledgeTransferError(409, 'PROJECT_SHARED',
                    'This project has other readers, so a private reference would not be visible to them. Publish a copy instead.',
                    { audience });
            }
            const existing = await db.get(
                `SELECT id FROM knowledge_transfers
                 WHERE sourceNodeId = @nodeId AND targetKind = 'project' AND targetId = @projectId
                   AND mode = 'reference' AND userId = @userId`,
                { nodeId: note.id, projectId: row.id, userId }
            );
            const transferId = existing
                ? existing.id
                : await db.insert(
                    `INSERT INTO knowledge_transfers
                        (userId, sourceKind, sourceNodeId, sourceLabel, targetKind, targetId, mode, audienceJson)
                     VALUES
                        (@userId, 'note', @nodeId, @sourceLabel, 'project', @projectId, 'reference', @audienceJson)`,
                    {
                        userId, nodeId: note.id, sourceLabel: note.label, projectId: row.id,
                        audienceJson: JSON.stringify(audience)
                    }
                );
            return {
                mode: 'reference',
                project: this._projectShape(row),
                audience,
                transfer: await this._transferById(transferId),
                copy: null
            };
        }

        const coords = projectService.knowledgeCoords(row);
        const priorCopy = await db.get(
            `SELECT id, copyNodeId FROM knowledge_transfers
             WHERE sourceNodeId = @nodeId AND targetKind = 'project' AND targetId = @projectId
               AND mode = 'copy' AND copyNodeId IS NOT NULL`,
            { nodeId: note.id, projectId: row.id }
        );
        const clash = await knowledgeGraphService.getNode(coords.guildId, note.label, coords.scopeKey);
        if (clash && (!priorCopy || clash.id !== priorCopy.copyNodeId)) {
            throw new KnowledgeTransferError(409, 'CONFLICT',
                `The project already has a note called "${note.label}".`);
        }
        const upserted = priorCopy
            ? await knowledgeGraphService.updateScopedNote({
                ...coords, nodeId: priorCopy.copyNodeId, label: note.label,
                content: note.content, type: note.type, tags: note.tags
            })
            : await knowledgeGraphService.upsertNode({
            guildId: coords.guildId,
            scopeKey: coords.scopeKey,
            subjectType: 'USER',
            subjectId: row.ownerId,
            type: note.type || 'concept',
            label: note.label,
            content: note.content || null,
            salience: note.salience,
            confidence: note.confidence,
            source: 'user',
            curation: 'saved'
        });
        if (!upserted) {
            throw new KnowledgeTransferError(500, 'COPY_FAILED', 'The copy could not be written.');
        }
        await knowledgeGraphService.setTagsOnNode({
            guildId: coords.guildId,
            scopeKey: coords.scopeKey,
            label: note.label,
            tags: note.tags || []
        });
        let transferId;
        if (priorCopy) {
            transferId = priorCopy.id;
            await db.run(
                `UPDATE knowledge_transfers
                 SET copyNodeId = @copyNodeId, sourceLabel = @sourceLabel, audienceJson = @audienceJson,
                     createdAt = datetime('now')
                 WHERE id = @id`,
                { id: priorCopy.id, copyNodeId: upserted.id, sourceLabel: note.label, audienceJson: JSON.stringify(audience) }
            );
        } else {
            transferId = await db.insert(
                `INSERT INTO knowledge_transfers
                    (userId, sourceKind, sourceNodeId, sourceLabel, targetKind, targetId, mode, copyNodeId, audienceJson)
                 VALUES
                    (@userId, 'note', @nodeId, @sourceLabel, 'project', @projectId, 'copy', @copyNodeId, @audienceJson)`,
                {
                    userId, nodeId: note.id, sourceLabel: note.label, projectId: row.id,
                    copyNodeId: upserted.id, audienceJson: JSON.stringify(audience)
                }
            );
        }
        const copy = await db.get('SELECT id, type, label, content, source, curation, updatedAt FROM kg_nodes WHERE id = @id', { id: upserted.id });
        return {
            mode: 'copy',
            project: this._projectShape(row),
            audience,
            transfer: await this._transferById(transferId),
            copy: { ...copy, tags: note.tags || [] }
        };
    }

    /**
     * Post a note into a discussion the caller owns or joined, as a plain
     * transcript message from them. No persona turn runs.
     * @param {Object} params - { userId, userName?, nodeId, conversationId, requestId }
     */
    async useNoteInDiscussion({ userId, userName = null, nodeId, conversationId, requestId } = {}) {
        if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(requestId)) {
            throw new KnowledgeTransferError(400, 'BAD_REQUEST', 'A valid requestId is required.');
        }
        const parlorService = require('./parlorService');
        let posted = false;
        const result = await db.transaction(async () => {
            // The durable receipt and message commit together. An account-scoped
            // request lock also covers concurrent retries before a receipt exists.
            if (db.engine === 'postgres') {
                await db.rawQuery('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
                    [`knowledge-transfer:${userId}:${requestId}`]);
            }
            const prior = await db.get(
                'SELECT * FROM knowledge_transfers WHERE userId = @userId AND requestId = @requestId',
                { userId, requestId }
            );
            const note = prior ? null : await this._requirePersonalNote(userId, nodeId);
            const conversation = await parlorService.requireConversationAccess(userId, conversationId);
            let message;
            let transfer;
            if (prior) {
                if (prior.targetKind !== 'discussion' || prior.targetId !== Number(conversationId)
                    || prior.requestSourceNodeId !== Number(nodeId)) {
                    throw new KnowledgeTransferError(409, 'REQUEST_CONFLICT', 'This requestId was used for another transfer.');
                }
                message = await db.get(
                    'SELECT id, role, content, userId, userName, createdAt FROM parlor_messages WHERE id = @id AND conversationId = @conversationId',
                    { id: prior.copyMessageId, conversationId: conversation.id }
                );
                if (!message) throw new KnowledgeTransferError(410, 'MESSAGE_REMOVED', 'The previously posted message is no longer available.');
                transfer = await this._transferById(prior.id);
            } else {
                const audience = await this.discussionAudience(conversation);
                message = await parlorService.postMessage({
                    userId, userName, conversationId: conversation.id,
                    content: this.formatNoteMessage(note), notify: false
                });
                const transferId = await db.insert(
                    `INSERT INTO knowledge_transfers
                        (userId, sourceKind, sourceNodeId, sourceLabel, targetKind, targetId, mode,
                         copyMessageId, audienceJson, requestId, requestSourceNodeId)
                     VALUES
                        (@userId, 'note', @nodeId, @sourceLabel, 'discussion', @conversationId, 'copy',
                         @messageId, @audienceJson, @requestId, @nodeId)`,
                    {
                        userId, nodeId: note.id, sourceLabel: note.label, conversationId: conversation.id,
                        messageId: message.id, audienceJson: JSON.stringify(audience), requestId
                    }
                );
                transfer = await this._transferById(transferId);
                posted = true;
            }
            return {
                mode: 'copy',
                discussion: {
                    id: conversation.id, title: conversation.title || null,
                    ownerId: conversation.ownerId, projectId: conversation.projectId || null
                },
                audience: transfer.audience, message, transfer
            };
        });
        if (posted) await parlorService._notifyTurn(result.discussion.id, userId);
        return result;
    }

    /** The Markdown a shared note becomes in a transcript. */
    formatNoteMessage(note) {
        const lines = [`📝 **${note.label}**`];
        const body = String(note.content || '').trim();
        if (body) lines.push('', body.slice(0, DISCUSSION_MESSAGE_MAX));
        if (note.tags?.length) lines.push('', `_Tags: ${note.tags.join(', ')}_`);
        return lines.join('\n');
    }

    /**
     * Drop a reference the caller created. Copies are removed from the
     * destination side (projectService.deleteKnowledgeNote), never here.
     */
    async removeReference({ userId, transferId } = {}) {
        const result = await db.run(
            `DELETE FROM knowledge_transfers
             WHERE id = @id AND userId = @userId AND mode = 'reference'`,
            { id: Number(transferId), userId }
        );
        if (!result.changes) throw new KnowledgeTransferError(404, 'NOT_FOUND', 'No such reference.');
        return { removed: true };
    }

    // --- Reads: from the note ---------------------------------------------

    /**
     * Where a personal note has gone: every live destination, with what the
     * caller may do about each. Rows whose destination no longer exists are
     * excluded by joining the target. Feeds the "Shared to" line and the
     * deletion dialog (ADR 0010 §4).
     */
    async listNoteDestinations({ userId, nodeId } = {}) {
        const note = await this._requirePersonalNote(userId, nodeId, { knowledgeOnly: false });
        const origin = await db.get(
            `SELECT t.id, t.sourceConversationId, t.sourceMessageId, t.sourceLabel, t.createdAt, wc.title
             FROM knowledge_transfers t
             LEFT JOIN web_conversations wc ON wc.id = t.sourceConversationId AND wc.userId = t.userId
             WHERE t.targetKind = 'note' AND t.copyNodeId = @nodeId AND t.userId = @userId
             ORDER BY t.id ASC LIMIT 1`,
            { nodeId: note.id, userId }
        );
        const projectRows = await db.all(
            `SELECT t.id AS transferId, t.mode, t.copyNodeId, t.audienceJson, t.createdAt,
                    p.id AS projectId, p.slug, p.name, p.userId AS ownerId,
                    CASE WHEN p.userId = @userId THEN 'owner' ELSE 'collaborator' END AS role,
                    EXISTS (SELECT 1 FROM kg_nodes n WHERE n.id = t.copyNodeId) AS copyExists
             FROM knowledge_transfers t
             JOIN observatory_projects p ON p.id = t.targetId
             WHERE t.sourceNodeId = @nodeId AND t.targetKind = 'project'
               AND (t.mode = 'reference' OR t.copyNodeId IS NOT NULL)
             ORDER BY t.createdAt DESC, t.id DESC`,
            { nodeId: note.id, userId }
        );
        const discussionRows = await db.all(
            `SELECT t.id AS transferId, t.copyMessageId, t.audienceJson, t.createdAt,
                    c.id AS conversationId, c.title, c.ownerId, c.projectId,
                    EXISTS (SELECT 1 FROM parlor_messages m WHERE m.id = t.copyMessageId) AS messageExists
             FROM knowledge_transfers t
             JOIN parlor_conversations c ON c.id = t.targetId
             WHERE t.sourceNodeId = @nodeId AND t.targetKind = 'discussion'
             ORDER BY t.createdAt DESC, t.id DESC`,
            { nodeId: note.id }
        );
        return {
            note: { id: note.id, label: note.label, curation: note.curation },
            savedFrom: origin
                ? {
                    conversationId: origin.sourceConversationId,
                    messageId: origin.sourceMessageId,
                    title: origin.title || origin.sourceLabel || null,
                    createdAt: origin.createdAt
                }
                : null,
            projects: projectRows
                .filter(row => row.mode === 'reference' || row.copyExists)
                .map(row => ({
                    transferId: row.transferId,
                    mode: row.mode,
                    projectId: row.projectId,
                    slug: row.slug,
                    name: row.name,
                    ownerId: row.ownerId,
                    role: row.role,
                    copyNodeId: row.mode === 'copy' ? row.copyNodeId : null,
                    audience: parseAudience(row.audienceJson),
                    // The caller may remove a copy they published or one in a project they own;
                    // a reference is always theirs to drop.
                    canRemove: true,
                    createdAt: row.createdAt
                })),
            discussions: discussionRows.map(row => ({
                transferId: row.transferId,
                conversationId: row.conversationId,
                title: row.title || null,
                ownerId: row.ownerId,
                projectId: row.projectId || null,
                messageId: row.copyMessageId,
                messageExists: Boolean(row.messageExists),
                audience: parseAudience(row.audienceJson),
                // A message in a shared transcript stays; the dialog says so.
                canRemove: false,
                createdAt: row.createdAt
            }))
        };
    }

    // --- Reads: from the project -------------------------------------------

    /**
     * The references a reader may see in a project: only those they
     * created, whose source still exists in their own personal scope. Any
     * other reader gets an empty list - not a count, not a title.
     * @param {Object} params - { readerId, projectId }
     */
    async listProjectReferences({ readerId, projectId } = {}) {
        const coords = personalCoords(readerId);
        const rows = await db.all(
            `SELECT t.id AS transferId, t.userId, t.createdAt AS referencedAt,
                    n.id, n.type, n.label, n.content, n.salience, n.confidence, n.source, n.curation,
                    n.createdAt, n.updatedAt
             FROM knowledge_transfers t
             JOIN kg_nodes n ON n.id = t.sourceNodeId
             WHERE t.targetKind = 'project' AND t.targetId = @projectId AND t.mode = 'reference'
               AND t.userId = @readerId
               AND n.guildId = @guildId AND n.scopeKey = @scopeKey
             ORDER BY n.updatedAt DESC, n.id DESC`,
            { projectId: Number(projectId), readerId, ...coords }
        );
        const tagMap = await knowledgeGraphService.getTagsForNodes(rows.map(r => r.id));
        return rows.map(row => ({
            id: row.id,
            type: row.type,
            label: row.label,
            content: row.content || '',
            salience: row.salience,
            confidence: row.confidence,
            source: row.source,
            curation: row.curation,
            tags: tagMap.get(row.id) || [],
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            reference: {
                transferId: row.transferId,
                userId: row.userId,
                referencedAt: row.referencedAt
            }
        }));
    }

    /**
     * For project-scope nodes: which ones are published copies, by whom and
     * from which note. @returns {Map<number, { userId, sourceLabel, sourceNodeId, createdAt }>}
     */
    async copyOriginsForNodes(nodeIds) {
        const map = new Map();
        const ids = (nodeIds || []).map(Number).filter(Number.isFinite);
        if (!ids.length) return map;
        const { placeholders, params } = inList(ids);
        const rows = await db.all(
            `SELECT id, copyNodeId, userId, sourceLabel, sourceNodeId, createdAt
             FROM knowledge_transfers
             WHERE mode = 'copy' AND targetKind = 'project' AND copyNodeId IN (${placeholders})`,
            params
        );
        for (const row of rows) {
            map.set(row.copyNodeId, {
                transferId: row.id,
                userId: row.userId,
                sourceLabel: row.sourceLabel,
                sourceNodeId: row.sourceNodeId,
                createdAt: row.createdAt
            });
        }
        return map;
    }

    /** Who published a project copy, or null when the node is not a copy. */
    async publisherOf(nodeId) {
        const row = await db.get(
            `SELECT userId FROM knowledge_transfers
             WHERE mode = 'copy' AND targetKind = 'project' AND copyNodeId = @nodeId LIMIT 1`,
            { nodeId: Number(nodeId) }
        );
        return row?.userId || null;
    }

    // --- Shapes and privacy --------------------------------------------------

    _projectShape(row) {
        return { id: row.id, slug: row.slug, name: row.name, ownerId: row.ownerId, role: row.role };
    }

    async _transferById(id) {
        const row = await db.get('SELECT * FROM knowledge_transfers WHERE id = @id', { id: Number(id) });
        if (!row) return null;
        return {
            id: row.id,
            userId: row.userId,
            sourceKind: row.sourceKind,
            sourceConversationId: row.sourceConversationId,
            sourceMessageId: row.sourceMessageId,
            sourceNodeId: row.sourceNodeId,
            sourceLabel: row.sourceLabel,
            targetKind: row.targetKind,
            targetId: row.targetId,
            mode: row.mode,
            copyNodeId: row.copyNodeId,
            copyMessageId: row.copyMessageId,
            audience: parseAudience(row.audienceJson),
            createdAt: row.createdAt
        };
    }

    /** Transparency-report counts for one person. */
    async summarizeForUser(userId) {
        const row = await db.get(
            `SELECT
                 SUM(CASE WHEN sourceKind = 'chat_message' THEN 1 ELSE 0 END) AS savedAnswers,
                 SUM(CASE WHEN mode = 'reference' THEN 1 ELSE 0 END) AS referenceCount,
                 SUM(CASE WHEN mode = 'copy' AND targetKind = 'project' THEN 1 ELSE 0 END) AS publishedToProjects,
                 SUM(CASE WHEN targetKind = 'discussion' THEN 1 ELSE 0 END) AS publishedToDiscussions
             FROM knowledge_transfers WHERE userId = @userId`,
            { userId }
        );
        return {
            savedAnswers: Number(row?.savedAnswers) || 0,
            references: Number(row?.referenceCount) || 0,
            publishedToProjects: Number(row?.publishedToProjects) || 0,
            publishedToDiscussions: Number(row?.publishedToDiscussions) || 0
        };
    }

    /**
     * Erasure: every transfer the person made. Copies they published into
     * other people's projects are project data and stay (like note_knowledge
     * rows); copies in their own projects go with the PROJECT: scope.
     */
    async forgetUser(userId) {
        const result = await db.run('DELETE FROM knowledge_transfers WHERE userId = @userId', { userId });
        if (result.changes) logger.info?.(`[Transfers] Erased ${result.changes} transfer row(s) for ${userId}`);
        return { transfers: result.changes };
    }

    async countUserData(userId) {
        const row = await db.get(
            'SELECT COUNT(*) AS c FROM knowledge_transfers WHERE userId = @userId', { userId }
        );
        return { transfers: row?.c || 0 };
    }
}

module.exports = new KnowledgeTransferService();
module.exports.KnowledgeTransferService = KnowledgeTransferService;
module.exports.KnowledgeTransferError = KnowledgeTransferError;
module.exports.suggestLabel = suggestLabel;
