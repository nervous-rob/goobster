/**
 * Song Studio shared songs: the server-side document store
 * (services/studioSongService.js), its REST routes (web/routes/studio.js),
 * the live collaboration room (services/studioLiveService.js behind
 * /api/app/studio/live), and the privacy erasure path. Runs against a
 * throwaway database with no Discord and no provider keys.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const WebSocket = require('ws');

const TEST_DB = path.join(os.tmpdir(), `goobster-studio-songs-${process.pid}.sqlite`);
process.env.GOOBSTER_DB_PATH = TEST_DB;

const db = require('@goobster/core/db');
const studioSongs = require('@goobster/core/services/studioSongService');
const { StudioLiveService } = require('@goobster/core/services/studioLiveService');
const privacy = require('@goobster/core/services/privacyService');
const webSessionService = require('@goobster/core/services/webSessionService');
const { createWebAppContext, createWebAppApp, attachWebAppWebSocket } = require('@goobster/core/web/appApi');

const OWNER = '810000000000000001';
const FRIEND = '810000000000000002';
const STRANGER = '810000000000000003';

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

function project(overrides = {}) {
    return {
        id: 'local-song',
        name: 'Our song',
        bpm: 100,
        swing: 0,
        keyRoot: 'C',
        rhythmId: '4-4',
        resolution: 'eighth',
        sections: [
            { id: 's1', kind: 'verse', name: 'Verse', measures: 8, chords: [{ root: 'C', quality: 'major', extension: 'none', inversion: 0, voicing: 'closed', register: 'mid' }], measuresPerChord: 1 }
        ],
        tracks: [
            { id: 't1', name: 'Kick', role: 'kick', performer: { id: 't1', role: 'kick', enabled: true, mute: false, volume: -2, drumSteps: [true, false] }, mute: false, solo: false, volume: -2 }
        ],
        clips: [{ id: 'c1', trackId: 't1', startMeasure: 0, lengthMeasures: 8 }],
        masterVolume: -2,
        reverbWet: 0.28,
        ...overrides
    };
}

let liveService;
let server;
let port;

beforeAll((done) => {
    liveService = new StudioLiveService({ logger: silentLogger });
    const ctx = createWebAppContext({
        client: null,
        config: { clientId: '123', webapp: { enabled: true, devMode: true } },
        logger: silentLogger,
        deps: { studioLive: liveService }
    });
    const app = express();
    app.use(createWebAppApp(ctx));
    server = app.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        attachWebAppWebSocket(server, ctx);
        done();
    });
});

afterAll(async () => {
    liveService.stopAll();
    await new Promise(resolve => server.close(resolve));
    await db.closeConnection();
    for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(TEST_DB + suffix); } catch { /* already gone */ }
    }
});

beforeEach(async () => {
    liveService.stopAll();
    for (const table of ['studio_song_members', 'studio_songs', 'inbox_items', 'web_sessions', 'web_rate_events']) {
        await db.run(`DELETE FROM ${table}`);
    }
});

/* ---------- service ---------- */

