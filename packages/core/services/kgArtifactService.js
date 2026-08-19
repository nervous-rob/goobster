/**
 * Knowledge-graph artifacts: files stored on disk, indexed as kg_nodes type
 * `artifact` with metadata in kg_artifacts. Spec: documentation/user_knowledge_graph.md
 */

const db = require('../db');
const knowledgeGraphService = require('./knowledgeGraphService');
const artifactStorage = require('../utils/kgArtifactStorage');
const {
    MAX_ARTIFACT_BYTES,
    MAX_EXTRACTED_TEXT,
    MAX_ARTIFACTS_PER_SCOPE,
    classifyArtifactKind,
    sanitizeFilename
} = require('../config/kgArtifactConfig');

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

        const artifactId = await db.insert(
            `INSERT INTO kg_artifacts (
                nodeId, guildId, scopeKey, authorId, originalName, mimeType, artifactKind,
                relativePath, sizeBytes, contentHash, extractedText, channelId, messageId
             ) VALUES (
                @nodeId, @guildId, @scopeKey, @authorId, @originalName, @mimeType, @artifactKind,
                @relativePath, @sizeBytes, @contentHash, @extractedText, @channelId, @messageId
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
            artifactKind: payload.artifactKind
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
     * Search artifact nodes by label, summary, or extracted text.
     */
    async searchArtifacts({ guildId, scopeKey, query, limit = 6 }) {
        const terms = String(query || '')
            .toLowerCase()
            .split(/[^\p{L}\p{N}]+/u)
            .filter(t => t.length >= 3)
            .slice(0, 8);
        if (terms.length === 0) return [];

        const clauses = terms.map((_, i) => `(n.label LIKE @t${i} OR n.content LIKE @t${i} OR a.extractedText LIKE @t${i} OR a.originalName LIKE @t${i})`);
        const params = { guildId, scopeKey, limit };
        terms.forEach((t, i) => { params[`t${i}`] = `%${t}%`; });

        return await db.all(
            `SELECT n.*, a.originalName, a.artifactKind, a.extractedText, a.relativePath
             FROM kg_nodes n
             JOIN kg_artifacts a ON a.nodeId = n.id
             WHERE n.guildId = @guildId AND n.scopeKey = @scopeKey AND n.type = 'artifact'
               AND (${clauses.join(' OR ')})
             ORDER BY n.salience DESC, n.updatedAt DESC
             LIMIT @limit`,
            params
        );
    }

    formatArtifactLines(rows, { maxChars = 1200 } = {}) {
        if (!rows?.length) return null;
        let used = 0;
        const lines = [];
        for (const row of rows) {
            const excerptSource = row.extractedText || row.content || '';
            const excerpt = excerptSource
                ? clipText(excerptSource, Math.min(400, maxChars - used))
                : '';
            const fileBit = row.originalName ? ` file=${row.originalName}` : '';
            const line = `- [artifact/${row.artifactKind || 'file'}] "${row.label}"${fileBit}${excerpt ? `: ${excerpt}` : ''}`;
            if (used + line.length > maxChars && lines.length > 0) break;
            lines.push(line);
            used += line.length;
        }
        return lines.join('\n');
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
