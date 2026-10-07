/**
 * The reset inventory (documentation/data_reset.md): what an installation's
 * application data is made of, who owns each piece, and the deletion plan
 * for each scope. Pure data and derivation: it requires no service that
 * touches the database and opens nothing; db/reset.js executes the plans.
 *
 * Everything is derived from the places that already know:
 *
 *   tables           schema.sql (parsed with the dialect's own statement
 *                    splitter and foreign-key extractor); owners come from
 *                    features/inventory.js `ownerOf('table', name)`
 *   derived indexes  the per-dimension memory_vec_<dims> tables, which
 *                    memoryService.cleanupVecIndex() empties
 *   file sets        backupService.FILE_SETS (what a backup carries),
 *                    dormantDataService's workspace roots, plus the few
 *                    sets a backup deliberately leaves out (sandbox runs,
 *                    account exports, music and ambience files)
 *
 * What cannot be derived is written down here, as data, and pinned by
 * tests/resetInventory.test.js: the rows reset intentionally keeps or
 * recreates, the policy for every foreign key that crosses a feature
 * boundary, and the rows of shared tables a feature's data lives in
 * (a Discriminator column, never an owner guess). A new table, a new
 * cross-feature foreign key or a new backup file set that is not
 * classified fails that test.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const dialect = require('./dialect');
const featureInventory = require('../features/inventory');
const runtimePaths = require('../runtimePaths');
const backupService = require('../services/backupService');
const dormantDataService = require('../services/dormantDataService');

const SCOPES = Object.freeze(['instance', 'feature']);
const CORE_ID = 'core';
const FEATURE_ID_RE = /^[a-z][A-Za-z0-9]{0,31}$/;
const VEC_TABLE_RE = /^memory_vec_\d+$/;
const SAFE_LITERAL_RE = /^[A-Za-z0-9._:-]{1,80}$/;

class ResetPlanError extends Error {
    constructor(code, message, details = null) {
        super(message);
        this.name = 'ResetPlanError';
        this.code = code;
        this.details = details;
    }
}

/* --------------------------------------------------------- what is kept */

/**
 * Rows a full-instance reset leaves exactly as they are, and why. These
 * tables are listed in the plan and in the doc as "intentionally kept".
 */
const INSTANCE_KEPT = Object.freeze({
    operator_audit: 'The required operation audit (documentation/work_ledger.md): who changed what on this instance. Erasure nulls actors and keeps rows; a reset keeps them too, and the reset itself adds its own rows.',
    data_migrations: 'Markers of one-time backfills that already ran. They hold no person data, and keeping them stops a backfill from running again over an empty database.'
});

/**
 * Tables a full-instance reset empties and then deliberately writes again
 * (or that the application refills on its own).
 */
const INSTANCE_RECREATED = Object.freeze({
    instance_state: 'Emptied, then the paused flag is written again inside the same transaction, so the instance comes back paused (like a restore) and the Host room offers Resume.',
    self_docs: 'Goobster\'s own documentation corpus. Emptied, then seeded again from documentation/ on the next start (or by npm run docs:seed). It is public docs, not user data.'
});

/* -------------------------------------- foreign keys across feature lines */

/**
 * The policy for every foreign key whose child and parent have different
 * owners. A feature purge empties the parent table, so each such child
 * needs a decision: `delete` (the child row means nothing without the
 * parent) or `set-null` (the child row stays valid without the link).
 * Keyed `<child>.<column>`; pinned against schema.sql by the inventory test.
 */
const CROSS_OWNER_REFERENCES = Object.freeze({
    'followed_sources.projectId': {
        parent: 'observatory_projects',
        policy: 'delete',
        note: 'A followed source bound to a project is that project\'s source list; it goes with the project (the foreign key already says ON DELETE CASCADE).'
    },
    'followed_source_entries.expeditionId': {
        parent: 'spitball_expeditions',
        policy: 'set-null',
        note: 'A fetched entry stays valid without the expedition that read it (the foreign key already says ON DELETE SET NULL).'
    },
    'observatory_jobs.projectId': {
        parent: 'observatory_projects',
        policy: 'delete',
        note: 'A job runs inside a project; purging projects removes the jobs of those projects (ON DELETE CASCADE). The observatory feature depends on projects, so it is dormant whenever projects is.'
    },
    'project_trigger_deliveries.sourceJobId': {
        parent: 'observatory_jobs',
        policy: 'delete',
        note: 'A delivery record names the job that fired it; purging the observatory removes those records (ON DELETE CASCADE). The trigger itself stays.'
    }
});

