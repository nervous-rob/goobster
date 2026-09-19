/**
 * Chat tools: files found on the web, kept in the knowledge base, shown in
 * chat - findImages (search → save → display), fetchWebFile (one URL of any
 * accepted type → save → display), showSavedFiles (recall → display).
 * Required by packages/core/utils/toolsRegistry.js — apps keep requiring the facade.
 *
 * Display rides the generateImage path: `channel.send({ files })` renders
 * inline in Discord and in the portal (the portal draws images with a
 * caption, CSV as a table, text-shaped files as a preview card), and the
 * entry recorded on `interactionContext.generatedFiles` is what history
 * re-serves after a reload. Entries are objects here ({ path, name,
 * caption, sourceUrl, kind }) so captions and origin survive the reload.
 */

const path = require('node:path');
const fileDiscoveryConfig = require('../../config/fileDiscoveryConfig');

function resolveScope(interactionContext) {
    const { dmScopeId } = require('../dmScope');
    const guildId = interactionContext?.guildId
        || (interactionContext?.user?.id ? dmScopeId(interactionContext.user.id) : null);
    const userId = interactionContext?.user?.id || null;
    return { guildId, userId };
}

function cleanTags(tags) {
    return (Array.isArray(tags) ? tags : [])
        .map(t => String(t || '').trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 6);
}

/**
 * Send one saved file to the conversation and record it for history.
 * Never throws: a failed send is reported in the tool result instead.
 */
async function deliverFile(interactionContext, saved) {
    if (!interactionContext?.channel?.send || !saved?.absolutePath) return false;
    const name = saved.fileName || path.basename(saved.absolutePath);
    const description = saved.caption ? String(saved.caption).slice(0, 1000) : undefined;
    try {
        await interactionContext.channel.send({
            files: [{
                attachment: saved.absolutePath,
                name,
                description,
                sourceUrl: saved.sourceUrl || undefined,
                kind: saved.displayKind || undefined
            }]
        });
    } catch (error) {
        console.warn('files tool: could not send attachment:', error?.message || error);
        return false;
    }
    if (!Array.isArray(interactionContext.generatedFiles)) interactionContext.generatedFiles = [];
    interactionContext.generatedFiles.push({
        path: saved.absolutePath,
        name,
        caption: saved.caption || null,
        sourceUrl: saved.sourceUrl || null,
        kind: saved.displayKind || null
    });
    return true;
}

function describeSaved(saved, { duplicate = false } = {}) {
    const bits = [`"${saved.label}"`, `${saved.displayKind}${saved.fileName ? ` ${saved.fileName}` : ''}`];
    if (saved.caption) bits.push(saved.caption);
    if (saved.sourceUrl) bits.push(`source: ${saved.sourceUrl}`);
    if (duplicate) bits.push('(already in the knowledge base - shown again, not re-saved)');
    return bits.join(' — ');
}

const DISPLAY_NOTE = 'The file(s) are already displayed in the chat above your reply - do not paste image URLs or repeat the contents; describe or discuss them and credit the source/license briefly.';

