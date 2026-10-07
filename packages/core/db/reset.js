/**
 * Executes a data reset (documentation/data_reset.md) against the open
 * database: `resetInstance` and `purgeFeature` run one scope's plan inside
 * the transaction they are handed; `runReset` is the whole mutation (linked
 * files, the transaction, the derived vector index, the owned file sets,
 * compaction); `verifyReset` re-reads everything the plan promised.
 *
 * Statements are SQLite-dialect through the facade; the engine differences
 * (a Postgres schema, vec0 versus pgvector, VACUUM) live in db/dialect.js
 * and the adapters. Nothing here names a schema or a database, so on
 * Postgres every statement lands in the connection's own `search_path`
 * schema, and nothing here drops a table, a schema, an extension or a role.
 *
 * Every step is idempotent (deleting again is a no-op), which is what lets
 * the manager resume an interrupted reset by running it again.
 *
 * Results carry counts and table, file-set and feature names only: never a
 * row, a path or a file name.
 */

const fs = require('node:fs');
const path = require('node:path');
const db = require('./index');
const inventoryModule = require('./resetInventory');

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PAUSE_REASON = 'reset';

class ResetError extends Error {
    constructor(code, message, details = null) {
        super(message);
        this.name = 'ResetError';
        this.code = code;
        this.details = details;
    }
}

function ident(inventory, name) {
    if (!IDENTIFIER_RE.test(name) || !inventory.byName.has(name)) {
        throw new ResetError('UNKNOWN_TABLE', 'A plan names a table the inventory does not know.');
    }
    return name;
}

async function countRows(table, where = null) {
    const row = await db.get(`SELECT COUNT(*) AS c FROM ${table}${where ? ` WHERE ${where}` : ''}`);
    return Number(row?.c || 0);
}

/**
 * Apply one plan's table steps through `tx`. Returns per-table counts.
 * @returns {Promise<{ tables: Object<string, { before: number, removed: number, after: number }>, removed: number }>}
 */
async function applyPlan(tx, inventory, plan) {
    const touched = new Map();
    const note = async (table) => {
        if (!touched.has(table)) touched.set(table, { before: await countRows(table), removed: 0, after: 0 });
        return touched.get(table);
    };
    for (const step of plan.steps) {
        const table = ident(inventory, step.table);
        const entry = await note(table);
        if (step.op === 'delete-all') {
            entry.removed += (await tx.run(`DELETE FROM ${table}`)).changes;
        } else if (step.op === 'delete-where') {
            entry.removed += (await tx.run(`DELETE FROM ${table} WHERE ${step.where}`)).changes;
        } else if (step.op === 'set-null') {
            if (!IDENTIFIER_RE.test(step.column)) throw new ResetError('UNKNOWN_COLUMN', 'A plan names a column that is not an identifier.');
            await tx.run(`UPDATE ${table} SET ${step.column} = NULL WHERE ${step.column} IS NOT NULL`);
        } else {
            throw new ResetError('UNKNOWN_STEP', 'A plan holds a step this version cannot run.');
        }
    }
    let removed = 0;
    const tables = {};
    for (const [table, entry] of touched) {
        entry.after = await countRows(table);
        removed += entry.removed;
        tables[table] = entry;
    }
    return { tables, removed };
}

/**
 * Empty every application table (except the ones the plan keeps) and write
 * the paused flag again, all in the caller's transaction.
 * @param {{ run: Function }} tx
 * @param {ReturnType<typeof inventoryModule.buildInventory>} inventory
 */
async function resetInstance(tx, inventory) {
    const plan = inventoryModule.planScope(inventory, { scope: 'instance' });
    const applied = await applyPlan(tx, inventory, plan);
    const instanceStateService = require('../services/instanceStateService');
    const pause = await instanceStateService.pause({ reason: PAUSE_REASON, by: 'manager', detail: { scope: 'instance' } });
    return { scope: 'instance', feature: null, ...applied, recreated: ['instance_state'], paused: Boolean(pause) };
}