/* ------------------------------------------ rows of shared tables by kind */

/**
 * Work kinds written into the ledgers (work_failures.kind,
 * resource_events.workKind, usage_reservations.workKind), by owning feature.
 * Kinds not listed belong to core (chat, automation, followup, delivery,
 * watch, reflection, followed_source) and are never touched by a purge.
 */
const WORK_KIND_OWNER = Object.freeze({
    expedition: 'expeditions',
    job: 'observatory',
    sandbox: 'sandbox',
    mission_step: 'projects',
    trigger: 'projects',
    integration_action: 'github'
});

/** resource_events.kind values that belong to a feature rather than core. */
const RESOURCE_KIND_OWNER = Object.freeze({
    sandbox_seconds: 'sandbox',
    speech_seconds: 'voice'
});

/**
 * Rows of tables another owner holds that belong to a feature's data.
 * Each entry names the table, a literal predicate in the SQLite dialect
 * (no parameters: every value is a constant here) and what happens to
 * the rows. `files` names a column holding a path relative to the data
 * directory whose files go with the rows. Pinned by the inventory test,
 * which runs every statement against an empty schema on both engines.
 */
const SHARED_ROWS = Object.freeze({
    projects: [
        { table: 'kg_artifacts', where: "scopeKey LIKE 'PROJECT:%'", files: { column: 'relativePath', base: 'data' }, note: 'Saved files of a project knowledge scope.' },
        { table: 'kg_nodes', where: "scopeKey LIKE 'PROJECT:%'", note: 'The project knowledge scopes (PROJECT:<id>); edges, tag links, provenance, embeddings and revisions cascade with the node.' },
        { table: 'kg_tags', where: "scopeKey LIKE 'PROJECT:%'", note: 'Tags of a project knowledge scope.' },
        { table: 'kg_reflection_runs', where: "scopeKey LIKE 'PROJECT:%'", note: 'Reflection runs over a project knowledge scope.' },
        { table: 'parlor_conversations', where: 'projectId IS NOT NULL', note: 'The project discussion; "deleting the project deletes the discussion" (schema.sql). Messages cascade.' },
        { table: 'knowledge_transfers', where: "targetKind = 'project'", note: 'Transfers into a project; the destination is gone.' },
        { table: 'inbox_items', where: "kind = 'project'", note: 'Inbox notices about projects.' }
    ],
    observatory: [
        { table: 'followups', where: 'jobId IS NOT NULL', note: 'Job-completion reminders name a job that no longer exists.' },
        { table: 'attention_provenance', where: "sourceKind = 'observatory_job'", note: 'Attention evidence that points at a job.' }
    ],
    expeditions: [
        { table: 'kg_provenance', where: "sourceKind IN ('research_claim', 'research_source', 'expedition')", note: 'The notes stay; their provenance rows pointing at expedition research go.' },
        { table: 'inbox_items', where: "kind = 'expedition'", note: 'Inbox notices about expeditions.' }
    ],
    github: [
        { table: 'user_integrations', where: "provider = 'github'", note: 'Personal GitHub tokens (other providers stay).' }
    ]
});

/* ------------------------------------------------------------ file sets */

/**
 * Where each backup file set belongs. A set backupService carries that is
 * not in one of these two maps fails the inventory test.
 */
const BACKUP_SET_OWNER = Object.freeze({
    projects: 'projects',
    dashboards: 'projects',
    uploads: CORE_ID,
    artifacts: CORE_ID,
    images: CORE_ID,
    'tavern-assets': 'tavern',
    'web-push-keys': 'push'
});

const BACKUP_SET_KEPT = Object.freeze({
    'tavern-campaigns': 'Operator-authored campaign files (data/tavern/campaigns). They are content the operator wrote, not data the instance collected; reset keeps them.'
});

