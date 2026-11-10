/**
 * The Notion connector for delegated work (DA-11e, ADR 0030;
 * documentation/delegated_notion.md).
 *
 * One grant is one Notion page or one Notion database, named by id
 * (`notion:<32 hex>`). Everything a call names (a page, a block, a
 * database) is proved to be inside that resource before it is touched: its
 * chain of parents is walked up to the granted id, one request a step, and
 * a chain that ends at the workspace, runs past the limit or cannot be read
 * is outside. Nothing else in the workspace is reachable, whatever the
 * person's Notion token could see.
 *
 * Every call uses the acting person's own Notion token from
 * `user_integrations`, handed in for the one call. This module keeps no
 * token, logs nothing, and writes no ledger row.
 *
 * Writes and how each is checked after a crash (`reconcile`):
 *  - `append` and `createPage` add content. Each ends with one grey line,
 *    "Goobster · ref <12 hex>", derived from the operation id and the
 *    input. Reconciling looks for that line; found means it happened.
 *  - `updateBlock` and `updatePage` set a value. Setting it twice is the
 *    same as setting it once, so reconciling compares what is there with
 *    what was asked: equal is done, different is made (again).
 *
 * Archiving (Notion's API has no permanent delete) is an *ask*: a run can
 * only request it, and it happens when the person approves that one
 * request themselves.
 *
 * A failure Notion itself reports (400, 401, 403, 404, 409, 429), and any
 * failure before the changing request was sent, is `declined`: certainly
 * nothing changed. A timeout or 5xx on the changing request itself is
 * thrown as it is: the framework treats that as "may have happened".
 */

const crypto = require('node:crypto');
const notion = require('../../notionService');

const ID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
/** Parents walked before a target is treated as outside the resource. */
const MAX_HOPS = 12;
const MAX_APPEND_BLOCKS = 60;
const MAX_TEXT_CHARS = 6000;
const RICH_TEXT_CHARS = 2000;
const TITLE_CHARS = 200;
const ROW_LIMIT = 25;
const ROW_CHARS = 400;
const LABEL_CHARS = 80;
/** Pages of children (100 each) read when looking for a write's marker. */
const RECONCILE_PAGES = 20;
const RECONCILE_CANDIDATES = 10;
const MARKER_PREFIX = 'Goobster · ref ';

