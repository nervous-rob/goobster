/**
 * Portal routes: guided tutorials (Increment F1).
 * Mounted by packages/core/web/appApi.js — do not require this file from apps.
 *
 * Account is always taken from the session. Clients cannot invent tutorial
 * or step ids; the service allow-lists against packages/core/config/tutorialCatalog.js.
 */

const tutorialService = require('../../services/tutorialService');
const { TutorialError } = tutorialService;

function capsFromReq(req, ctx) {
    return {
        isOperator: req.actor?.account?.role === 'operator',
        discordEnabled: ctx.discordConfig?.enabled === true,
        features: {
            projects: ctx.observatory?.organizationEnabled !== false,
            observatory: (ctx.observatory?.executionEnabled ?? ctx.observatory?.enabled) === true,
            spitball: ctx.spitball?.enabled === true
        }
    };
}

function mountTutorials(app, ctx, h) {
    const { requireAuth, chatRoute } = h;

    app.get('/api/app/tutorials', requireAuth, chatRoute(async (req) =>
        tutorialService.listForAccount({
            accountId: req.webUser.userId,
            caps: capsFromReq(req, ctx)
        })
    ));

    app.post('/api/app/tutorials/reset', requireAuth, chatRoute(async (req) =>
        tutorialService.resetAll({
            accountId: req.webUser.userId,
            caps: capsFromReq(req, ctx)
        })
    ));

    app.post('/api/app/tutorials/:id/events', requireAuth, chatRoute(async (req) => {
        const body = req.body || {};
        return tutorialService.applyEvent({
            accountId: req.webUser.userId,
            tutorialId: req.params.id,
            eventId: body.eventId,
            generation: body.generation,
            expectedRevision: body.expectedRevision,
            stepId: body.stepId ?? null,
            action: body.action,
            caps: capsFromReq(req, ctx)
        });
    }));

    app.post('/api/app/tutorials/:id/reset', requireAuth, chatRoute(async (req) =>
        tutorialService.resetOne({
            accountId: req.webUser.userId,
            tutorialId: req.params.id,
            caps: capsFromReq(req, ctx)
        })
    ));

    app.patch('/api/app/tutorial-preferences', requireAuth, chatRoute(async (req) =>
        tutorialService.patchPreferences(req.webUser.userId, {
            autoStart: req.body?.autoStart
        })
    ));

    app.post('/api/app/tutorials/orientation-offered', requireAuth, chatRoute(async (req) =>
        tutorialService.markOrientationOffered(req.webUser.userId)
    ));
}

module.exports = { mountTutorials, TutorialError };
