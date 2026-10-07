/**
 * Attachment references: every column that names a file on disk must still
 * resolve to a file under the data roots on the target, exactly as it did
 * on the source. Relocating files is not part of a migration - the data
 * root does not move - so this proves the rows and the files still agree.
 *
 * The columns are the ones that carry a path today (see ATTACHMENT_COLUMNS);
 * the roots come from the same list the backup uses (backupService
 * FILE_SETS, resolved against the data directory), so a root added there is
 * a root here. Counts only - a path can carry a person's file name, so no
 * path is ever returned.
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * `kind`:
 *   root-relative  `column` is relative to the file set `set`
 *   absolute       `column` is an absolute path that must sit under a file set
 *   project        `column` is relative to <projects root>/<userId>/<slug>
 */
const ATTACHMENT_COLUMNS = Object.freeze([
    { id: 'kg_artifacts.relativePath', kind: 'root-relative', set: 'artifacts', sql: 'SELECT relativePath AS ref FROM kg_artifacts WHERE relativePath IS NOT NULL' },
    { id: 'web_generated_files.path', kind: 'absolute', sql: 'SELECT path AS ref FROM web_generated_files WHERE path IS NOT NULL' },
    {
        id: 'observatory_jobs.renderPath',
        kind: 'project',
        sql: `SELECT j.renderPath AS ref, p.userId AS userId, p.slug AS slug
              FROM observatory_jobs j JOIN observatory_projects p ON p.id = j.projectId
              WHERE j.renderPath IS NOT NULL`
    }
]);

function rootsFor(dataDir) {
    const { FILE_SETS } = require('../../services/backupService');
    const roots = {};
    for (const set of FILE_SETS) roots[set.id] = path.resolve(set.resolve(dataDir));
    return roots;
}

function within(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveRef(column, row, roots) {
    const ref = String(row.ref);
    if (ref.includes('\0')) return { resolved: null };
    if (column.kind === 'root-relative') return { resolved: path.resolve(roots[column.set], ref), allowed: [roots[column.set]] };
    if (column.kind === 'project') {
        const base = path.join(roots.projects, String(row.userId), String(row.slug));
        return { resolved: path.resolve(base, ref), allowed: [base] };
    }
    return { resolved: path.resolve(ref), allowed: Object.values(roots) };
}

/**
 * @param {{ all: (sql: string) => Promise<Object[]> }} side
 * @param {string} dataDir
 */
async function collect(side, dataDir) {
    const roots = rootsFor(dataDir);
    const out = { total: 0, resolved: 0, outside: 0, columns: {} };
    for (const column of ATTACHMENT_COLUMNS) {
        const tally = { total: 0, resolved: 0, outside: 0 };
        const rows = await side.all(column.sql).catch(() => []);
        for (const row of rows) {
            tally.total++;
            const found = resolveRef(column, row, roots);
            if (!found.resolved || !found.allowed.some(root => within(root, found.resolved))) {
                tally.outside++;
                continue;
            }
            if (fs.existsSync(found.resolved)) tally.resolved++;
        }
        out.columns[column.id] = tally;
        out.total += tally.total;
        out.resolved += tally.resolved;
        out.outside += tally.outside;
    }
    return out;
}

/**
 * Compare the references on both sides. `dangling` are references that did
 * not resolve on the source either (reported, not a failure).
 */
async function checkAttachments({ source, target, dataDir }) {
    const before = await collect(source, dataDir);
    const after = await collect(target, dataDir);
    const same = before.total === after.total && before.resolved === after.resolved && before.outside === after.outside;
    return {
        ok: same && after.outside <= before.outside,
        checked: after.total,
        resolved: after.resolved,
        danglingBeforeMigration: before.total - before.resolved - before.outside,
        outsideRoots: after.outside,
        columns: after.columns
    };
}

module.exports = { checkAttachments, collect, rootsFor, ATTACHMENT_COLUMNS };
