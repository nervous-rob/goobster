/**
 * Song Studio live collaboration: the WebSocket rooms behind
 * /api/app/studio/live (documentation/music_lab.md, "Shared songs").
 *
 * One room per shared song. A client joins with a song id (membership is
 * checked through studioSongService, so strangers get the same 404 a
 * missing song gives), receives the current document, and from then on
 * every id-keyed patch it sends is applied to the stored document *first*
 * and then relayed - to everyone in the room including the sender - in the
 * order the server accepted it. That order is the whole conflict rule:
 * last writer wins per entity, and the echo lets a sender that raced
 * another editor re-apply its own edit on top so every browser converges
 * on the stored document.
 *
 * Playback is deliberately not synchronised: each browser plays the shared
 * arrangement with its own transport and its own audio engine.
 *
 * Messages in:  join { songId } · patch { opId, patch } · presence { trackId,
 *               sectionId, clipId } · sync · leave
 * Messages out: joined · patch · snapshot · peer_joined · peer_left ·
 *               peer_presence · members · song_deleted · removed · error
 */

const studioSongService = require('./studioSongService');
const { consumeWindow } = require('../utils/slidingWindowLimit');

const JOIN_RATE_LIMIT = 60;
const JOIN_RATE_WINDOW_MS = 10 * 60 * 1000;
const MAX_PEERS_PER_ROOM = 32;

class StudioLiveError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = 'StudioLiveError';
        this.status = status;
        this.code = code;
    }
}

let peerCounter = 0;
function makePeerId() {
    peerCounter += 1;
    return `peer-${Date.now().toString(36)}-${peerCounter.toString(36)}`;
}

class StudioLiveService {
    constructor({ songs = studioSongService, logger = null } = {}) {
        this._songs = songs;
        this._logger = logger;
        /** @type {Map<string, { songId: string, clients: Set<object>, queue: Promise<void> }>} */
        this._rooms = new Map();
        this.StudioLiveError = StudioLiveError;
    }

    _log() {
        return this._logger || require('../utils/logger');
    }

    /** Test/inspection seam: who is in a room right now. */
    peersIn(songId) {
        const room = this._rooms.get(String(songId));
        return room ? [...room.clients].map(c => this._peerView(c)) : [];
    }

    _peerView(client) {
        return { peerId: client.peerId, userId: client.userId, userName: client.userName };
    }

    _room(songId) {
        let room = this._rooms.get(songId);
        if (!room) {
            room = { songId, clients: new Set(), queue: Promise.resolve() };
            this._rooms.set(songId, room);
        }
        return room;
    }

    _send(client, type, data = {}) {
        const socket = client.socket;
        if (socket.readyState === socket.OPEN) {
            try { socket.send(JSON.stringify({ type, ...data })); } catch { /* closing */ }
        }
    }

    _broadcast(room, type, data = {}, { except = null } = {}) {
        for (const client of room.clients) {
            if (client === except) continue;
            this._send(client, type, data);
        }
    }

    _leaveRoom(client) {
        const room = client.room;
        if (!room) return;
        room.clients.delete(client);
        client.room = null;
        // Outside a room there is no resource to re-authorise; clearing the
        // hook is also what lets a "removed" notice reach someone who just
        // lost access (the channel re-checks access before every write).
        client.socket.authorizeResource = null;
        this._broadcast(room, 'peer_left', { songId: room.songId, peerId: client.peerId, userId: client.userId });
        if (room.clients.size === 0) this._rooms.delete(room.songId);
    }

    /**
     * Roster changed through REST (owner added or removed someone). Push the
     * new roster to the room and drop any connection the removed person had.
     */
    async notifyRoster(songId, { removedUserId = null } = {}) {
        const room = this._rooms.get(String(songId));
        if (!room) return;
        if (removedUserId) {
            for (const client of [...room.clients]) {
                if (client.userId !== String(removedUserId)) continue;
                this._leaveRoom(client);
                this._send(client, 'removed', { songId: room.songId });
            }
        }
        if (!room.clients.size) return;
        let members = [];
        try { members = await this._songs.listMembers(room.songId); } catch { /* best effort */ }
        this._broadcast(room, 'members', { songId: room.songId, members });
    }

    /** The owner deleted the song: everyone in the room is told and dropped. */
    notifyDeleted(songId) {
        const room = this._rooms.get(String(songId));
        if (!room) return;
        for (const client of [...room.clients]) {
            room.clients.delete(client);
            client.room = null;
            client.socket.authorizeResource = null;
            this._send(client, 'song_deleted', { songId: room.songId });
        }
        this._rooms.delete(room.songId);
    }

    /** Drop every connection (tests, shutdown). */
    stopAll() {
        for (const room of this._rooms.values()) {
            for (const client of room.clients) {
                try { client.socket.close(); } catch { /* already gone */ }
                client.room = null;
            }
        }
        this._rooms.clear();
    }

