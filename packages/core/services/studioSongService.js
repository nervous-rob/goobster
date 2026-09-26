/**
 * Song Studio shared songs: SongProject documents saved on the server and
 * shared with named collaborators (documentation/music_lab.md, "Shared
 * songs"). The browser keeps local songs in localStorage; this service is
 * only for songs a person chose to save here.
 *
 * Authority model: the stored document is the truth, every accepted edit
 * bumps `version`, and edits arrive either as a whole-document replace or
 * as an id-keyed patch (utils/songPatch.js) that the live service relays to
 * every other member after it lands here.
 *
 * Authorization: the owner and every member may read and edit; only the
 * owner adds or removes people and deletes the song; a member may leave.
 * Access is checked here, never in a route.
 */

const crypto = require('node:crypto');
const db = require('../db');
const { applyPatch, isEmptyPatch, validateProjectShape } = require('../utils/songPatch');

const MAX_PROJECT_BYTES = 1024 * 1024;
const MAX_PATCH_BYTES = 256 * 1024;
const MAX_SONGS_PER_OWNER = 200;
const MAX_MEMBERS_PER_SONG = 16;
const MAX_NAME_LENGTH = 40;
const COLLECTION_LIMITS = { sections: 64, tracks: 32, clips: 2048 };

class StudioSongError extends Error {
    constructor(status, code, message, details = null) {
        super(message);
        this.name = 'StudioSongError';
        this.status = status;
        this.code = code;
        if (details) this.details = details;
    }
}

function cleanId(value) {
    const id = String(value ?? '').trim();
    return id;
}

function cleanName(value, fallback = 'Untitled song') {
    const name = typeof value === 'string' ? value.trim().slice(0, MAX_NAME_LENGTH) : '';
    return name || fallback;
}

function makeSongId() {
    return `song-${crypto.randomBytes(9).toString('base64url')}`;
}

/** Display name for a principal, from whatever table knows one. */
async function displayNameFor(userId, handle = db) {
    const principal = await handle.get(
        'SELECT displayName FROM principals WHERE id = @id', { id: String(userId) }
    ).catch(() => null);
    if (principal?.displayName) return principal.displayName;
    const user = await handle.get(
        'SELECT username FROM users WHERE discordId = @id', { id: String(userId) }
    ).catch(() => null);
    return user?.username || null;
}

function parseProjectJson(row) {
    try {
        return JSON.parse(row.projectJson);
    } catch {
        return { id: row.id, name: row.name, sections: [], tracks: [], clips: [] };
    }
}

function summaryRow(row) {
    return {
        id: row.id,
        name: row.name,
        ownerId: row.ownerId,
        role: row.role,
        version: Number(row.version),
        memberCount: Number(row.memberCount || 0),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt
    };
}

class StudioSongService {
    constructor() {
        this.StudioSongError = StudioSongError;
        this.MAX_MEMBERS_PER_SONG = MAX_MEMBERS_PER_SONG;
    }

    /**
     * Ensure `project` is a document the server will store: right shape,
     * within the size and count limits, and named. Returns the normalised
     * project (id and name pinned to the song row).
     */
    _acceptProject(project, { id, name }) {
        const shapeError = validateProjectShape(project, COLLECTION_LIMITS);
        if (shapeError) throw new StudioSongError(400, 'BAD_SONG', shapeError);
        const accepted = { ...project, id, name };
        const size = Buffer.byteLength(JSON.stringify(accepted), 'utf8');
        if (size > MAX_PROJECT_BYTES) {
            throw new StudioSongError(413, 'SONG_TOO_LARGE', 'That song is too large to save on the server.');
        }
        return accepted;
    }

