/**
 * Portal routes: Parlor.
 * Mounted by packages/core/web/appApi.js — do not require this file from apps.
 */


const { streamParlorTurn } = require('../appStream');

function mountParlor(app, ctx, h) {
    const { requireAuth, parlorRoute, sendError } = h;


    // --- The Parlor (multi-persona workspace) --------------------------------
    app.get('/api/app/parlor/personas', requireAuth, parlorRoute(async (req) => ({
        personas: await ctx.parlor.listPersonas(req.webUser.userId)
    })));

    app.post('/api/app/parlor/personas', requireAuth, parlorRoute(async (req) =>
        ctx.parlor.createPersona({
            ownerId: req.webUser.userId,
            name: req.body?.name,
            emoji: req.body?.emoji,
            color: req.body?.color,
            charter: req.body?.charter
        })
    ));

    app.patch('/api/app/parlor/personas/:personaId', requireAuth, parlorRoute(async (req) =>
        ctx.parlor.updatePersona({
            ownerId: req.webUser.userId,
            personaId: req.params.personaId,
            name: req.body?.name,
            emoji: req.body?.emoji,
            color: req.body?.color,
            charter: req.body?.charter
        })
    ));

    app.delete('/api/app/parlor/personas/:personaId', requireAuth, parlorRoute(async (req) =>
        ctx.parlor.deletePersona({
            ownerId: req.webUser.userId,
            personaId: req.params.personaId
        })
    ));

    // Persona voice for Parlor Live: resolved through the ElevenLabs voice
    // library at save time, so a bad name fails here, never mid-session.
    // An empty voice clears back to the default pool.
    app.put('/api/app/parlor/personas/:personaId/voice', requireAuth, parlorRoute(async (req) =>
        ctx.parlor.setPersonaVoice({
            ownerId: req.webUser.userId,
            personaId: req.params.personaId,
            voice: req.body?.voice
        })
    ));

    // The ElevenLabs voice library (feeds the persona voice picker)
    app.get('/api/app/parlor/voices', requireAuth, parlorRoute(async () => ({
        voices: await ctx.parlorLive.listVoices()
    })));

    // Whether live voice sessions are possible (no key = button hidden)
    app.get('/api/app/parlor/live/capabilities', requireAuth, parlorRoute(async () =>
        ctx.parlorLive.capabilities()
    ));

    app.get('/api/app/parlor/personas/:personaId/notes', requireAuth, parlorRoute(async (req) => ({
        notes: await ctx.parlor.listNotes({
            ownerId: req.webUser.userId,
            personaId: req.params.personaId,
            tagId: req.query.tagId ? Number(req.query.tagId) : null,
            q: req.query.q ? String(req.query.q) : null
        })
    })));

    app.post('/api/app/parlor/personas/:personaId/notes', requireAuth, parlorRoute(async (req) =>
        ctx.parlor.createNote({
            ownerId: req.webUser.userId,
            personaId: req.params.personaId,
            title: req.body?.title,
            content: req.body?.content,
            tags: req.body?.tags
        })
    ));

    app.patch('/api/app/parlor/notes/:noteId', requireAuth, parlorRoute(async (req) =>
        ctx.parlor.updateNote({
            ownerId: req.webUser.userId,
            noteId: req.params.noteId,
            title: req.body?.title,
            content: req.body?.content,
            tags: req.body?.tags
        })
    ));

    app.delete('/api/app/parlor/notes/:noteId', requireAuth, parlorRoute(async (req) =>
        ctx.parlor.deleteNote({
            ownerId: req.webUser.userId,
            noteId: req.params.noteId
        })
    ));

    app.get('/api/app/parlor/personas/:personaId/tags', requireAuth, parlorRoute(async (req) => ({
        tags: await ctx.parlor.listTags({
            ownerId: req.webUser.userId,
            personaId: req.params.personaId
        })
    })));

    app.post('/api/app/parlor/personas/:personaId/suggest-tags', requireAuth, parlorRoute(async (req) => ({
        tags: await ctx.parlor.suggestTags({
            ownerId: req.webUser.userId,
            personaId: req.params.personaId,
            title: req.body?.title,
            content: req.body?.content
        })
    })));

    app.get('/api/app/parlor/personas/:personaId/graph', requireAuth, parlorRoute(async (req) =>
        ctx.parlor.getWorkspaceGraph({
            ownerId: req.webUser.userId,
            personaId: req.params.personaId
        })
    ));

    app.get('/api/app/parlor/personas/:personaId/search', requireAuth, parlorRoute(async (req) => ({
        results: await ctx.parlor.searchNotes({
            ownerId: req.webUser.userId,
            personaId: req.params.personaId,
            query: String(req.query.q || ''),
            limit: req.query.limit ? Number(req.query.limit) : undefined
        })
    })));

    app.get('/api/app/parlor/conversations', requireAuth, parlorRoute(async (req) => ({
        conversations: await ctx.parlor.listConversations(req.webUser.userId)
    })));

    app.post('/api/app/parlor/conversations', requireAuth, parlorRoute(async (req) =>
        ctx.parlor.createConversation({
            ownerId: req.webUser.userId,
            personaIds: req.body?.personaIds
        })
    ));

    app.patch('/api/app/parlor/conversations/:conversationId', requireAuth, parlorRoute(async (req) =>
        ctx.parlor.renameConversation({
            ownerId: req.webUser.userId,
            conversationId: req.params.conversationId,
            title: req.body?.title
        })
    ));

    app.delete('/api/app/parlor/conversations/:conversationId', requireAuth, parlorRoute(async (req) =>
        ctx.parlor.deleteConversation({
            ownerId: req.webUser.userId,
            conversationId: req.params.conversationId
        })
    ));

    app.put('/api/app/parlor/conversations/:conversationId/participants/:personaId', requireAuth,
        parlorRoute(async (req) =>
            ctx.parlor.setParticipant({
                ownerId: req.webUser.userId,
                conversationId: req.params.conversationId,
                personaId: req.params.personaId,
                present: true
            })
        ));

    app.delete('/api/app/parlor/conversations/:conversationId/participants/:personaId', requireAuth,
        parlorRoute(async (req) =>
            ctx.parlor.setParticipant({
                ownerId: req.webUser.userId,
                conversationId: req.params.conversationId,
                personaId: req.params.personaId,
                present: false
            })
        ));

    app.get('/api/app/parlor/conversations/:conversationId/messages', requireAuth, parlorRoute(async (req) => ({
        messages: await ctx.parlor.getMessages({
            userId: req.webUser.userId,
            conversationId: req.params.conversationId,
            limit: req.query.limit,
            beforeId: req.query.beforeId ? Number(req.query.beforeId) : null
        })
    })));

    // --- Shared discussions (multi-user parlors) -----------------------------

    // The user's synced Discord friends (the roster the Activity collected;
    // the web app can never read relationships itself). Read-only: the
    // Activity is the collector, this is the mirror the portal shows. Each
    // friend carries an `online` flag - whether THEY are in the portal
    // right now (presenceService; Discord friendships are mutual, so this
    // mirrors what Discord itself shows friends). Polling this route also
    // keeps the caller's own session warm (requireAuth touches lastSeenAt).
    app.get('/api/app/friends', requireAuth, parlorRoute(async (req) => {
        const friends = await ctx.friends.listFriends(req.webUser.userId);
        const online = await ctx.presence.onlineIds(friends.map(friend => friend.id));
        return {
            friends: friends.map(friend => ({ ...friend, online: online.has(friend.id) })),
            syncedAt: await ctx.friends.lastSyncedAt(req.webUser.userId)
        };
    }));

    // The human roster of one discussion (owner also sees pending invites)
    app.get('/api/app/parlor/conversations/:conversationId/members', requireAuth, parlorRoute(async (req) =>
        ctx.parlor.listMembers({
            userId: req.webUser.userId,
            conversationId: req.params.conversationId
        })
    ));

    // Who the owner could invite: their synced Discord friends first, then
    // people they share a server with (the invite picker's source)
    app.get('/api/app/parlor/conversations/:conversationId/invitable', requireAuth,
        parlorRoute(async (req) =>
            ctx.parlor.listInvitable({
                gateway: ctx.gateway,
                ownerId: req.webUser.userId,
                conversationId: req.params.conversationId,
                q: req.query.q ? String(req.query.q) : null
            })
        ));

    // Invite a Discord friend (owner only). The bot DMs them accept/decline
    // buttons; the invite also appears in their web app invitation list.
    app.post('/api/app/parlor/conversations/:conversationId/invites', requireAuth, parlorRoute(async (req) =>
        ctx.parlor.invite({
            gateway: ctx.gateway,
            ownerId: req.webUser.userId,
            ownerName: req.webUser.userName,
            conversationId: req.params.conversationId,
            inviteeId: req.body?.userId
        })
    ));

    // Withdraw a pending invitation (owner only)
    app.delete('/api/app/parlor/invites/:inviteId', requireAuth, parlorRoute(async (req) =>
        ctx.parlor.revokeInvite({
            ownerId: req.webUser.userId,
            inviteId: req.params.inviteId
        })
    ));

    // Pending invitations addressed to me
    app.get('/api/app/parlor/invites', requireAuth, parlorRoute(async (req) => ({
        invites: await ctx.parlor.listInvites(req.webUser.userId)
    })));

    // Accept or decline one of my invitations (the web path; the Discord DM
    // buttons settle invites through events/interactionCreate.js)
    app.post('/api/app/parlor/invites/:inviteId/respond', requireAuth, parlorRoute(async (req) =>
        ctx.parlor.respondInvite({
            userId: req.webUser.userId,
            userName: req.webUser.userName,
            inviteId: req.params.inviteId,
            accept: req.body?.accept === true
        })
    ));

    // Owner removes a member; a member removes themself (leave)
    app.delete('/api/app/parlor/conversations/:conversationId/members/:memberId', requireAuth,
        parlorRoute(async (req) =>
            ctx.parlor.removeMember({
                userId: req.webUser.userId,
                conversationId: req.params.conversationId,
                memberId: req.params.memberId
            })
        ));

    // One-prompt bootstrap: the concierge designs a cast of personas (with
    // seed notes) for the topic and opens a discussion with them.
    app.post('/api/app/parlor/quickstart', requireAuth, parlorRoute(async (req) =>
        ctx.parlor.quickstart({
            ownerId: req.webUser.userId,
            prompt: req.body?.prompt
        })
    ));

    app.post('/api/app/parlor/stop', requireAuth, parlorRoute(async (req) => ({
        stopped: ctx.parlor.stopTurn(req.webUser.userId)
    })));
    // One parlor turn: store the user message, then every participating
    // persona considers whether to speak and replies in seat order.
    app.post('/api/app/parlor/chat', requireAuth, async (req, res) => {
        let turn;
        try {
            turn = await ctx.parlor.startTurn({
                gateway: ctx.gateway,
                userId: req.webUser.userId,
                userName: req.webUser.userName,
                conversationId: req.body?.conversationId,
                message: req.body?.message
            });
        } catch (error) {
            const status = error.status || 500;
            sendError(res, status, error.code || 'INTERNAL',
                status === 500 ? 'Something went wrong.' : error.message);
            return;
        }
        await streamParlorTurn(res, turn, ctx);
    });

    // Manually trigger one seated persona to respond right now (no new
    // user message, no gate - the participant-chip "speak" action).
    app.post('/api/app/parlor/conversations/:conversationId/personas/:personaId/respond',
        requireAuth, async (req, res) => {
            let turn;
            try {
                turn = await ctx.parlor.startPersonaTurn({
                    userId: req.webUser.userId,
                    userName: req.webUser.userName,
                    conversationId: req.params.conversationId,
                    personaId: req.params.personaId
                });
            } catch (error) {
                const status = error.status || 500;
                sendError(res, status, error.code || 'INTERNAL',
                    status === 500 ? 'Something went wrong.' : error.message);
                return;
            }
            await streamParlorTurn(res, turn, ctx);
        });
}

module.exports = { mountParlor };
