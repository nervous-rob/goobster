/**
 * Source adapter `project_plan`: the project plan a responsibility is
 * linked to. Read only while the projects feature is on.
 */

const db = require('../../../db');

module.exports = {
    feature: 'projects',
    async read(responsibility) {
        if (!responsibility.planId || !responsibility.projectId) return [];
        const plan = await db.get(
            'SELECT id, projectId, status, planRevision FROM project_missions WHERE id = @id',
            { id: responsibility.planId }
        );
        if (!plan || Number(plan.projectId) !== Number(responsibility.projectId)) return [];
        return [{
            sourceId: String(plan.id),
            revision: `${plan.planRevision}:${plan.status}`,
            title: 'Linked project plan changed',
            reason: String(plan.status || '').toLowerCase(),
            category: 'project'
        }];
    }
};
