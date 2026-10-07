/**
 * The operations that connect an installation to an existing PostgreSQL
 * server (documentation/database_connection.md). The read-only probe is a
 * route (`POST /manager/api/database/test`), not a kind; these three change
 * something and are separate on purpose:
 *
 *   database.provision      creates, with an elevated credential and only
 *                           the actions the operator ticked, the database,
 *                           the least-privilege application role, the schema,
 *                           the two extensions and the grants. The elevated
 *                           credential lives in memory for this operation and
 *                           is never persisted.
 *   database.schema.apply   applies schema.sql (through install/dbInit.js's
 *                           child) to an EMPTY schema or brings an older
 *                           Goobster schema up to date. Never on a foreign one.
 *   database.connect        for an installation that already exists: inside
 *                           the maintenance barrier, probe, require a present
 *                           and compatible schema, start the workers fenced
 *                           on the new connection, then write the overlay
 *                           and the record. A nonempty SQLite installation is
 *                           refused and routed to the migration.
 *
 * The password of the application role and the elevated credential are
 * `privateInput`: in memory, never in a plan, the journal, the audit log, a
 * result or an error. Nothing here opens an application database in this
 * process: the schema applies in a child (install/dbInit.js), the validation
 * counts in the migration's child, and the probe is the core library's
 * read-only inspector over a short-lived `pg` client.
 */

const nodeFs = require('node:fs');
const { ManagerError } = require('../../errors');
const environment = require('../../environment');
const { createBarrier, NEXT_PHASES } = require('../../maintenance/barrier');
const registry = require('../../lifecycle/registry');
const dbInit = require('../../install/dbInit');
const { createInstallCore, exactKeys, parseBoolean } = require('../../install/engine');
const { createChildRunner } = require('../../migration/runChild');
const { createMigrationState } = require('../../migration/state');
const { validateOnTarget } = require('../../migration/validation');
const input = require('../../database/input');
const state = require('../../database/state');
const { createProbe } = require('../../database/probe');

const SESSION_VIA = ['local', 'bridge', 'setup', 'recovery'];
const PROVISION_STEPS = ['provision', 'verify'];
const SCHEMA_STEPS = ['probe', 'apply', 'verify'];
const CONNECT_STEPS = ['maintenance', 'probe', 'validate', 'cutover', 'settle', 'release'];
const PHASE_RANK = Object.freeze({ quiesced: 0, backup: 1, mutate: 2, verify: 3, cutover: 4 });
const COMPATIBLE = new Set(['goobster-current', 'goobster-older']);
const CODE_ONLY = /^[A-Za-z][A-Za-z0-9_]{0,60}$/;
const MIGRATE_HINT = 'Moving data from SQLite to Postgres is the migration (P4.3, documentation/db_migration.md): run "goobster-manager migrate preflight" and then "migrate run", or use the migration page of the portal.';

const allowed = (managerState, via) => (
    (managerState.state === 'unclaimed' && via === 'local')
    || (managerState.state === 'claimed' && SESSION_VIA.includes(via))
    || (managerState.state === 'recovery' && (via === 'local' || via === 'recovery'))
);
const allowedInstalled = (managerState, via) => managerState.state === 'claimed' && SESSION_VIA.includes(via);

function codeOf(error) {
    return error && typeof error.code === 'string' && CODE_ONLY.test(error.code) ? error.code : 'STEP_FAILED';
}

/** The findings of a probe as names a plan or an error may carry. */
function findingsOf(items) {
    return (items || []).map(item => ({ code: item.code, detail: item.detail }));
}

