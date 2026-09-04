/**
 * Pre-index repair for the one-active-Observatory-job unique index.
 *
 * Older installs could have two RUNNING jobs on the same project. The
 * partial unique index in schema.sql fails to create until extras are
 * parked as INTERRUPTED. Newest id per project is kept.
 *
 * Both adapters call this after column migrations and before schema.sql
 * creates the index.
 */

function interruptExtrasSql() {
    return `
        UPDATE observatory_jobs
        SET status = 'INTERRUPTED',
            error = 'Superseded: only one active job per project.',
            finishedAt = datetime('now')
        WHERE status = 'RUNNING'
          AND id NOT IN (
              SELECT keepId FROM (
                  SELECT MAX(id) AS keepId
                  FROM observatory_jobs
                  WHERE status = 'RUNNING'
                  GROUP BY projectId
              ) kept
          )`;
}

function tableExistsSync(database, name) {
    return !!database.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?"
    ).get(name);
}

function repairObservatoryJobsSync(database) {
    if (!tableExistsSync(database, 'observatory_jobs')) return;
    database.exec(interruptExtrasSql());
}

async function repairObservatoryJobs(client, { tableExists, exec }) {
    if (!await tableExists(client, 'observatory_jobs')) return;
    await exec(interruptExtrasSql());
}

module.exports = {
    repairObservatoryJobs,
    repairObservatoryJobsSync,
    interruptExtrasSql
};
