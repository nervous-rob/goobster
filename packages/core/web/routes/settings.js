/**
 * Portal routes: User Settings (spec §8).
 * Mounted by packages/core/web/appApi.js — do not require this file from apps.
 */

const userSettingsService = require('../../services/userSettingsService');

function mountSettings(app, ctx, h) {
    const { requireAuth, chatRoute } = h;

    // Read aggregated settings, section revisions, defaults/effective values, and capabilities
    app.get('/api/app/settings', requireAuth, chatRoute(async (req) =>
        userSettingsService.getSettings({
            userId: req.webUser.userId,
            gateway: ctx.gateway
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