/** Sets a backup does not carry (derived, temporary or regenerable), resolved against the data and cache roots. */
const EXTRA_SETS = Object.freeze([
    { id: 'sandbox-runs', owner: 'sandbox', label: 'sandbox run workspaces', base: 'data', segments: ['sandbox', 'runs'], kind: 'dir' },
    { id: 'account-exports', owner: CORE_ID, label: 'account export archives', base: 'data', segments: ['account-exports'], kind: 'dir' },
    { id: 'music-library', owner: 'music', label: 'downloaded music', base: 'data', segments: ['music'], kind: 'dir' },
    { id: 'ambience', owner: 'music', label: 'generated ambience', base: 'data', segments: ['ambience'], kind: 'dir' },
    { id: 'music-cache', owner: 'music', label: 'generated music cache', base: 'cache', segments: ['music'], kind: 'dir' }
]);

/** What is deliberately outside every scope, for the doc and the preview. */
const NEVER_TOUCHED = Object.freeze([
    'config.json and every environment value',
    'the manager store (identity, operations journal, audit log, maintenance and lifecycle state)',
    'the database file or schema itself, its extensions and its roles',
    'features.json (which features are on)',
    'the sandbox Python environment and package overlay (data/sandbox/venv, data/sandbox/overlay)',
    'operator-authored files (data/self-docs, data/tavern/campaigns)',
    'the code, the release payload and the logs'
]);

/* ------------------------------------------------------ schema parsing */

let schemaCache = null;

function readSchemaSql() {
    return fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
}

function matchingParen(text, open) {
    let depth = 0;
    let inString = false;
    for (let index = open; index < text.length; index++) {
        const ch = text[index];
        if (inString) {
            if (ch === "'") inString = false;
            continue;
        }
        if (ch === "'") inString = true;
        else if (ch === '(') depth++;
        else if (ch === ')') {
            depth--;
            if (depth === 0) return index;
        }
    }
    return -1;
}

function topLevelItems(body) {
    const items = [];
    let depth = 0;
    let inString = false;
    let current = '';
    for (const ch of body) {
        if (inString) {
            current += ch;
            if (ch === "'") inString = false;
            continue;
        }
        if (ch === "'") {
            inString = true;
            current += ch;
        } else if (ch === '(') {
            depth++;
            current += ch;
        } else if (ch === ')') {
            depth--;
            current += ch;
        } else if (ch === ',' && depth === 0) {
            items.push(current.trim());
            current = '';
        } else {
            current += ch;
        }
    }
    if (current.trim()) items.push(current.trim());
    return items;
}

const TABLE_ITEM_KEYWORDS = /^(PRIMARY|UNIQUE|FOREIGN|CHECK|CONSTRAINT)\b/i;

/**
 * Parse the CREATE TABLE statements of a schema file.
 * @param {string} [sql]
 * @returns {Array<{ name: string, columns: string[], references: Array<{ column: string, refTable: string, refColumn: string, onDelete: string }> }>}
 */
function parseSchema(sql = readSchemaSql()) {
    const tables = [];
    for (const statement of dialect.splitStatements(sql)) {
        const header = /^\s*CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+"?([A-Za-z_][\w]*)"?/i.exec(statement);
        if (!header) continue;
        const name = header[1];
        const { sql: stripped, fks } = dialect.extractCreateTableForeignKeys(statement);
        const open = stripped.indexOf('(');
        const close = matchingParen(stripped, open);
        const items = topLevelItems(stripped.slice(open + 1, close));
        const columns = [];
        const references = fks.map(fk => ({ column: fk.column, refTable: fk.refTable, refColumn: fk.refColumn, onDelete: fk.onDelete }));
        for (const item of items) {
            if (TABLE_ITEM_KEYWORDS.test(item)) {
                const fk = /FOREIGN\s+KEY\s*\(\s*"?([\w]+)"?\s*\)\s*REFERENCES\s+"?([\w]+)"?\s*\(\s*"?([\w]+)"?\s*\)(\s+ON\s+DELETE\s+(?:CASCADE|SET\s+NULL|RESTRICT|NO\s+ACTION|SET\s+DEFAULT))?/i.exec(item);
                if (fk) references.push({ column: fk[1], refTable: fk[2], refColumn: fk[3], onDelete: (fk[4] || '').trim() });
                continue;
            }
            const column = /^"?([A-Za-z_][\w]*)"?/.exec(item);
            if (column) columns.push(column[1]);
        }
        tables.push({ name, columns, references });
    }
    return tables;
}

function loadSchema() {
    if (!schemaCache) schemaCache = parseSchema();
    return schemaCache;
}

/**
 * Children before parents (every foreign key points from a later table to
 * an earlier one in reverse). Self references are ignored; a cycle is an
 * error, because a plan that deletes in table order would not be FK-safe.
 * @returns {string[]}
 */
