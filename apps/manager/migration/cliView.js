/**
 * What `goobster-manager migrate ...` prints and asks (apps/manager/cli.js
 * runs it): the preflight report, the migration and rollback plans, the
 * status view and the interactive questions. Pure text and data, no
 * database and no secret: every value shown is a name, a count, a boolean or
 * the non-secret part of the target (host, port, database, schema).
 */

const { lazy } = require('../lazy');

const limitLib = lazy('@goobster/core/db/migration/rollbackLimit');

const MIGRATE_DEFINITIONS = Object.freeze({ preflight: 'migrate-preflight', run: 'migrate', rollback: 'migrate-rollback' });
const SUBCOMMANDS = Object.freeze(['preflight', 'run', 'rollback', 'status']);

/** Every string of a migrate input whose verbatim appearance in output must be masked. */
function secretsOfMigrate(input, overlayValues = []) {
    const out = [];
    const add = (value) => { if (typeof value === 'string' && value.length >= 4) out.push(value); };
    const url = input && input.target && input.target.url;
    if (typeof url === 'string') {
        add(url);
        try {
            const parsed = new URL(url);
            add(decodeURIComponent(parsed.password || ''));
            add(parsed.password);
            if (parsed.username && parsed.password) add(`${parsed.username}:${parsed.password}`);
        } catch { }
    }
    if (input && input.backup) add(input.backup.passphrase);
    for (const value of overlayValues) {
        add(value);
        try {
            const parsed = new URL(value);
            add(decodeURIComponent(parsed.password || ''));
            add(parsed.password);
        } catch { }
    }
    return out;
}

const place = (target) => (target ? `${target.host}:${target.port}/${target.database}${target.schema ? ` schema ${target.schema}` : ''}` : 'unknown');
const mb = (bytes) => (typeof bytes === 'number' ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : 'unknown');
const finding = (detail) => (detail && typeof detail === 'object' ? Object.entries(detail).map(([key, value]) => `${key} ${Array.isArray(value) ? value.join(', ') : value}`).join('; ') : (detail ?? ''));

function describePreflight(result) {
    const lines = ['db.migrate.preflight (read only: nothing was written to the source or the target)'];
    const source = result.source || {};
    lines.push(`  source      ${source.present === false ? 'missing' : `${source.tableCount ?? '?'} tables, ${source.rows ?? '?'} rows, ${mb(source.sizeBytes)}${source.walPresent ? ', WAL in use' : ''}`}${source.integrity ? `, ${source.integrity.mode} ${source.integrity.ok ? 'ok' : 'FAILED'}` : ''}`);
    if (result.target) {
        const target = result.target;
        lines.push(`  target      ${place(target)}${target.local ? ' (this host)' : ''}`);
        lines.push(`              server ${target.serverVersion ?? 'unknown'}, schema ${target.schemaExists === false ? 'missing' : `${target.relationCount ?? '?'} relations`}, free ${mb(target.freeBytes)}`);
        const ext = Object.entries(target.extensions || {}).map(([name, info]) => `${name}: ${info.installed ? 'installed' : (info.available ? 'available, not installed' : 'unavailable')}`);
        if (ext.length) lines.push(`              extensions ${ext.join('; ')}`);
    }
    if (result.estimate) lines.push(`  estimate    ${result.estimate.tables ?? '?'} tables to copy, ${result.estimate.rows ?? '?'} rows`);
    lines.push(`  result      ${result.ready ? 'READY' : `BLOCKED (${result.blocks.length})`}`);
    for (const item of result.blocks || []) lines.push(`    block ${item.code}: ${finding(item.detail)}`);
    for (const item of result.provisioning || []) lines.push(`    needs ${item.code}${item.extension ? ` (${item.extension})` : ''}: ${item.action || item.detail || ''}`.trimEnd());
    for (const item of result.warnings || []) lines.push(`    warn  ${item.code}: ${finding(item.detail)}`);
    lines.push('');
    lines.push(`  ${result.rollbackLimit || limitLib.ROLLBACK_LIMIT}`);
    return lines;
}

