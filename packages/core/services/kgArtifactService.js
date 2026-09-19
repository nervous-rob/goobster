/**
 * Knowledge-graph artifacts: files stored on disk, indexed as kg_nodes type
 * `artifact` with metadata in kg_artifacts. Spec: documentation/user_knowledge_graph.md
 */

const db = require('../db');
const knowledgeGraphService = require('./knowledgeGraphService');
const artifactStorage = require('../utils/kgArtifactStorage');
const lookupRelevance = require('../utils/lookupRelevance');
const {
    MAX_ARTIFACT_BYTES,
    MAX_EXTRACTED_TEXT,
    MAX_ARTIFACTS_PER_SCOPE,
    classifyArtifactKind,
    sanitizeFilename
} = require('../config/kgArtifactConfig');

/** metadataJson keys a lookup may match on and show (never URLs or paths). */
const SEARCHABLE_METADATA_FIELDS = ['title', 'description', 'credit', 'license', 'provider'];

/** Default excerpt budget when a lookup describes an artifact. */
const LOOKUP_EXCERPT_CHARS = 320;
const LOOKUP_NOTES_CHARS = 240;

class KgArtifactError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'KgArtifactError';
    }
}

function clipText(text, max = MAX_EXTRACTED_TEXT) {
    const value = String(text || '').trim();
    if (value.length <= max) return value;
    return `${value.slice(0, max - 20).trim()}\n… [truncated]`;
}

async function extractTextFromBuffer({ buffer, name, mimeType, artifactKind }) {
    const kind = artifactKind || classifyArtifactKind({ name, mimeType });
    if (kind === 'image') return null;

    if (kind === 'pdf') {
        try {
            const { PDFParse } = require('pdf-parse');
            const parser = new PDFParse({ data: buffer });
            try {
                const result = await parser.getText();
                const text = String(result?.text || '').trim();
                if (!text) throw new KgArtifactError('EMPTY_PDF', 'No extractable text in that PDF.');
                return clipText(text);
            } finally {
                await parser.destroy().catch(() => {});
            }
        } catch (error) {
            if (error instanceof KgArtifactError) throw error;
            throw new KgArtifactError('PDF_PARSE_FAILED', `Could not read PDF: ${error.message}`);
        }
    }

    const asText = buffer.toString('utf8');
    if (asText.includes('\u0000')) {
        throw new KgArtifactError('BINARY', 'That file looks binary and cannot be stored as text.');
    }
    return clipText(asText);
}

async function resolveAttachmentPayload(attachment) {
    if (!attachment) throw new KgArtifactError('MISSING', 'No attachment provided.');

    let buffer = attachment.buffer || null;
    let content = attachment.content != null ? String(attachment.content) : null;

    if (!buffer && attachment.path) {
        const fs = require('node:fs');
        if (!fs.existsSync(attachment.path)) {
            throw new KgArtifactError('MISSING', 'Attachment file no longer exists.');
        }
        buffer = fs.readFileSync(attachment.path);
    }

    if (!buffer && content != null) {
        buffer = Buffer.from(content, 'utf8');
    }

    if (!buffer || buffer.length === 0) {
        throw new KgArtifactError('EMPTY', 'Attachment has no content.');
    }
    if (buffer.length > MAX_ARTIFACT_BYTES) {
        throw new KgArtifactError('TOO_LARGE', `Attachment exceeds ${Math.round(MAX_ARTIFACT_BYTES / (1024 * 1024))}MB limit.`);
    }

    const name = sanitizeFilename(attachment.name || 'attachment');
    const mimeType = attachment.mimeType || 'application/octet-stream';
    const artifactKind = attachment.artifactKind || classifyArtifactKind({ name, mimeType });

    if (content == null && artifactKind !== 'image') {
        content = await extractTextFromBuffer({ buffer, name, mimeType, artifactKind });
    }

    return { buffer, content, name, mimeType, artifactKind };
}

class KgArtifactService {
    async countScope(guildId, scopeKey) {
        return (await db.get(
            'SELECT COUNT(*) AS c FROM kg_artifacts WHERE guildId = @guildId AND scopeKey = @scopeKey',
            { guildId, scopeKey }
        )).c;
    }

    async getByNodeId(nodeId) {
        return await db.get('SELECT * FROM kg_artifacts WHERE nodeId = @nodeId', { nodeId });
    }