function deletionOrder(tables) {
    const names = new Set(tables.map(table => table.name));
    const childrenOf = new Map(tables.map(table => [table.name, new Set()]));
    for (const table of tables) {
        for (const ref of table.references) {
            if (ref.refTable === table.name || !names.has(ref.refTable)) continue;
            if (!childrenOf.get(ref.refTable).has(table.name)) {
                childrenOf.get(ref.refTable).add(table.name);
            }
        }
    }
    // A table is deletable once every table that references it is gone.
    const referencing = new Map(tables.map(table => [table.name, childrenOf.get(table.name).size]));
    const ready = [...names].filter(name => referencing.get(name) === 0).sort();
    const order = [];
    const parentsOf = new Map(tables.map(table => [table.name, new Set(table.references.filter(ref => ref.refTable !== table.name && names.has(ref.refTable)).map(ref => ref.refTable))]));
    while (ready.length > 0) {
        const name = ready.shift();
        order.push(name);
        for (const parent of [...parentsOf.get(name)].sort()) {
            referencing.set(parent, referencing.get(parent) - 1);
            if (referencing.get(parent) === 0) {
                ready.push(parent);
                ready.sort();
            }
        }
    }
    if (order.length !== names.size) {
        const stuck = [...names].filter(name => !order.includes(name)).sort();
        throw new ResetPlanError('INVENTORY_CYCLE', 'Foreign keys form a cycle, so no children-first deletion order exists.', { tables: stuck });
    }
    return order;
}

/* --------------------------------------------------------------- build */

function ownerOfTable(name) {
    const claim = featureInventory.ownerOf('table', name);
    return claim ? claim.owner : null;
}

function resolveBase(base, roots) {
    return base === 'cache' ? roots.cacheDir : roots.dataDir;
}

/**
 * Resolve every file set against the given roots (the installation's, not
 * the process's: a manager acting for another data directory resolves
 * against that one).
 */
function resolveFileSets({ dataDir, cacheDir }) {
    const sets = [];
    const kept = [];
    for (const set of backupService.FILE_SETS) {
        if (Object.prototype.hasOwnProperty.call(BACKUP_SET_KEPT, set.id)) {
            kept.push({ id: set.id, label: set.label, reason: BACKUP_SET_KEPT[set.id] });
            continue;
        }
        const owner = BACKUP_SET_OWNER[set.id];
        if (!owner) throw new ResetPlanError('UNCLASSIFIED_FILE_SET', `The backup file set "${set.id}" is not classified for reset.`);
        const target = set.resolve(dataDir);
        sets.push({ id: set.id, owner, label: set.label, path: target, kind: path.extname(target) === '.json' ? 'file' : 'dir', inBackup: true });
    }
    for (const spec of EXTRA_SETS) {
        sets.push({
            id: spec.id,
            owner: spec.owner,
            label: spec.label,
            path: path.join(resolveBase(spec.base, { dataDir, cacheDir }), ...spec.segments),
            kind: spec.kind,
            inBackup: false
        });
    }
    return { sets, kept };
}

/** The workspace roots dormantDataService owns, as segments below the data directory. */
function dormantRootSegments() {
    return {
        projects: path.relative(runtimePaths.dataDir, dormantDataService.PROJECTS_ROOT).split(path.sep),
        dashboards: path.relative(runtimePaths.dataDir, dormantDataService.DASHBOARDS_ROOT).split(path.sep)
    };
}

/**
 * @param {Object} [options]
 * @param {string} [options.dataDir]
 * @param {string} [options.cacheDir]
 * @param {string[]} [options.extraRoots] further roots the installation owns (for example a separate uploads root)
 * @param {string} [options.schemaSql]
 */
function buildInventory({ dataDir = runtimePaths.dataDir, cacheDir = runtimePaths.cacheDir, extraRoots = [], schemaSql } = {}) {
    const parsed = schemaSql === undefined ? loadSchema() : parseSchema(schemaSql);
    const order = deletionOrder(parsed);
    const byName = new Map();
    for (const table of parsed) {
        const owner = ownerOfTable(table.name);
        if (!owner) throw new ResetPlanError('UNCLASSIFIED_TABLE', `Table "${table.name}" has no owner in features/inventory.js.`);
        byName.set(table.name, { ...table, owner });
    }
    const { sets, kept } = resolveFileSets({ dataDir, cacheDir });
    return Object.freeze({
        dataDir,
        cacheDir,
        allowedRoots: Object.freeze([dataDir, cacheDir, ...extraRoots].filter(Boolean)),
        tables: order.map(name => byName.get(name)),
        byName,
        order,
        fileSets: sets,
        keptFileSets: kept,
        dormantRoots: dormantRootSegments()
    });
}

