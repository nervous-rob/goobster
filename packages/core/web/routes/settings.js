/**
 * Portal routes: User Settings (spec §8).
 * Mounted by packages/core/web/appApi.js — do not require this file from apps.
 */

const userSettingsService = require('../../services/userSettingsService');

function mountSettings(app, ctx, h) {
    const { requireAuth, chatRoute } = h;

    app.post('/api/app/settings/legacy-lab', requireAuth, h.requireRecentAuth, chatRoute(async req => {
        if (!['migration', 'bootstrap'].includes(req.actor?.account?.entitlement)) {
            const error = new Error('Only a verified existing account can recover unowned legacy browser data.');
            error.status = 403; error.code = 'LEGACY_ACCOUNT_REQUIRED'; throw error;
        }
        return { allowed: true };
    }));

    // Read aggregated settings, section revisions, defaults/effective values, and capabilities
    app.get('/api/app/settings', requireAuth, chatRoute(async (req) =>
            userSettingsService.getSettings({
                userId: req.webUser.userId,
                voice: ctx.voice
            })
    ));

    app.get('/api/app/settings/export', requireAuth, chatRoute(async (req) =>
        userSettingsService.exportUserData({ userId: req.webUser.userId })
    ));

    app.get('/api/app/settings/account/sessions', requireAuth, chatRoute(async (req) =>
        userSettingsService.listSessions({
            userId: req.webUser.userId,
            currentToken: req.webSessionToken
        })
    ));

    app.delete('/api/app/settings/account/sessions/:id', requireAuth, chatRoute(async (req) =>
        userSettingsService.revokeSession({
            userId: req.webUser.userId,
            sessionId: req.params.id,
            currentToken: req.webSessionToken
        })
    ));

    app.post('/api/app/settings/account/sessions/revoke-others', requireAuth, chatRoute(async (req) =>
        userSettingsService.revokeOtherSessions({
            userId: req.webUser.userId,
            currentToken: req.webSessionToken
        })
    ));

    app.get('/api/app/settings/shares', requireAuth, chatRoute(async (req) =>
        userSettingsService.listOwnedShares({ userId: req.webUser.userId })
    ));

    app.delete('/api/app/settings/shares/:kind/:id', requireAuth, chatRoute(async (req) =>
        userSettingsService.revokeOwnedShare({
            userId: req.webUser.userId,
            kind: req.params.kind,
            id: req.params.id
        })
    ));

    app.get('/api/app/settings/applets', requireAuth, chatRoute(async (req) =>
        userSettingsService.listOwnedApplets({ userId: req.webUser.userId })
    ));

    app.post('/api/app/settings/applets/:id/revoke-grants', requireAuth, chatRoute(async (req) =>
        userSettingsService.revokeAppletGrants({
            userId: req.webUser.userId,
            appletId: req.params.id
        })
    ));

    // Atomically validate and save a partial section draft with optimistic concurrency
    app.patch('/api/app/settings/:section', requireAuth, chatRoute(async (req) => {
        const body = req.body || {};
        const expectedRevision = 'expectedRevision' in body ? body.expectedRevision : null;
        let changes = 'changes' in body && typeof body.changes === 'object' && body.changes !== null
            ? body.changes
            : { ...body };
        delete changes.expectedRevision;

        return userSettingsService.updateSection({
            userId: req.webUser.userId,
            section: req.params.section,
            changes,
            expectedRevision
        });
    }));

    // Destructive retention flow (spec §10): read-only impact estimate, then an
    // explicit apply that purges and reports the real count.
    app.post('/api/app/settings/memory/retention-preview', requireAuth, chatRoute(async (req) =>
        userSettingsService.retentionPreview({
            userId: req.webUser.userId,
            days: req.body?.days ?? null
        })
    ));

    app.post('/api/app/settings/memory/retention', requireAuth, chatRoute(async (req) =>
        userSettingsService.applyRetention({
            userId: req.webUser.userId,
            days: req.body?.days ?? null,
            expectedRevision: req.body?.expectedRevision ?? null
        })
    ));

    app.post('/api/app/settings/memory/chat-history-preview', requireAuth, chatRoute(async (req) =>
        userSettingsService.chatHistoryPreview({
            userId: req.webUser.userId,
            days: req.body?.days ?? null
        })
    ));

    app.post('/api/app/settings/memory/chat-history', requireAuth, chatRoute(async (req) =>
        userSettingsService.applyChatHistoryRetention({
            userId: req.webUser.userId,
            days: req.body?.days ?? null,
            expectedRevision: req.body?.expectedRevision ?? null
        })
    ));

    // Return the exact preference changes a section reset would make (preview only; no mutation)
    app.post('/api/app/settings/:section/reset-preview', requireAuth, chatRoute(async (req) =>
        userSettingsService.resetPreview({
            userId: req.webUser.userId,
            section: req.params.section
        })
    ));

    // Apply the confirmed preference reset with concurrency guard
    app.post('/api/app/settings/:section/reset', requireAuth, chatRoute(async (req) =>
        userSettingsService.resetSection({
            userId: req.webUser.userId,
            section: req.params.section,
            expectedRevision: req.body?.expectedRevision ?? null
        })
    ));
}

module.exports = { mountSettings };
