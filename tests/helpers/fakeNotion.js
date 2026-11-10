/**
 * An in-memory Notion for the Notion connector's tests, the browser
 * journey's fixture and the evaluation harness (DA-11e, ADR 0030).
 *
 * It stands in for `notionService._request`: the same paths, the same
 * object shapes (API version 2022-06-28) and the same `NotionError` codes,
 * for the calls the connector makes. Pages, databases and blocks form one
 * tree through their `parent`, so "is this inside the granted resource" is
 * answered by the connector walking that tree, exactly as against Notion.
 *
 * It can also fail on purpose: lose the answer to a write (the change
 * lands, the caller sees `UNAVAILABLE`), be unreachable, or refuse. It
 * records the tokens and the calls it saw. Nothing here talks to Notion.
 */

const notionService = require('@goobster/core/services/notionService');

const { NotionError } = notionService;
const dashed = (hex) => `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
const norm = (id) => {
    const hex = String(id ?? '').replace(/-/g, '').toLowerCase();
    return /^[0-9a-f]{32}$/.test(hex) ? dashed(hex) : null;
};
const rich = (text) => [{ type: 'text', text: { content: String(text) }, plain_text: String(text) }];
const withPlain = (parts) => (parts || []).map(part => ({ ...part, plain_text: part.plain_text ?? part.text?.content ?? '' }));

function createFakeNotion() {
    const state = {
        objects: new Map(),
        children: new Map(),
        tokens: new Set(),
        tokensSeen: new Set(),
        calls: [],
        /** { test(call), mode: 'lost'|'unavailable'|'refuse', code?, times } */
        faults: [],
        counter: 0,
        clock: 0
    };

    const newId = () => {
        state.counter += 1;
        return dashed(`${'f'.repeat(8)}${'0'.repeat(12)}${String(state.counter).padStart(12, '0')}`);
    };
    const stamp = () => {
        state.clock += 1;
        return new Date(Date.UTC(2026, 10, 1, 0, 0, state.clock)).toISOString();
    };
    const kids = (id) => {
        if (!state.children.has(id)) state.children.set(id, []);
        return state.children.get(id);
    };
    const parentRef = (parent) => {
        if (!parent) return { type: 'workspace', workspace: true };
        const object = state.objects.get(parent);
        if (object?.object === 'database') return { type: 'database_id', database_id: parent };
        if (object?.object === 'page') return { type: 'page_id', page_id: parent };
        return { type: 'block_id', block_id: parent };
    };
    const get = (id) => state.objects.get(norm(id)) || null;
    const titleOf = (page) => {
        const title = Object.values(page.properties || {}).find(property => property.type === 'title');
        return (title?.title || []).map(part => part.plain_text).join('');
    };

    // --- Seeding -------------------------------------------------------------

    /** Add blocks under a page or block. `lines` are texts, or `{ type, text, checked, children }`. */
    function addBlocks(parent, lines = []) {
        const parentId = norm(parent);
        const made = [];
        for (const line of lines) {
            const spec = typeof line === 'string' ? { type: 'paragraph', text: line } : line;
            const id = norm(spec.id) || newId();
            const type = spec.type || 'paragraph';
            const now = stamp();
            const block = {
                object: 'block', id, parent: parentRef(parentId), type, has_children: false, archived: false,
                created_time: now, last_edited_time: now,
                [type]: type === 'divider' ? {} : { rich_text: rich(spec.text ?? ''), ...(type === 'to_do' ? { checked: Boolean(spec.checked) } : {}) }
            };
            state.objects.set(id, block);
            kids(parentId).push(id);
            const above = state.objects.get(parentId);
            if (above?.object === 'block') above.has_children = true;
            if (spec.children?.length) addBlocks(id, spec.children);
            made.push(block);
        }
        return made;
    }

    /** Add a page under a page, a database (a row) or the workspace (`parent: null`). */
    function addPage({ id = null, parent = null, title = 'Untitled', properties = {}, blocks = [], shared = null } = {}) {
        const pageId = norm(id) || newId();
        const parentId = norm(parent);
        const above = parentId ? state.objects.get(parentId) : null;
        const now = stamp();
        const page = {
            // A top-level page is shared with the integration unless the test says otherwise; the rest inherit.
            object: 'page', id: pageId, parent: parentRef(parentId), archived: false, shared: shared ?? (parentId ? undefined : true),
            created_time: now, last_edited_time: now, url: `https://www.notion.so/${pageId.replace(/-/g, '')}`,
            properties: {}
        };
        if (above?.object === 'database') {
            for (const [name, schema] of Object.entries(above.properties)) {
                page.properties[name] = emptyProperty(schema.type);
            }
            const titleName = Object.keys(above.properties).find(name => above.properties[name].type === 'title');
            page.properties[titleName] = { type: 'title', title: rich(title) };
            for (const [name, value] of Object.entries(properties)) page.properties[name] = { ...page.properties[name], ...value };
        } else {
            page.properties.title = { type: 'title', title: rich(title) };
        }
        state.objects.set(pageId, page);
        // A page under a page is one of that page's blocks; a row is not a block of its database.
        if (parentId && above?.object !== 'database') kids(parentId).push(pageId);
        else if (parentId) kids(`rows:${parentId}`).push(pageId);
        addBlocks(pageId, blocks);
        return page;
    }

    /** Add a database under a page or the workspace. `properties` maps a name to a type. */
    function addDatabase({ id = null, parent = null, title = 'Untitled database', properties = { Name: 'title' }, shared = null } = {}) {
        const databaseId = norm(id) || newId();
        const parentId = norm(parent);
        const now = stamp();
        const database = {
            object: 'database', id: databaseId, parent: parentRef(parentId), archived: false, shared: shared ?? (parentId ? undefined : true),
            created_time: now, last_edited_time: now, title: rich(title),
            properties: Object.fromEntries(Object.entries(properties).map(([name, type]) => [name, { id: name, name, type, [type]: {} }]))
        };
        state.objects.set(databaseId, database);
        if (parentId) kids(parentId).push(databaseId);
        return database;
    }

    function emptyProperty(type) {
        const empty = {
            title: [], rich_text: [], number: null, select: null, status: null, multi_select: [], checkbox: false,
            date: null, url: null, email: null, phone_number: null, people: []
        };
        return { type, [type]: Object.prototype.hasOwnProperty.call(empty, type) ? empty[type] : null };
    }

    // --- What the API answers -------------------------------------------------

    const notFound = () => new NotionError('NOT_FOUND', 'Notion returned 404 - the page may not be shared with the integration.');
    const badRequest = () => new NotionError('BAD_REQUEST', 'Notion did not accept the request (400).');

    /** An object is visible when it, or something above it, is shared with the integration. */
    function visible(object) {
        let current = object;
        for (let hop = 0; current && hop < 50; hop += 1) {
            if (current.shared === false) return false;
            if (current.shared === true) return true;
            const parent = current.parent;
            const above = parent?.page_id || parent?.database_id || parent?.block_id;
            current = above ? state.objects.get(above) : null;
        }
        return false;
    }

    function need(id, kind) {
        const object = get(id);
        if (!object || !visible(object)) throw notFound();
        if (kind && object.object !== kind) throw (kind === 'page' && object.object === 'database' ? badRequest() : notFound());
        return object;
    }

    /** A page or database as the block it is in its parent's content. */
    function asBlock(object) {
        if (object.object === 'block') return publicCopy(object);
        const type = object.object === 'page' ? 'child_page' : 'child_database';
        const title = object.object === 'page' ? titleOf(object) : object.title.map(part => part.plain_text).join('');
        return {
            object: 'block', id: object.id, parent: object.parent, type, has_children: kids(object.id).length > 0,
            archived: object.archived, created_time: object.created_time, last_edited_time: object.last_edited_time,
            [type]: { title }
        };
    }

    const publicCopy = (object) => {
        const { shared: _shared, ...rest } = object;
        return JSON.parse(JSON.stringify(rest));
    };

    function listChildren(id, params) {
        need(id);
        const all = kids(norm(id)).map(child => state.objects.get(child)).filter(child => child && !child.archived);
        const size = Math.max(1, Math.min(Number(params?.page_size) || 100, 100));
        const start = Number(params?.start_cursor || 0) || 0;
        const page = all.slice(start, start + size);
        const more = start + size < all.length;
        return { object: 'list', results: page.map(asBlock), has_more: more, next_cursor: more ? String(start + size) : null };
    }

    function matches(row, filter) {
        if (!filter) return true;
        if (Array.isArray(filter.and)) return filter.and.every(entry => matches(row, entry));
        if (Array.isArray(filter.or)) return filter.or.some(entry => matches(row, entry));
        const property = row.properties[filter.property];
        const rule = filter.title || filter.rich_text;
        if (!property || !rule) return true;
        const text = (property.title || property.rich_text || []).map(part => part.plain_text).join('');
        if (rule.equals !== undefined) return text === rule.equals;
        if (rule.contains !== undefined) return text.toLowerCase().includes(String(rule.contains).toLowerCase());
        return true;
    }

    function queryDatabase(id, body) {
        const database = need(id, 'database');
        let rows = kids(`rows:${database.id}`).map(child => state.objects.get(child)).filter(row => row && !row.archived && matches(row, body?.filter));
        if (body?.sorts?.some(sort => sort.direction === 'descending')) rows = rows.slice().reverse();
        const size = Math.max(1, Math.min(Number(body?.page_size) || 100, 100));
        const start = Number(body?.start_cursor || 0) || 0;
        const more = start + size < rows.length;
        return { object: 'list', results: rows.slice(start, start + size).map(publicCopy), has_more: more, next_cursor: more ? String(start + size) : null };
    }

    function appendChildren(id, body) {
        const parent = need(id);
        if (parent.archived) throw badRequest();
        if (parent.object === 'database' || !Array.isArray(body?.children) || !body.children.length || body.children.length > 100) throw badRequest();
        const made = [];
        for (const child of body.children) {
            const type = child?.type;
            if (!type || !child[type]) throw badRequest();
            const blockId = newId();
            const now = stamp();
            const block = {
                object: 'block', id: blockId, parent: parentRef(parent.id), type, has_children: false, archived: false,
                created_time: now, last_edited_time: now,
                [type]: { ...child[type], ...(child[type].rich_text ? { rich_text: withPlain(child[type].rich_text) } : {}) }
            };
            state.objects.set(blockId, block);
            kids(parent.id).push(blockId);
            if (parent.object === 'block') parent.has_children = true;
            made.push(block);
        }
        parent.last_edited_time = stamp();
        return { object: 'list', results: made.map(publicCopy) };
    }

    function applyProperties(page, properties) {
        for (const [name, value] of Object.entries(properties || {})) {
            const current = page.properties[name];
            if (!current) throw badRequest();
            const type = current.type;
            if (!Object.prototype.hasOwnProperty.call(value, type)) throw badRequest();
            const next = value[type];
            page.properties[name] = { type, [type]: (type === 'title' || type === 'rich_text') ? withPlain(next) : next };
        }
        page.last_edited_time = stamp();
    }

    function createPage(body) {
        const database = need(body?.parent?.database_id, 'database');
        if (database.archived) throw badRequest();
        const page = addPage({ parent: database.id, title: '' });
        // Validate before anything is kept: a refused create leaves no row.
        try {
            applyProperties(page, body.properties);
        } catch (error) {
            state.objects.delete(page.id);
            const rows = kids(`rows:${database.id}`);
            rows.splice(rows.indexOf(page.id), 1);
            throw error;
        }
        if (body.children?.length) appendChildren(page.id, { children: body.children });
        return publicCopy(page);
    }

    function updateBlock(id, body) {
        const object = need(id);
        if (body?.archived === true) {
            object.archived = true;
            object.last_edited_time = stamp();
            return asBlock(object);
        }
        if (object.object !== 'block' || object.archived) throw badRequest();
        const given = body?.[object.type];
        if (!given) throw badRequest();
        object[object.type] = {
            ...object[object.type],
            ...given,
            ...(given.rich_text ? { rich_text: withPlain(given.rich_text) } : {})
        };
        object.last_edited_time = stamp();
        return publicCopy(object);
    }

    function updatePage(id, body) {
        const page = need(id, 'page');
        if (body?.archived === true) {
            page.archived = true;
            page.last_edited_time = stamp();
            return publicCopy(page);
        }
        if (page.archived) throw badRequest();
        applyProperties(page, body?.properties);
        return publicCopy(page);
    }

    function route(method, apiPath, { body, params }) {
        let match;
        if (method === 'GET' && apiPath === '/v1/users/me') return { name: 'Fake integration', bot: { workspace_name: 'Fake workspace' } };
        if ((match = /^\/v1\/blocks\/([^/]+)\/children$/.exec(apiPath))) {
            return method === 'GET' ? listChildren(match[1], params) : appendChildren(match[1], body);
        }
        if ((match = /^\/v1\/blocks\/([^/]+)$/.exec(apiPath))) {
            return method === 'GET' ? asBlock(need(match[1])) : updateBlock(match[1], body);
        }
        if ((match = /^\/v1\/pages\/([^/]+)$/.exec(apiPath))) {
            return method === 'GET' ? publicCopy(need(match[1], 'page')) : updatePage(match[1], body);
        }
        if (method === 'POST' && apiPath === '/v1/pages') return createPage(body);
        if ((match = /^\/v1\/databases\/([^/]+)\/query$/.exec(apiPath))) return queryDatabase(match[1], body);
        if ((match = /^\/v1\/databases\/([^/]+)$/.exec(apiPath))) return publicCopy(need(match[1], 'database'));
        if (method === 'POST' && apiPath === '/v1/search') return { results: [] };
        throw badRequest();
    }

    /** The stand-in for `notionService._request(token, apiPath, { method, body, params })`. */
    async function request(token, apiPath, { method = 'GET', body = null, params = null } = {}) {
        state.tokensSeen.add(token);
        const call = { method, path: apiPath, write: method !== 'GET' && !/\/query$|\/search$/.test(apiPath) };
        state.calls.push(call);
        if (!state.tokens.has(token)) throw new NotionError('BAD_TOKEN', 'Notion rejected the token (401) - reconnect the integration.');
        const fault = state.faults.find(entry => entry.times > 0 && entry.test(call));
        if (fault) {
            fault.times -= 1;
            if (fault.mode === 'refuse') throw new NotionError(fault.code || 'FORBIDDEN', 'Notion refused the request.');
            if (fault.mode === 'unavailable') throw new NotionError('UNAVAILABLE', 'Notion is unreachable right now.');
            // 'lost': the change lands and the answer does not.
            route(method, apiPath, { body, params });
            throw new NotionError('UNAVAILABLE', 'Notion is unreachable right now.');
        }
        return route(method, apiPath, { body, params });
    }

    let original = null;
    return {
        state,
        request,
        addPage,
        addDatabase,
        addBlocks,
        get,
        allow(token) { state.tokens.add(token); },
        /** Remove an object and everything under it, as if it had never been there (a fixture seeding twice). */
        drop(id) {
            const top = norm(id);
            const gone = [top];
            for (let at = 0; at < gone.length; at += 1) {
                gone.push(...(state.children.get(gone[at]) || []), ...(state.children.get(`rows:${gone[at]}`) || []));
            }
            for (const entry of gone) {
                state.objects.delete(entry);
                state.children.delete(entry);
                state.children.delete(`rows:${entry}`);
            }
            for (const list of state.children.values()) {
                const at = list.indexOf(top);
                if (at >= 0) list.splice(at, 1);
            }
        },
        /** Texts of the live blocks directly under a page or block, in order. */
        texts(id) {
            return listChildren(id, { page_size: 100 }).results.map(block => (block[block.type]?.rich_text || []).map(part => part.plain_text).join('') || block[block.type]?.title || '');
        },
        rows(id) {
            return queryDatabase(id, { page_size: 100 }).results;
        },
        /** Fail the next `times` calls that `test(call)` accepts. `call` is `{ method, path, write }`. */
        fail(mode, test = (call) => call.write, { times = 1, code = null } = {}) {
            state.faults.push({ mode, test, times, code });
        },
        writes() {
            return state.calls.filter(call => call.write);
        },
        /** Route `notionService` to this fake. Call `uninstall()` to put the real one back. */
        install() {
            if (!original) original = notionService._request;
            notionService._request = request;
            return this;
        },
        uninstall() {
            if (original) notionService._request = original;
            original = null;
        },
        reset() {
            state.objects.clear(); state.children.clear(); state.tokens.clear(); state.tokensSeen.clear();
            state.calls.length = 0; state.faults.length = 0; state.counter = 0; state.clock = 0;
        }
    };
}

module.exports = { createFakeNotion };