/* -------------------------------------------------------------- scopes */

function normalizeScope(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new ResetPlanError('INVALID_SCOPE', '"scope" must be "instance" or "feature".');
    }
    const { scope, feature } = input;
    if (!SCOPES.includes(scope)) throw new ResetPlanError('INVALID_SCOPE', '"scope" must be "instance" or "feature".');
    if (scope === 'instance') {
        if (feature !== undefined) throw new ResetPlanError('INVALID_SCOPE', 'A full-instance reset does not take a feature.');
        return { scope };
    }
    if (typeof feature !== 'string' || !FEATURE_ID_RE.test(feature)) {
        throw new ResetPlanError('INVALID_SCOPE', 'A feature purge needs "feature": the id of one feature.');
    }
    if (feature === CORE_ID) throw new ResetPlanError('CORE_NOT_PURGEABLE', 'Core is never purged; a full-instance reset is the way to empty it.');
    if (!featureInventory.FEATURE_IDS.includes(feature)) throw new ResetPlanError('UNKNOWN_FEATURE', 'That is not a feature of this release.');
    return { scope, feature };
}

/** The text the operator types: the installation id, plus `:<feature>` for a purge. */
function confirmationFor(installationId, scope) {
    return scope.scope === 'feature' ? `${installationId}:${scope.feature}` : String(installationId);
}

function literalList(values) {
    for (const value of values) {
        if (!SAFE_LITERAL_RE.test(value)) throw new ResetPlanError('UNSAFE_LITERAL', 'An inventory constant is not a plain identifier.');
    }
    return values.map(value => `'${value}'`).join(', ');
}

function ledgerSteps(feature) {
    const kinds = Object.keys(WORK_KIND_OWNER).filter(kind => WORK_KIND_OWNER[kind] === feature);
    const resourceKinds = Object.keys(RESOURCE_KIND_OWNER).filter(kind => RESOURCE_KIND_OWNER[kind] === feature);
    const steps = [];
    if (kinds.length > 0) {
        const list = literalList(kinds);
        steps.push({ op: 'delete-where', table: 'work_failures', where: `kind IN (${list})`, note: 'Failure ledger rows for this feature\'s kinds of work.' });
        steps.push({ op: 'delete-where', table: 'resource_events', where: `workKind IN (${list})`, note: 'Resource events attributed to this feature\'s work.' });
        steps.push({ op: 'delete-where', table: 'usage_reservations', where: `workKind IN (${list})`, note: 'Usage reservations for this feature\'s work.' });
    }
    if (resourceKinds.length > 0) {
        steps.push({ op: 'delete-where', table: 'resource_events', where: `kind IN (${literalList(resourceKinds)})`, note: 'Resource events of a kind only this feature produces.' });
    }
    return steps;
}

function tutorialSteps(feature) {
    const ids = Object.keys(featureInventory.tutorials).filter(id => featureInventory.tutorials[id].owner === feature);
    if (ids.length === 0) return [];
    const list = literalList(ids);
    return ['tutorial_progress', 'tutorial_events', 'tutorial_feedback'].map(table => ({
        op: 'delete-where', table, where: `tutorialId IN (${list})`, note: 'Tutorial progress of this feature\'s tutorials.'
    }));
}

function planDigest(plan) {
    return crypto.createHash('sha256')
        .update(JSON.stringify({ scope: plan.scope, feature: plan.feature || null, steps: plan.steps, files: plan.files.map(set => set.id) }))
        .digest('hex')
        .slice(0, 16);
}

/**
 * The exact plan for one scope.
 * @param {ReturnType<typeof buildInventory>} inventory
 * @param {{ scope: string, feature?: string }} scopeInput
 */
function planScope(inventory, scopeInput) {
    const scope = normalizeScope(scopeInput);
    if (scope.scope === 'instance') return planInstance(inventory);
    return planFeature(inventory, scope.feature);
}

