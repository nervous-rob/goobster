function mountFollowedSources(app, ctx, h) {
    const service = ctx.followedSources;
    const { requireAuth, chatRoute } = h;
    app.get('/api/app/followed-sources', requireAuth, chatRoute(req => service.list({ userId: req.webUser.userId, projectId: req.query.projectId, topicNodeId: req.query.topicNodeId })));
    app.post('/api/app/followed-sources', requireAuth, chatRoute(req => service.create({ userId: req.webUser.userId,
        projectId: req.body?.projectId, topicNodeId: req.body?.topicNodeId, url: req.body?.url, label: req.body?.label, kind: req.body?.kind })));
    app.post('/api/app/followed-sources/:id/enabled', requireAuth, chatRoute(req => service.setEnabled({ userId: req.webUser.userId, sourceId: req.params.id, enabled: req.body?.enabled })));
    app.post('/api/app/followed-sources/:id/entries/:entryId/research', requireAuth, chatRoute(req => service.prepareResearch({ userId: req.webUser.userId, sourceId: req.params.id, entryId: req.params.entryId })));
    app.post('/api/app/followed-sources/:id/check', requireAuth, chatRoute(req => service.check({ userId: req.webUser.userId, sourceId: req.params.id })));
    app.delete('/api/app/followed-sources/:id', requireAuth, chatRoute(req => service.remove({ userId: req.webUser.userId, sourceId: req.params.id })));
    app.post('/api/app/followed-sources/:id/entries/:entryId/keep', requireAuth, chatRoute(req => service.keep({ userId: req.webUser.userId, sourceId: req.params.id, entryId: req.params.entryId, kept: req.body?.kept })));
}
module.exports = { mountFollowedSources };