module.exports = {
    findImages: {
        definition: {
            name: 'findImages',
            description: 'Search the web for pictures of something (what does X look like, show me a Y), save the best matches into the user\'s knowledge base with your notes about the topic, and display them in the chat right away. Sources are Wikimedia Commons / Wikipedia (free-licensed, keyless) and, when configured, Perplexity. Use the full formal name of the thing in `query` ("M1943 field jacket", not "M43 jacket") because search engines match loosely; the result lists what was found so you can call again with a better query if the titles do not match. For a specific image URL the user gave you, use fetchWebFile instead. To re-show something already saved, use showSavedFiles.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'What to find pictures of - specific and formal, e.g. "U.S. Army M1943 field jacket".' },
                    count: {
                        type: 'integer',
                        minimum: 1,
                        maximum: fileDiscoveryConfig.MAX_IMAGES_PER_CALL,
                        description: `How many images to save and show (default ${fileDiscoveryConfig.DEFAULT_IMAGES_PER_CALL}, max ${fileDiscoveryConfig.MAX_IMAGES_PER_CALL}).`
                    },
                    label: { type: 'string', description: 'Short knowledge-base title for the saved image(s), e.g. "M1943 field jacket". Defaults to the query.' },
                    notes: { type: 'string', description: 'One or two sentences about the topic worth remembering alongside the picture (what it is, why the user asked, context). Stored as the note body.' },
                    tags: { type: 'array', items: { type: 'string' }, description: 'Optional lowercase concept tags, e.g. ["ww2", "uniforms"].' }
                },
                required: ['query']
            }
        },
        execute: async ({ query, count, label = null, notes = null, tags = [], interactionContext }) => {
            const clean = String(query || '').trim();
            if (!clean) return '❌ findImages needs a query.';
            const { guildId, userId } = resolveScope(interactionContext);
            if (!guildId || !userId || !interactionContext?.channel) {
                return '❌ Images can only be found and shown inside a conversation.';
            }
            const imageSearchService = require('../../services/imageSearchService');
            const fileDiscoveryService = require('../../services/fileDiscoveryService');

            const want = Math.max(1, Math.min(fileDiscoveryConfig.MAX_IMAGES_PER_CALL,
                Number.isInteger(count) ? count : fileDiscoveryConfig.DEFAULT_IMAGES_PER_CALL));
            const { candidates, providersTried, errors } = await imageSearchService.search(clean, { limit: want });
            if (candidates.length === 0) {
                const where = providersTried.length ? ` (searched ${providersTried.join(', ')})` : '';
                const why = errors.length ? ` Provider errors: ${errors.join('; ')}.` : '';
                return `No images found for "${clean}"${where}.${why} Try the formal name or a broader term, or ask the user for a URL to fetch with fetchWebFile.`;
            }

            const shown = [];
            const skipped = [];
            const shownUrls = new Set();
            const baseLabel = String(label || clean).trim().slice(0, 100);
            for (const cand of candidates) {
                if (shown.length >= want) break;
                try {
                    const { buffer, contentType, finalUrl } = await fileDiscoveryService.download(cand.imageUrl, {
                        allowedContentTypes: ['image/']
                    });
                    const classified = fileDiscoveryService.classify({
                        url: finalUrl, contentType, buffer, preferredName: cand.title || baseLabel
                    });
                    if (classified.displayKind !== 'image') {
                        skipped.push(`${cand.title || cand.imageUrl}: not an image`);
                        continue;
                    }
                    const ordinal = shown.length === 0 ? '' : ` (${shown.length + 1})`;
                    const { saved, duplicate } = await fileDiscoveryService.saveFound({
                        guildId,
                        userId,
                        buffer,
                        ...classified,
                        label: `${baseLabel}${ordinal}`,
                        notes,
                        tags: cleanTags(tags),
                        origin: {
                            sourceUrl: finalUrl,
                            pageUrl: cand.pageUrl,
                            title: cand.title,
                            description: cand.description,
                            credit: cand.credit,
                            license: cand.license,
                            provider: cand.provider
                        },
                        channelId: interactionContext.channelId || interactionContext.channel?.id || null,
                        messageId: interactionContext.messageId || null
                    });
                    const delivered = await deliverFile(interactionContext, saved);
                    shown.push({ saved, duplicate, delivered });
                    shownUrls.add(cand.imageUrl);
                } catch (error) {
                    skipped.push(`${cand.title || cand.imageUrl}: ${error?.message || 'download failed'}`);
                }
            }

            if (shown.length === 0) {
                return `Found ${candidates.length} candidate image(s) for "${clean}" but none could be downloaded:\n- ${skipped.join('\n- ')}`;
            }
            const alternates = candidates
                .filter(c => !shownUrls.has(c.imageUrl) && !skipped.some(line => line.startsWith(`${c.title || c.imageUrl}:`)))
                .slice(0, 4)
                .map(c => `- ${c.title || 'untitled'}${c.license ? ` (${c.license})` : ''}: ${c.imageUrl}`);
            return [
                `Saved and displayed ${shown.length} image(s) for "${clean}" in the knowledge base:`,
                ...shown.map((s, i) => `${i + 1}. ${describeSaved(s.saved, { duplicate: s.duplicate })}${s.delivered ? '' : ' [display failed - describe it instead]'}`),
                alternates.length ? `Other candidates found (fetch one with fetchWebFile if these fit better):\n${alternates.join('\n')}` : null,
                skipped.length ? `Skipped: ${skipped.join('; ')}` : null,
                DISPLAY_NOTE
            ].filter(Boolean).join('\n');
        }
    },

    fetchWebFile: {
        definition: {
            name: 'fetchWebFile',
            description: 'Download one file from an https URL (an image, CSV/TSV, JSON, Markdown, plain text, code, or PDF - up to 8 MB; web pages are refused), save it into the user\'s knowledge base with your notes, and display it in the chat: images render inline, CSV as a table, text-shaped files as a preview, PDFs as a download. Use when the user shares or asks for a specific file URL, or to grab a dataset/document you found with a search. The result includes a preview of the contents (CSV columns and first rows, text head, PDF excerpt) so you can discuss it.',
            parameters: {
                type: 'object',
                properties: {
                    url: { type: 'string', description: 'Direct https:// link to the file itself (not a page that links to it).' },
                    label: { type: 'string', description: 'Short knowledge-base title, e.g. "2023 rainfall dataset" or "M1943 jacket spec sheet".' },
                    notes: { type: 'string', description: 'One or two sentences about what this file is and why it matters to the user. Stored as the note body.' },
                    tags: { type: 'array', items: { type: 'string' }, description: 'Optional lowercase concept tags.' }
                },
                required: ['url', 'label']
            }
        },
        execute: async ({ url, label, notes = null, tags = [], interactionContext }) => {
            const { guildId, userId } = resolveScope(interactionContext);
            if (!guildId || !userId || !interactionContext?.channel) {
                return '❌ Files can only be fetched and shown inside a conversation.';
            }
            const cleanLabel = String(label || '').trim();
            if (!cleanLabel) return '❌ fetchWebFile needs a short label for the knowledge base.';
            const fileDiscoveryService = require('../../services/fileDiscoveryService');
            const kgArtifactService = require('../../services/kgArtifactService');
            const knowledgeGraphService = require('../../services/knowledgeGraphService');

            let downloaded;
            let classified;
            try {
                downloaded = await fileDiscoveryService.download(url);
                classified = fileDiscoveryService.classify({
                    url: downloaded.finalUrl,
                    contentType: downloaded.contentType,
                    buffer: downloaded.buffer,
                    preferredName: cleanLabel
                });
            } catch (error) {
                return `❌ Could not fetch that file (${error?.code || 'FETCH_FAILED'}): ${error?.message || 'download failed'}`;
            }

            let pageHost = null;
            try { pageHost = new URL(downloaded.finalUrl).hostname.replace(/^www\./, ''); } catch { /* keep null */ }
            let result;
            try {
                result = await fileDiscoveryService.saveFound({
                    guildId,
                    userId,
                    buffer: downloaded.buffer,
                    ...classified,
                    label: cleanLabel,
                    notes,
                    tags: cleanTags(tags),
                    origin: {
                        sourceUrl: downloaded.finalUrl,
                        pageUrl: downloaded.finalUrl,
                        title: cleanLabel,
                        credit: pageHost,
                        provider: null
                    },
                    channelId: interactionContext.channelId || interactionContext.channel?.id || null,
                    messageId: interactionContext.messageId || null
                });
            } catch (error) {
                return `❌ Fetched the file but could not save it: ${error?.message || 'unknown error'}`;
            }
            const { saved, duplicate } = result;
            const delivered = await deliverFile(interactionContext, saved);

            let extractedText = null;
            if (classified.displayKind === 'pdf') {
                try {
                    const scopeKey = knowledgeGraphService.resolveScopeKey({ subjectType: 'USER', subjectId: userId });
                    extractedText = await kgArtifactService.readArtifactContent({
                        guildId, scopeKey, label: saved.label, maxChars: fileDiscoveryConfig.PREVIEW_CHARS
                    });
                } catch { /* preview is best-effort */ }
            }
            const preview = fileDiscoveryService.preview({
                buffer: classified.displayKind === 'pdf' ? null : downloaded.buffer,
                extractedText,
                displayKind: classified.displayKind,
                fileName: saved.fileName,
                caption: saved.caption
            });
            return [
                `${duplicate ? 'Already had' : 'Saved'} ${describeSaved(saved, { duplicate })}${delivered ? ' and displayed it in the chat.' : ' (display failed - summarize it instead).'}`,
                `Size: ${(saved.sizeBytes / 1024).toFixed(1)} KB, type ${saved.mimeType || classified.mimeType}.`,
                preview,
                DISPLAY_NOTE
            ].join('\n');
        }
    },

    showSavedFiles: {
        definition: {
            name: 'showSavedFiles',
            description: 'Display files already saved in the user\'s knowledge base (pictures found with findImages, files fetched with fetchWebFile, artifacts saved with saveArtifact) in the chat again. Use when the user asks to see something you showed or saved before ("show me that jacket picture again", "pull up the rainfall CSV"). Searches labels, notes, file names and extracted text; with no query it shows the most recent saved files. Results render inline (images with captions, CSV tables, text previews).',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Words to match against saved files (label, notes, file name, content). Omit to list the most recent.' },
                    kind: {
                        type: 'string',
                        enum: ['any', 'image', 'csv', 'markdown', 'code', 'document', 'pdf'],
                        description: 'Restrict to one kind of file (default any).'
                    },
                    limit: {
                        type: 'integer',
                        minimum: 1,
                        maximum: fileDiscoveryConfig.MAX_RECALL_PER_CALL,
                        description: `How many to show (default 2, max ${fileDiscoveryConfig.MAX_RECALL_PER_CALL}).`
                    }
                }
            }
        },
        execute: async ({ query = '', kind = 'any', limit = 2, interactionContext }) => {
            const { guildId, userId } = resolveScope(interactionContext);
            if (!guildId || !userId || !interactionContext?.channel) {
                return '❌ Saved files can only be shown inside a conversation.';
            }
            const fileDiscoveryService = require('../../services/fileDiscoveryService');
            const { files, missing } = await fileDiscoveryService.recall({ guildId, userId, query, kind, limit });
            if (files.length === 0) {
                const scopeNote = String(query || '').trim() ? ` matching "${String(query).trim()}"` : '';
                const kindNote = kind && kind !== 'any' ? ` of kind ${kind}` : '';
                const gone = missing > 0 ? ` (${missing} matching entr${missing === 1 ? 'y is' : 'ies are'} no longer on disk)` : '';
                return `No saved files${kindNote}${scopeNote}${gone}. Offer to find or fetch one (findImages / fetchWebFile) instead of inventing a description.`;
            }
            const lines = [];
            for (const saved of files) {
                const delivered = await deliverFile(interactionContext, saved);
                const noteBit = saved.notes ? ` Notes: ${String(saved.notes).split('\n')[0].slice(0, 240)}` : '';
                lines.push(`- ${describeSaved(saved)}${noteBit}${delivered ? '' : ' [display failed]'}`);
            }
            return [
                `Displayed ${files.length} saved file(s):`,
                ...lines,
                missing > 0 ? `${missing} other match(es) are no longer on disk.` : null,
                DISPLAY_NOTE
            ].filter(Boolean).join('\n');
        }
    }
};