function planInstance(inventory) {
    const cleared = [];
    const steps = [];
    for (const table of inventory.tables) {
        if (Object.prototype.hasOwnProperty.call(INSTANCE_KEPT, table.name)) continue;
        cleared.push(table.name);
        steps.push({ op: 'delete-all', table: table.name });
    }
    const plan = {
        scope: 'instance',
        feature: null,
        steps,
        tables: {
            cleared,
            kept: Object.entries(INSTANCE_KEPT).map(([table, reason]) => ({ table, reason })),
            recreated: Object.entries(INSTANCE_RECREATED).map(([table, reason]) => ({ table, reason }))
        },
        derived: { vectorIndex: true },
        files: inventory.fileSets.map(set => ({ ...set })),
        keptFiles: [...inventory.keptFileSets],
        neverTouched: [...NEVER_TOUCHED]
    };
    plan.digest = planDigest(plan);
    return plan;
}

/**
 * Tables a plan reaches only through foreign keys: rows that go with a
 * deleted parent (`ON DELETE CASCADE`, transitively) or lose a link to it
 * (`ON DELETE SET NULL`), listed so the preview and the doc name them
 * instead of leaving them to the database.
 */
function cascadeReach(inventory, steps) {
    const explicit = new Set(steps.map(step => step.table));
    const reach = new Map();
    const seen = new Set(steps.filter(step => step.op !== 'set-null').map(step => step.table));
    const queue = [...seen];
    while (queue.length > 0) {
        const parent = queue.shift();
        for (const table of inventory.tables) {
            if (table.name === parent || explicit.has(table.name)) continue;
            for (const ref of table.references) {
                if (ref.refTable !== parent) continue;
                const cascade = /CASCADE/i.test(ref.onDelete);
                if (!cascade && !/SET\s+NULL/i.test(ref.onDelete)) continue;
                if (cascade || !reach.has(table.name)) {
                    reach.set(table.name, { table: table.name, op: cascade ? 'delete' : 'set-null', via: parent, column: ref.column });
                }
                if (cascade && !seen.has(table.name)) {
                    seen.add(table.name);
                    queue.push(table.name);
                }
            }
        }
    }
    return [...reach.values()].sort((a, b) => a.table.localeCompare(b.table));
}

function planFeature(inventory, feature) {
    const owned = inventory.tables.filter(table => table.owner === feature).map(table => table.name);
    const ownedSet = new Set(owned);
    const steps = [];

    const referencesToOwned = [];
    for (const table of inventory.tables) {
        if (ownedSet.has(table.name)) continue;
        for (const ref of table.references) {
            if (ownedSet.has(ref.refTable)) referencesToOwned.push({ child: table.name, ...ref });
        }
    }
    for (const ref of referencesToOwned) {
        const policy = CROSS_OWNER_REFERENCES[`${ref.child}.${ref.column}`];
        if (!policy) {
            throw new ResetPlanError('UNPLANNED_REFERENCE', `${ref.child}.${ref.column} references ${ref.refTable} across feature lines and has no deletion policy.`);
        }
        if (policy.policy === 'delete') {
            steps.push({ op: 'delete-where', table: ref.child, where: `${ref.column} IS NOT NULL`, note: policy.note, reference: `${ref.child}.${ref.column}` });
        } else {
            steps.push({ op: 'set-null', table: ref.child, column: ref.column, note: policy.note, reference: `${ref.child}.${ref.column}` });
        }
    }
    for (const entry of SHARED_ROWS[feature] || []) {
        steps.push({ op: 'delete-where', table: entry.table, where: entry.where, note: entry.note, ...(entry.files ? { files: entry.files } : {}) });
    }
    steps.push(...ledgerSteps(feature), ...tutorialSteps(feature));
    for (const table of owned) steps.push({ op: 'delete-all', table });

    const files = inventory.fileSets.filter(set => set.owner === feature).map(set => ({ ...set }));
    const plan = {
        scope: 'feature',
        feature,
        steps,
        tables: {
            cleared: owned,
            partial: steps.filter(step => step.op !== 'delete-all').map(step => ({ table: step.table, op: step.op, ...(step.where ? { where: step.where } : {}), ...(step.column ? { column: step.column } : {}), note: step.note })),
            cascading: cascadeReach(inventory, steps),
            kept: [],
            recreated: []
        },
        derived: { vectorIndex: false },
        files,
        keptFiles: [],
        neverTouched: [...NEVER_TOUCHED]
    };
    plan.empty = steps.length === 0 && files.length === 0;
    plan.digest = planDigest(plan);
    return plan;
}