/**
 * Remove one feature's data in the caller's transaction, following the
 * feature's deletion plan (cross-feature references first, then shared
 * rows, then the feature's own tables, children before parents).
 * @param {{ run: Function }} tx
 * @param {ReturnType<typeof inventoryModule.buildInventory>} inventory
 * @param {string} featureId
 */
async function purgeFeature(tx, inventory, featureId) {
    const plan = inventoryModule.planScope(inventory, { scope: 'feature', feature: featureId });
    const applied = await applyPlan(tx, inventory, plan);
    return { scope: 'feature', feature: featureId, ...applied, recreated: [], paused: false };
}

/* ------------------------------------------------------- derived index */

async function vecTables() {
    return (await db.listTables({ includeDerived: true })).filter(name => inventoryModule.VEC_TABLE_RE.test(name));
}

async function countVectors() {
    let total = 0;
    for (const table of await vecTables()) total += await countRows(table);
    return total;
}

async function vectorOrphans() {
    let orphans = 0;
    if (!(await db.listTables()).includes('memory_embeddings')) return countVectors();
    for (const table of await vecTables()) {
        orphans += await countRows(table, 'mem_id NOT IN (SELECT id FROM memory_embeddings)');
    }
    return orphans;
}

/* --------------------------------------------------------------- files */

