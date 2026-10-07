/**
 * Verifying a migration beyond row counts (documentation/db_migration.md).
 * Every check runs against the source and the target and reports names,
 * counts and booleans only - never a key, a row or a path.
 *
 *   counts         per-table row counts, source vs target
 *   foreign keys   every FK in schema.sql: orphan rows on the target
 *   identities     MAX(id) of every identity column equals the source's and
 *                  the sequence's next value is MAX + 1
 *   relationships  five join checks across the main domains (RELATIONSHIPS)
 *   content        a deterministic sample per table (the first, the last and
 *                  three interior rows by primary key), compared column by
 *                  column after normalisation (see `sameValue`)
 *   attachments    every path-bearing column still resolves (attachments.js)
 *   vectors        the derived vector index rebuilt from memory_embeddings
 *
 * The sample keys are chosen on the SOURCE and looked up on the target by
 * primary-key equality, so a different collation (SQLite NOCASE vs
 * Postgres CITEXT, byte order vs locale order) cannot make the two sides
 * pick different rows.
 */

const { expectedSchema, quoteIdent } = require('./schemaModel');
const { checkAttachments } = require('./attachments');
const { identityColumns } = require('./copy');

/** The five relationship checks: the same SQL runs on both sides and the counts must agree. */
const RELATIONSHIPS = Object.freeze([
    {
        id: 'user-memories',
        label: 'users and the memories they authored',
        sql: 'SELECT COUNT(*) AS c FROM memory_embeddings m JOIN users u ON u.discordId = m.authorId'
    },
    {
        id: 'project-files',
        label: 'projects, their assets and each asset\'s head version',
        sql: `SELECT COUNT(*) AS c FROM project_assets a
              JOIN observatory_projects p ON p.id = a.projectId AND p.userId = a.userId
              JOIN project_asset_versions v ON v.id = a.currentVersionId AND v.assetId = a.id`
    },
    {
        id: 'inbox-person',
        label: 'inbox items and the person (user or principal) they belong to',
        sql: `SELECT COUNT(*) AS c FROM inbox_items i
              WHERE i.userId IN (SELECT discordId FROM users) OR i.userId IN (SELECT id FROM principals)`
    },
    {
        id: 'exchange-positions-accounts',
        label: 'exchange positions and the accounts that hold them',
        sql: `SELECT (SELECT COUNT(*) FROM short_positions s JOIN exchange_accounts a ON a.guildId = s.guildId AND a.userId = s.userId)
                    + (SELECT COUNT(*) FROM option_positions o JOIN exchange_accounts a ON a.guildId = o.guildId AND a.userId = o.userId) AS c`
    },
    {
        id: 'graph-edges-nodes',
        label: 'knowledge-graph edges and both of their nodes',
        sql: `SELECT COUNT(*) AS c FROM kg_edges e
              JOIN kg_nodes s ON s.id = e.sourceId JOIN kg_nodes t ON t.id = e.targetId`
    }
]);

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?Z?$/;

function canonicalTimestamp(text) {
    return text.replace('T', ' ').replace(/Z$/, '').replace(/\.0+$/, '');
}

/**
 * Normalisation applied to both sides before a content comparison:
 *   null / undefined         -> null
 *   boolean                  -> 0 / 1 (the facade stores booleans as integers)
 *   bigint, number           -> Number
 *   Buffer                   -> its bytes (hex)
 *   Date                     -> UTC `YYYY-MM-DD HH:MM:SS`
 *   timestamp-shaped string  -> `T` replaced by a space, `Z` and a zero fraction dropped
 *   JSON-text string         -> parsed and compared by deep equality, when the strings differ
 *   any other string         -> exact (no case folding: CITEXT columns keep their case)
 * A number against a numeric string compares by value.
 */
function sameValue(a, b) {
    const x = normalize(a);
    const y = normalize(b);
    if (x === y) return true;
    if (typeof x === 'string' && typeof y === 'string') {
        if (TIMESTAMP.test(x) && TIMESTAMP.test(y)) return canonicalTimestamp(x) === canonicalTimestamp(y);
        return sameJson(x, y);
    }
    if ((typeof x === 'number' && typeof y === 'string') || (typeof x === 'string' && typeof y === 'number')) {
        return String(x) === String(y) || Number(x) === Number(y);
    }
    return false;
}