function summarize(report) {
    return {
        reachable: report.reachable,
        auth: report.auth,
        server: report.server ? { text: report.server.text, supported: report.server.supported } : null,
        tls: { effective: report.tls.effective, encrypted: report.tls.encrypted, verified: report.tls.verified },
        schema: report.schema ? { state: report.schema.state, fingerprint: report.schema.fingerprint, expectedFingerprint: report.schema.expectedFingerprint, missingTables: report.schema.missingTables.length, missingColumns: report.schema.missingColumns.length } : null,
        ok: report.verdict.ok,
        next: report.verdict.next,
        blocks: findingsOf(report.verdict.blocks),
        warnings: findingsOf(report.verdict.warnings)
    };
}

function createKinds({ settings, fs = nodeFs, now = () => new Date(), logger = console }) {
    const core = createInstallCore({ settings, fs, now, logger });
    const deps = () => settings.databaseDeps || {};
    const lib = input.connectionLib;
    const barrier = () => createBarrier({ settings, fs, now, logger, ...(deps().barrier || {}) });
    const runChild = (...args) => (deps().runChild || createChildRunner({ settings, ...(deps().spawn ? { spawn: deps().spawn } : {}) }))(...args);
    const migrationState = () => createMigrationState({ storeDir: settings.storeDir, fs, now });

    const needInput = (ctx) => {
        if (!ctx.input) throw new ManagerError(409, 'PLAN_INPUT_LOST', 'The manager restarted after planning; plan again.');
        return ctx.input;
    };

    const probe = createProbe(settings);

    function urlFor(connection, report) {
        return input.mapped(async () => lib.connectionUrl(connection, { tlsMode: report.tls.effective }));
    }

    /** What must be true of a probe before anything is written on the strength of it. */
    function assertUsable(report, { allow = COMPATIBLE } = {}) {
        if (!report.reachable) {
            throw new ManagerError(409, 'PROBE_BLOCKED', `The server cannot be used yet: ${[...new Set(report.verdict.blocks.map(item => item.code))].join(', ') || 'unreachable'}.`, { findings: findingsOf(report.verdict.blocks) });
        }
        const found = report.schema ? report.schema.state : 'missing-schema';
        if (found === 'foreign') throw new ManagerError(409, 'SCHEMA_FOREIGN', 'The schema holds tables that are not Goobster\'s. Goobster never writes into it: choose an empty schema or database.', { objects: report.schema.foreign.slice(0, 10) });
        if (found === 'goobster-newer') throw new ManagerError(409, 'SCHEMA_NEWER', 'The schema was written by a newer release of Goobster. Update this installation instead of connecting it to that database.');
        if (found === 'missing-schema') throw new ManagerError(409, 'SCHEMA_MISSING', 'The schema does not exist in that database; provision it first (database.provision, "create the schema").');
        if (!report.verdict.ok) {
            throw new ManagerError(409, 'PROBE_BLOCKED', `The server cannot be used yet: ${[...new Set(report.verdict.blocks.map(item => item.code))].join(', ')}.`, { findings: findingsOf(report.verdict.blocks) });
        }
        if (!allow.has(found)) {
            throw new ManagerError(409, 'SCHEMA_NOT_APPLIED', 'The schema is empty: apply it first (database.schema.apply). Connecting an installation to a database without its tables would start it with nothing.');
        }
        return found;
    }

    /** An environment variable that names another database wins over the overlay; saying "connected" then would be a lie. */
    function assertOverlayEffective(url) {
        const env = settings.processEnv || {};
        if (env.GOOBSTER_DB_URL && env.GOOBSTER_DB_URL !== url) {
            throw new ManagerError(409, 'ENV_OVERRIDES_OVERLAY', 'GOOBSTER_DB_URL is set in the process environment and names another database. The environment wins over the manager overlay, so this connection would not take effect: change the environment instead.');
        }
    }

    // ================================================================ provision
    function provisionKind() {
        async function check(parsed) {
            return input.mapped(() => (deps().checkProvisioning || lib.checkProvisioning)({
                application: parsed.connection, elevated: parsed.elevated, actions: parsed.actions, tlsMode: parsed.connection.tls.mode, ...(deps().provisioningDeps || {})
            }));
        }

        return {
            kind: 'database.provision',
            public: true,
            allowed,
            async plan(raw, ctx) {
                exactKeys(raw, new Set(['connection', 'elevated', 'actions']));
                const parsed = {
                    connection: input.parseConnection(raw.connection),
                    elevated: input.parseElevated(raw.elevated),
                    actions: input.parseActions(raw.actions)
                };
                const checked = await check(parsed);
                const shown = lib.displayPlan(parsed.actions, { ...parsed.connection, password: '' });
                const existing = checked.state;
                return {
                    plan: {
                        target: 'database',
                        effect: 'provision-database',
                        database: input.publicView(parsed.connection),
                        elevated: { user: parsed.elevated.user, database: parsed.elevated.database || 'postgres', persisted: false },
                        boundary: 'the selected database, the selected schema and the application role, by name; nothing else',
                        actions: shown.map(entry => ({ action: entry.action, permitted: checked.permitted[entry.action] === true, statements: entry.statements.map(statement => `[${statement.scope}] ${statement.sql}`) })),
                        blocked: checked.blocked,
                        dba: checked.dba,
                        existing: {
                            roleExists: existing.roleExists,
                            databaseExists: existing.databaseExists,
                            schemaExists: existing.schemaExists,
                            schema: existing.schemaState ? { state: existing.schemaState.state, tables: existing.schemaState.tables } : null,
                            extensions: Object.fromEntries(Object.entries(existing.extensions).map(([name, info]) => [name, { available: info.available, installed: info.installed, trusted: info.trusted }]))
                        },
                        capabilities: checked.capabilities,
                        steps: PROVISION_STEPS.map(name => ({ name }))
                    },
                    revision: null,
                    privateInput: { parsed }
                };
            },
            async validate(record, ctx) {
                const { parsed } = needInput(ctx);
                const checked = await check(parsed);
                if (checked.blocked.length > 0) {
                    throw new ManagerError(409, 'PROVISIONING_NOT_PERMITTED', 'The elevated credential does not have the privileges these actions need. Nothing was changed. Ask the database administrator to run the statements in "dba".', { blocked: checked.blocked, dba: checked.dba });
                }
            },
            steps: [
                {
                    name: 'provision',
                    async run(record, ctx) {
                        const { parsed } = needInput(ctx);
                        const out = await input.mapped(() => (deps().runProvisioning || lib.runProvisioning)({
                            application: parsed.connection, elevated: parsed.elevated, actions: parsed.actions, tlsMode: parsed.connection.tls.mode, ...(deps().provisioningDeps || {})
                        }));
                        ctx.scratch.done = out.results;
                        return { done: out.results.filter(item => item.status === 'done').length, already: out.results.filter(item => item.status === 'already').length };
                    }
                },
                {
                    name: 'verify',
                    async run(record, ctx) {
                        const { parsed } = needInput(ctx);
                        const report = await probe(parsed.connection);
                        ctx.scratch.verified = summarize(report);
                        return { reachable: report.reachable, ok: report.verdict.ok, next: report.verdict.next };
                    }
                }
            ],
            result: scratch => ({ done: scratch.done || [], verified: scratch.verified || null }),
            auditDetail: (record, scratch) => ({ actions: (scratch.done || []).map(item => `${item.action}:${item.status}`), database: record.plan.database.database, schema: record.plan.database.schema })
        };
    }

    // ============================================================ schema.apply
    function schemaKind() {
        async function inspect(parsed) {
            const report = await probe(parsed.connection);
            const found = assertUsable(report, { allow: new Set(['empty', 'goobster-older', 'goobster-current']) });
            return { report, found };
        }

        return {
            kind: 'database.schema.apply',
            public: true,
            allowed,
            async plan(raw) {
                exactKeys(raw, new Set(['connection']));
                const parsed = { connection: input.parseConnection(raw.connection) };
                const { report, found } = await inspect(parsed);
                const effect = found === 'empty' ? 'apply-schema' : (found === 'goobster-older' ? 'update-schema' : 'none');
                return {
                    plan: {
                        target: 'database',
                        effect,
                        noop: effect === 'none',
                        database: { ...input.publicView(parsed.connection), tls: { mode: report.tls.effective, ca: Boolean(parsed.connection.tls.caFile) } },
                        schema: summarize(report).schema,
                        boundary: 'creates Goobster\'s tables in the selected schema only; never on a schema that holds anything else',
                        steps: SCHEMA_STEPS.map(name => ({ name }))
                    },
                    revision: null,
                    privateInput: { parsed }
                };
            },
            async validate(record, ctx) {
                const { parsed } = needInput(ctx);
                await inspect(parsed);
            },
            steps: [
                {
                    name: 'probe',
                    async run(record, ctx) {
                        const { parsed } = needInput(ctx);
                        const { report, found } = await inspect(parsed);
                        ctx.scratch.before = found;
                        ctx.scratch.url = await urlFor(parsed.connection, report);
                        return { schema: found };
                    }
                },
                {
                    name: 'apply',
                    async run(record, ctx) {
                        if (ctx.scratch.before === 'goobster-current') return { skipped: true, code: 'ALREADY_CURRENT' };
                        const initialise = deps().initDatabase || dbInit.initDatabase;
                        const out = await initialise({ roots: { data: settings.dataDir, code: settings.root }, settings, database: { engine: 'postgres', external: true }, url: ctx.scratch.url });
                        ctx.scratch.tables = out.tables;
                        return { tables: out.tables };
                    }
                },
                {
                    name: 'verify',
                    async run(record, ctx) {
                        const { parsed } = needInput(ctx);
                        const report = await probe(parsed.connection);
                        const found = report.schema ? report.schema.state : 'missing-schema';
                        if (!report.reachable || found !== 'goobster-current') {
                            throw new ManagerError(409, 'SCHEMA_NOT_CURRENT', `The schema is ${found} after applying it; nothing else was changed.`);
                        }
                        ctx.scratch.after = summarize(report).schema;
                        return { fingerprint: found };
                    }
                }
            ],
            result: scratch => ({ before: scratch.before || null, after: scratch.after || null, tables: scratch.tables ?? null }),
            auditDetail: (record, scratch) => ({ before: scratch.before || null, tables: scratch.tables ?? null, database: record.plan.database.database, schema: record.plan.database.schema })
        };
    }

    // ================================================================= connect
    function parseConnect(raw) {
        exactKeys(raw, new Set(['connection', 'maintenance', 'expectedRevision', 'release']));
        if (raw.expectedRevision !== undefined && (!Number.isInteger(raw.expectedRevision) || raw.expectedRevision < 0)) throw new ManagerError(400, 'INVALID_INPUT', '"expectedRevision" must be a non-negative integer.');
        return {
            connection: input.parseConnection(raw.connection),
            maintenance: input.parseMaintenance(raw.maintenance),
            expectedRevision: raw.expectedRevision,
            release: parseBoolean(raw.release, 'release', false)
        };
    }

    function heldBarrier(maintenance) {
        const view = barrier().view();
        if (!view.active || view.operationId !== maintenance.operationId || view.fence !== maintenance.fence) {
            throw new ManagerError(409, 'MAINTENANCE_NOT_HELD', 'The maintenance barrier is not held with that operation id and fence; enter maintenance first.');
        }
        if (view.stale) throw new ManagerError(409, 'STALE_MAINTENANCE', 'The barrier was left by an earlier manager process and is never resumed automatically.');
        if (!(view.phase in PHASE_RANK)) throw new ManagerError(409, 'MAINTENANCE_NOT_HELD', 'The maintenance barrier is not quiesced yet.');
        const writers = Object.entries(view.writers || {});
        if (writers.length === 0 || writers.some(([, info]) => info.acked !== true)) {
            throw new ManagerError(409, 'WRITER_UNACKNOWLEDGED', 'Not every writer acknowledged the fence; the application may still be writing.');
        }
        return view;
    }

    function ensurePhase(op, target, actor) {
        const view = barrier().view();
        if (!view.active || view.operationId !== op.operationId || view.fence !== op.fence) {
            throw new ManagerError(409, 'MAINTENANCE_NOT_HELD', 'The maintenance barrier is no longer held by this operation.');
        }
        if ((PHASE_RANK[view.phase] ?? -1) >= PHASE_RANK[target]) return view.phase;
        if (!(NEXT_PHASES[view.phase] || []).includes(target)) {
            throw new ManagerError(409, 'PHASE_NOT_ALLOWED', `The barrier cannot move from ${view.phase} to ${target}.`);
        }
        barrier().advance({ operationId: op.operationId, fence: op.fence, to: target, actor });
        return target;
    }

    function restartWorkers() {
        try {
            const running = deps().supervisor || registry.get(settings.storeDir);
            if (!running || typeof running.operatorRestart !== 'function') return false;
            running.operatorRestart();
            return true;
        } catch {
            return false;
        }
    }

    /** The rules that do not need the server: what the installation is on now and what it may move to. */
    async function connectGuards(doc) {
        const effective = Boolean(settings.dbUrl);
        const store = migrationState();
        const { doc: migration, problem } = store.read();
        if (problem) throw new ManagerError(409, 'MIGRATION_STATE_UNREADABLE', 'migration.json in the manager store cannot be read; it was left as it is.', { problem });
        if (migration && (migration.status === 'running' || migration.status === 'failed')) {
            throw new ManagerError(409, 'MIGRATION_IN_PROGRESS', 'A migration to Postgres left a partial state; finish or roll it back (db.migrate.rollback) before changing the connection.');
        }
        if (migration && migration.status === 'switched' && !store.acceptedWrites(migration)) {
            throw new ManagerError(409, 'MIGRATION_ROLLBACK_PENDING', 'A migration to Postgres was switched and can still be rolled back; roll it back, or let the application write to Postgres, before changing the connection.');
        }
        if (effective) return { from: 'postgres', sqlite: null };
        const sqlite = await state.sqliteState({ settings, deps: deps() });
        if (!sqlite.readable) throw new ManagerError(409, 'SQLITE_UNREADABLE', 'The installation\'s SQLite file cannot be read, so it cannot be shown to be empty. Nothing was changed.', { code: sqlite.code || null });
        if (!sqlite.empty) {
            throw new ManagerError(409, 'MIGRATION_REQUIRED', `This installation's SQLite database holds data (${sqlite.populated.join(', ')}). Pointing it at an empty Postgres database would start it with nothing. ${MIGRATE_HINT}`, { populated: sqlite.populated, migration: 'P4.3', command: 'migrate' });
        }
        void doc;
        return { from: 'sqlite', sqlite };
    }

    function connectKind() {
        function buildPlan(raw, ctx) {
            const parsed = parseConnect(raw);
            const doc = core.ownedInstall(ctx);
            if (parsed.expectedRevision !== undefined && parsed.expectedRevision !== doc.revision) {
                throw new ManagerError(409, 'REVISION_CONFLICT', 'The installation changed since it was read; read it again.', { expected: parsed.expectedRevision, actual: doc.revision });
            }
            return { parsed, doc };
        }

        return {
            kind: 'database.connect',
            public: true,
            allowed: allowedInstalled,
            async plan(raw, ctx) {
                const { parsed, doc } = buildPlan(raw, ctx);
                const guards = await connectGuards(doc);
                const report = await probe(parsed.connection);
                const summary = summarize(report);
                const signature = core.signatureOf(['database.connect', doc.installationId, report.target.fingerprint]);
                return {
                    plan: {
                        target: 'installation',
                        effect: 'connect-database',
                        from: { engine: guards.from, ...(guards.from === 'postgres' && settings.dbUrl ? { target: state.connectionInEffect({ settings, fs }).target } : {}) },
                        to: { engine: 'postgres', ...input.publicView(parsed.connection), tls: { mode: report.tls.effective, ca: Boolean(parsed.connection.tls.caFile) } },
                        signature,
                        probe: summary,
                        leaves: guards.from === 'sqlite'
                            ? { sqliteFile: 'kept in place, not deleted', bookkeepingRows: guards.sqlite.bookkeepingRows }
                            : { previousDatabase: 'not touched' },
                        maintenance: parsed.maintenance ? { mode: 'held', operationId: parsed.maintenance.operationId, fence: parsed.maintenance.fence } : { mode: 'enter' },
                        boundary: 'cancel-safe-until-cutover',
                        release: parsed.release,
                        steps: CONNECT_STEPS.map(name => ({ name }))
                    },
                    revision: doc.revision,
                    privateInput: { parsed }
                };
            },
            async validate(record, ctx) {
                const { parsed } = needInput(ctx);
                const doc = core.ownedInstall(ctx);
                if (doc.revision !== record.revision) {
                    throw new ManagerError(409, 'REVISION_CONFLICT', 'The installation changed since this plan was made; plan again.', { expected: record.revision, actual: doc.revision });
                }
                await connectGuards(doc);
                const report = await probe(parsed.connection);
                assertUsable(report);
                assertOverlayEffective(await urlFor(parsed.connection, report));
                if (parsed.maintenance) heldBarrier(parsed.maintenance);
                else barrier().assertEnterable();
            },
            steps: connectSteps(),
            result: scratch => scratch.result || null,
            auditDetail: (record, scratch) => scratch.audit || null
        };
    }

    function connectSteps() {
        function guarded(name, body) {
            return {
                name,
                async run(record, ctx) {
                    try {
                        await deps().beforeStep?.({ step: name, operationId: record.id });
                        return await body(record, ctx, needInput(ctx).parsed);
                    } catch (error) {
                        await abandonIfCancelSafe(record, ctx, codeOf(error));
                        throw error;
                    }
                }
            };
        }

        /** A barrier this operation entered and has not mutated under is given back on failure; one that was mutated under stays up and is settled as failed. */
        async function abandonIfCancelSafe(record, ctx, code) {
            const op = ctx.scratch.maintenance;
            if (!op) return;
            try {
                const view = barrier().view();
                if (!view.active || view.operationId !== op.operationId) return;
                if (view.mutateBegun) {
                    barrier().settle({ operationId: op.operationId, fence: op.fence, outcome: 'failed', code, actor: record.actor });
                    return;
                }
                if (op.entered) await barrier().release({ operationId: op.operationId, fence: op.fence, actor: record.actor });
            } catch { }
        }

        return [
            guarded('maintenance', async (record, ctx, parsed) => {
                if (parsed.maintenance) {
                    heldBarrier(parsed.maintenance);
                    ctx.scratch.maintenance = { ...parsed.maintenance, entered: false };
                    return { mode: 'held', fence: parsed.maintenance.fence };
                }
                const b = barrier();
                const resolved = await b.preflight({ actor: record.actor, ctx });
                const { fence } = b.begin({ operationId: record.id, actor: record.actor, via: record.via, reason: 'database connection' });
                ctx.scratch.maintenance = { operationId: record.id, fence, entered: true };
                const out = await b.quiesce({ operationId: record.id, fence, resolved, timeoutSeconds: 120, actor: record.actor });
                await b.verify({ operationId: record.id, fence, resolved, writers: out.writers, sent: out.sent, actor: record.actor });
                return { mode: 'entered', fence, writers: Object.keys(out.writers) };
            }),

            guarded('probe', async (record, ctx, parsed) => {
                const doc = core.ownedInstall(ctx);
                await connectGuards(doc);
                const report = await probe(parsed.connection);
                const found = assertUsable(report);
                ctx.scratch.url = await urlFor(parsed.connection, report);
                assertOverlayEffective(ctx.scratch.url);
                ctx.scratch.schema = found;
                ctx.scratch.probe = summarize(report);
                return { schema: found, server: report.server ? report.server.text : null };
            }),

            guarded('validate', async (record, ctx) => {
                const counts = async () => (await runChild('targetCounts', {}, { url: ctx.scratch.url })).counts;
                const before = await counts();
                const out = await (deps().validate || validateOnTarget)({ settings, url: ctx.scratch.url, fs, ...(deps().validation || {}) });
                const after = await counts();
                const changed = Object.keys({ ...before, ...after }).filter(table => !table.startsWith('memory_vec_') && before[table] !== after[table]);
                if (changed.length > 0) {
                    throw new ManagerError(409, 'VALIDATION_WROTE', 'A table on the target changed while the application was started under validation; the fence did not hold. The connection was not changed.', { tables: changed.slice(0, 20) });
                }
                ctx.scratch.validated = out.workers.map(item => item.name);
                return { workers: ctx.scratch.validated, layout: out.layout, unchanged: true };
            }),

            guarded('cutover', async (record, ctx, parsed) => {
                const op = ctx.scratch.maintenance;
                ensurePhase(op, 'mutate', record.actor);
                ensurePhase(op, 'verify', record.actor);
                ensurePhase(op, 'cutover', record.actor);
                const existing = environment.read(settings.storeDir, fs).values;
                const values = { ...existing, GOOBSTER_DB_URL: ctx.scratch.url };
                environment.write(settings.storeDir, values, { fs, now });
                await deps().afterOverlayWrite?.();
                const doc = core.ownedInstall(ctx);
                ctx.store.updateInstallation(draft => ({ ...draft, database: { engine: 'postgres', external: true } }), { expectedRevision: doc.revision });
                environment.apply(settings, values);
                ctx.scratch.workersRestarted = restartWorkers();
                ctx.scratch.audit = { from: record.plan.from.engine, to: 'postgres', schema: ctx.scratch.schema, validated: ctx.scratch.validated || [], database: record.plan.to.database, tls: record.plan.to.tls.mode };
                return { engine: 'postgres', schema: ctx.scratch.schema, workersRestarted: ctx.scratch.workersRestarted };
            }),

            guarded('settle', async (record, ctx) => {
                const op = ctx.scratch.maintenance;
                barrier().settle({ operationId: op.operationId, fence: op.fence, outcome: 'ok', actor: record.actor });
                const view = barrier().view();
                ctx.scratch.result = {
                    connected: true,
                    engine: 'postgres',
                    schema: ctx.scratch.schema,
                    probe: ctx.scratch.probe,
                    maintenance: { operationId: op.operationId, fence: op.fence, phase: view.phase, enteredByOperation: op.entered },
                    instancePaused: true,
                    workersMode: settings.workersMode,
                    ...(ctx.scratch.workersRestarted === undefined ? {} : { workersRestarted: ctx.scratch.workersRestarted })
                };
                return { phase: view.phase };
            }),

            guarded('release', async (record, ctx, parsed) => {
                if (!parsed.release) return { skipped: true, code: 'NOT_REQUESTED' };
                const op = ctx.scratch.maintenance;
                const out = await barrier().release({ operationId: op.operationId, fence: op.fence, actor: record.actor });
                ctx.scratch.result.maintenance = { ...ctx.scratch.result.maintenance, released: true };
                return { outcome: out.outcome };
            })
        ];
    }

    return [provisionKind(), schemaKind(), connectKind()];
}

module.exports = { createKinds, COMPATIBLE, MIGRATE_HINT };