function relativeInside(root, relative) {
    const target = path.resolve(root, String(relative || '').replace(/\//g, path.sep));
    const rel = path.relative(root, target);
    if (!relative || rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
    return target;
}

/** Files that rows of a shared table point at (kept under the data root) and that go with those rows. */
async function collectLinkedFiles(inventory, plan) {
    const targets = [];
    for (const step of plan.steps) {
        if (!step.files || step.op !== 'delete-where') continue;
        const table = ident(inventory, step.table);
        if (!IDENTIFIER_RE.test(step.files.column)) continue;
        const rows = await db.all(`SELECT ${step.files.column} AS rel FROM ${table} WHERE ${step.where}`);
        for (const row of rows) {
            const target = relativeInside(inventory.dataDir, row.rel);
            if (target) targets.push(target);
        }
    }
    return [...new Set(targets)];
}

function removeFiles(targets, removeOwned) {
    let removed = 0;
    for (const target of targets) {
        if (removeOwned(target)) removed += 1;
    }
    return removed;
}

function removeFileSet(set, removeOwned) {
    const before = inventoryModule.countTree(set.path);
    const removed = removeOwned(set.path);
    if (removed && set.kind === 'dir') fs.mkdirSync(set.path, { recursive: true });
    return { id: set.id, owner: set.owner, files: before.files, bytes: before.bytes };
}

/* ---------------------------------------------------------------- run */

/**
 * The whole mutation for one scope. Idempotent: running it on an already
 * reset scope removes nothing and reports zeros.
 * @param {Object} params
 * @param {ReturnType<typeof inventoryModule.buildInventory>} params.inventory
 * @param {{ scope: string, feature?: string }} params.scope
 * @param {(target: string) => boolean} params.removeOwned the manager's guarded remover (refuses roots, home, links)
 * @param {string[]} [params.protectedPaths] paths no file set may contain (manager store, config, database file)
 * @returns {Promise<Object>} sanitized counts
 */
async function runReset({ inventory, scope, removeOwned, protectedPaths = [] }) {
    if (typeof removeOwned !== 'function') throw new ResetError('NO_REMOVER', 'A guarded file remover is required.');
    const plan = inventoryModule.planScope(inventory, scope);
    inventoryModule.assertFileSetsSafe(plan.files, protectedPaths, inventory.allowedRoots);

    const vectorsBefore = await countVectors();
    const linked = await collectLinkedFiles(inventory, plan);
    const linkedRemoved = removeFiles(linked, removeOwned);

    const applied = await db.transaction(tx => (plan.scope === 'instance'
        ? resetInstance(tx, inventory)
        : purgeFeature(tx, inventory, plan.feature)));

    const memoryService = require('../services/memoryService');
    await memoryService.cleanupVecIndex();

    const sets = plan.files.map(set => removeFileSet(set, removeOwned));

    let compacted = false;
    if (plan.scope === 'instance') {
        try {
            compacted = Boolean((await db.compactStorage()).compacted);
        } catch {
            compacted = false;
        }
    }

    return {
        scope: plan.scope,
        feature: plan.feature,
        digest: plan.digest,
        tables: applied.tables,
        rows: applied.removed,
        vectors: { before: vectorsBefore, after: await countVectors() },
        files: {
            sets,
            linked: linkedRemoved,
            total: sets.reduce((sum, set) => sum + set.files, 0) + linkedRemoved
        },
        recreated: applied.recreated,
        kept: plan.tables.kept.map(entry => entry.table),
        compacted
    };
}

/* -------------------------------------------------------------- verify */

async function referenceViolations(inventory, { onlyTables = null } = {}) {
    const present = new Set(await db.listTables());
    const violations = [];
    for (const table of inventory.tables) {
        if (!present.has(table.name)) continue;
        if (onlyTables && !onlyTables.has(table.name)) continue;
        for (const ref of table.references) {
            if (!present.has(ref.refTable) || ref.refTable === table.name) continue;
            const orphans = await countRows(
                `${ident(inventory, table.name)} AS c`,
                `c.${ref.column} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${ident(inventory, ref.refTable)} AS p WHERE p.${ref.refColumn} = c.${ref.column})`
            );
            if (orphans > 0) violations.push({ table: table.name, column: ref.column, orphans });
        }
    }
    return violations;
}

/**
 * Re-read what the plan promised. Returns the list of findings (empty means
 * verified): codes, table names and counts only.
 * @returns {Promise<{ ok: boolean, findings: Array<Object> }>}
 */
async function verifyReset({ inventory, scope }) {
    const plan = inventoryModule.planScope(inventory, scope);
    const findings = [];
    const present = new Set(await db.listTables());
    for (const step of plan.steps) {
        if (!present.has(step.table)) continue;
        let remaining = 0;
        if (step.op === 'delete-all') {
            remaining = await countRows(step.table, plan.scope === 'instance' && step.table === 'instance_state' ? "key <> 'paused'" : null);
        }
        else if (step.op === 'delete-where') remaining = await countRows(step.table, step.where);
        else if (step.op === 'set-null') remaining = await countRows(step.table, `${step.column} IS NOT NULL`);
        if (remaining > 0) findings.push({ code: 'ROWS_REMAINING', table: step.table, rows: remaining });
    }
    if (plan.scope === 'instance') {
        const vectors = await countVectors();
        if (vectors > 0) findings.push({ code: 'VECTORS_REMAINING', vectors });
        const paused = present.has('instance_state')
            ? await countRows('instance_state', "key = 'paused'")
            : 0;
        if (paused !== 1) findings.push({ code: 'NOT_PAUSED' });
    } else {
        const orphans = await vectorOrphans();
        if (orphans > 0) findings.push({ code: 'VECTORS_ORPHANED', vectors: orphans });
    }
    for (const set of plan.files) {
        const left = inventoryModule.countTree(set.path).files;
        if (left > 0) findings.push({ code: 'FILES_REMAINING', set: set.id, files: left });
    }
    for (const violation of await referenceViolations(inventory)) {
        findings.push({ code: 'REFERENCE_ORPHANS', table: violation.table, column: violation.column, rows: violation.orphans });
    }
    return { ok: findings.length === 0, findings };
}

module.exports = {
    ResetError,
    PAUSE_REASON,
    resetInstance,
    purgeFeature,
    runReset,
    verifyReset,
    countVectors,
    vectorOrphans,
    referenceViolations
};