    /**
     * The song row with the caller's role, or a 404 (a stranger learns
     * nothing beyond "no such song").
     */
    async requireAccess(userId, songId, handle = db) {
        const id = cleanId(songId);
        const actor = cleanId(userId);
        if (!id || !actor) throw new StudioSongError(404, 'SONG_NOT_FOUND', 'No such song.');
        const row = await handle.get(
            `SELECT s.id, s.ownerId, s.name, s.projectJson, s.version, s.createdAt, s.updatedAt, m.role
             FROM studio_songs s
             JOIN studio_song_members m ON m.songId = s.id AND m.userId = @actor
             WHERE s.id = @id`,
            { id, actor }
        );
        if (!row) throw new StudioSongError(404, 'SONG_NOT_FOUND', 'No such song.');
        return row;
    }

    async _requireOwner(userId, songId, handle = db) {
        const row = await this.requireAccess(userId, songId, handle);
        if (row.role !== 'owner') {
            throw new StudioSongError(403, 'NOT_SONG_OWNER', 'Only the song owner can do that.');
        }
        return row;
    }

    async listMembers(songId, handle = db) {
        const rows = await handle.all(
            `SELECT userId, userName, role, joinedAt FROM studio_song_members
             WHERE songId = @songId ORDER BY (role = 'owner') DESC, joinedAt, userId`,
            { songId }
        );
        return rows.map(row => ({
            userId: row.userId,
            userName: row.userName || null,
            role: row.role,
            joinedAt: row.joinedAt
        }));
    }

    /** Save a browser song on the server. The server mints the id. */
    async createSong({ ownerId, ownerName = null, project }) {
        const owner = cleanId(ownerId);
        if (!owner) throw new StudioSongError(400, 'BAD_USER', 'A song needs an owner.');
        const owned = await db.get(
            'SELECT COUNT(*) AS c FROM studio_songs WHERE ownerId = @owner', { owner }
        );
        if (Number(owned?.c || 0) >= MAX_SONGS_PER_OWNER) {
            throw new StudioSongError(409, 'SONG_LIMIT', `You already have ${MAX_SONGS_PER_OWNER} songs on the server.`);
        }
        const id = makeSongId();
        const name = cleanName(project?.name);
        const accepted = this._acceptProject(project, { id, name });
        const userName = ownerName || await displayNameFor(owner);
        await db.transaction(async (tx) => {
            await tx.run(
                `INSERT INTO studio_songs (id, ownerId, name, projectJson, version)
                 VALUES (@id, @owner, @name, @projectJson, 1)`,
                { id, owner, name, projectJson: JSON.stringify(accepted) }
            );
            await tx.run(
                `INSERT INTO studio_song_members (songId, userId, userName, role, addedBy)
                 VALUES (@id, @owner, @userName, 'owner', @owner)`,
                { id, owner, userName }
            );
        });
        return this.getSong(owner, id);
    }

    /** Every song the person owns or was added to, newest edit first. */
    async listSongs(userId) {
        const actor = cleanId(userId);
        if (!actor) return [];
        const rows = await db.all(
            `SELECT s.id, s.ownerId, s.name, s.version, s.createdAt, s.updatedAt, m.role,
                    (SELECT COUNT(*) FROM studio_song_members c WHERE c.songId = s.id) AS memberCount
             FROM studio_songs s
             JOIN studio_song_members m ON m.songId = s.id AND m.userId = @actor
             ORDER BY s.updatedAt DESC, s.id`,
            { actor }
        );
        return rows.map(summaryRow);
    }

    /** The full document plus its roster. */
    async getSong(userId, songId) {
        const row = await this.requireAccess(userId, songId);
        return {
            id: row.id,
            name: row.name,
            ownerId: row.ownerId,
            role: row.role,
            version: Number(row.version),
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            project: parseProjectJson(row),
            members: await this.listMembers(row.id)
        };
    }