function describeMigratePlan(plan) {
    const lines = ['db.migrate'];
    lines.push(`  from        sqlite (the source file is only read after the backup; it is never changed or deleted)`);
    lines.push(`  to          postgres, target fingerprint ${plan.database && plan.database.fingerprint}`);
    lines.push(`  maintenance ${plan.maintenance && plan.maintenance.mode === 'held' ? 'a barrier you hold' : 'enters the maintenance barrier itself and holds it'}`);
    lines.push(`  backup      verified before anything is written; config.json ${plan.backup && plan.backup.configIncluded ? 'included, encrypted' : 'excluded'}`);
    lines.push(`  provision   ${plan.provision && plan.provision.extensions ? 'creates missing extensions' : 'does not create extensions'}`);
    if (plan.resumeOf) lines.push(`  resumes     ${plan.resumeOf.status} migration ${plan.resumeOf.migrationId}; finished steps: ${plan.resumeOf.completed.length ? plan.resumeOf.completed.join(', ') : 'none'}`);
    if (plan.steps) lines.push(`  steps       ${plan.steps.map(step => step.name).join(' > ')}`);
    lines.push(`  release     ${plan.release ? 'releases the barrier when done' : 'leaves the barrier held after the cutover (--release to release it)'}`);
    if (plan.confirmation) lines.push(`  confirm     ${plan.confirmation.satisfied ? 'given' : 'required: --confirm <installationId>'}`);
    lines.push('');
    lines.push(`  ${plan.rollbackLimit || limitLib.ROLLBACK_LIMIT}`);
    return lines;
}

function describeRollbackPlan(plan) {
    const lines = ['db.migrate.rollback'];
    lines.push(`  migration   ${plan.migrationId}${plan.wasSwitched ? ' (switched: the connection is put back to SQLite)' : ' (not switched yet)'}`);
    lines.push(`  drops       ${plan.drops ? `${plan.drops.tables} tables${plan.drops.extensions.length ? `, extensions ${plan.drops.extensions.join(', ')}` : ''}` : 'nothing'} that the migration created on the target`);
    if (plan.drops && plan.drops.emptied) lines.push(`  empties     ${plan.drops.emptied} tables the target already held (the provisioned schema; kept, emptied again)`);
    lines.push(`  release     ${plan.releaseMaintenance ? 'releases the maintenance barrier' : 'leaves the maintenance barrier as it is (--release to release it)'}`);
    if (plan.confirmation) lines.push(`  confirm     ${plan.confirmation.satisfied ? 'given' : 'required: --confirm <installationId>'}`);
    lines.push('');
    lines.push(`  ${plan.rollbackLimit || limitLib.ROLLBACK_LIMIT}`);
    return lines;
}

function describeStatus(view) {
    const lines = [`migration   ${view.state}${view.id ? ` (${view.id})` : ''}`];
    if (view.target) lines.push(`target      ${place(view.target)}`);
    if (view.startedAt) lines.push(`started     ${view.startedAt}${view.updatedAt ? `, updated ${view.updatedAt}` : ''}`);
    for (const [name, step] of Object.entries(view.steps || {})) {
        const facts = ['tables', 'rows', 'vectors', 'verified'].filter(key => step[key] !== undefined).map(key => `${key} ${step[key]}`).join(', ');
        lines.push(`  ${step.done ? 'done   ' : 'started'} ${name}${facts ? ` (${facts})` : ''}`);
    }
    if (view.progress) lines.push(`copy        ${view.progress.tablesDone}/${view.progress.tablesTotal} tables, ${view.progress.rowsCopied} rows${view.progress.current ? `, now ${view.progress.current}` : ''}`);
    if (view.failure) lines.push(`failure     ${view.failure.step || '?'}: ${view.failure.code}`);
    if (view.maintenance) lines.push(`maintenance operation ${view.maintenance.operationId}, fence ${view.maintenance.fence}${view.maintenance.enteredByMigration ? ' (entered by the migration)' : ''}`);
    const rollback = view.rollback || {};
    lines.push(`rollback    ${rollback.possible ? `possible (${rollback.boundary})` : `not possible (${rollback.reason})`}`);
    lines.push('');
    lines.push(view.rollbackLimit || limitLib.ROLLBACK_LIMIT);
    return lines;
}

async function promptMigrate(prompter, sub) {
    const input = { target: { url: await prompter.ask('Postgres connection URL (hidden): ', { hidden: true }) } };
    if (sub === 'preflight') return input;
    if (sub === 'rollback') {
        if (!input.target.url) delete input.target;
        return input;
    }
    const dir = await prompter.ask('Directory to write the backup into: ');
    input.backup = { dir };
    const passphrase = await prompter.ask('Backup passphrase for config.json (hidden; blank = leave config.json out): ', { hidden: true });
    if (passphrase) input.backup.passphrase = passphrase;
    else input.backup.skipConfig = true;
    if (/^(y|yes)$/i.test(await prompter.ask('Create the pgvector/citext extensions if they are missing? [y/N]: '))) input.provision = { extensions: true };
    return input;
}

module.exports = {
    MIGRATE_DEFINITIONS, SUBCOMMANDS, secretsOfMigrate, describePreflight, describeMigratePlan, describeRollbackPlan, describeStatus, promptMigrate
};