describe('studioSongService', () => {
    test('createSong stores the document under a server id and lists it for the owner', async () => {
        const song = await studioSongs.createSong({ ownerId: OWNER, ownerName: 'Rob', project: project() });
        expect(song.id).toMatch(/^song-/);
        expect(song.project.id).toBe(song.id);
        expect(song.name).toBe('Our song');
        expect(song.version).toBe(1);
        expect(song.role).toBe('owner');
        expect(song.members).toEqual([expect.objectContaining({ userId: OWNER, role: 'owner', userName: 'Rob' })]);

        const list = await studioSongs.listSongs(OWNER);
        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({ id: song.id, name: 'Our song', role: 'owner', memberCount: 1, version: 1 });
        expect(await studioSongs.listSongs(FRIEND)).toEqual([]);
    });

    test('rejects malformed and oversized documents', async () => {
        await expect(studioSongs.createSong({ ownerId: OWNER, project: { name: 'x', sections: [], tracks: [] } }))
            .rejects.toMatchObject({ status: 400, code: 'BAD_SONG' });
        await expect(studioSongs.createSong({ ownerId: OWNER, project: project({ clips: [{ id: 'c9', trackId: 'ghost' }] }) }))
            .rejects.toMatchObject({ status: 400, code: 'BAD_SONG' });
        const huge = project({ notes: 'x'.repeat(1024 * 1024 + 10) });
        await expect(studioSongs.createSong({ ownerId: OWNER, project: huge }))
            .rejects.toMatchObject({ status: 413, code: 'SONG_TOO_LARGE' });
    });

    test('strangers get 404, members get access, only the owner manages the roster', async () => {
        const song = await studioSongs.createSong({ ownerId: OWNER, project: project() });
        await expect(studioSongs.getSong(STRANGER, song.id)).rejects.toMatchObject({ status: 404, code: 'SONG_NOT_FOUND' });
        await expect(studioSongs.addMember({ userId: FRIEND, songId: song.id, memberId: STRANGER }))
            .rejects.toMatchObject({ status: 404 });

        const added = await studioSongs.addMember({ userId: OWNER, songId: song.id, memberId: FRIEND, memberName: 'Sam' });
        expect(added.members.map(m => m.userId)).toEqual([OWNER, FRIEND]);
        await expect(studioSongs.addMember({ userId: OWNER, songId: song.id, memberId: FRIEND }))
            .rejects.toMatchObject({ status: 409, code: 'ALREADY_MEMBER' });
        await expect(studioSongs.addMember({ userId: OWNER, songId: song.id, memberId: OWNER }))
            .rejects.toMatchObject({ status: 400, code: 'ALREADY_MEMBER' });
        await expect(studioSongs.addMember({ userId: OWNER, songId: song.id, memberId: 'not a user id!' }))
            .rejects.toMatchObject({ status: 400, code: 'BAD_USER' });

        const asFriend = await studioSongs.getSong(FRIEND, song.id);
        expect(asFriend.role).toBe('editor');
        expect((await studioSongs.listSongs(FRIEND))[0]).toMatchObject({ id: song.id, role: 'editor', memberCount: 2 });

        // The friend got an Inbox notice pointing at the song.
        const notice = await db.get('SELECT kind, title, link FROM inbox_items WHERE userId = @u', { u: FRIEND });
        expect(notice).toMatchObject({ kind: 'notice', link: `/conservatory/studio?song=${song.id}` });
        expect(notice.title).toContain('Our song');

        // A member cannot remove others or the owner, and the owner cannot leave.
        await expect(studioSongs.addMember({ userId: FRIEND, songId: song.id, memberId: STRANGER }))
            .rejects.toMatchObject({ status: 403, code: 'NOT_SONG_OWNER' });
        await expect(studioSongs.removeMember({ userId: FRIEND, songId: song.id, memberId: OWNER }))
            .rejects.toMatchObject({ status: 400, code: 'OWNER_CANNOT_LEAVE' });
        await expect(studioSongs.deleteSong({ userId: FRIEND, songId: song.id }))
            .rejects.toMatchObject({ status: 403, code: 'NOT_SONG_OWNER' });

        // A member may leave on their own.
        const left = await studioSongs.removeMember({ userId: FRIEND, songId: song.id, memberId: FRIEND });
        expect(left.members.map(m => m.userId)).toEqual([OWNER]);
        await expect(studioSongs.getSong(FRIEND, song.id)).rejects.toMatchObject({ status: 404 });

        // Owner deletes; everything is gone.
        await studioSongs.deleteSong({ userId: OWNER, songId: song.id });
        expect(await studioSongs.listSongs(OWNER)).toEqual([]);
        expect((await db.get('SELECT COUNT(*) AS c FROM studio_song_members')).c).toBe(0);
    });

    test('replaceSong is optimistic and applyPatch is last-writer-wins with a version bump', async () => {
        const song = await studioSongs.createSong({ ownerId: OWNER, project: project() });
        const replaced = await studioSongs.replaceSong({
            userId: OWNER, songId: song.id, project: { ...song.project, bpm: 120, name: 'Faster' }, expectedVersion: 1
        });
        expect(replaced.version).toBe(2);
        expect(replaced.project.bpm).toBe(120);
        expect((await studioSongs.listSongs(OWNER))[0].name).toBe('Faster');

        await expect(studioSongs.replaceSong({
            userId: OWNER, songId: song.id, project: song.project, expectedVersion: 1
        })).rejects.toMatchObject({ status: 409, code: 'SONG_VERSION_CONFLICT', details: { version: 2 } });

        const patched = await studioSongs.applyPatch({
            userId: OWNER, songId: song.id,
            patch: { settings: { name: 'Patched' }, tracks: { upsert: [{ ...song.project.tracks[0], volume: -9 }] } }
        });
        expect(patched.version).toBe(3);
        expect(patched.project.name).toBe('Patched');
        expect(patched.project.tracks[0].volume).toBe(-9);
        expect(patched.project.id).toBe(song.id);

        await expect(studioSongs.applyPatch({ userId: OWNER, songId: song.id, patch: {} }))
            .rejects.toMatchObject({ status: 400, code: 'EMPTY_PATCH' });
        await expect(studioSongs.applyPatch({ userId: STRANGER, songId: song.id, patch: { settings: { bpm: 90 } } }))
            .rejects.toMatchObject({ status: 404 });
        // A patch that breaks the shape (a clip on a missing track survives
        // pruning, but a duplicated section id does not) is refused.
        await expect(studioSongs.applyPatch({
            userId: OWNER, songId: song.id,
            patch: { sections: { upsert: Array.from({ length: 70 }, (_, i) => ({ id: `x${i}`, measures: 1 })) } }
        })).rejects.toMatchObject({ status: 400, code: 'BAD_SONG' });
        expect((await studioSongs.getSong(OWNER, song.id)).version).toBe(3);
    });

    test('forgetUser deletes owned songs (with every seat) and leaves shared ones', async () => {
        const mine = await studioSongs.createSong({ ownerId: OWNER, project: project({ name: 'Mine' }) });
        await studioSongs.addMember({ userId: OWNER, songId: mine.id, memberId: FRIEND });
        const theirs = await studioSongs.createSong({ ownerId: FRIEND, project: project({ name: 'Theirs' }) });
        await studioSongs.addMember({ userId: FRIEND, songId: theirs.id, memberId: OWNER });

        const report = await privacy.buildUserReport({ guildId: `dm:${OWNER}`, userId: OWNER });
        expect(report.studioSongs.map(s => s.name).sort()).toEqual(['Mine', 'Theirs']);
        const audit = await privacy.auditUser({ userId: OWNER });
        expect(audit.byTable.studio_songs).toBe(1);
        expect(audit.byTable.studio_song_members).toBe(2);

        const counts = await privacy.forgetUser({ userId: OWNER });
        expect(counts.studioSongs).toBe(1);
        expect(counts.studioSongMemberships).toBe(3);

        expect(await studioSongs.listSongs(OWNER)).toEqual([]);
        expect(await db.get('SELECT id FROM studio_songs WHERE id = @id', { id: mine.id })).toBeUndefined();
        const remaining = await studioSongs.getSong(FRIEND, theirs.id);
        expect(remaining.members.map(m => m.userId)).toEqual([FRIEND]);
        const after = await privacy.auditUser({ userId: OWNER });
        expect(after.byTable.studio_songs).toBe(0);
        expect(after.byTable.studio_song_members).toBe(0);
    });
});

