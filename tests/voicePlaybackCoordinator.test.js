/**
 * Borrow/restore contract for the shared guild voice connection
 * (services/voice/voicePlaybackCoordinator.js): speech playback captures
 * the player it displaces (usually music) and hands the connection back
 * afterwards - unless something newer claimed the subscription meanwhile.
 */
const {
    getSubscribedPlayer,
    captureDisplacedPlayer,
    restoreDisplacedPlayer
} = require('../services/voice/voicePlaybackCoordinator');

/** Discord voice connection stand-in with real subscription tracking. */
function fakeConnection(initialPlayer = null) {
    const connection = {
        state: {
            subscription: initialPlayer
                ? { player: initialPlayer, unsubscribe: jest.fn() }
                : undefined
        },
        subscribe: jest.fn((player) => {
            connection.state.subscription = { player, unsubscribe: jest.fn() };
            return connection.state.subscription;
        })
    };
    return connection;
}

const musicPlayer = { id: 'music' };
const ttsPlayer = { id: 'tts' };
const cuePlayer = { id: 'cue' };

describe('getSubscribedPlayer', () => {
    test('returns the subscribed player, or null for none / broken connections', () => {
        expect(getSubscribedPlayer(fakeConnection(musicPlayer))).toBe(musicPlayer);
        expect(getSubscribedPlayer(fakeConnection())).toBeNull();
        expect(getSubscribedPlayer(null)).toBeNull();
        expect(getSubscribedPlayer({})).toBeNull();
    });
});

describe('captureDisplacedPlayer', () => {
    test('captures the player about to be displaced', () => {
        expect(captureDisplacedPlayer(fakeConnection(musicPlayer), ttsPlayer)).toBe(musicPlayer);
    });

    test('returns null when nothing is subscribed', () => {
        expect(captureDisplacedPlayer(fakeConnection(), ttsPlayer)).toBeNull();
    });

    test('never captures the speech player itself (back-to-back replies)', () => {
        expect(captureDisplacedPlayer(fakeConnection(ttsPlayer), ttsPlayer)).toBeNull();
    });
});

describe('restoreDisplacedPlayer', () => {
    test('hands the connection back to the displaced player', () => {
        const connection = fakeConnection(musicPlayer);
        connection.subscribe(ttsPlayer); // speech borrows the connection
        expect(restoreDisplacedPlayer(connection, ttsPlayer, musicPlayer)).toBe(true);
        expect(getSubscribedPlayer(connection)).toBe(musicPlayer);
    });

    test('no-op when there was nothing to restore', () => {
        const connection = fakeConnection();
        connection.subscribe(ttsPlayer);
        expect(restoreDisplacedPlayer(connection, ttsPlayer, null)).toBe(false);
        expect(getSubscribedPlayer(connection)).toBe(ttsPlayer);
    });

    test('yields to whoever claimed the subscription mid-speech', () => {
        const connection = fakeConnection(musicPlayer);
        connection.subscribe(ttsPlayer);
        connection.subscribe(cuePlayer); // e.g. a notification cue took over
        expect(restoreDisplacedPlayer(connection, ttsPlayer, musicPlayer)).toBe(false);
        expect(getSubscribedPlayer(connection)).toBe(cuePlayer);
    });

    test('never throws on a torn-down connection', () => {
        const connection = {
            state: { subscription: { player: ttsPlayer } },
            subscribe: () => { throw new Error('destroyed'); }
        };
        expect(restoreDisplacedPlayer(connection, ttsPlayer, musicPlayer)).toBe(false);
    });
});