    async _checkJoinRateLimit(userId) {
        const ok = await consumeWindow({
            scope: 'studio_live_join',
            subject: userId,
            max: JOIN_RATE_LIMIT,
            windowMs: JOIN_RATE_WINDOW_MS
        });
        if (!ok) {
            throw new StudioLiveError(429, 'RATE_LIMITED',
                'Slow down - too many song sessions opened; try again in a few minutes.');
        }
    }

    async _join(client, songId) {
        const id = String(songId ?? '').trim();
        if (!id) throw new StudioLiveError(400, 'BAD_SONG', 'join needs a songId.');
        await this._checkJoinRateLimit(client.userId);
        const song = await this._songs.getSong(client.userId, id);
        if (client.room) this._leaveRoom(client);
        const room = this._room(song.id);
        if (room.clients.size >= MAX_PEERS_PER_ROOM) {
            throw new StudioLiveError(409, 'ROOM_FULL', 'Too many people are on this song right now.');
        }
        const peers = [...room.clients].map(c => this._peerView(c));
        room.clients.add(client);
        client.room = room;
        client.socket.authorizeResource = () => this._songs.requireAccess(client.userId, song.id);
        this._send(client, 'joined', {
            songId: song.id,
            peerId: client.peerId,
            version: song.version,
            role: song.role,
            ownerId: song.ownerId,
            project: song.project,
            members: song.members,
            peers
        });
        this._broadcast(room, 'peer_joined', { songId: song.id, ...this._peerView(client) }, { except: client });
    }

    /**
     * Apply a patch in room order. The per-room promise chain is what
     * guarantees "accepted order == broadcast order" even though the
     * database write is asynchronous.
     */
    _patch(client, message) {
        const room = client.room;
        const opId = typeof message.opId === 'string' ? message.opId.slice(0, 64) : null;
        const run = async () => {
            if (client.room !== room) return; // left while queued
            let result;
            try {
                result = await this._songs.applyPatch({ userId: client.userId, songId: room.songId, patch: message.patch });
            } catch (error) {
                if (error?.status && error?.code) {
                    this._send(client, 'error', { code: error.code, message: error.message, opId });
                    if (error.status === 404) {
                        this._leaveRoom(client);
                        this._send(client, 'removed', { songId: room.songId });
                    }
                } else {
                    this._log().error?.('[StudioLive] patch failed:', error.message);
                    this._send(client, 'error', { code: 'INTERNAL', message: 'Could not apply that edit.', opId });
                }
                return;
            }
            this._broadcast(room, 'patch', {
                songId: room.songId,
                version: result.version,
                patch: message.patch,
                opId,
                from: client.peerId
            });
        };
        room.queue = room.queue.then(run, run);
        return room.queue;
    }

    async _sync(client) {
        const room = client.room;
        const song = await this._songs.getSong(client.userId, room.songId);
        this._send(client, 'snapshot', {
            songId: song.id,
            version: song.version,
            project: song.project,
            members: song.members,
            peers: [...room.clients].filter(c => c !== client).map(c => this._peerView(c))
        });
    }

    _presence(client, message) {
        const room = client.room;
        const pick = key => (typeof message[key] === 'string' ? message[key].slice(0, 64) : null);
        this._broadcast(room, 'peer_presence', {
            songId: room.songId,
            peerId: client.peerId,
            userId: client.userId,
            trackId: pick('trackId'),
            sectionId: pick('sectionId'),
            clipId: pick('clipId')
        }, { except: client });
    }

    /**
     * Drive one authenticated live WebSocket. The web layer already
     * resolved the session cookie; song membership is checked on join and
     * again by the connection's periodic re-authorisation.
     */
    handleConnection(socket, { userId, userName = null }) {
        const client = {
            socket,
            userId: String(userId),
            userName: userName || null,
            peerId: makePeerId(),
            room: null
        };
        const sendError = (code, message, opId = null) => this._send(client, 'error', { code, message, opId });

        socket.on('message', async (raw) => {
            let message;
            try {
                message = JSON.parse(raw.toString());
            } catch {
                sendError('BAD_JSON', 'Messages must be JSON.');
                return;
            }
            if (!message || typeof message !== 'object') {
                sendError('BAD_JSON', 'Messages must be JSON objects.');
                return;
            }
            try {
                if (message.type === 'join') {
                    await this._join(client, message.songId);
                } else if (!client.room) {
                    sendError('NOT_JOINED', 'Join a song first.');
                } else if (message.type === 'patch') {
                    await this._patch(client, message);
                } else if (message.type === 'presence') {
                    this._presence(client, message);
                } else if (message.type === 'sync') {
                    await this._sync(client);
                } else if (message.type === 'leave') {
                    this._leaveRoom(client);
                } else {
                    sendError('BAD_TYPE', 'Unknown message type.');
                }
            } catch (error) {
                if (error?.status && error?.code) {
                    sendError(error.code, error.message);
                } else {
                    this._log().error?.('[StudioLive] WS error:', error.message);
                    sendError('INTERNAL', 'Something went wrong.');
                }
            }
        });

        socket.on('close', () => {
            this._leaveRoom(client);
        });
    }
}

module.exports = new StudioLiveService();
module.exports.StudioLiveService = StudioLiveService;
module.exports.StudioLiveError = StudioLiveError;