/** Tables a plan reads or writes, for the counts and the verification. */
function tablesOf(plan) {
    return [...new Set(plan.steps.map(step => step.table))];
}

/**
 * The sanitized view of a plan the CLI prints and the route returns: table
 * and file-set names, never a row and never a path with content. File sets
 * show their id, label, owner and whether a backup carries them; the path
 * stays below the data root and is shown relative to it.
 */
function describePlan(plan, { inventory, installationId = null, counts = null, fileCounts = null } = {}) {
    const rel = (target) => {
        const base = inventory ? [inventory.dataDir, inventory.cacheDir].find(root => target === root || target.startsWith(root + path.sep)) : null;
        return base ? path.relative(path.dirname(base), target).split(path.sep).join('/') : path.basename(target);
    };
    return {
        scope: plan.scope,
        feature: plan.feature,
        digest: plan.digest,
        confirm: installationId ? confirmationFor(installationId, plan) : null,
        tables: {
            cleared: plan.tables.cleared.map(name => ({ table: name, ...(counts && counts[name] !== undefined ? { rows: counts[name] } : {}) })),
            partial: plan.tables.partial || [],
            cascading: plan.tables.cascading || [],
            kept: plan.tables.kept,
            recreated: plan.tables.recreated
        },
        derived: plan.derived,
        files: plan.files.map(set => ({
            id: set.id,
            label: set.label,
            owner: set.owner,
            inBackup: set.inBackup,
            location: rel(set.path),
            ...(fileCounts && fileCounts[set.id] ? fileCounts[set.id] : {})
        })),
        keptFiles: plan.keptFiles,
        neverTouched: plan.neverTouched
    };
}

/** Count files and bytes below a path without following links. */
function countTree(target) {
    let files = 0;
    let bytes = 0;
    const walk = (current) => {
        let stat;
        try {
            stat = fs.lstatSync(current);
        } catch {
            return;
        }
        if (stat.isSymbolicLink()) {
            files += 1;
        } else if (stat.isDirectory()) {
            let entries = [];
            try {
                entries = fs.readdirSync(current);
            } catch { }
            for (const entry of entries) walk(path.join(current, entry));
        } else {
            files += 1;
            bytes += stat.size;
        }
    };
    walk(target);
    return { files, bytes };
}

function isInside(parent, child) {
    const rel = path.relative(parent, child);
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/**
 * Throw when a file set could take something that is never in scope: a
 * set outside the installation's own roots, or one that contains (or is) a
 * protected path.
 * @param {Array<{ id: string, path: string }>} sets
 * @param {string[]} protectedPaths
 * @param {string[]} [allowedRoots] when given, every set must lie strictly inside one of these
 */
function assertFileSetsSafe(sets, protectedPaths, allowedRoots = null) {
    for (const set of sets) {
        const root = path.resolve(set.path);
        if (allowedRoots && !allowedRoots.filter(Boolean).some(allowed => isInside(path.resolve(allowed), root))) {
            throw new ResetPlanError('FILE_SET_UNSAFE', `The file set "${set.id}" is outside this installation's data roots; reset was refused.`, { set: set.id });
        }
        for (const protectedPath of protectedPaths.filter(Boolean)) {
            const other = path.resolve(protectedPath);
            if (other === root || other.startsWith(root + path.sep)) {
                throw new ResetPlanError('FILE_SET_UNSAFE', `The file set "${set.id}" contains something reset must never touch; reset was refused.`, { set: set.id });
            }
        }
    }
}

module.exports = {
    SCOPES,
    CORE_ID,
    VEC_TABLE_RE,
    INSTANCE_KEPT,
    INSTANCE_RECREATED,
    CROSS_OWNER_REFERENCES,
    WORK_KIND_OWNER,
    RESOURCE_KIND_OWNER,
    SHARED_ROWS,
    BACKUP_SET_OWNER,
    BACKUP_SET_KEPT,
    EXTRA_SETS,
    NEVER_TOUCHED,
    ResetPlanError,
    parseSchema,
    deletionOrder,
    buildInventory,
    normalizeScope,
    confirmationFor,
    planScope,
    tablesOf,
    describePlan,
    countTree,
    assertFileSetsSafe
};
