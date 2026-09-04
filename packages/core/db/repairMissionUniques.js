/**
 * Pre-index repair for Project Mission unique constraints.
 *
 * PR #205 allowed duplicate evidence and, under concurrency, duplicate
 * decisions. The unique indexes in schema.sql will fail to create on any
 * database that already has those rows. NULL criterionId is also
 * NULL-distinct on both engines, so the comment claiming NULL-safe
 * uniqueness is only true after we store '' instead.
 *
 * Both adapters call this after column migrations and before schema.sql
 * creates the indexes.
 */

function evidenceNormalizeSql() {
    return `UPDATE project_mission_evidence SET criterionId = '' WHERE criterionId IS NULL`;
}

function evidenceDedupeSql() {
    return `
        DELETE FROM project_mission_evidence
        WHERE id NOT IN (
            SELECT keepId FROM (
                SELECT MIN(id) AS keepId FROM project_mission_evidence
                GROUP BY missionId, COALESCE(criterionId, ''), kind, refId
            ) kept
        )`;
}

function decisionDedupeSql() {
    return `
        DELETE FROM project_decisions
        WHERE missionId IS NOT NULL AND id NOT IN (
            SELECT keepId FROM (
                SELECT MIN(id) AS keepId FROM project_decisions
                WHERE missionId IS NOT NULL
                GROUP BY missionId
            ) kept
        )`;
}

function tableExistsSync(database, name) {
    return !!database.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?"
    ).get(name);
}

function repairMissionUniquesSync(database) {
    if (tableExistsSync(database, 'project_mission_evidence')) {
        database.exec(evidenceNormalizeSql());
        database.exec(evidenceDedupeSql());
    }
    if (tableExistsSync(database, 'project_decisions')) {
        database.exec(decisionDedupeSql());
    }
}

async function repairMissionUniques(client, { tableExists, exec }) {
    if (await tableExists(client, 'project_mission_evidence')) {
        await exec(evidenceNormalizeSql());
        await exec(evidenceDedupeSql());
    }
    if (await tableExists(client, 'project_decisions')) {
        await exec(decisionDedupeSql());
    }
}

module.exports = {
    repairMissionUniques,
    repairMissionUniquesSync,
    evidenceNormalizeSql,
    evidenceDedupeSql,
    decisionDedupeSql
};
