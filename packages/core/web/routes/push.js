/**
 * Portal routes: Web Push subscriptions for the installed app
 * (documentation/pwa.md). Mounted by packages/core/web/appApi.js - do not
 * require this file from apps.
 *
 * The browser owns the subscription (it asks the push service, gets an
 * endpoint and keys); these routes only let the signed-in person keep,
 * drop and test their own devices. Endpoints are never listed back.
 */

function mountPush(app, ctx, h) {
    const { requireAuth, pushRoute } = h;

    app.get('/api/app/push', requireAuth, pushRoute(async (req) => {
        const described = await ctx.push.describe(req.webUser.userId);
        const endpoint = typeof req.query.endpoint === 'string' ? req.query.endpoint : null;
        return {
            ...described,
            thisDevice: endpoint && described.enabled
                ? await ctx.push.hasEndpoint({ userId: req.webUser.userId, endpoint })
                : false
        };
    }));

    app.post('/api/app/push/subscriptions', requireAuth, pushRoute(async (req) => ctx.push.subscribe({
        userId: req.webUser.userId,
        subscription: req.body?.subscription,
        userAgent: req.headers['user-agent'] || null
    })));

    app.delete('/api/app/push/subscriptions', requireAuth, pushRoute(async (req) => ctx.push.unsubscribe({
        userId: req.webUser.userId,
        endpoint: req.body?.endpoint ?? null,
        all: req.body?.all === true
    })));

    // A test notification to the person's own devices, bounded so a stuck
    // button cannot hammer the push service.
    app.post('/api/app/push/test', requireAuth, pushRoute(async (req) => {
        const { consumeWindow } = require('../../utils/slidingWindowLimit');
        if (!await consumeWindow({ scope: 'push_test', subject: req.webUser.userId, max: 5, windowMs: 60_000 })) {
            throw new ctx.push.PushError(429, 'RATE_LIMITED', 'Give it a moment before sending another test.');
        }
        return ctx.push.notify({
            userId: req.webUser.userId,
            title: 'Notifications are on',
            body: 'This is how Goobster will reach this device.',
            link: '/settings/initiative',
            tag: 'push-test',
            kind: 'test'
        });
    }));
}

module.exports = { mountPush };
