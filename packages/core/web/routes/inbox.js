/**
 * Portal routes: the in-app inbox and people lookup (shared-instance
 * Increment C). Mounted by packages/core/web/appApi.js - do not require
 * this file from apps.
 *
 * The inbox is where unattended work lands - reminders, task output, watch
 * reports, invitations, notices - whether or not this installation has a
 * Discord adapter. Items are the signed-in person's own; the routes never
 * cross users. Delivery itself happens in inboxService (producers call
 * `deliver`); these routes only read and update state.
 */

function mountInbox(app, ctx, h) {
    const { requireAuth, inboxRoute } = h;

    const flag = (value) => value === '1' || value === 'true';

    // The list: open items by default; ?unread=1 narrows to unread,
    // ?archived=1 switches to the archive. Always carries the unread count
    // so the sidebar badge and the pane agree.
    app.get('/api/app/inbox', requireAuth, inboxRoute(async (req) => ctx.inbox.list({
        userId: req.webUser.userId,
        unread: flag(req.query.unread),
        archived: flag(req.query.archived),
        limit: req.query.limit,
        cursor: req.query.cursor
    })));

    app.get('/api/app/inbox/unread', requireAuth, inboxRoute(async (req) => ({
        unread: await ctx.inbox.unreadCount(req.webUser.userId)
    })));

    app.post('/api/app/inbox/read-all', requireAuth, inboxRoute(async (req) =>
        ctx.inbox.markAllRead({ userId: req.webUser.userId })
    ));

    app.get('/api/app/inbox/:itemId', requireAuth, inboxRoute(async (req) =>
        ctx.inbox.get({ userId: req.webUser.userId, itemId: req.params.itemId })
    ));

    // Read state is a toggle: { read: false } puts an item back to unread.
    app.post('/api/app/inbox/:itemId/read', requireAuth, inboxRoute(async (req) =>
        ctx.inbox.markRead({
            userId: req.webUser.userId,
            itemId: req.params.itemId,
            read: req.body?.read !== false
        })
    ));

    app.post('/api/app/inbox/:itemId/archive', requireAuth, inboxRoute(async (req) =>
        ctx.inbox.archive({ userId: req.webUser.userId, itemId: req.params.itemId })
    ));

    // --- People -------------------------------------------------------------

    // Who the signed-in person can reach: synced Discord friends, members
    // of shared servers (when Discord is connected), and members of this
    // installation (always). Query-only for the member source - the roster
    // is never browsable - and every result is name + id only.
    app.get('/api/app/people', requireAuth, inboxRoute(async (req) => {
        const q = String(req.query.q || '').trim();
        const result = await ctx.friends.listInvitable({
            gateway: ctx.gateway,
            userId: req.webUser.userId,
            q: q || null,
            limit: req.query.limit
        });
        return { ...result, discord: ctx.discordConfig.enabled };
    }));
}

module.exports = { mountInbox };