function normalize(value) {
    if (value === undefined || value === null) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value === 'bigint') return Number(value);
    if (Buffer.isBuffer(value)) return `buf:${value.toString('hex')}`;
    if (value instanceof Date) return value.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
    return value;
}

function sameJson(x, y) {
    if (!/^\s*[[{]/.test(x) || !/^\s*[[{]/.test(y)) return false;
    try {
        return deepEqual(JSON.parse(x), JSON.parse(y));
    } catch {
        return false;
    }
}

function deepEqual(a, b) {
    if (a === b) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every(key => deepEqual(a[key], b[key]));
}

function samplePositions(count) {
    if (count <= 0) return [];
    return [...new Set([0, Math.floor(count / 4), Math.floor(count / 2), Math.floor((3 * count) / 4), count - 1])].sort((p, q) => p - q);
}

async function checkCounts({ source, target, plan }) {
    const mismatched = [];
    for (const table of plan.tables) {
        const have = Number((await target.get(`SELECT COUNT(*) AS c FROM ${quoteIdent(table.name)}`)).c);
        const want = source.count(table.name);
        if (have !== want) mismatched.push({ table: table.name, source: want, target: have });
    }
    return { checked: plan.tables.length, mismatched, ok: mismatched.length === 0 };
}

async function checkForeignKeys({ target, plan }) {
    const model = expectedSchema();
    const included = new Set(plan.tables.map(table => table.name));
    const orphans = [];
    let checked = 0;
    for (const table of plan.tables) {
        for (const fk of model.tables[table.name].foreignKeys) {
            if (!included.has(fk.parent)) continue;
            const parentColumn = fk.parentColumn || model.tables[fk.parent].primaryKey[0];
            checked++;
            const row = await target.get(
                `SELECT COUNT(*) AS c FROM ${quoteIdent(table.name)} c
                 LEFT JOIN ${quoteIdent(fk.parent)} p ON p.${quoteIdent(parentColumn)} = c.${quoteIdent(fk.column)}
                 WHERE c.${quoteIdent(fk.column)} IS NOT NULL AND p.${quoteIdent(parentColumn)} IS NULL`
            );
            if (Number(row.c) > 0) orphans.push({ table: table.name, column: fk.column, orphans: Number(row.c) });
        }
    }
    return { checked, orphans, ok: orphans.length === 0 };
}

async function checkIdentities({ source, target, plan }) {
    const included = new Set(plan.tables.map(table => table.name));
    const problems = [];
    let checked = 0;
    for (const { table, column } of await identityColumns(target)) {
        if (!included.has(table)) continue;
        checked++;
        const wanted = source.get(`SELECT COALESCE(MAX(${quoteIdent(column)}), 0) AS m FROM ${quoteIdent(table)}`).m;
        const max = Number((await target.get(`SELECT COALESCE(MAX(${quoteIdent(column)}), 0) AS m FROM ${quoteIdent(table)}`)).m);
        const seq = (await target.rawQuery('SELECT pg_get_serial_sequence($1, $2) AS name', [quoteIdent(table), column])).rows[0].name;
        const state = (await target.rawQuery(`SELECT last_value, is_called FROM ${seq}`)).rows[0];
        const next = state.is_called ? Number(state.last_value) + 1 : Number(state.last_value);
        if (max !== Number(wanted)) problems.push({ table, column, reason: 'MAX_DIFFERS' });
        else if (next !== max + 1) problems.push({ table, column, reason: 'SEQUENCE_BEHIND' });
    }
    return { checked, problems, ok: problems.length === 0 };
}

async function checkRelationships({ source, target }) {
    const results = [];
    for (const check of RELATIONSHIPS) {
        const want = Number(source.get(check.sql).c);
        const have = Number((await target.get(check.sql)).c);
        results.push({ id: check.id, source: want, target: have, ok: want === have });
    }
    return { checked: results.length, results, ok: results.every(item => item.ok) };
}

async function checkContent({ source, target, plan }) {
    const model = expectedSchema();
    const mismatches = [];
    let rowsCompared = 0;
    let tablesSampled = 0;
    const noKey = [];
    for (const table of plan.tables) {
        const key = model.tables[table.name].primaryKey.filter(col => table.columns.includes(col));
        if (key.length === 0) {
            noKey.push(table.name);
            continue;
        }
        const total = source.count(table.name);
        if (total === 0) continue;
        tablesSampled++;
        const order = key.map(quoteIdent).join(', ');
        const columnList = table.columns.map(quoteIdent).join(', ');
        for (const position of samplePositions(total)) {
            const want = source.get(`SELECT ${columnList} FROM ${quoteIdent(table.name)} ORDER BY ${order} LIMIT 1 OFFSET ${position}`);
            const where = key.map(col => `${quoteIdent(col)} = @k_${col}`).join(' AND ');
            const params = Object.fromEntries(key.map(col => [`k_${col}`, want[col]]));
            const have = await target.get(`SELECT ${columnList} FROM ${quoteIdent(table.name)} WHERE ${where}`, params);
            rowsCompared++;
            if (!have) {
                mismatches.push({ table: table.name, position, reason: 'ROW_MISSING' });
                continue;
            }
            for (const col of table.columns) {
                if (!sameValue(want[col], have[col])) mismatches.push({ table: table.name, position, column: col, reason: 'VALUE_DIFFERS' });
            }
        }
    }
    return { tablesSampled, rowsCompared, mismatches, withoutPrimaryKey: noKey, ok: mismatches.length === 0 };
}

/** Rebuild the derived vector index on the target and check it covers every embedding. */
async function rebuildVectors({ target }) {
    let available = false;
    try {
        available = Boolean(target.vecAvailable());
    } catch { }
    if (!available) return { available: false, rebuilt: false, reason: 'VECTOR_EXTENSION_UNAVAILABLE', embeddings: 0, indexed: 0, ok: true };
    const memoryService = require('../../services/memoryService');
    await memoryService.syncVecIndex();
    const groups = await target.all('SELECT dims, COUNT(*) AS c FROM memory_embeddings GROUP BY dims');
    let embeddings = 0;
    let indexed = 0;
    for (const group of groups) {
        embeddings += Number(group.c);
        const row = await target.get(`SELECT COUNT(*) AS c FROM memory_vec_${Number(group.dims)}`);
        indexed += Number(row.c);
    }
    return { available: true, rebuilt: true, embeddings, indexed, ok: embeddings === indexed };
}

/**
 * @param {Object} params
 * @param {Object} params.source openSource() handle
 * @param {Object} params.target the database facade (Postgres)
 * @param {Object} params.plan planCopy() result
 * @param {string} params.dataDir the data root the attachment references resolve against
 * @param {boolean} [params.vectors] rebuild the vector index (default true)
 */
async function verifyMigration({ source, target, plan, dataDir, vectors = true }) {
    const counts = await checkCounts({ source, target, plan });
    const foreignKeys = await checkForeignKeys({ target, plan });
    const identities = await checkIdentities({ source, target, plan });
    const relationships = await checkRelationships({ source, target });
    const content = await checkContent({ source, target, plan });
    const attachments = await checkAttachments({
        source: { all: async sql => source.all(sql) },
        target: { all: sql => target.all(sql) },
        dataDir
    });
    const vectorIndex = vectors ? await rebuildVectors({ target }) : { available: null, rebuilt: false, ok: true };
    const failures = [];
    if (!counts.ok) failures.push('COUNT_MISMATCH');
    if (!foreignKeys.ok) failures.push('FOREIGN_KEY_ORPHANS');
    if (!identities.ok) failures.push('IDENTITY_MISMATCH');
    if (!relationships.ok) failures.push('RELATIONSHIP_MISMATCH');
    if (!content.ok) failures.push('CONTENT_MISMATCH');
    if (!attachments.ok) failures.push('ATTACHMENTS_UNRESOLVED');
    if (!vectorIndex.ok) failures.push('VECTOR_INDEX_INCOMPLETE');
    return {
        ok: failures.length === 0,
        failures,
        rows: plan.tables.reduce((sum, table) => sum + table.rows, 0),
        tables: plan.tables.length,
        counts,
        foreignKeys,
        identities,
        relationships,
        content,
        attachments,
        vectors: vectorIndex
    };
}

module.exports = {
    verifyMigration,
    checkCounts,
    checkForeignKeys,
    checkIdentities,
    checkRelationships,
    checkContent,
    rebuildVectors,
    sameValue,
    samplePositions,
    RELATIONSHIPS
};