    async getByLabel({ guildId, scopeKey, label }) {
        const node = await knowledgeGraphService.getNode(guildId, label, scopeKey);
        if (!node || node.type !== 'artifact') return null;
        const artifact = await this.getByNodeId(node.id);
        return artifact ? { node, artifact } : null;
    }

    /**
     * Save an attachment as a KG artifact node.
     */
    async saveArtifact({
        guildId,
        userId,
        label,
        summary = null,
        attachment,
        tags = [],
        salience = 0.7,
        confidence = 0.85,
        channelId = null,
        messageId = null,
        metadata = null,
        confirm = false
    } = {}) {
        if (!confirm) {
            throw new KgArtifactError(
                'CONFIRM_REQUIRED',
                'Ask the user before saving, then call saveArtifact again with confirm=true.'
            );
        }
        if (!guildId || !userId) {
            throw new KgArtifactError('SCOPE', 'Artifacts require a conversation scope and author.');
        }

        const cleanLabel = String(label || '').trim();
        if (!cleanLabel) throw new KgArtifactError('LABEL', 'A short label is required.');

        const scopeKey = knowledgeGraphService.resolveScopeKey({
            subjectType: 'USER',
            subjectId: userId
        });

        const count = await this.countScope(guildId, scopeKey);
        if (count >= MAX_ARTIFACTS_PER_SCOPE) {
            throw new KgArtifactError('CAP', 'Artifact storage cap reached for this user.');
        }

        const payload = await resolveAttachmentPayload(attachment);
        const stored = artifactStorage.saveBuffer({
            guildId,
            authorId: userId,
            originalName: payload.name,
            buffer: payload.buffer
        });

        const nodeContent = clipText(
            summary
            || payload.content
            || `Saved file ${payload.name} (${payload.artifactKind}).`,
            MAX_EXTRACTED_TEXT
        );

        const node = await knowledgeGraphService.upsertNode({
            guildId,
            scopeKey,
            subjectType: 'USER',
            subjectId: userId,
            type: 'artifact',
            label: cleanLabel,
            content: nodeContent,
            salience,
            confidence,
            source: 'tool'
        });
        if (!node) throw new KgArtifactError('NODE', 'Could not create artifact node.');

        // A re-saved label replaces the previous file row (upsertNode kept
        // the node), so a repeated "find pictures of X" never orphans rows.
        await db.run('DELETE FROM kg_artifacts WHERE nodeId = @nodeId', { nodeId: node.id });
        const artifactId = await db.insert(
            `INSERT INTO kg_artifacts (
                nodeId, guildId, scopeKey, authorId, originalName, mimeType, artifactKind,
                relativePath, sizeBytes, contentHash, extractedText, metadataJson, channelId, messageId
             ) VALUES (
                @nodeId, @guildId, @scopeKey, @authorId, @originalName, @mimeType, @artifactKind,
                @relativePath, @sizeBytes, @contentHash, @extractedText, @metadataJson, @channelId, @messageId
             )`,
            {
                nodeId: node.id,
                guildId,
                scopeKey,
                authorId: userId,
                originalName: payload.name,
                mimeType: payload.mimeType,
                artifactKind: payload.artifactKind,
                relativePath: stored.relativePath,
                sizeBytes: stored.sizeBytes,
                contentHash: stored.contentHash,
                extractedText: payload.content,
                metadataJson: metadata && typeof metadata === 'object' ? JSON.stringify(metadata) : null,
                channelId,
                messageId
            }
        );

        await knowledgeGraphService.addProvenance({
            nodeId: node.id,
            sourceKind: 'artifact',
            sourceId: Number(artifactId)
        });
        await knowledgeGraphService.addProvenance({
            nodeId: node.id,
            sourceKind: 'tool',
            sourceId: null
        });

        if (Array.isArray(tags) && tags.length > 0) {
            await knowledgeGraphService.addTagsToNode({
                guildId,
                scopeKey,
                label: cleanLabel,
                tags
            });
        }

        return {
            nodeId: node.id,
            artifactId: Number(artifactId),
            label: cleanLabel,
            fileName: payload.name,
            artifactKind: payload.artifactKind,
            mimeType: payload.mimeType,
            sizeBytes: stored.sizeBytes,
            relativePath: stored.relativePath,
            absolutePath: stored.absolutePath
        };
    }

