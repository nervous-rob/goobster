/**
 * MCP resources: documents a client can list and attach by URI, next to
 * the tools that search them.
 *
 *   goobster://docs/<slug>     a documentation page (any scope)
 *   goobster://briefs/<id>     one of the token owner's research briefs
 *                              (`read` scope only)
 *
 * The same rules as the tools apply: read-only, owner-scoped, and a
 * `docs` token never sees anything private. A URI the token cannot read
 * is "not found", never "forbidden", so ids are not an oracle.
 */

const mcpConfig = require('../config/mcpConfig');
const { callTool, clip, includeOperatorDocs } = require('./tools');
const { surfaceActive, GateError } = require('../features/gate');
const requireOptional = require('../utils/optionalModule').forModule(module);

const DOC_PREFIX = 'goobster://docs/';
const BRIEF_PREFIX = 'goobster://briefs/';
const RESOURCE_NOT_FOUND = -32002;
const DOC_TEMPLATE = 'goobster://docs/{slug}';
const BRIEF_TEMPLATE = 'goobster://briefs/{id}';

/**
 * Whether the feature that owns a resource family is active. Evaluated per
 * listing and per read; a family nobody owns fails closed.
 */
function resourceAvailable(template) {
    try {
        return surfaceActive('mcpResource', template);
    } catch (error) {
        if (error instanceof GateError) return false;
        throw error;
    }
}

function fail(code, message) {
    const error = new Error(message);
    error.rpcCode = code;
    error.publicMessage = message;
    return error;
}

function notFound() {
    return fail(RESOURCE_NOT_FOUND, 'Resource not found.');
}

function docUri(slug) {
    return `${DOC_PREFIX}${String(slug).split('/').map(encodeURIComponent).join('/')}`;
}

function encodeCursor(offset) {
    return Buffer.from(JSON.stringify({ o: offset })).toString('base64url');
}

function decodeCursor(cursor) {
    if (cursor === undefined || cursor === null || cursor === '') return 0;
    try {
        const parsed = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
        if (Number.isInteger(parsed?.o) && parsed.o >= 0) return parsed.o;
    } catch {
        // Falls through to the shared error below.
    }
    throw fail(-32602, 'That cursor is not valid. Call resources/list without one.');
}

function docsAvailable() {
    return resourceAvailable(DOC_TEMPLATE) && require('../config/selfDocsConfig').enabled;
}

async function docEntries(userId) {
    if (!docsAvailable()) return [];
    const selfDocs = require('../services/selfDocsService');
    await selfDocs.ensureSeeded();
    const docs = await selfDocs.listDocs({ includeOperator: await includeOperatorDocs(userId) });
    return docs.map(doc => ({
        uri: docUri(doc.slug),
        name: doc.slug,
        title: doc.title,
        ...(doc.summary ? { description: doc.summary } : {}),
        mimeType: 'text/markdown'
    }));
}

async function briefEntries(userId) {
    const briefs = requireOptional('../services/expeditionBriefService', { feature: 'expeditions' });
    if (!briefs) return [];
    const rows = await briefs.listForUser({ userId, limit: 50 });
    return rows.map(row => ({
        uri: `${BRIEF_PREFIX}${row.id}`,
        name: `brief-${row.id}`,
        title: `Research brief #${row.id} (expedition ${row.expeditionId})`,
        description: `Status ${row.status}${row.quality ? `, quality ${row.quality}` : ''}.`,
        mimeType: 'text/plain'
    }));
}

/**
 * One page of resources. Documentation first, then (for a `read` token)
 * the owner's briefs.
 * @returns {Promise<{ resources: object[], nextCursor?: string }>}
 */
async function listResources(userId, scope, cursor) {
    const start = decodeCursor(cursor);
    const all = [
        ...(await docEntries(userId)),
        ...(scope === 'read' && resourceAvailable(BRIEF_TEMPLATE) ? await briefEntries(userId) : [])
    ];
    const size = mcpConfig.resourcePageSize;
    const page = all.slice(start, start + size);
    const next = start + size;
    return next < all.length
        ? { resources: page, nextCursor: encodeCursor(next) }
        : { resources: page };
}

function listResourceTemplates(scope) {
    const templates = !resourceAvailable(DOC_TEMPLATE) ? [] : [{
        uriTemplate: `${DOC_PREFIX}{slug}`,
        name: 'goobster-doc',
        title: 'Goobster documentation page',
        description: 'A page of Goobster\'s manual, by slug from list_docs.',
        mimeType: 'text/markdown'
    }];
    if (scope === 'read' && resourceAvailable(BRIEF_TEMPLATE)) {
        templates.push({
            uriTemplate: `${BRIEF_PREFIX}{id}`,
            name: 'goobster-brief',
            title: 'Research brief',
            description: 'One of your research briefs, by id from list_briefs.',
            mimeType: 'text/plain'
        });
    }
    return { resourceTemplates: templates };
}

async function readDocResource(userId, uri) {
    if (!docsAvailable()) throw notFound();
    let slug;
    try {
        slug = uri.slice(DOC_PREFIX.length).split('/').map(decodeURIComponent).join('/');
    } catch {
        throw notFound();
    }
    if (!slug) throw notFound();
    const selfDocs = require('../services/selfDocsService');
    await selfDocs.ensureSeeded();
    const result = await selfDocs.readDoc({
        ref: slug,
        offset: 1,
        limit: 800,
        includeOperator: await includeOperatorDocs(userId)
    });
    // readDoc resolves loosely (titles, suffixes); a resource URI must be exact.
    if (!result || result.doc.slug !== slug) throw notFound();
    return { contents: [{ uri, mimeType: 'text/markdown', text: clip(result.window.content) }] };
}

async function readBriefResource(userId, uri) {
    const idText = uri.slice(BRIEF_PREFIX.length);
    if (!/^\d{1,15}$/.test(idText)) throw notFound();
    const outcome = await callTool(userId, 'get_brief', { id: Number(idText) }, { scope: 'read' });
    if (outcome.isError) throw notFound();
    const text = outcome.content.map(part => part.text).join('\n');
    return { contents: [{ uri, mimeType: 'text/plain', text }] };
}

/** @returns {Promise<{ contents: Array<{ uri: string, mimeType: string, text: string }> }>} */
async function readResource(userId, scope, uri) {
    if (typeof uri !== 'string' || !uri) throw fail(-32602, 'resources/read needs a uri.');
    if (uri.startsWith(DOC_PREFIX)) return readDocResource(userId, uri);
    if (uri.startsWith(BRIEF_PREFIX) && scope === 'read') {
        if (!resourceAvailable(BRIEF_TEMPLATE)) throw notFound();
        return readBriefResource(userId, uri);
    }
    throw notFound();
}

module.exports = {
    DOC_PREFIX,
    BRIEF_PREFIX,
    RESOURCE_NOT_FOUND,
    docUri,
    listResources,
    listResourceTemplates,
    readResource
};
