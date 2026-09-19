/**
 * Files found on the web, kept in the knowledge base, shown in chat.
 *
 * The behaviour behind the findImages / fetchWebFile / showSavedFiles tools:
 *
 *   download(url)   - SSRF-hardened transfer built from the safeFetch stages
 *                     (https only, public addresses only, DNS pinned, byte
 *                     cap on RECEIVED bytes, bounded redirects that are each
 *                     re-vetted). Content is sniffed, never trusted.
 *   saveFound(...)  - persists the bytes as a knowledge-graph artifact node
 *                     (kgArtifactService) with the model's notes as the
 *                     node body and the origin (source URL, page, credit,
 *                     license, provider) in kg_artifacts.metadataJson, so a
 *                     later "show me that jacket again" resolves through
 *                     the same graph the rest of memory uses.
 *   recall(...)     - finds saved artifacts by text (or lists recent ones)
 *                     and resolves the files still on disk.
 *   preview(...)    - the compact description a tool result hands the model
 *                     (CSV shape + first rows, text head, image caption).
 *
 * The model proposes a URL / query / notes; this service decides what may
 * be fetched, how much, and how it is stored. All limits live in
 * config/fileDiscoveryConfig.js.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const db = require('../db');
const safeFetch = require('../utils/safeFetch');
const kgArtifactService = require('./kgArtifactService');
const knowledgeGraphService = require('./knowledgeGraphService');
const { classifyArtifactKind, sanitizeFilename, extensionOf } = require('../config/kgArtifactConfig');
const config = require('../config/fileDiscoveryConfig');

class FileDiscoveryError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'FileDiscoveryError';
        this.code = code;
    }
}

/** Kinds a saved file can be shown as by the portal (beyond the artifact kinds). */
const DISPLAY_KINDS = ['image', 'csv', 'markdown', 'code', 'document', 'pdf', 'other'];

const CSV_EXTENSIONS = new Set(['csv', 'tsv']);
const ACTIVE_DOCUMENT_EXTENSIONS = new Set(['html', 'htm', 'xhtml', 'xht', 'svg', 'svgz']);