    async readArtifactContent({ guildId, scopeKey, label, maxChars = MAX_EXTRACTED_TEXT }) {
        const row = await this.getByLabel({ guildId, scopeKey, label });
        if (!row) return null;

        if (row.artifact.extractedText) {
            return clipText(row.artifact.extractedText, maxChars);
        }

        const buffer = artifactStorage.readBuffer(row.artifact.relativePath);
        if (!buffer) return row.node.content || null;

        if (row.artifact.artifactKind === 'image') {
            return row.node.content || `[image artifact: ${row.artifact.originalName}]`;
        }

        try {
            const text = await extractTextFromBuffer({
                buffer,
                name: row.artifact.originalName,
                mimeType: row.artifact.mimeType,
                artifactKind: row.artifact.artifactKind
            });
            return clipText(text, maxChars);
        } catch {
            return row.node.content || null;
        }
    }

    /**
     * The intentionally searchable origin fields of a found file (title,
     * description, credit, license, provider). URLs, paths, and timestamps
     * in metadataJson are deliberately not part of this text.
     * @param {Object} row - artifact row with metadataJson
     * @returns {string}
     */
    searchableMetadata(row) {
        const meta = this.parseMetadata(row);
        if (!meta) return '';
        return SEARCHABLE_METADATA_FIELDS
            .map(key => meta[key])
            .filter(v => typeof v === 'string' && v.trim())
            .join('\n');
    }

    /**
     * Search artifact nodes by label, notes, file name, extracted text, and
     * the searchable origin metadata of found files. Purely lexical (works
     * with no embedding backend and the moment a file is saved); ranked by
     * query relevance first (exact label/file name > strong label match >
     * whole phrase / every term > partial), salience second.
     *
     * Returned rows carry `relevance`, `relevanceTier`, and `matchedTerms`.
     */
    async searchArtifacts({ guildId, scopeKey, query, limit = 6, kind = null }) {
        const terms = lookupRelevance.queryTerms(query);
        const phrase = lookupRelevance.normalizeText(query);
        if (terms.length === 0 && phrase.length < 2) return [];

        const hit = (i) => `(n.label LIKE @t${i} OR n.content LIKE @t${i} OR a.extractedText LIKE @t${i} OR a.originalName LIKE @t${i} OR a.metadataJson LIKE @t${i})`;
        const clauses = terms.map((_, i) => hit(i));
        // A short query ("go.md", "q3") has no 3-letter term; the phrase
        // clause still lets an exact file name or label resolve.
        clauses.push('(n.label LIKE @phrase OR a.originalName LIKE @phrase)');
        const termHits = terms.length > 0
            ? terms.map((_, i) => `(CASE WHEN ${hit(i)} THEN 1 ELSE 0 END)`).join(' + ')
            : '0';
        const cap = Math.max(1, Number(limit) || 6);
        const params = { guildId, scopeKey, fetch: Math.min(120, Math.max(cap * 6, 30)), phrase: `%${phrase}%` };
        terms.forEach((t, i) => { params[`t${i}`] = `%${t}%`; });
        let kindClause = '';
        if (kind) {
            kindClause = ' AND a.artifactKind = @kind';
            params.kind = kind;
        }

        const rows = await db.all(
            `SELECT n.*, a.originalName, a.artifactKind, a.mimeType, a.sizeBytes,
                    a.extractedText, a.relativePath, a.metadataJson,
                    (CASE WHEN n.label LIKE @phrase OR a.originalName LIKE @phrase THEN 1 ELSE 0 END) AS phraseHit,
                    (${termHits}) AS termHits
             FROM kg_nodes n
             JOIN kg_artifacts a ON a.nodeId = n.id
             WHERE n.guildId = @guildId AND n.scopeKey = @scopeKey AND n.type = 'artifact'
               AND (${clauses.join(' OR ')})${kindClause}
             ORDER BY phraseHit DESC, termHits DESC, n.salience DESC, n.updatedAt DESC, n.id ASC
             LIMIT @fetch`,
            params
        );

        const ranked = [];
        for (const row of rows) {
            const { score, tier, matchedTerms } = lookupRelevance.scoreCandidate({
                query,
                terms,
                label: row.label,
                fileName: row.originalName,
                texts: [row.content, row.extractedText, this.searchableMetadata(row)],
                salience: row.salience,
                confidence: row.confidence
            });
            // A row that only matched inside a URL or timestamp of the
            // metadata JSON is noise, not a hit.
            if (score <= 0) continue;
            const out = { ...row, relevance: score, relevanceTier: tier, matchedTerms };
            delete out.phraseHit;
            delete out.termHits;
            ranked.push(out);
        }
        ranked.sort(lookupRelevance.compareRanked);
        return ranked.slice(0, cap);
    }

