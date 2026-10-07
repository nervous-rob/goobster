#!/usr/bin/env node
'use strict';

/**
 * Renders the release acceptance matrix from evidence files (documentation/release_acceptance.md).
 *
 *   node scripts/acceptance/report.js <evidence dir>... [--matrix] [--format markdown|json]
 *        [--out <file>] [--strict]
 *
 * Every `evidence-*.json` under the directories is validated and scanned for anything that looks like
 * a secret, a token, user content or a home directory before it is rendered; a file that fails either
 * is listed as rejected and contributes nothing. `--matrix` adds the intended matrix of
 * scripts/acceptance/matrix.js: a hosted cell with no evidence shows as `missing`, and the cells no
 * hosted runner can give show as `deferred` with their reasons. `--strict` exits 1 when anything failed,
 * was rejected, or is missing.
 */

const fs = require('node:fs');
const path = require('node:path');

const E = require('./lib/evidence');
const matrix = require('./matrix');

const STEP_LABELS = {
    install: 'install', owner: 'owner', chat: 'chat', features: 'features', 'defaults-keys': 'keys', 'boot-recovery': 'crash',
    update: 'update', repair: 'repair', 'backup-restore': 'restore', migrate: 'migrate', reset: 'reset', 'uninstall-keep': 'keep', 'uninstall-full': 'remove'
};
const INJECTION_LABELS = {
    'stale-setup-token': 'token', 'lost-manager-store': 'store', 'port-in-use': 'port', 'storage-refusal': 'storage',
    'update-interrupted': 'update-kill', 'restore-interrupted': 'restore-kill', 'disabled-feature-route': 'gated', 'unauthenticated-manager': 'no-session', 'recovery-not-remote': 'proxy'
};
const SHOWN = { pass: 'pass', fail: 'fail', 'not-applicable': 'n/a', deferred: 'deferred', missing: 'missing' };

function walk(dir, found = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, found);
        else if (/^evidence-.*\.json$/.test(entry.name)) found.push(full);
    }
    return found;
}

/** Read, validate and leak-scan the evidence under `dirs`. */
function loadEvidence(dirs) {
    const accepted = [];
    const rejected = [];
    for (const dir of dirs) {
        if (!fs.existsSync(dir)) {
            rejected.push({ file: path.basename(dir), problems: ['no such directory'] });
            continue;
        }
        for (const file of walk(dir).sort()) {
            const name = path.basename(file);
            let doc;
            try {
                doc = JSON.parse(fs.readFileSync(file, 'utf8'));
            } catch {
                rejected.push({ file: name, problems: ['not JSON'] });
                continue;
            }
            const problems = E.validate(doc);
            const leaks = E.findLeaks(doc);
            if (leaks.length) problems.push(...leaks.map((item) => `${item.where} looks like ${item.kind}`));
            if (problems.length) rejected.push({ file: name, problems });
            else accepted.push(doc);
        }
    }
    return { accepted, rejected };
}

const key = (cell) => [cell.platform, cell.install, cell.db, cell.features].join('/');
const platformRank = (name) => { const at = matrix.TARGETS.findIndex((item) => name.startsWith(item.id)); return at < 0 ? 99 : at; };

function rowOf(doc) {
    const statuses = {};
    for (const entry of [...doc.steps, ...doc.injections]) statuses[entry.id] = entry.status;
    return {
        platform: doc.cell.platform + (doc.cell.arch && !String(doc.cell.platform).includes(doc.cell.arch) ? `-${doc.cell.arch}` : ''),
        install: doc.cell.install,
        db: doc.cell.db,
        features: doc.cell.features,
        statuses,
        doc
    };
}

/** The rows of the table: evidence, then (with `withMatrix`) hosted cells without evidence and the deferred cells. */
function buildModel(evidence, { withMatrix = false } = {}) {
    const rows = evidence.accepted.map(rowOf);
    const missing = [];
    const deferredRows = [];
    if (withMatrix) {
        const have = new Set(rows.map((row) => key(row)));
        for (const cell of matrix.hostedCells()) {
            if (have.has(key(cell))) continue;
            const statuses = {};
            for (const def of [...E.STEPS, ...E.INJECTIONS]) statuses[def.id] = 'missing';
            const row = { platform: cell.platform, install: cell.install, db: cell.db, features: cell.features, statuses, doc: null };
            rows.push(row);
            missing.push(row);
        }
        for (const cell of matrix.DEFERRED) {
            const statuses = {};
            for (const def of [...E.STEPS, ...E.INJECTIONS]) statuses[def.id] = 'deferred';
            const row = { platform: cell.platform, install: cell.install, db: cell.db, features: cell.features, statuses, doc: null, reason: cell.reason };
            rows.push(row);
            deferredRows.push(row);
        }
    }
    rows.sort((a, b) => (a.reason ? 1 : 0) - (b.reason ? 1 : 0)
        || platformRank(a.platform) - platformRank(b.platform)
        || a.platform.localeCompare(b.platform)
        || E.INSTALLS.indexOf(a.install) - E.INSTALLS.indexOf(b.install)
        || E.DATABASES.indexOf(a.db) - E.DATABASES.indexOf(b.db)
        || E.FEATURE_SETS.indexOf(a.features) - E.FEATURE_SETS.indexOf(b.features));
    const counts = { pass: 0, fail: 0, 'not-applicable': 0, deferred: 0, missing: 0 };
    for (const row of rows) for (const status of Object.values(row.statuses)) counts[status] += 1;
    return { rows, missing, deferredRows, rejected: evidence.rejected, counts };
}