function sniffImageMime(buffer) {
    if (!buffer || buffer.length < 12) return null;
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
    if (buffer.subarray(0, 6).toString('ascii') === 'GIF87a'
        || buffer.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif';
    if (buffer.subarray(0, 4).toString('ascii') === 'RIFF'
        && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
    if (buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
        const brand = buffer.subarray(8, 12).toString('ascii');
        if (brand === 'avif' || brand === 'avis') return 'image/avif';
    }
    return null;
}

function looksLikeHtml(buffer) {
    const head = buffer.subarray(0, 512).toString('utf8').trimStart().toLowerCase();
    return head.startsWith('<!doctype html') || head.startsWith('<html') || /^<\?xml[^>]*>\s*<(!doctype\s+)?html/.test(head);
}

function looksLikeSvg(buffer) {
    const head = buffer.subarray(0, 512).toString('utf8').trimStart().toLowerCase();
    return head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'));
}

/** Display kind for the portal renderer: CSV/TSV gets its own table card. */
function displayKindFor({ artifactKind, fileName }) {
    if (artifactKind === 'document' && CSV_EXTENSIONS.has(extensionOf(fileName))) return 'csv';
    return DISPLAY_KINDS.includes(artifactKind) ? artifactKind : 'other';
}

function fileNameFromUrl(url) {
    try {
        const pathname = decodeURIComponent(new URL(url).pathname);
        const base = pathname.split('/').filter(Boolean).pop() || '';
        return base.length > 0 && base.length <= 160 ? base : '';
    } catch {
        return '';
    }
}

function slug(text, fallback = 'file') {
    const value = String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    return value || fallback;
}

/**
 * Minimal RFC 4180 parser for previews: quoted fields, escaped quotes,
 * CRLF. Bounded to `maxRows` data rows so a huge file costs nothing.
 */
function parseDelimited(text, { delimiter = ',', maxRows = Infinity } = {}) {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    let i = 0;
    const src = String(text || '');
    while (i < src.length) {
        const ch = src[i];
        if (quoted) {
            if (ch === '"') {
                if (src[i + 1] === '"') { field += '"'; i += 2; continue; }
                quoted = false; i += 1; continue;
            }
            field += ch; i += 1; continue;
        }
        if (ch === '"') { quoted = true; i += 1; continue; }
        if (ch === delimiter) { row.push(field); field = ''; i += 1; continue; }
        if (ch === '\r') { i += 1; continue; }
        if (ch === '\n') {
            row.push(field); field = '';
            if (row.some(cell => cell !== '')) rows.push(row);
            row = [];
            if (rows.length > maxRows) break;
            i += 1; continue;
        }
        field += ch; i += 1;
    }
    if (field !== '' || row.length > 0) {
        row.push(field);
        if (row.some(cell => cell !== '')) rows.push(row);
    }
    return rows;
}

function countLines(text) {
    let n = 0;
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n += 1;
    if (text.length > 0 && text[text.length - 1] !== '\n') n += 1;
    return n;
}

class FileDiscoveryService {
    /**
     * @param {Object} [deps] - injectable safeFetch stages (tests)
     */
    constructor(deps = {}) {
        this._assessUrl = deps.assessUrl || safeFetch.assessUrl;
        this._resolvePinned = deps.resolvePinned || safeFetch.resolvePinned;
        this._fetchToFile = deps.fetchToFile || safeFetch.fetchToFile;
    }

    /**
     * Download one file trusting nothing about it.
     * @param {string} rawUrl
     * @param {{ maxBytes?: number, timeoutMs?: number, allowedContentTypes?: string[] }} [opts]
     * @returns {Promise<{ buffer: Buffer, contentType: string|null, finalUrl: string, hops: number }>}
     */
    async download(rawUrl, {
        maxBytes = config.MAX_FILE_BYTES,
        timeoutMs = config.FETCH_TIMEOUT_MS,
        allowedContentTypes = []
    } = {}) {
        let current = String(rawUrl || '').trim();
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-fetch-'));
        const destPath = path.join(tmpDir, 'download');
        try {
            for (let hop = 0; hop <= config.MAX_REDIRECTS; hop++) {
                const { url, host } = this._assessUrl(current);
                const { address } = await this._resolvePinned(host);
                const result = await this._fetchToFile({
                    url,
                    address,
                    destPath,
                    maxBytes,
                    timeoutMs,
                    allowedContentTypes,
                    reportRedirects: true,
                    headers: { 'User-Agent': config.USER_AGENT }
                });
                if (result.redirectTo) {
                    current = result.redirectTo;
                    continue;
                }
                const buffer = fs.readFileSync(destPath);
                if (buffer.length === 0) throw new FileDiscoveryError('EMPTY', 'The download was empty.');
                return { buffer, contentType: result.contentType, finalUrl: url.toString(), hops: hop };
            }
            throw new FileDiscoveryError('TOO_MANY_REDIRECTS',
                `Gave up after ${config.MAX_REDIRECTS} redirects - propose the final URL directly.`);
        } catch (error) {
            if (error instanceof FileDiscoveryError) throw error;
            if (error?.code) throw new FileDiscoveryError(error.code, error.message);
            throw new FileDiscoveryError('FETCH_FAILED', error?.message || 'Download failed.');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    }

    /**
     * Decide what a downloaded body IS: sniffed image type wins over the
     * declared header, web pages and SVG are refused (they would execute
     * on the app origin when served back), octet-stream is accepted only
     * for known data extensions. Returns the storage name and kinds.
     */
    classify({ url, contentType, buffer, preferredName = null }) {
        const declared = String(contentType || '').split(';')[0].trim().toLowerCase() || null;
        const sniffed = sniffImageMime(buffer);
        if (!sniffed && looksLikeHtml(buffer)) {
            throw new FileDiscoveryError('IS_WEB_PAGE',
                'That URL is a web page, not a file. Search or read it instead; only downloadable files (images, CSV, JSON, text, Markdown, PDF, code) can be saved.');
        }
        if (!sniffed && looksLikeSvg(buffer)) {
            throw new FileDiscoveryError('TYPE_REFUSED', 'SVG files are not accepted (they can carry scripts). Ask for a PNG or JPEG instead.');
        }
        if (declared && config.REFUSED_CONTENT_TYPES.includes(declared) && !sniffed) {
            throw new FileDiscoveryError('TYPE_REFUSED', `Files of type ${declared} are not accepted.`);
        }

        const urlName = fileNameFromUrl(url);
        const urlExt = extensionOf(urlName);
        let mimeType = sniffed || declared;
        if (!mimeType || mimeType === 'application/octet-stream') {
            if (!config.OCTET_STREAM_EXTENSIONS.has(urlExt)) {
                throw new FileDiscoveryError('TYPE_UNKNOWN',
                    `The server did not say what kind of file that is (${declared || 'no content type'}) and the URL has no recognizable extension.`);
            }
            mimeType = config.MIME_BY_EXTENSION[urlExt] || 'text/plain';
        }
        if (!sniffed && !config.ALLOWED_CONTENT_TYPES.includes(mimeType)
            && !mimeType.startsWith('text/')) {
            throw new FileDiscoveryError('TYPE_REFUSED', `Files of type ${mimeType} are not accepted.`);
        }
        if (mimeType.startsWith('image/') && !sniffed) {
            throw new FileDiscoveryError('NOT_AN_IMAGE', 'The server called that an image but the bytes are not a PNG/JPEG/GIF/WebP/AVIF file.');
        }

        // Storage name: the URL's filename when it is a real one (has an
        // extension, is not a generic "download"), else a slug of the label -
        // always carrying an extension that matches the (sniffed) type so the
        // portal picks the right renderer.
        const wantedExt = config.EXTENSION_BY_MIME[mimeType] || urlExt || 'bin';
        const urlNameUsable = Boolean(urlExt) && !/^(index|download|file|raw)$/i.test(urlName.replace(/\.[^.]+$/, ''));
        let baseName = urlNameUsable ? urlName : slug(preferredName || urlName || 'file');
        if (!extensionOf(baseName) || (sniffed && extensionOf(baseName) !== wantedExt
            && !(wantedExt === 'jpg' && extensionOf(baseName) === 'jpeg'))) {
            baseName = `${baseName.replace(/\.[^.]+$/, '') || 'file'}.${wantedExt}`;
        }
        // A text/plain body can contain HTML fragments that the prefix
        // checks cannot identify. Keep it inert when opened after download.
        if (ACTIVE_DOCUMENT_EXTENSIONS.has(extensionOf(baseName))) {
            baseName = `${(baseName.replace(/\.[^.]+$/, '') || 'file').slice(0, 116)}.txt`;
        }
        const fileName = sanitizeFilename(baseName);
        const artifactKind = classifyArtifactKind({ name: fileName, mimeType });
        return {
            fileName,
            mimeType,
            artifactKind,
            displayKind: displayKindFor({ artifactKind, fileName })
        };
    }

    /**
     * Is this exact content already saved in the scope? Re-showing beats
     * re-saving the same picture under a second label.
     */
    async findByHash({ guildId, scopeKey, buffer }) {
        const contentHash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 24);
        return await db.get(
            `SELECT n.*, a.originalName, a.artifactKind, a.mimeType, a.sizeBytes, a.extractedText,
                    a.relativePath, a.metadataJson
             FROM kg_artifacts a JOIN kg_nodes n ON n.id = a.nodeId
             WHERE a.guildId = @guildId AND a.scopeKey = @scopeKey AND a.contentHash = @contentHash
             ORDER BY a.id DESC LIMIT 1`,
            { guildId, scopeKey, contentHash }
        );
    }

    /**
     * A label that will not silently convert an existing concept/fact node
     * into an artifact: existing non-artifact labels get a kind suffix.
     */
    async uniqueLabel({ guildId, scopeKey, label, displayKind }) {
        const base = String(label || '').trim().slice(0, 110) || 'found file';
        const existing = await knowledgeGraphService.getNode(guildId, base, scopeKey);
        if (!existing || existing.type === 'artifact') return base;
        const suffixed = `${base} (${displayKind === 'image' ? 'image' : 'file'})`;
        const clash = await knowledgeGraphService.getNode(guildId, suffixed, scopeKey);
        if (!clash || clash.type === 'artifact') return suffixed;
        return `${base} (${displayKind} ${Date.now().toString(36).slice(-4)})`;
    }

    /** One-line attribution for captions and tool results. */
    captionFor({ title, credit, license, provider, pageUrl, sourceUrl } = {}) {
        const parts = [];
        if (title) parts.push(String(title).trim());
        const who = [credit, license].filter(Boolean).map(s => String(s).trim()).join(', ');
        if (who) parts.push(who);
        const via = provider ? `via ${provider}` : (pageUrl || sourceUrl ? (() => {
            try { return `via ${new URL(pageUrl || sourceUrl).hostname.replace(/^www\./, '')}`; } catch { return null; }
        })() : null);
        if (via) parts.push(via);
        return parts.join(' — ');
    }

    /**
     * Persist a downloaded file as an artifact node with notes + origin.
     * @returns {Promise<{ saved: Object, duplicate: boolean }>}
     */
    async saveFound({
        guildId, userId, buffer, fileName, mimeType, artifactKind, displayKind,
        label, notes = null, tags = [], origin = {}, channelId = null, messageId = null
    }) {
        const scopeKey = knowledgeGraphService.resolveScopeKey({ subjectType: 'USER', subjectId: userId });
        const existing = await this.findByHash({ guildId, scopeKey, buffer });
        if (existing) {
            return { saved: this._rowToSaved(existing), duplicate: true };
        }

        const caption = this.captionFor(origin);
        const metadata = {
            sourceUrl: origin.sourceUrl || null,
            pageUrl: origin.pageUrl || null,
            title: origin.title || null,
            credit: origin.credit || null,
            license: origin.license || null,
            provider: origin.provider || null,
            displayKind,
            fetchedAt: new Date().toISOString()
        };
        const kind = displayKind === 'image' ? 'image' : 'file';
        const attributionLine = [
            caption ? `Credit: ${caption}.` : null,
            origin.pageUrl ? `Page: ${origin.pageUrl}` : null,
            origin.sourceUrl && origin.sourceUrl !== origin.pageUrl ? `File: ${origin.sourceUrl}` : null
        ].filter(Boolean).join(' ');
        const summary = [
            String(notes || origin.description || `Found ${kind} for "${label}".`).trim(),
            attributionLine
        ].filter(Boolean).join('\n');

        const finalLabel = await this.uniqueLabel({ guildId, scopeKey, label, displayKind });
        const attachment = {
            name: fileName,
            buffer,
            mimeType,
            artifactKind
        };
        // Images have no extractable text; the caption + notes become the
        // searchable text so "that M43 jacket photo" resolves by words.
        if (artifactKind === 'image') {
            attachment.content = [origin.title, origin.description, notes, attributionLine]
                .filter(Boolean).join('\n');
        }
        const cleanTags = [...new Set([
            ...(Array.isArray(tags) ? tags : []),
            displayKind === 'image' ? 'image' : displayKind,
            'found-on-web'
        ].map(t => String(t || '').trim().toLowerCase()).filter(Boolean))].slice(0, 8);

        const saved = await kgArtifactService.saveArtifact({
            guildId,
            userId,
            label: finalLabel,
            summary,
            attachment,
            tags: cleanTags,
            metadata,
            channelId,
            messageId,
            confirm: true
        });
        return {
            saved: {
                ...saved,
                label: finalLabel,
                displayKind,
                caption,
                sourceUrl: metadata.pageUrl || metadata.sourceUrl || null,
                metadata
            },
            duplicate: false
        };
    }

    _rowToSaved(row) {
        const metadata = kgArtifactService.parseMetadata(row) || {};
        const displayKind = metadata.displayKind
            || displayKindFor({ artifactKind: row.artifactKind, fileName: row.originalName });
        return {
            nodeId: row.id,
            label: row.label,
            fileName: row.originalName,
            artifactKind: row.artifactKind,
            mimeType: row.mimeType || null,
            sizeBytes: row.sizeBytes || 0,
            relativePath: row.relativePath,
            absolutePath: kgArtifactService.resolvePath(row),
            displayKind,
            caption: this.captionFor(metadata) || null,
            sourceUrl: metadata.pageUrl || metadata.sourceUrl || null,
            notes: row.content || null,
            extractedText: row.extractedText || null,
            metadata
        };
    }

    /**
     * Saved files matching a query (or the most recent ones when the query
     * is empty), only those still present on disk.
     * @param {{ guildId: string, userId: string, query?: string, kind?: string, limit?: number }} params
     */
    async recall({ guildId, userId, query = '', kind = 'any', limit = 2 }) {
        const scopeKey = knowledgeGraphService.resolveScopeKey({ subjectType: 'USER', subjectId: userId });
        const cap = Math.max(1, Math.min(config.MAX_RECALL_PER_CALL, Number(limit) || 1));
        const wanted = DISPLAY_KINDS.includes(kind) ? kind : null;
        // CSV is a display kind layered on the 'document' artifact kind.
        const artifactKind = wanted === 'csv' ? 'document' : wanted;
        const fetchLimit = wanted === 'csv' ? cap * 4 : cap * 2;
        const rows = String(query || '').trim()
            ? await kgArtifactService.searchArtifacts({ guildId, scopeKey, query, limit: fetchLimit, kind: artifactKind })
            : await kgArtifactService.listArtifacts({ guildId, scopeKey, limit: fetchLimit, kind: artifactKind });
        const out = [];
        let missing = 0;
        for (const row of rows) {
            const saved = this._rowToSaved(row);
            if (wanted === 'csv' && saved.displayKind !== 'csv') continue;
            if (!saved.absolutePath) { missing += 1; continue; }
            out.push(saved);
            if (out.length >= cap) break;
        }
        return { files: out, missing };
    }

    /**
     * Compact, model-facing description of a saved file's contents.
     * @param {{ buffer?: Buffer, displayKind: string, fileName: string, extractedText?: string|null }} file
     */
    preview({ buffer = null, displayKind, fileName, extractedText = null, caption = null }) {
        if (displayKind === 'image') {
            return caption ? `Image (${fileName}): ${caption}` : `Image (${fileName}).`;
        }
        const text = buffer ? buffer.toString('utf8') : String(extractedText || '');
        if (!text) return `${displayKind} file ${fileName}.`;
        if (displayKind === 'csv') {
            const delimiter = extensionOf(fileName) === 'tsv' ? '\t' : ',';
            const rows = parseDelimited(text, { delimiter, maxRows: config.PREVIEW_ROWS + 1 });
            const header = rows[0] || [];
            const totalRows = Math.max(0, countLines(text) - 1);
            const sample = rows.slice(1, config.PREVIEW_ROWS + 1)
                .map(r => r.map(c => (c.length > 40 ? `${c.slice(0, 37)}…` : c)).join(' | '));
            return [
                `${extensionOf(fileName).toUpperCase()} ${fileName}: ~${totalRows} data rows × ${header.length} columns.`,
                header.length ? `Columns: ${header.slice(0, 30).join(', ')}${header.length > 30 ? ', …' : ''}` : null,
                sample.length ? `First rows:\n${sample.join('\n')}` : null
            ].filter(Boolean).join('\n');
        }
        if (displayKind === 'pdf') {
            const clipped = text.length > config.PREVIEW_CHARS ? `${text.slice(0, config.PREVIEW_CHARS)}…` : text;
            return `PDF ${fileName} (text excerpt):\n${clipped}`;
        }
        const clipped = text.length > config.PREVIEW_CHARS ? `${text.slice(0, config.PREVIEW_CHARS)}…` : text;
        return `${displayKind} ${fileName} (${countLines(text)} lines):\n${clipped}`;
    }
}

module.exports = new FileDiscoveryService();
module.exports.FileDiscoveryService = FileDiscoveryService;
module.exports.FileDiscoveryError = FileDiscoveryError;
module.exports.parseDelimited = parseDelimited;
module.exports.sniffImageMime = sniffImageMime;
module.exports.displayKindFor = displayKindFor;
module.exports.DISPLAY_KINDS = DISPLAY_KINDS;