    /**
     * Most recent artifacts in a scope (optionally one kind) - the browse
     * path behind "show me the files you saved".
     */
    async listArtifacts({ guildId, scopeKey, limit = 6, kind = null }) {
        const params = { guildId, scopeKey, limit };
        let kindClause = '';
        if (kind) {
            kindClause = ' AND a.artifactKind = @kind';
            params.kind = kind;
        }
        return await db.all(
            `SELECT n.*, a.originalName, a.artifactKind, a.mimeType, a.sizeBytes,
                    a.extractedText, a.relativePath, a.metadataJson
             FROM kg_nodes n
             JOIN kg_artifacts a ON a.nodeId = n.id
             WHERE n.guildId = @guildId AND n.scopeKey = @scopeKey AND n.type = 'artifact'${kindClause}
             ORDER BY a.createdAt DESC, n.id DESC
             LIMIT @limit`,
            params
        );
    }

    /** Parse the stored origin metadata of an artifact row (never throws). */
    parseMetadata(row) {
        if (!row?.metadataJson) return null;
        try {
            const parsed = JSON.parse(row.metadataJson);
            return parsed && typeof parsed === 'object' ? parsed : null;
        } catch {
            return null;
        }
    }

    /** Absolute on-disk path for an artifact row, or null when the file is gone. */
    resolvePath(row) {
        const abs = artifactStorage.resolveRelativePath(row?.relativePath);
        if (!abs) return null;
        const fs = require('node:fs');
        return fs.existsSync(abs) ? abs : null;
    }

    /**
     * One bounded, model-facing line per artifact for a lookup result:
     * label, file name and kind, the notes, an excerpt of the extracted
     * text centred on the query terms, and the exact `showSavedFiles`
     * query that re-displays it. Never the whole document, never a path.
     *
     * @param {Array<Object>} rows - searchArtifacts()/listArtifacts() rows
     * @param {{ query?: string, maxChars?: number, excerptChars?: number,
     *   topExcerptChars?: number }} [opts]
     * @returns {string|null}
     */
    formatArtifactLines(rows, {
        query = '',
        maxChars = 1200,
        excerptChars = LOOKUP_EXCERPT_CHARS,
        topExcerptChars = null
    } = {}) {
        if (!rows?.length) return null;
        const terms = lookupRelevance.queryTerms(query);
        let used = 0;
        const lines = [];
        rows.forEach((row, index) => {
            const line = this.describeArtifactLine(row, {
                query,
                terms,
                excerptChars: index === 0 && topExcerptChars ? topExcerptChars : excerptChars
            });
            if (used + line.length > maxChars && lines.length > 0) return;
            lines.push(line);
            used += line.length;
        });
        return lines.join('\n');
    }

    describeArtifactLine(row, { query = '', terms = null, excerptChars = LOOKUP_EXCERPT_CHARS } = {}) {
        const notes = String(row.content || '').trim();
        const extracted = String(row.extractedText || '').trim();
        // With no summary the node body is just the head of the extracted
        // text (and a found image's text IS its notes) - show it once.
        const notesAreText = Boolean(notes) && Boolean(extracted)
            && (extracted === notes || extracted.startsWith(notes.replace(/\n?… \[truncated\]$/, '')));
        const summary = !notesAreText && notes
            ? lookupRelevance.excerptAround(notes, { query, terms, maxChars: LOOKUP_NOTES_CHARS })
            : '';
        const excerpt = extracted
            ? lookupRelevance.excerptAround(extracted, { query, terms, maxChars: excerptChars })
            : '';

        const kind = row.artifactKind || 'file';
        const fileBit = row.originalName ? `, file ${row.originalName}` : '';
        const idBit = row.id != null ? `, id ${row.id}` : '';
        const parts = [`- [saved artifact/${kind}] "${row.label}" (${kind}${fileBit}${idBit})`];
        if (summary) parts.push(`notes: ${summary}`);
        if (excerpt) parts.push(`${kind === 'image' ? 'about' : 'excerpt'}: ${excerpt}`);
        parts.push(`show again with showSavedFiles(query="${String(row.label).replace(/"/g, '\'')}")`);
        return parts.join(' — ');
    }

    async deleteAuthorFiles(guildId, authorId) {
        return artifactStorage.deleteAuthorArtifacts(guildId, authorId);
    }

    async deleteGuildFiles(guildId) {
        return artifactStorage.deleteGuildArtifacts(guildId);
    }
}

module.exports = new KgArtifactService();
module.exports.KgArtifactError = KgArtifactError;