/* ---------- REST ---------- */

function request({ method = 'GET', reqPath, headers = {}, body = null }) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const req = http.request({
            host: '127.0.0.1', port, method, path: reqPath,
            headers: {
                ...headers,
                ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {})
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(data); } catch { /* non-JSON */ }
                resolve({ status: res.statusCode, json });
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

async function cookieFor(userId, userName = 'tester') {
    const { token } = await webSessionService.create({ userId, userName });
    return `goobster_web_session=${token}`;
}

describe('REST /api/app/studio/songs', () => {
    test('requires a session', async () => {
        expect((await request({ reqPath: '/api/app/studio/songs' })).status).toBe(401);
        expect((await request({ method: 'POST', reqPath: '/api/app/studio/songs', body: { project: project() } })).status).toBe(401);
    });

    test('create, list, fetch, save, share, leave, delete', async () => {
        const owner = await cookieFor(OWNER, 'Rob');
        const friend = await cookieFor(FRIEND, 'Sam');

        const created = await request({ method: 'POST', reqPath: '/api/app/studio/songs', headers: { cookie: owner }, body: { project: project() } });
        expect(created.status).toBe(200);
        const songId = created.json.id;
        expect(created.json.members[0]).toMatchObject({ userId: OWNER, userName: 'Rob', role: 'owner' });

        const list = await request({ reqPath: '/api/app/studio/songs', headers: { cookie: owner } });
        expect(list.json.songs.map(s => s.id)).toEqual([songId]);

        expect((await request({ reqPath: `/api/app/studio/songs/${songId}`, headers: { cookie: friend } })).status).toBe(404);

        const shared = await request({
            method: 'POST', reqPath: `/api/app/studio/songs/${songId}/members`,
            headers: { cookie: owner }, body: { userId: FRIEND, userName: 'Sam' }
        });
        expect(shared.status).toBe(200);
        expect(shared.json.members.map(m => m.userId)).toEqual([OWNER, FRIEND]);

        const fetched = await request({ reqPath: `/api/app/studio/songs/${songId}`, headers: { cookie: friend } });
        expect(fetched.status).toBe(200);
        expect(fetched.json.role).toBe('editor');
        expect(fetched.json.project.tracks).toHaveLength(1);

        const saved = await request({
            method: 'PUT', reqPath: `/api/app/studio/songs/${songId}`, headers: { cookie: friend },
            body: { project: { ...fetched.json.project, bpm: 88 }, expectedVersion: fetched.json.version }
        });
        expect(saved.status).toBe(200);
        expect(saved.json.version).toBe(2);

        const stale = await request({
            method: 'PUT', reqPath: `/api/app/studio/songs/${songId}`, headers: { cookie: owner },
            body: { project: fetched.json.project, expectedVersion: 1 }
        });
        expect(stale.status).toBe(409);
        expect(stale.json.error.code).toBe('SONG_VERSION_CONFLICT');

        const bad = await request({ method: 'POST', reqPath: '/api/app/studio/songs', headers: { cookie: owner }, body: { project: { nope: true } } });
        expect(bad.status).toBe(400);
        expect(bad.json.error.code).toBe('BAD_SONG');

        const notOwner = await request({ method: 'DELETE', reqPath: `/api/app/studio/songs/${songId}`, headers: { cookie: friend } });
        expect(notOwner.status).toBe(403);

        const left = await request({ method: 'DELETE', reqPath: `/api/app/studio/songs/${songId}/members/${FRIEND}`, headers: { cookie: friend } });
        expect(left.status).toBe(200);
        expect(left.json.members.map(m => m.userId)).toEqual([OWNER]);

        const deleted = await request({ method: 'DELETE', reqPath: `/api/app/studio/songs/${songId}`, headers: { cookie: owner } });
        expect(deleted.status).toBe(200);
        expect((await request({ reqPath: `/api/app/studio/songs/${songId}`, headers: { cookie: owner } })).status).toBe(404);
    });
});

/* ---------- live room ---------- */

class LiveClient {
    constructor({ token = null, origin = null } = {}) {
        const headers = {};
        if (token) headers.cookie = `goobster_web_session=${token}`;
        if (origin) headers.origin = origin;
        this.messages = [];
        this.ws = new WebSocket(`ws://127.0.0.1:${port}/api/app/studio/live`, { headers });
        this.ws.on('message', (raw) => {
            try { this.messages.push(JSON.parse(raw.toString())); } catch { /* ignore */ }
        });
    }
    open() {
        return new Promise((resolve, reject) => {
            this.ws.on('open', resolve);
            this.ws.on('error', reject);
        });
    }
    send(payload) {
        this.ws.send(JSON.stringify(payload));
    }
    waitFor(match, timeoutMs = 4000) {
        const fn = typeof match === 'string' ? (m => m.type === match) : match;
        return new Promise((resolve, reject) => {
            const started = Date.now();
            const poll = () => {
                const found = this.messages.find(fn);
                if (found) return resolve(found);
                if (Date.now() - started > timeoutMs) {
                    return reject(new Error(`waitFor timed out; saw: ${this.messages.map(m => m.type).join(', ')}`));
                }
                setTimeout(poll, 10);
            };
            poll();
        });
    }
    ofType(type) {
        return this.messages.filter(m => m.type === type);
    }
    close() {
        try { this.ws.close(); } catch { /* already gone */ }
    }
}

async function joinLive({ userId, userName, songId }) {
    const { token } = await webSessionService.create({ userId, userName });
    const client = new LiveClient({ token });
    await client.open();
    client.send({ type: 'join', songId });
    await client.waitFor(m => m.type === 'joined' || m.type === 'error');
    return client;
}

describe('live room /api/app/studio/live', () => {
    test('rejects the upgrade without a session', async () => {
        const client = new LiveClient();
        await expect(client.open()).rejects.toBeTruthy();
    });

    test('strangers cannot join; members get the snapshot and see each other', async () => {
        const song = await studioSongs.createSong({ ownerId: OWNER, project: project() });
        await studioSongs.addMember({ userId: OWNER, songId: song.id, memberId: FRIEND });

        const stranger = await joinLive({ userId: STRANGER, userName: 'Eve', songId: song.id });
        expect(stranger.ofType('error')[0]).toMatchObject({ code: 'SONG_NOT_FOUND' });
        stranger.close();

        const owner = await joinLive({ userId: OWNER, userName: 'Rob', songId: song.id });
        const joined = owner.ofType('joined')[0];
        expect(joined).toMatchObject({ songId: song.id, version: 1, role: 'owner', peers: [] });
        expect(joined.project.tracks).toHaveLength(1);
        expect(joined.members.map(m => m.userId)).toEqual([OWNER, FRIEND]);

        const friend = await joinLive({ userId: FRIEND, userName: 'Sam', songId: song.id });
        expect(friend.ofType('joined')[0].peers).toEqual([{ peerId: joined.peerId, userId: OWNER, userName: 'Rob' }]);
        const peerJoined = await owner.waitFor('peer_joined');
        expect(peerJoined).toMatchObject({ userId: FRIEND, userName: 'Sam' });
        expect(liveService.peersIn(song.id)).toHaveLength(2);

        friend.close();
        await owner.waitFor('peer_left');
        expect(liveService.peersIn(song.id)).toHaveLength(1);
        owner.close();
    });

    test('patches land in the store, echo to the sender and relay to peers in order', async () => {
        const song = await studioSongs.createSong({ ownerId: OWNER, project: project() });
        await studioSongs.addMember({ userId: OWNER, songId: song.id, memberId: FRIEND });
        const owner = await joinLive({ userId: OWNER, userName: 'Rob', songId: song.id });
        const friend = await joinLive({ userId: FRIEND, userName: 'Sam', songId: song.id });
        const ownerPeer = owner.ofType('joined')[0].peerId;

        owner.send({ type: 'patch', opId: 'op-1', patch: { settings: { bpm: 111 } } });
        owner.send({ type: 'patch', opId: 'op-2', patch: { tracks: { upsert: [{ ...song.project.tracks[0], name: 'Boom' }] } } });
        friend.send({ type: 'patch', opId: 'op-f', patch: { settings: { name: 'Renamed live' } } });

        await friend.waitFor(m => m.type === 'patch' && m.opId === 'op-2');
        await owner.waitFor(m => m.type === 'patch' && m.opId === 'op-f');

        // The friend's patch travels on another socket, so where it lands
        // relative to op-1/op-2 is up to arrival order. What the room does
        // guarantee: one sender's patches keep their order, versions climb
        // by one per accepted patch, and every client sees the same sequence.
        const echoes = owner.ofType('patch').filter(m => m.from === ownerPeer);
        expect(echoes.map(m => m.opId)).toEqual(['op-1', 'op-2']);
        expect(echoes[1].version).toBeGreaterThan(echoes[0].version);
        const relayed = friend.ofType('patch').filter(m => m.from === ownerPeer);
        expect(relayed.map(m => m.opId)).toEqual(['op-1', 'op-2']);
        expect(relayed[0].patch).toEqual({ settings: { bpm: 111 } });
        const sequence = client => client.ofType('patch').map(m => `${m.opId}@${m.version}`);
        expect(sequence(owner)).toEqual(sequence(friend));
        expect(owner.ofType('patch').map(m => m.version)).toEqual([2, 3, 4]);

        const stored = await studioSongs.getSong(OWNER, song.id);
        expect(stored.version).toBe(4);
        expect(stored.project.bpm).toBe(111);
        expect(stored.project.tracks[0].name).toBe('Boom');
        expect(stored.name).toBe('Renamed live');

        // Bad patches are answered on the sender's socket only.
        owner.send({ type: 'patch', opId: 'op-bad', patch: {} });
        const bad = await owner.waitFor(m => m.type === 'error' && m.opId === 'op-bad');
        expect(bad.code).toBe('EMPTY_PATCH');
        expect(friend.ofType('error')).toHaveLength(0);

        // Presence relays to peers, never back to the sender.
        owner.send({ type: 'presence', trackId: 't1', sectionId: null });
        const presence = await friend.waitFor('peer_presence');
        expect(presence).toMatchObject({ userId: OWNER, trackId: 't1', sectionId: null });
        expect(owner.ofType('peer_presence')).toHaveLength(0);

        // sync answers with the current document.
        friend.send({ type: 'sync' });
        const snapshot = await friend.waitFor('snapshot');
        expect(snapshot.version).toBe(4);
        expect(snapshot.project.bpm).toBe(111);

        owner.close();
        friend.close();
    });

    test('messages before join, unknown types and bad JSON are refused', async () => {
        const { token } = await webSessionService.create({ userId: OWNER, userName: 'Rob' });
        const client = new LiveClient({ token });
        await client.open();
        client.send({ type: 'patch', patch: { settings: { bpm: 1 } } });
        expect((await client.waitFor('error')).code).toBe('NOT_JOINED');
        client.ws.send('not json');
        await client.waitFor(m => m.type === 'error' && m.code === 'BAD_JSON');
        const song = await studioSongs.createSong({ ownerId: OWNER, project: project() });
        client.send({ type: 'join', songId: song.id });
        await client.waitFor('joined');
        client.send({ type: 'nonsense' });
        await client.waitFor(m => m.type === 'error' && m.code === 'BAD_TYPE');
        client.close();
    });

    test('roster changes and deletion reach the room', async () => {
        const song = await studioSongs.createSong({ ownerId: OWNER, project: project() });
        await studioSongs.addMember({ userId: OWNER, songId: song.id, memberId: FRIEND });
        const owner = await joinLive({ userId: OWNER, userName: 'Rob', songId: song.id });
        const friend = await joinLive({ userId: FRIEND, userName: 'Sam', songId: song.id });
        const ownerCookie = await cookieFor(OWNER, 'Rob');

        const removed = await request({
            method: 'DELETE', reqPath: `/api/app/studio/songs/${song.id}/members/${FRIEND}`, headers: { cookie: ownerCookie }
        });
        expect(removed.status).toBe(200);
        await friend.waitFor('removed');
        const roster = await owner.waitFor('members');
        expect(roster.members.map(m => m.userId)).toEqual([OWNER]);
        await owner.waitFor('peer_left');
        expect(liveService.peersIn(song.id)).toHaveLength(1);

        // The removed person can no longer patch (their room membership is gone).
        friend.send({ type: 'patch', opId: 'late', patch: { settings: { bpm: 50 } } });
        expect((await friend.waitFor(m => m.type === 'error' && m.code === 'NOT_JOINED')).code).toBe('NOT_JOINED');

        const deleted = await request({ method: 'DELETE', reqPath: `/api/app/studio/songs/${song.id}`, headers: { cookie: ownerCookie } });
        expect(deleted.status).toBe(200);
        await owner.waitFor('song_deleted');
        expect(liveService.peersIn(song.id)).toEqual([]);
        owner.close();
        friend.close();
    });
});
