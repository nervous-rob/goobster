/**
 * Download Discord CDN attachments for the saveArtifact tool pipeline.
 */

const axios = require('axios');
const { fromDownloaded } = require('./incomingAttachments');
const { MAX_ARTIFACT_BYTES, MAX_INCOMING_ATTACHMENTS } = require('../config/kgArtifactConfig');

async function downloadDiscordAttachments(message, { maxBytes = MAX_ARTIFACT_BYTES, maxFiles = MAX_INCOMING_ATTACHMENTS } = {}) {
    if (!message?.attachments?.size) return [];

    const results = [];
    for (const attachment of [...message.attachments.values()].slice(0, maxFiles)) {
        try {
            const response = await axios.get(attachment.url, {
                responseType: 'arraybuffer',
                timeout: 30_000,
                maxContentLength: maxBytes,
                maxBodyLength: maxBytes,
                headers: { 'User-Agent': 'GoobsterBot/1.0' }
            });
            const buffer = Buffer.from(response.data);
            if (buffer.length === 0 || buffer.length > maxBytes) continue;

            if (attachment.contentType?.startsWith('image/')) {
                results.push(fromDownloaded({
                    name: attachment.name || 'image.png',
                    mimeType: attachment.contentType,
                    buffer
                }));
                continue;
            }

            let content = null;
            if (attachment.contentType?.startsWith('text/')
                || /\.(md|markdown|txt|csv|json|ya?ml|toml|js|ts|py|go|rs|java|c|cpp|h|cs|rb|php|sh|xml|html|css|sql)$/i.test(attachment.name || '')) {
                const text = buffer.toString('utf8');
                if (!text.includes('\u0000')) content = text;
            }

            if (attachment.contentType === 'application/pdf' || /\.pdf$/i.test(attachment.name || '')) {
                results.push(fromDownloaded({
                    name: attachment.name || 'document.pdf',
                    mimeType: attachment.contentType || 'application/pdf',
                    buffer
                }));
                continue;
            }

            results.push(fromDownloaded({
                name: attachment.name || 'attachment',
                mimeType: attachment.contentType || 'application/octet-stream',
                buffer,
                content
            }));
        } catch (error) {
            console.warn('[DiscordAttachments] download failed:', attachment.name, error.message);
        }
    }
    return results;
}

module.exports = { downloadDiscordAttachments };
