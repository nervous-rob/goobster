/**
 * Portal routes: People - friends and direct messages
 * (documentation/friends_and_messages.md). Mounted by
 * packages/core/web/appApi.js - do not require this file from apps.
 *
 * Friendships are Goobster's own record (friendService): search someone
 * out by name, verified email, shared server, or id; send a request; the
 * other person answers from their Inbox (or the Discord DM echo). Friends
 * see each other's portal presence and can message each other
 * (directMessageService). Every route is scoped to the signed-in person;
 * nothing here reads Discord relationships (bots cannot).
 */

function mountPeople(app, ctx, h) {
    const { requireAuth, peopleRoute } = h;

    // --- Friends ------------------------------------------------------------

    // Everything the Friends view needs in one read: friends with
    // presence, requests waiting for me, requests I sent.
    app.get('/api/app/friends', requireAuth, peopleRoute(async (req) =>
        ctx.friends.overview({ userId: req.webUser.userId })
    ));

    // Find someone to befriend. `q` is a name prefix, an exact verified
    // email address, or a user id; results carry the caller's relationship.
    app.get('/api/app/friends/search', requireAuth, peopleRoute(async (req) =>
        ctx.friends.search({
            gateway: ctx.gateway,
            userId: req.webUser.userId,
            q: req.query.q,
            limit: req.query.limit
        })
    ));

    // Send a friend request (lands in their Inbox, echoed to Discord).
    app.post('/api/app/friends/requests', requireAuth, peopleRoute(async (req) =>
        ctx.friends.request({
            gateway: ctx.gateway,
            userId: req.webUser.userId,
            userName: req.webUser.userName || null,
            targetId: req.body?.userId
        })
    ));

    // Answer one addressed to me.
    app.post('/api/app/friends/requests/:requestId/accept', requireAuth, peopleRoute(async (req) =>
        ctx.friends.respond({
            gateway: ctx.gateway,
            userId: req.webUser.userId,
            userName: req.webUser.userName || null,
            requestId: req.params.requestId,
            accept: true
        })
    ));

    app.post('/api/app/friends/requests/:requestId/decline', requireAuth, peopleRoute(async (req) =>
        ctx.friends.respond({
            gateway: ctx.gateway,
            userId: req.webUser.userId,
            userName: req.webUser.userName || null,
            requestId: req.params.requestId,
            accept: false
        })
    ));

    // Withdraw one I sent.
    app.delete('/api/app/friends/requests/:requestId', requireAuth, peopleRoute(async (req) =>
        ctx.friends.cancel({ userId: req.webUser.userId, requestId: req.params.requestId })
    ));

    // End a friendship (quiet: the other person is not told).
    app.delete('/api/app/friends/:friendId', requireAuth, peopleRoute(async (req) =>
        ctx.friends.remove({ userId: req.webUser.userId, friendId: req.params.friendId })
    ));

    // --- Direct messages ----------------------------------------------------

    app.get('/api/app/dm/threads', requireAuth, peopleRoute(async (req) => ({
        threads: await ctx.dm.listThreads({ userId: req.webUser.userId }),
        unread: await ctx.dm.unreadCount(req.webUser.userId)
    })));

    // Open (or find) the thread with one friend.
    app.post('/api/app/dm/threads', requireAuth, peopleRoute(async (req) =>
        ctx.dm.openWith({ userId: req.webUser.userId, friendId: req.body?.userId })
    ));

    app.get('/api/app/dm/threads/:threadId', requireAuth, peopleRoute(async (req) => ({
        thread: await ctx.dm.getThread({ userId: req.webUser.userId, threadId: req.params.threadId }),
        ...await ctx.dm.getMessages({
            userId: req.webUser.userId,
            threadId: req.params.threadId,
            limit: req.query.limit,
            beforeId: req.query.beforeId
        })
    })));

    app.post('/api/app/dm/threads/:threadId/messages', requireAuth, peopleRoute(async (req) => ({
        message: await ctx.dm.send({
            userId: req.webUser.userId,
            threadId: req.params.threadId,
            content: req.body?.content
        })
    })));

    app.post('/api/app/dm/threads/:threadId/read', requireAuth, peopleRoute(async (req) =>
        ctx.dm.markRead({ userId: req.webUser.userId, threadId: req.params.threadId, upToId: req.body?.upToId })
    ));
}

module.exports = { mountPeople };
