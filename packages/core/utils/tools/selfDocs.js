/**
 * Chat tool: consultDocs - Goobster consults his own documentation.
 * Required by packages/core/utils/toolsRegistry.js — apps keep requiring the facade.
 */

const { KINDS } = require('../../services/selfDocsService');

const MAX_SEARCH_CHARS = 14_000;
const MAX_LIST_CHARS = 12_000;

function kindLabel(kind) {
    return kind === 'skill' ? 'skill guide' : kind;
}

function formatSearch(query, { mode, results }) {
    if (results.length === 0) {
        return `DOCS — nothing in your documentation matches "${query}". `
            + 'Try different words, call consultDocs with action="list" to see every doc, or tell the user plainly that the docs do not cover it. Do not invent configuration keys, commands, or behaviour.';
    }
    const lines = [`DOCS — ${results.length} result(s) for "${query}" (${mode} ranking). Cite the doc you rely on by title.`];
    let used = lines[0].length;
    for (const [i, hit] of results.entries()) {
        const header = `\n[${i + 1}] ${hit.headingPath} — ${kindLabel(hit.kind)}, ${hit.relPath} (read more: action="read", slug="${hit.slug}")`;
        const body = hit.content;
        if (used + header.length + body.length > MAX_SEARCH_CHARS && i > 0) {
            lines.push(`\n… ${results.length - i} more result(s) omitted for length; narrow the query or read a doc directly.`);
            break;
        }
        lines.push(header, body);
        used += header.length + body.length;
    }
    return lines.join('\n');
}

function formatList(docs, kind) {
    if (docs.length === 0) {
        return kind
            ? `DOCS — no ${kindLabel(kind)} documents are seeded.`
            : 'DOCS — the documentation corpus is empty. The operator can seed it with `npm run docs:seed`; it also seeds itself when the bot starts.';
    }
    const groups = new Map();
    for (const doc of docs) {
        if (!groups.has(doc.kind)) groups.set(doc.kind, []);
        groups.get(doc.kind).push(doc);
    }
    const lines = [`DOCS — ${docs.length} document(s)${kind ? ` of kind ${kindLabel(kind)}` : ''}. Read one with action="read" and its slug; search inside them with action="search".`];
    let used = lines[0].length;
    for (const k of KINDS) {
        const group = groups.get(k);
        if (!group) continue;
        const heading = `\n## ${kindLabel(k)}${k === 'skill' ? ' — step-by-step procedures; read the whole guide before acting on it' : ''}`;
        lines.push(heading);
        used += heading.length;
        for (const doc of group) {
            let line = `- ${doc.title} (slug: ${doc.slug})`;
            if (doc.summary) line += ` — ${doc.summary}`;
            if (doc.useWhen) line += `\n  Use when: ${doc.useWhen}`;
            if (used + line.length > MAX_LIST_CHARS) {
                lines.push('- … more omitted for length; filter by kind.');
                return lines.join('\n');
            }
            lines.push(line);
            used += line.length;
        }
    }
    return lines.join('\n');
}

function formatRead(ref, result, section) {
    if (!result) {
        return `DOCS — no document matches "${ref}". Use action="list" to see slugs and titles, or action="search" to find the right section.`;
    }
    const { doc, window, sectionMatched, sections } = result;
    const header = [`DOCS — ${doc.title} (${kindLabel(doc.kind)}, ${doc.relPath})`];
    if (section && !sectionMatched) {
        header.push(`No section matches "${section}"; showing the whole document. Sections: ${sections.slice(0, 30).join(' | ')}`);
    } else if (section) {
        header.push(`Section filter: "${section}"`);
    }
    header.push(`Lines ${window.startLine}-${window.endLine} of ${window.totalLines}${window.truncated ? ` (continue with offset=${window.nextOffset})` : ''}${window.charCapped ? ' — character-capped' : ''}`);
    return `${header.join('\n')}\n\n${window.content}`;
}

module.exports = {
    consultDocs: {
        definition: {
            name: 'consultDocs',
            description: 'Consult your OWN documentation (you are Goobster - this is the manual for the software you are). '
                + 'Use it before answering anything about how you work: which commands, tools, rooms, and features exist and what they do; '
                + 'how to set up, configure, or deploy you (config.json keys, environment variables, Raspberry Pi, Docker, Postgres, the web portal, voice, music); '
                + 'project examples and working guidelines; and how to troubleshoot when one of your own features or tool calls fails, is disabled, or is unavailable. '
                + 'Actions: "search" ranks the most relevant sections across every doc (semantic + keyword); '
                + '"read" returns one document, or one section of it, by slug/title; '
                + '"list" shows the document index - use kind="skill" to see your skill guides, step-by-step procedures for specific jobs (troubleshooting tactics, project examples, working guidelines) that you should read in full before doing that job. '
                + 'Cite the document title you relied on. If the docs do not cover something, say so instead of inventing a configuration key, command, or behaviour.',
            parameters: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        enum: ['search', 'read', 'list'],
                        description: 'search = find relevant sections; read = one doc or section; list = the index (default search when a query is given).'
                    },
                    query: { type: 'string', description: 'search: what you need to know, in plain words, e.g. "enable the code sandbox" or "why would memory recall return nothing".' },
                    slug: { type: 'string', description: 'read: document slug, path, or title, e.g. "documentation/code_sandbox" or "Code Sandbox". Slugs appear in search and list results.' },
                    section: { type: 'string', description: 'read: optional heading to narrow to, e.g. "Enabling it" or "Troubleshooting".' },
                    kind: {
                        type: 'string',
                        enum: KINDS,
                        description: 'search / list: restrict to one kind. Leave unset on a first search (feature docs are "reference", not "guide"). skill = your skill guides; guide = setup and deployment how-tos; reference = feature docs; standards = engineering conventions; decision = architecture decision records and plans.'
                    },
                    limit: { type: 'integer', description: 'search: max results (default 5, max 8). read: max lines (default 400, max 800).' },
                    offset: { type: 'integer', description: 'read: 1-based line to start at (continue a long document).' }
                }
            }
        },
        execute: async ({ action, query, slug, section, kind, limit, offset }) => {
            const selfDocsService = require('../../services/selfDocsService');
            const config = require('../../config/selfDocsConfig');
            if (!config.enabled) return 'DOCS — self-documentation is disabled on this deployment (selfDocs.enabled = false).';

            const want = action || (slug ? 'read' : (query ? 'search' : 'list'));
            try {
                await selfDocsService.ensureSeeded();
                if (want === 'list') {
                    const docs = await selfDocsService.listDocs({ kind: kind || null });
                    return formatList(docs, kind || null);
                }
                if (want === 'read') {
                    const ref = slug || query;
                    if (!ref) return 'DOCS — read needs a slug (or title). Use action="list" to see them.';
                    const result = await selfDocsService.readDoc({ ref, section: section || null, offset, limit });
                    return formatRead(ref, result, section || null);
                }
                const text = String(query || '').trim();
                if (!text) return 'DOCS — search needs a query. Say what you need to know in plain words.';
                const result = await selfDocsService.search({ query: text, kind: kind || null, limit: limit || 5 });
                return formatSearch(text, result);
            } catch (error) {
                return `❌ Could not consult the documentation: ${error.message}`;
            }
        }
    }
};