    /**
     * Replace the whole document (the browser's "save" fallback when the
     * live connection is down). `expectedVersion` makes it optimistic:
     * a stale save is refused with the current version so the client can
     * resync instead of silently reverting someone else's work.
     */
    async replaceSong({ userId, songId, project, expectedVersion = null }) {
        return db.transaction(async (tx) => {
            const row = await this.requireAccess(userId, songId, tx);
            if (expectedVersion != null && Number(expectedVersion) !== Number(row.version)) {
                throw new StudioSongError(409, 'SONG_VERSION_CONFLICT', 'The song changed since you loaded it.', {
                    version: Number(row.version)
                });
            }
            const name = cleanName(project?.name, row.name);
            const accepted = this._acceptProject(project, { id: row.id, name });
            const version = Number(row.version) + 1;
            await tx.run(
                `UPDATE studio_songs
                 SET projectJson = @projectJson, name = @name, version = @version, updatedAt = datetime('now')
                 WHERE id = @id`,
                { id: row.id, projectJson: JSON.stringify(accepted), name, version }
            );
            return { id: row.id, version, project: accepted };
        });
    }

    /**
     * Apply one id-keyed patch. Patches are applied in arrival order without
     * a base-version check — every entity is replaced whole, so the order
     * the server accepts them in *is* the resolution (last writer wins).
     */
    async applyPatch({ userId, songId, patch }) {
        if (isEmptyPatch(patch)) throw new StudioSongError(400, 'EMPTY_PATCH', 'Nothing to apply.');
        if (Buffer.byteLength(JSON.stringify(patch), 'utf8') > MAX_PATCH_BYTES) {
            throw new StudioSongError(413, 'PATCH_TOO_LARGE', 'That edit is too large.');
        }
        return db.transaction(async (tx) => {
            const row = await this.requireAccess(userId, songId, tx);
            const current = parseProjectJson(row);
            const patched = applyPatch(current, patch);
            const name = cleanName(patched.name, row.name);
            const accepted = this._acceptProject(patched, { id: row.id, name });
            const version = Number(row.version) + 1;
            await tx.run(
                `UPDATE studio_songs
                 SET projectJson = @projectJson, name = @name, version = @version, updatedAt = datetime('now')
                 WHERE id = @id`,
                { id: row.id, projectJson: JSON.stringify(accepted), name, version }
            );
            return { id: row.id, version, project: accepted, name };
        });
    }

    async deleteSong({ userId, songId }) {
        return db.transaction(async (tx) => {
            const row = await this._requireOwner(userId, songId, tx);
            await tx.run('DELETE FROM studio_song_members WHERE songId = @id', { id: row.id });
            await tx.run('DELETE FROM studio_songs WHERE id = @id', { id: row.id });
            return { deleted: true, id: row.id };
        });
    }

    /**
     * Owner adds a collaborator by principal id. Adding is direct (no
     * invitation round-trip): the song shows up in the person's Shared
     * list and they get an Inbox notice they can follow.
     */
    async addMember({ userId, songId, memberId, memberName = null, actorName = null }) {
        const target = cleanId(memberId);
        if (!target || !/^[A-Za-z0-9_.:-]{1,64}$/.test(target)) {
            throw new StudioSongError(400, 'BAD_USER', 'That does not look like a user id.');
        }
        const result = await db.transaction(async (tx) => {
            const row = await this._requireOwner(userId, songId, tx);
            if (target === row.ownerId) {
                throw new StudioSongError(400, 'ALREADY_MEMBER', 'You already own this song.');
            }
            const existing = await tx.get(
                'SELECT userId FROM studio_song_members WHERE songId = @id AND userId = @target',
                { id: row.id, target }
            );
            if (existing) throw new StudioSongError(409, 'ALREADY_MEMBER', 'They already have this song.');
            const count = await tx.get(
                'SELECT COUNT(*) AS c FROM studio_song_members WHERE songId = @id', { id: row.id }
            );
            if (Number(count?.c || 0) >= MAX_MEMBERS_PER_SONG) {
                throw new StudioSongError(409, 'SONG_FULL', `A song can have at most ${MAX_MEMBERS_PER_SONG} people.`);
            }
            const userName = cleanName(memberName, '') || await displayNameFor(target, tx);
            await tx.run(
                `INSERT INTO studio_song_members (songId, userId, userName, role, addedBy)
                 VALUES (@id, @target, @userName, 'editor', @actor)`,
                { id: row.id, target, userName, actor: row.ownerId }
            );
            return { songId: row.id, songName: row.name, ownerId: row.ownerId };
        });
        await this._notifyAdded({ ...result, memberId: target, actorName });
        return { members: await this.listMembers(result.songId) };
    }

