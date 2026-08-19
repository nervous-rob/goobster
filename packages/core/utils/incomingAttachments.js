/**
 * Build normalized incoming attachment descriptors for the saveArtifact tool.
 */

const {
    MAX_INCOMING_ATTACHMENTS,
    classifyArtifactKind,
    sanitizeFilename
} = require('../config/kgArtifactConfig');

function decodeDataUrlImage(dataUrl) {
    const match = /^data:(image\/(?:png|jpe?g|webp|gif));base64,(.+)$/i.exec(String(dataUrl || ''));
    if (!match) return null;
    try {
        const buffer = Buffer.from(match[2], 'base64');
        if (buffer.length === 0) return null;
        const ext = match[1].includes('png') ? 'png'
            : match[1].includes('webp') ? 'webp'
                : match[1].includes('gif') ? 'gif'
                    : 'jpg';
        return {
            name: `upload.${ext}`,
            mimeType: match[1].toLowerCase(),
            buffer,
            content: null,
            artifactKind: 'image'
        };
    } catch {
        return null;
    }
}

function fromTextFile({ name, content }) {
    const cleanName = sanitizeFilename(name);
    return {
        name: cleanName,
        mimeType: 'text/plain',
        buffer: null,
        content: String(content || ''),
        artifactKind: classifyArtifactKind({ name: cleanName, mimeType: 'text/plain' })
    };
}

function fromDownloaded({ name, mimeType, buffer, content = null }) {
    const cleanName = sanitizeFilename(name);
    return {
        name: cleanName,
        mimeType: mimeType || 'application/octet-stream',
        buffer: buffer || null,
        content: content != null ? String(content) : null,
        artifactKind: classifyArtifactKind({ name: cleanName, mimeType })
    };
}

function fromSavedPath({ name, path: filePath, mimeType = null }) {
    const cleanName = sanitizeFilename(name || filePath);
    return {
        name: cleanName,
        mimeType: mimeType || 'application/octet-stream',
        path: filePath,
        buffer: null,
        content: null,
        artifactKind: classifyArtifactKind({ name: cleanName, mimeType })
    };
}

/**
 * @param {Array} items
 * @returns {Array<{index: number, name: string, mimeType: string, artifactKind: string, buffer?: Buffer, content?: string, path?: string}>}
 */
function normalizeIncomingAttachments(items) {
    if (!Array.isArray(items)) return [];
    return items.slice(0, MAX_INCOMING_ATTACHMENTS).map((item, index) => ({
        index,
        name: item.name,
        mimeType: item.mimeType,
        artifactKind: item.artifactKind || classifyArtifactKind(item),
        buffer: item.buffer || null,
        content: item.content != null ? String(item.content) : null,
        path: item.path || null
    }));
}

function describeIncomingAttachments(attachments) {
    const list = normalizeIncomingAttachments(attachments);
    if (list.length === 0) return null;
    const lines = list.map(a => {
        const kind = a.artifactKind || 'file';
        const sizeHint = a.content
            ? `${a.content.length} chars`
            : a.buffer
                ? `${a.buffer.length} bytes`
                : a.path
                    ? 'on disk'
                    : 'attached';
        return `- [${a.index}] ${a.name} (${kind}, ${sizeHint})`;
    });
    return `ATTACHMENTS THIS TURN (save durable ones with saveArtifact; ask before saving if unsure):
${lines.join('\n')}`;
}

module.exports = {
    decodeDataUrlImage,
    fromTextFile,
    fromDownloaded,
    fromSavedPath,
    normalizeIncomingAttachments,
    describeIncomingAttachments
};
