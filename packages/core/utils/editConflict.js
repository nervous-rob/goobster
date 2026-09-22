function editConflict(currentRevision) {
    const error = new Error('This item changed in another tab or by another person. Reload it and compare before saving again.');
    error.status = 409;
    error.code = 'EDIT_CONFLICT';
    error.details = { currentRevision: Number(currentRevision) };
    return error;
}

/** Call inside the write transaction. Membership removal takes this same lock. */
async function lockProjectWrite(tx, projectId, actorId) {
    const result = await tx.run('UPDATE observatory_projects SET id = id WHERE id = @id', { id: projectId });
    const row = result.changes ? await tx.get(`SELECT p.id FROM observatory_projects p WHERE p.id = @id
        AND (p.userId = @actor OR EXISTS (SELECT 1 FROM project_members m WHERE m.projectId = p.id AND m.userId = @actor))`,
    { id: projectId, actor: actorId }) : null;
    if (!row) {
        const error = new Error('No such project.');
        error.status = 404;
        error.code = 'NO_SUCH_PROJECT';
        throw error;
    }
}
module.exports = { editConflict, lockProjectWrite };
