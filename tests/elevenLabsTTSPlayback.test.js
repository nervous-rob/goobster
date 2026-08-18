/**
 * ElevenLabs HTTP TTS playback (services/voice/elevenLabsTTSService.js):
 * speech borrows the shared guild voice connection and must hand it back
 * to whatever player it displaced - the /play music regression where TTS
 * (via /speak or a /voicechat reply) permanently evicted the music player.
 *
 * The FFmpeg transcoder is mocked to a PassThrough (no decoding needed)
 * and the audio player is a stub so the test drives state transitions.
 */
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');

jest.mock('prism-media', () => {
    const actual = jest.requireActual('prism-media');
    const { PassThrough } = require('node:stream');
    // Only FFmpeg is faked; @discordjs/voice still needs the real
    // VolumeTransformer et al. for createAudioResource.
    return { ...actual, FFmpeg: class FakeFFmpeg extends PassThrough {} };
});

const ElevenLabsTTSService = require('@goobster/core/services/voice/elevenLabsTTSService');

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

/** AudioPlayer stand-in: EventEmitter carries the stateChange handshake. */
function fakePlayer() {
    const player = new EventEmitter();
    player.play = jest.fn();
    player.stop = jest.fn();
    return player;
}

const waitFor = (fn, ms = 1500) => new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = () => {
        if (fn()) return resolve();
        if (Date.now() - start > ms) return reject(new Error('waitFor timed out'));
        setTimeout(poll, 10);
    };
    poll();
});

function makeService() {
    const service = new ElevenLabsTTSService({ elevenlabs: { apiKey: 'test-key' } });
    service.player = fakePlayer();
    service.fetchStream = jest.fn(async () => ({
        body: Readable.from([Buffer.from('fake-mp3-bytes')])
    }));
    return service;
}

describe('ElevenLabsTTSService playback hand-back', () => {
    test('restores the displaced music player once speech finishes', async () => {
        const musicPlayer = { id: 'music' };
        const service = makeService();
        const connection = fakeConnection(musicPlayer);

        const speech = service.textToSpeech('Hello everyone!', {}, connection);
        await waitFor(() => service.player.play.mock.calls.length > 0);

        // Speech borrowed the connection from the music player
        expect(connection.state.subscription.player).toBe(service.player);

        service.player.emit('stateChange', { status: 'playing' }, { status: 'idle' });
        await speech;

        expect(connection.state.subscription.player).toBe(musicPlayer);
    });

    test('leaves its own subscription in place when nothing was displaced', async () => {
        const service = makeService();
        const connection = fakeConnection();

        const speech = service.textToSpeech('Nobody was playing.', {}, connection);
        await waitFor(() => service.player.play.mock.calls.length > 0);
        service.player.emit('stateChange', { status: 'playing' }, { status: 'idle' });
        await speech;

        expect(connection.state.subscription.player).toBe(service.player);
    });

    test('yields to a player that claimed the connection mid-speech', async () => {
        const musicPlayer = { id: 'music' };
        const otherPlayer = { id: 'other' };
        const service = makeService();
        const connection = fakeConnection(musicPlayer);

        const speech = service.textToSpeech('Interrupted speech.', {}, connection);
        await waitFor(() => service.player.play.mock.calls.length > 0);

        connection.subscribe(otherPlayer); // someone else takes over mid-speech
        service.player.emit('stateChange', { status: 'playing' }, { status: 'idle' });
        await speech;

        expect(connection.state.subscription.player).toBe(otherPlayer);
    });

    test('a failed synthesis never disturbs the music subscription', async () => {
        const musicPlayer = { id: 'music' };
        const service = makeService();
        service.fetchStream = jest.fn(async () => { throw new Error('API down'); });
        const connection = fakeConnection(musicPlayer);

        await expect(service.textToSpeech('Will fail.', {}, connection)).rejects.toThrow('API down');
        expect(connection.subscribe).not.toHaveBeenCalled();
        expect(connection.state.subscription.player).toBe(musicPlayer);
    });
});
