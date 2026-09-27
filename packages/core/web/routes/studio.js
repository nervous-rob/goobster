/**
 * Portal routes: Song Studio shared songs (documentation/music_lab.md).
 * Mounted by packages/core/web/appApi.js — do not require this file from apps.
 *
 * The account is always taken from the session; access to a song is
 * decided by studioSongService (owner or member), never here. Roster
 * changes are pushed to the live room after they land.
 */

function mountStudio(app, ctx, h) {
    const { requireAuth, chatRoute } = h;
    const songs = () => ctx.studioSongs;
    const live = () => ctx.studioLive;

    app.get('/api/app/studio/songs', requireAuth, chatRoute(async (req) => ({
        songs: await songs().listSongs(req.webUser.userId)
    })));

    app.post('/api/app/studio/songs', requireAuth, chatRoute(async (req) =>
        songs().createSong({
            ownerId: req.webUser.userId,
            ownerName: req.webUser.userName || null,
            project: req.body?.project
        })
    ));

    app.get('/api/app/studio/songs/:id', requireAuth, chatRoute(async (req) =>
        songs().getSong(req.webUser.userId, req.params.id)
    ));

    // Whole-document save (the fallback when the live connection is down).
    app.put('/api/app/studio/songs/:id', requireAuth, chatRoute(async (req) =>
        songs().replaceSong({
            userId: req.webUser.userId,
            songId: req.params.id,
            project: req.body?.project,
            expectedVersion: req.body?.expectedVersion ?? null
        })
    ));

    app.delete('/api/app/studio/songs/:id', requireAuth, chatRoute(async (req) => {
        const result = await songs().deleteSong({ userId: req.webUser.userId, songId: req.params.id });
        live().notifyDeleted(result.id);
        return result;
    }));

    app.post('/api/app/studio/songs/:id/members', requireAuth, chatRoute(async (req) => {
        const result = await songs().addMember({
            userId: req.webUser.userId,
            songId: req.params.id,
            memberId: req.body?.userId,
            memberName: req.body?.userName ?? null,
            actorName: req.webUser.userName || null
        });
        void live().notifyRoster(req.params.id);
        return result;
    }));

    // Owner removes someone, or a member removes themselves (leave).
    app.delete('/api/app/studio/songs/:id/members/:userId', requireAuth, chatRoute(async (req) => {
        const result = await songs().removeMember({
            userId: req.webUser.userId,
            songId: req.params.id,
            memberId: req.params.userId
        });
        void live().notifyRoster(result.songId, { removedUserId: result.removedUserId });
        return result;
    }));
}

module.exports = { mountStudio };