    async _notifyAdded({ songId, songName, ownerId, memberId, actorName }) {
        try {
            const inbox = require('./inboxService');
            const who = actorName || await displayNameFor(ownerId) || 'Someone';
            await inbox.deliver({
                userId: memberId,
                kind: 'notice',
                title: `${who} shared the song "${songName}" with you`,
                body: 'Open Song Studio to work on it together — it is under Shared in the song list.',
                source: { type: 'studio_song', id: songId },
                link: `/conservatory/studio?song=${encodeURIComponent(songId)}`,
                dedupeKey: `studio_song:${songId}:member:${memberId}`
            });
        } catch { /* the roster change already landed; the notice is a courtesy */ }
    }

    /** Owner removes anyone but themselves; a member removes only themselves. */
    async removeMember({ userId, songId, memberId }) {
        const actor = cleanId(userId);
        const target = cleanId(memberId);
        return db.transaction(async (tx) => {
            const row = await this.requireAccess(actor, songId, tx);
            if (target === row.ownerId) {
                throw new StudioSongError(400, 'OWNER_CANNOT_LEAVE', 'The owner cannot leave — delete the song instead.');
            }
            if (row.role !== 'owner' && target !== actor) {
                throw new StudioSongError(403, 'NOT_SONG_OWNER', 'Only the song owner can remove other people.');
            }
            const removed = (await tx.run(
                'DELETE FROM studio_song_members WHERE songId = @id AND userId = @target',
                { id: row.id, target }
            )).changes;
            if (!removed) throw new StudioSongError(404, 'MEMBER_NOT_FOUND', 'They are not on this song.');
            return { songId: row.id, removedUserId: target, members: await this.listMembers(row.id, tx) };
        });
    }

    /** Erasure path (privacyService.forgetUser). */
    async forgetUser(userId, handle = db) {
        const actor = cleanId(userId);
        const owned = await handle.all('SELECT id FROM studio_songs WHERE ownerId = @actor', { actor });
        let ownedMemberships = 0;
        for (const { id } of owned) {
            ownedMemberships += (await handle.run(
                'DELETE FROM studio_song_members WHERE songId = @id', { id }
            )).changes;
        }
        const songs = (await handle.run('DELETE FROM studio_songs WHERE ownerId = @actor', { actor })).changes;
        const memberships = (await handle.run(
            'DELETE FROM studio_song_members WHERE userId = @actor', { actor }
        )).changes;
        await handle.run(
            'UPDATE studio_song_members SET addedBy = NULL WHERE addedBy = @actor', { actor }
        );
        return { songs, memberships: memberships + ownedMemberships };
    }

    async countUserData(userId, handle = db) {
        const actor = cleanId(userId);
        const songs = (await handle.get(
            'SELECT COUNT(*) AS c FROM studio_songs WHERE ownerId = @actor', { actor }
        )).c;
        const memberships = (await handle.get(
            `SELECT COUNT(*) AS c FROM studio_song_members WHERE userId = @actor AND role <> 'owner'`, { actor }
        )).c;
        return { songs: Number(songs), memberships: Number(memberships) };
    }

    /** What the person can see about their own footprint (no documents). */
    async summarizeForUser(userId) {
        const songs = await this.listSongs(userId);
        return songs.map(song => ({
            id: song.id,
            name: song.name,
            role: song.role,
            memberCount: song.memberCount,
            updatedAt: song.updatedAt
        }));
    }
}

module.exports = new StudioSongService();
module.exports.StudioSongService = StudioSongService;
module.exports.StudioSongError = StudioSongError;
module.exports.MAX_PROJECT_BYTES = MAX_PROJECT_BYTES;
module.exports.MAX_MEMBERS_PER_SONG = MAX_MEMBERS_PER_SONG;