/** Block types whose text a run may set. Notion does not let a block change type. */
const EDITABLE = new Set([
    'paragraph', 'heading_1', 'heading_2', 'heading_3', 'bulleted_list_item', 'numbered_list_item',
    'to_do', 'toggle', 'quote', 'callout', 'code'
]);
/** Notion's own refusals: the request was understood and nothing was changed. */
const CERTAIN = new Set(['BAD_REQUEST', 'BAD_TOKEN', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT', 'RATE_LIMITED', 'BAD_PAGE_ID']);

// The registry requires this module while it is loading, so it is reached lazily.
const declined = (code, message) => require('./registry').declined(code, message);

const hex = (id) => String(id ?? '').replace(/-/g, '').toLowerCase();
const same = (a, b) => hex(a) === hex(b) && hex(a).length === 32;
const dashed = (id) => notion.normalizePageId(id);
const isId = (value) => typeof value === 'string' && ID.test(value.trim());
const clip = (value, max) => {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/**
 * A pasted link or a dashed id becomes the 32 hex characters a grant keeps.
 * In a link the id is the end of the last part of the path ("Title-<id>");
 * what follows "?" (a database's view, a peeked row) names something else.
 */
function canonical(input) {
    let raw = String(input ?? '').trim();
    let link = false;
    if (/^https?:\/\//i.test(raw)) {
        try { raw = new URL(raw).pathname.split('/').filter(Boolean).pop() || ''; } catch { return null; }
        link = true;
    }
    const bare = raw.replace(/-/g, '');
    const found = (link ? /[0-9a-f]{32}$/i : /^[0-9a-f]{32}$/i).exec(bare);
    return found ? found[0].toLowerCase() : null;
}

/** Everything before the changing request: any failure here changed nothing. */
async function before(work) {
    try {
        return await work();
    } catch (error) {
        if (error?.declined === true) throw error;
        if (error?.name === 'NotionError') throw declined(error.code, error.message);
        throw error;
    }
}

/** The changing request itself: only Notion's own refusal is certain. */
async function change(work) {
    try {
        return await work();
    } catch (error) {
        if (CERTAIN.has(error?.code)) throw declined(error.code, error.message);
        throw error;
    }
}

/** Whether an id is a page or a database never changes, so it is remembered. */
const kinds = new Map();
function remember(id, kind) {
    if (kinds.size > 500) kinds.clear();
    kinds.set(hex(id), kind);
}

/** The granted resource, read now: `{ id, kind: 'page'|'database', object }`. */
async function rootOf(token, resource) {
    const id = dashed(resource);
    let kind = kinds.get(hex(id));
    let object = null;
    if (kind !== 'database') {
        try {
            object = await notion.getPage(token, id);
            kind = 'page';
        } catch (error) {
            if (kind === 'page' || !['NOT_FOUND', 'BAD_REQUEST'].includes(error?.code)) throw error;
        }
    }
    if (!object) {
        object = await notion.getDatabase(token, id);
        kind = 'database';
    }
    remember(id, kind);
    if (object.archived || object.in_trash) throw declined('RESOURCE_ARCHIVED', 'the granted Notion resource is in the trash');
    return { id, kind, object };
}

const fetchers = {
    block: (token, id) => notion.getBlock(token, id),
    page: (token, id) => notion.getPage(token, id),
    database: (token, id) => notion.getDatabase(token, id)
};

function parentOf(object) {
    const parent = object?.parent;
    if (parent?.type === 'page_id') return { id: parent.page_id, kind: 'page' };
    if (parent?.type === 'database_id') return { id: parent.database_id, kind: 'database' };
    if (parent?.type === 'block_id') return { id: parent.block_id, kind: 'block' };
    return null;
}

/**
 * Prove `id` is the granted resource or inside it, and return the object
 * read for it. `kind` says which endpoint answers for the id (a page id
 * also answers as a block). Throws `declined('OUTSIDE_RESOURCE')` otherwise.
 */
async function inside(token, root, id, kind) {
    const outside = () => declined('OUTSIDE_RESOURCE', 'that is not inside the Notion page or database this work was granted');
    if (same(id, root.id)) return root.object;
    let first = null;
    let current = { id: dashed(id), kind };
    for (let hop = 0; hop < MAX_HOPS; hop += 1) {
        let object;
        try {
            object = await fetchers[current.kind](token, current.id);
        } catch (error) {
            // Not shared with the integration, or not there: it cannot be shown to be inside.
            if (['NOT_FOUND', 'BAD_REQUEST', 'FORBIDDEN'].includes(error?.code)) throw outside();
            throw error;
        }
        if (!first) first = object;
        const parent = parentOf(object);
        if (!parent) throw outside();
        if (same(parent.id, root.id)) return first;
        current = { id: dashed(parent.id), kind: parent.kind };
    }
    throw outside();
}

// --- Text in and out ---------------------------------------------------------

function richText(text, annotations = null) {
    const content = String(text ?? '');
    const parts = [];
    for (let at = 0; at < content.length; at += RICH_TEXT_CHARS) {
        parts.push({ type: 'text', text: { content: content.slice(at, at + RICH_TEXT_CHARS) }, ...(annotations ? { annotations } : {}) });
    }
    return parts;
}

const blockOf = (type, text, extra = {}) => ({ object: 'block', type, [type]: { rich_text: richText(text), ...extra } });

/** Markdown-ish lines to Notion blocks: the reverse of `notionService.blockToText`. */
function toBlocks(text) {
    const blocks = [];
    for (const raw of String(text ?? '').split(/\r?\n/)) {
        const line = raw.trimEnd();
        if (!line.trim()) continue;
        let match;
        if (/^---+$/.test(line.trim())) blocks.push({ object: 'block', type: 'divider', divider: {} });
        else if ((match = /^(#{1,3})\s+(.*)$/.exec(line))) blocks.push(blockOf(`heading_${match[1].length}`, match[2]));
        else if ((match = /^[-*]\s+\[( |x|X)\]\s+(.*)$/.exec(line))) blocks.push(blockOf('to_do', match[2], { checked: match[1] !== ' ' }));
        else if ((match = /^[-*]\s+(.*)$/.exec(line))) blocks.push(blockOf('bulleted_list_item', match[1]));
        else if ((match = /^\d+[.)]\s+(.*)$/.exec(line))) blocks.push(blockOf('numbered_list_item', match[1]));
        else if ((match = /^>\s?(.*)$/.exec(line))) blocks.push(blockOf('quote', match[1]));
        else blocks.push(blockOf('paragraph', line.trim()));
    }
    return blocks;
}

/** Sorted-key JSON, so one input always gives one marker. */
function stable(value) {
    if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value ?? null);
}

/** The line that ends everything a run adds: who wrote it, and which operation. */
function markerOf(operationId, resource, input) {
    const digest = crypto.createHash('sha256').update(`${operationId}\n${hex(resource)}\n${stable(input)}`).digest('hex').slice(0, 12);
    return `${MARKER_PREFIX}${digest}`;
}

const markerBlock = (marker) => ({
    object: 'block', type: 'paragraph', paragraph: { rich_text: richText(marker, { italic: true, color: 'gray' }) }
});

const plainOf = (block) => notion.richTextToPlain(block?.[block?.type]?.rich_text);

/** A property's value as text, for reading and for comparing after a crash. */
function propertyText(property) {
    const type = property?.type;
    const value = property?.[type];
    switch (type) {
        case 'title':
        case 'rich_text': return notion.richTextToPlain(value);
        case 'number': return value == null ? '' : String(value);
        case 'select':
        case 'status': return value?.name || '';
        case 'multi_select': return (value || []).map(option => option.name).join(', ');
        case 'checkbox': return value ? 'yes' : 'no';
        case 'date': return value?.start ? `${value.start}${value.end ? ` to ${value.end}` : ''}` : '';
        case 'url':
        case 'email':
        case 'phone_number': return value || '';
        case 'people': return (value || []).map(person => person.name || 'someone').join(', ');
        case 'created_time':
        case 'last_edited_time': return value || '';
        case 'formula': return value?.[value?.type] == null ? '' : String(value[value.type]);
        default: return '';
    }
}

/** What a run gave for a property, as Notion wants it. Throws `declined` for what cannot be set. */
function toProperty(name, type, value) {
    const wrong = (what) => declined('BAD_PROPERTY_VALUE', `"${clip(name, 60)}" takes ${what}`);
    const cleared = value === null || value === '';
    switch (type) {
        case 'title':
        case 'rich_text':
            if (typeof value !== 'string' && !cleared) throw wrong('text');
            return { [type]: richText(cleared ? '' : value) };
        case 'number': {
            if (cleared) return { number: null };
            const number = typeof value === 'number' ? value : Number(String(value).trim());
            if (!Number.isFinite(number) || (typeof value !== 'number' && typeof value !== 'string')) throw wrong('a number');
            return { number };
        }
        case 'select':
        case 'status':
            if (cleared && type === 'select') return { select: null };
            if (typeof value !== 'string' || !value.trim()) throw wrong('one option name');
            return { [type]: { name: value.trim().slice(0, 100) } };
        case 'multi_select':
            if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string' || !entry.trim())) throw wrong('a list of option names');
            return { multi_select: value.map(entry => ({ name: entry.trim().slice(0, 100) })) };
        case 'checkbox':
            if (typeof value !== 'boolean') throw wrong('true or false');
            return { checkbox: value };
        case 'date': {
            if (cleared) return { date: null };
            const date = typeof value === 'string' ? { start: value.trim() } : value;
            const ok = (text) => typeof text === 'string' && /^\d{4}-\d{2}-\d{2}([T ][\d:.+\-Z]+)?$/.test(text);
            if (!date || !ok(date.start) || (date.end != null && !ok(date.end))) throw wrong('a date (YYYY-MM-DD) or { start, end }');
            return { date: { start: date.start, ...(date.end ? { end: date.end } : {}) } };
        }
        case 'url':
        case 'email':
        case 'phone_number':
            if (cleared) return { [type]: null };
            if (typeof value !== 'string') throw wrong('text');
            return { [type]: value.trim().slice(0, 2000) };
        default:
            throw declined('UNSUPPORTED_PROPERTY', `"${clip(name, 60)}" is a ${type || 'kind of'} property, which cannot be set from here`);
    }
}

/** The text `propertyText` gives once Notion holds what `toProperty` built. */
function expectedText(type, built) {
    const value = built[type];
    if (type === 'title' || type === 'rich_text') return value.map(part => part.text.content).join('');
    if (type === 'select' || type === 'status') return value?.name || '';
    if (type === 'multi_select') return value.map(option => option.name).join(', ');
    return propertyText({ type, [type]: value });
}

/** The properties a call names, resolved against what the page or database has. */
function buildProperties(schema, given) {
    const names = Object.keys(schema || {});
    const titleName = names.find(name => schema[name]?.type === 'title') || null;
    const built = {};
    const expected = {};
    for (const [asked, value] of Object.entries(given || {})) {
        // "title" always means the title property, whatever the database calls it.
        const name = Object.prototype.hasOwnProperty.call(schema || {}, asked) ? asked : (asked.toLowerCase() === 'title' ? titleName : null);
        if (!name) throw declined('NO_SUCH_PROPERTY', `there is no property "${clip(asked, 60)}" there`);
        const type = schema[name].type;
        built[name] = toProperty(name, type, value);
        expected[name] = expectedText(type, built[name]);
    }
    return { built, expected, titleName };
}

const propertiesLine = (properties) => Object.entries(properties || {})
    .filter(([, property]) => property?.type !== 'title')
    .map(([name, property]) => [name, propertyText(property)])
    .filter(([, text]) => text)
    .map(([name, text]) => `${name}: ${clip(text, 120)}`)
    .join('; ');

/** A block type in words a person reads: "to-do", "bulleted list item". */
const typeName = (type) => (type === 'to_do' ? 'to-do' : String(type || 'block').replace(/_/g, ' '));

const labelOfBlock = (block) => {
    if (block?.type === 'child_page') return `the page "${clip(block.child_page?.title || 'Untitled', LABEL_CHARS)}"`;
    // The block's own words, without the "- [ ]" a page read shows before them.
    const text = clip(plainOf(block) || notion.blockToText(block), LABEL_CHARS);
    return text ? `the ${typeName(block?.type)} "${text}"` : `a ${typeName(block?.type)} block`;
};

// --- Where a call lands --------------------------------------------------------

/** The page (or block) to read or append to: the one named, else the granted page. */
async function pageTarget(token, root, named, kind) {
    if (named) return { id: dashed(named), object: await inside(token, root, named, kind) };
    if (root.kind !== 'page') throw declined('NEEDS_PAGE', 'the grant is a database: name one of its pages (see rows)');
    return { id: root.id, object: root.object };
}

/** The database to query or add to: the one named, else the granted database. */
async function databaseTarget(token, root, named) {
    if (named && !same(named, root.id)) {
        const object = await inside(token, root, named, 'database');
        return { id: dashed(named), object };
    }
    if (root.kind !== 'database') throw declined('NEEDS_DATABASE', 'the grant is a page: name a database inside it');
    return { id: root.id, object: root.object };
}

async function findMarker(token, parentId, marker) {
    let cursor = null;
    for (let page = 0; page < RECONCILE_PAGES; page += 1) {
        const batch = await notion.listChildren(token, parentId, { cursor });
        if ((batch.results || []).some(block => plainOf(block).trim() === marker)) return 'found';
        if (!batch.has_more) return 'absent';
        cursor = batch.next_cursor;
    }
    // More content than is read here: it cannot be said either way.
    return 'unknown';
}

/** The block an edit names: inside the resource, of a type whose text can be set, not in the trash. */
async function editableBlock({ resource, input, token }) {
    const root = await rootOf(token, resource);
    if (same(input.block, root.id)) throw declined('NOT_A_BLOCK', 'that is the granted page itself, not a block in it');
    const block = await inside(token, root, input.block, 'block');
    if (!EDITABLE.has(block?.type)) throw declined('UNSUPPORTED_BLOCK', `a ${typeName(block?.type)} block cannot be edited from here`);
    if (input.checked !== undefined && block.type !== 'to_do') throw declined('NOT_A_TODO', 'only a to-do can be ticked');
    if (block.archived || block.in_trash) throw declined('BLOCK_ARCHIVED', 'that block is in the trash');
    return block;
}

/** The page whose properties a call sets, with the values as Notion wants them. */
async function pageToSet({ resource, input, token }) {
    const root = await rootOf(token, resource);
    const target = await pageTarget(token, root, input.page, 'page');
    if (target.object?.archived || target.object?.in_trash) throw declined('PAGE_ARCHIVED', 'that page is in the trash');
    return { ...target, ...buildProperties(target.object?.properties, input.properties) };
}

/** What an archive request names: a page or block inside the resource, never the resource itself. */
async function archivable({ resource, target, token }) {
    const root = await rootOf(token, resource);
    if (same(target, root.id)) throw declined('ROOT_NOT_ARCHIVABLE', 'the granted page or database itself cannot be archived from here');
    const block = await inside(token, root, target, 'block');
    if (block?.type === 'child_database') throw declined('UNSUPPORTED_BLOCK', 'a database cannot be archived from here');
    return block;
}

// --- Validation (no network) -----------------------------------------------------

const optionalId = (value) => value === undefined || value === null || isId(value);
const textProblem = (value, { required }) => {
    if (value === undefined || value === null) return required ? 'EMPTY_TEXT' : null;
    if (typeof value !== 'string') return 'BAD_TEXT';
    if (required && !value.trim()) return 'EMPTY_TEXT';
    return value.length > MAX_TEXT_CHARS ? 'TEXT_TOO_LONG' : null;
};
const propertiesProblem = (value, { required }) => {
    if (value === undefined || value === null) return required ? 'NO_PROPERTIES' : null;
    if (typeof value !== 'object' || Array.isArray(value)) return 'BAD_PROPERTIES';
    const names = Object.keys(value);
    if (required && !names.length) return 'NO_PROPERTIES';
    return names.length > 30 ? 'BAD_PROPERTIES' : null;
};

// --- The manifest ------------------------------------------------------------------

module.exports = {
    id: 'notion',
    name: 'Notion',
    description: 'Read and write one Notion page or one Notion database that you name, as you. Nothing else in your workspace is reachable.',
    decision: {
        recordedBy: 'Rob (owner)',
        recordedAt: '2026-11-09',
        reference: 'Owner decision 12: Notion is the first outside connector, reading and writing (ADR 0030)'
    },
    credential: { provider: 'notion' },
    resource: {
        describe: 'the id of one Notion page or database (paste its link). It must be shared with your Notion integration',
        pattern: /^[0-9a-f]{32}$/,
        canonical
    },
    /**
     * The person's own Notion allowlist (Settings, Connections): when they
     * keep one, a resource that is not on it is not used, whatever a
     * responsibility grants. An empty list restricts nothing. A lookup that
     * fails is a refusal: the caller treats a throw as "not allowed".
     */
    async permits({ userId, resource }) {
        const allow = await require('../../userSettingsService').getPreference(String(userId), 'notionAllowlist');
        if (!Array.isArray(allow) || !allow.length) return null;
        return allow.some(entry => canonical(entry) === resource) ? null : 'NOT_ON_ALLOWLIST';
    },
    reads: [
        {
            operation: 'page',
            describe: 'A page\'s title, properties and text. Input: { page? } - the id of a page inside the resource; without it, the granted page.',
            validate: (input) => (optionalId(input.page) ? null : 'BAD_ID'),
            run: ({ resource, input, token }) => before(async () => {
                const root = await rootOf(token, resource);
                const target = await pageTarget(token, root, input.page, 'page');
                const page = await notion.getPageText(token, target.id);
                const properties = propertiesLine(target.object?.properties);
                return [
                    `Page "${page.title}" (${target.id})`,
                    properties ? `Properties: ${properties}` : '',
                    '',
                    page.content || '(no text)',
                    page.truncated ? '\n(The page is longer than this.)' : ''
                ].filter((line, index) => line || index === 2).join('\n');
            })
        },
        {
            operation: 'blocks',
            describe: 'The blocks directly under a page or block, one per line with its id, for editing. Input: { parent?, cursor? } - parent is a page or block id inside the resource; without it, the granted page.',
            validate: (input) => (!optionalId(input.parent) ? 'BAD_ID' : (input.cursor != null && typeof input.cursor !== 'string') ? 'BAD_CURSOR' : null),
            run: ({ resource, input, token }) => before(async () => {
                const root = await rootOf(token, resource);
                const target = await pageTarget(token, root, input.parent, 'block');
                const batch = await notion.listChildren(token, target.id, { cursor: input.cursor || null, limit: 50 });
                const lines = (batch.results || []).map((block) => {
                    const type = block.type === 'child_page' ? 'page' : block.type === 'child_database' ? 'database' : block.type;
                    const text = block.type === 'child_page' ? (block.child_page?.title || 'Untitled')
                        : block.type === 'child_database' ? (block.child_database?.title || 'Untitled') : plainOf(block);
                    const checked = block.type === 'to_do' ? (block.to_do?.checked ? ' [x]' : ' [ ]') : '';
                    return `${block.id} ${type}${checked}${block.has_children ? ' (has blocks under it)' : ''}: ${clip(text, 300)}`;
                });
                if (!lines.length) return 'There are no blocks there.';
                return `${lines.join('\n')}${batch.has_more && batch.next_cursor ? `\nThere are more: pass cursor "${batch.next_cursor}".` : ''}`;
            })
        },
        {
            operation: 'rows',
            describe: 'Rows of a database: each row\'s page id, title and properties. Input: { database?, title?, limit?, cursor? } - database is a database id inside the resource (without it, the granted database); title keeps rows whose title contains that text.',
            validate: (input) => {
                if (!optionalId(input.database)) return 'BAD_ID';
                if (input.title != null && (typeof input.title !== 'string' || input.title.length > TITLE_CHARS)) return 'BAD_TITLE';
                if (input.limit != null && !(Number.isSafeInteger(input.limit) && input.limit >= 1 && input.limit <= ROW_LIMIT)) return 'BAD_LIMIT';
                return input.cursor != null && typeof input.cursor !== 'string' ? 'BAD_CURSOR' : null;
            },
            run: ({ resource, input, token }) => before(async () => {
                const root = await rootOf(token, resource);
                const target = await databaseTarget(token, root, input.database);
                const schema = target.object?.properties || {};
                const titleName = Object.keys(schema).find(name => schema[name]?.type === 'title');
                const batch = await notion.queryDatabase(token, target.id, {
                    filter: input.title && titleName ? { property: titleName, title: { contains: input.title } } : null,
                    cursor: input.cursor || null,
                    limit: input.limit || 10
                });
                const rows = (batch.results || []).map((row) => {
                    const properties = propertiesLine(row.properties);
                    return clip(`${row.id} "${notion.titleOf(row)}"${properties ? ` | ${properties}` : ''}`, ROW_CHARS);
                });
                const head = `Database "${notion.titleOf(target.object)}" (${target.id}), properties: ${Object.entries(schema).map(([name, property]) => `${name} (${property.type})`).join(', ') || 'none'}`;
                if (!rows.length) return `${head}\nNo rows${input.title ? ' with that title' : ''}.`;
                return `${head}\n${rows.join('\n')}${batch.has_more && batch.next_cursor ? `\nThere are more: pass cursor "${batch.next_cursor}".` : ''}`;
            })
        }
    ],
    writes: [
        {
            operation: 'append',
            describe: 'Add text to the end of a page or under a block. Input: { text, parent? } - text is lines ("# heading", "- bullet", "- [ ] to-do", "> quote", else a paragraph); parent is a page or block id inside the resource, without it the granted page. A grey line saying Goobster wrote it is added after it.',
            validate: (input) => (!optionalId(input.parent) ? 'BAD_ID' : textProblem(input.text, { required: true })),
            async run({ resource, input, token, operationId }) {
                const { target, blocks } = await before(async () => {
                    const root = await rootOf(token, resource);
                    const found = await pageTarget(token, root, input.parent, 'block');
                    const built = toBlocks(input.text);
                    if (!built.length) throw declined('EMPTY_TEXT', 'there is no text to add');
                    if (built.length > MAX_APPEND_BLOCKS) throw declined('TOO_MANY_BLOCKS', `at most ${MAX_APPEND_BLOCKS} lines can be added at once`);
                    return { target: found, blocks: built };
                });
                await change(() => notion.appendChildren(token, target.id, [...blocks, markerBlock(markerOf(operationId, resource, input))]));
                return `added ${blocks.length} ${blocks.length === 1 ? 'block' : 'blocks'} to ${same(target.id, resource) ? 'the page' : target.id}`;
            },
            async reconcile({ resource, input, token, operationId }) {
                const root = await rootOf(token, resource);
                const target = await pageTarget(token, root, input.parent, 'block');
                const state = await findMarker(token, target.id, markerOf(operationId, resource, input));
                if (state === 'found') return { state: 'done', result: `added text to ${same(target.id, resource) ? 'the page' : target.id}` };
                return { state };
            }
        },
        {
            operation: 'createPage',
            describe: 'Add a row (a page) to a database. Input: { title, properties?, text?, database? } - properties maps a property name to its value (text, number, true/false, an option name, a list of option names, a YYYY-MM-DD date); text is the page\'s content, as for append; database is a database id inside the resource, without it the granted database.',
            validate: (input) => {
                if (!optionalId(input.database)) return 'BAD_ID';
                if (typeof input.title !== 'string' || !input.title.trim()) return 'NO_TITLE';
                if (input.title.length > TITLE_CHARS) return 'BAD_TITLE';
                return propertiesProblem(input.properties, { required: false }) || textProblem(input.text, { required: false });
            },
            async run({ resource, input, token, operationId }) {
                const { target, properties, children } = await before(async () => {
                    const root = await rootOf(token, resource);
                    const found = await databaseTarget(token, root, input.database);
                    const { built, titleName } = buildProperties(found.object?.properties, { ...(input.properties || {}), title: input.title.trim() });
                    if (!titleName) throw declined('NO_TITLE_PROPERTY', 'that database has no title property');
                    const blocks = toBlocks(input.text);
                    if (blocks.length > MAX_APPEND_BLOCKS) throw declined('TOO_MANY_BLOCKS', `at most ${MAX_APPEND_BLOCKS} lines can be added at once`);
                    return { target: found, properties: built, children: blocks };
                });
                const page = await change(() => notion.createPage(token, {
                    databaseId: target.id, properties, children: [...children, markerBlock(markerOf(operationId, resource, input))]
                }));
                return `created the page "${clip(input.title, LABEL_CHARS)}" (${page?.id || 'id not returned'})`;
            },
            async reconcile({ resource, input, token, operationId }) {
                const root = await rootOf(token, resource);
                const target = await databaseTarget(token, root, input.database);
                const schema = target.object?.properties || {};
                const titleName = Object.keys(schema).find(name => schema[name]?.type === 'title');
                if (!titleName) return { state: 'unknown' };
                const marker = markerOf(operationId, resource, input);
                const batch = await notion.queryDatabase(token, target.id, {
                    filter: { property: titleName, title: { equals: input.title.trim() } },
                    sorts: [{ timestamp: 'created_time', direction: 'descending' }],
                    limit: RECONCILE_CANDIDATES
                });
                for (const row of batch.results || []) {
                    const children = await notion.listChildren(token, row.id);
                    if ((children.results || []).some(block => plainOf(block).trim() === marker)) {
                        return { state: 'done', result: `created the page "${clip(input.title, LABEL_CHARS)}" (${row.id})` };
                    }
                }
                // More pages with that title than were looked at: it cannot be said.
                return { state: batch.has_more ? 'unknown' : 'absent' };
            }
        },
        {
            operation: 'updateBlock',
            describe: 'Replace the text of one existing block, or tick or untick a to-do. Input: { block, text?, checked? } - block is a block id from blocks. The block keeps its type.',
            validate: (input) => {
                if (!isId(input.block)) return 'BAD_ID';
                if (input.text === undefined && input.checked === undefined) return 'NOTHING_TO_SET';
                if (input.checked !== undefined && typeof input.checked !== 'boolean') return 'BAD_CHECKED';
                return input.text === undefined ? null : textProblem(input.text, { required: false }) || (typeof input.text === 'string' ? null : 'BAD_TEXT');
            },
            async run({ resource, input, token }) {
                const block = await before(() => editableBlock({ resource, input, token }));
                const body = {
                    [block.type]: {
                        ...(input.text !== undefined ? { rich_text: richText(input.text) } : {}),
                        ...(input.checked !== undefined ? { checked: input.checked } : {})
                    }
                };
                await change(() => notion.updateBlock(token, block.id, body));
                return `changed ${labelOfBlock(block)}`;
            },
            async reconcile({ resource, input, token }) {
                const block = await editableBlock({ resource, input, token });
                const textSet = input.text === undefined || plainOf(block) === String(input.text);
                const checkSet = input.checked === undefined || Boolean(block.to_do?.checked) === input.checked;
                return textSet && checkSet ? { state: 'done', result: `changed a ${typeName(block.type)} block` } : { state: 'absent' };
            }
        },
        {
            operation: 'updatePage',
            describe: 'Set properties of a page, such as its title or a row\'s status. Input: { properties, page? } - properties maps a property name ("title" for the title) to its new value, as for createPage; page is a page id inside the resource, without it the granted page.',
            validate: (input) => (!optionalId(input.page) ? 'BAD_ID' : propertiesProblem(input.properties, { required: true })),
            async run({ resource, input, token }) {
                const target = await before(() => pageToSet({ resource, input, token }));
                await change(() => notion.updatePage(token, target.id, target.built));
                return `set ${Object.keys(target.built).map(name => `"${clip(name, 40)}"`).join(', ')} on the page "${clip(notion.titleOf(target.object), LABEL_CHARS)}"`;
            },
            async reconcile({ resource, input, token }) {
                const target = await pageToSet({ resource, input, token });
                const set = Object.entries(target.expected).every(([name, text]) => propertyText(target.object.properties[name]) === text);
                return set ? { state: 'done', result: `set ${Object.keys(target.built).map(name => `"${clip(name, 40)}"`).join(', ')}` } : { state: 'absent' };
            }
        }
    ],
    asks: [
        {
            operation: 'archive',
            describe: 'Move one page or block inside the resource to Notion\'s trash. Never done for you: it asks the person, who approves or refuses that one request. Input: { target } - a page or block id.',
            action: 'Move it to the trash',
            consequence: 'It is moved to the trash in Notion, as you. You can restore it from Notion\'s trash for 30 days.',
            // The target is no longer something the request can be about: it ends instead of waiting.
            voids: ['OUTSIDE_RESOURCE', 'ROOT_NOT_ARCHIVABLE', 'UNSUPPORTED_BLOCK'],
            validate: (input) => (isId(input.target) ? null : 'BAD_ID'),
            prepare({ resource, input, token }) {
                return before(async () => {
                    const block = await archivable({ resource, target: input.target, token });
                    if (block.archived || block.in_trash) throw declined('ALREADY_ARCHIVED', 'that is already in the trash');
                    return { target: dashed(input.target), label: labelOfBlock(block) };
                });
            },
            async run({ resource, target, token }) {
                // Checked again at the moment of approval: it may have been moved since it was asked.
                const block = await before(() => archivable({ resource, target, token }));
                if (block.archived || block.in_trash) return `${labelOfBlock(block)} was already in the trash`;
                await change(() => (block.type === 'child_page' ? notion.archivePage(token, target) : notion.archiveBlock(token, target)));
                return `moved ${labelOfBlock(block)} to the trash`;
            }
        }
    ]
};

/** For the adapter's own tests. Not part of the manifest: the registry copies only what it knows. */
Object.defineProperty(module.exports, 'internals', {
    enumerable: false,
    value: { canonical, toBlocks, markerOf, propertyText, toProperty, MARKER_PREFIX, MAX_HOPS, forgetKinds: () => kinds.clear() }
});