function table(headers, rows) {
    const lines = [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`];
    for (const row of rows) lines.push(`| ${row.map((cell) => String(cell).replace(/\|/g, '/')).join(' | ')} |`);
    return lines.join('\n');
}

function renderMarkdown(model) {
    const out = [];
    const stepIds = E.STEPS.map((def) => def.id);
    const injectionIds = E.INJECTIONS.map((def) => def.id);
    const headers = ['platform', 'install', 'database', 'features', ...stepIds.map((id) => STEP_LABELS[id]), ...injectionIds.map((id) => INJECTION_LABELS[id])];
    out.push(table(headers, model.rows.map((row) => [row.platform, row.install, row.db, row.features, ...stepIds.map((id) => SHOWN[row.statuses[id]]), ...injectionIds.map((id) => SHOWN[row.statuses[id]])])));
    out.push('');
    out.push(`Columns: ${stepIds.map((id) => `\`${STEP_LABELS[id]}\` = ${E.STEPS.find((def) => def.id === id).title}`).join('; ')}. Injections: ${injectionIds.map((id) => `\`${INJECTION_LABELS[id]}\` = ${E.INJECTIONS.find((def) => def.id === id).title}`).join('; ')}.`);
    out.push('');
    const runs = model.rows.filter((row) => row.doc);
    if (runs.length) {
        out.push(table(['cell', 'artifact', 'commit', 'runner image', 'date', 'steps pass/fail/n.a.', 'injections pass/fail/n.a.'], runs.map((row) => {
            const doc = row.doc;
            const s = E.summarize(doc.steps);
            const i = E.summarize(doc.injections);
            return [`${row.platform}/${row.install}/${row.db}/${row.features}`, `${doc.artifact.version} (${doc.artifact.profile || 'n/a'}${doc.artifact.features && doc.artifact.features.length ? `: ${doc.artifact.features.join(', ')}` : ''})`, doc.commit.slice(0, 12), doc.cell.runnerImage || 'n/a', doc.date, `${s.pass}/${s.fail}/${s.notApplicable}`, `${i.pass}/${i.fail}/${i.notApplicable}`];
        })));
        out.push('');
    }
    if (model.deferredRows.length) {
        out.push('Deferred cells:');
        out.push('');
        for (const row of model.deferredRows) out.push(`- ${row.platform}, ${row.install}, ${row.db}, ${row.features}: ${row.reason}`);
        out.push('');
    }
    if (model.missing.length) out.push(`Hosted cells with no evidence yet: ${model.missing.length} (shown as \`missing\`).\n`);
    if (model.rejected.length) {
        out.push('Rejected evidence (not rendered):');
        out.push('');
        for (const item of model.rejected) out.push(`- ${item.file}: ${item.problems.slice(0, 3).join('; ')}`);
        out.push('');
    }
    return `${out.join('\n').trimEnd()}\n`;
}

function renderJson(model) {
    return `${JSON.stringify({
        rows: model.rows.map((row) => ({ platform: row.platform, install: row.install, database: row.db, features: row.features, statuses: row.statuses, ...(row.reason ? { reason: row.reason } : {}) })),
        counts: model.counts,
        rejected: model.rejected
    }, null, 2)}\n`;
}

function parseArgs(argv) {
    const o = { dirs: [], matrix: false, format: 'markdown', out: null, strict: false };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--matrix') o.matrix = true;
        else if (arg === '--strict') o.strict = true;
        else if (arg === '--format') { i += 1; o.format = argv[i]; }
        else if (arg === '--out') { i += 1; o.out = argv[i]; }
        else if (arg === '-h' || arg === '--help') o.help = true;
        else if (arg.startsWith('-')) throw new Error(`unknown option ${arg}`);
        else o.dirs.push(arg);
    }
    if (!['markdown', 'json'].includes(o.format)) throw new Error('--format is markdown or json');
    return o;
}

function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
    let o;
    try {
        o = parseArgs(argv);
    } catch (error) {
        stderr.write(`${error.message}\n`);
        return 2;
    }
    if (o.help || !o.dirs.length) {
        stderr.write(`${fs.readFileSync(__filename, 'utf8').match(/\/\*\*([\s\S]*?)\*\//)[1].replace(/^ ?\* ?/gm, '').trim()}\n`);
        return o.help ? 0 : 2;
    }
    const model = buildModel(loadEvidence(o.dirs), { withMatrix: o.matrix });
    const text = o.format === 'json' ? renderJson(model) : renderMarkdown(model);
    if (o.out) fs.writeFileSync(o.out, text);
    else stdout.write(text);
    if (!o.strict) return 0;
    return model.counts.fail || model.rejected.length || model.missing.length ? 1 : 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { loadEvidence, buildModel, renderMarkdown, renderJson, parseArgs, main, STEP_LABELS, INJECTION_LABELS };
