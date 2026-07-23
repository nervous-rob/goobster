/**
 * Voice notification cues (services/voice/notificationSounds.js): the
 * response and tool cues are distinct synthesized PCM clips, playback is
 * best-effort (never throws on a broken/absent connection), and the
 * previously subscribed player gets the connection back afterwards.
 */
const {
    playResponseCue,
    playToolCue,
    playErrorCue,
    RESPONSE_CUE_PCM,
    TOOL_CUE_PCM,
    ERROR_CUE_PCM,
    SAMPLE_RATE,
    CHANNELS
} = require('../services/voice/notificationSounds');

describe('cue clips', () => {
    test('all cues are non-empty, frame-aligned 48kHz stereo PCM', () => {
        for (const pcm of [RESPONSE_CUE_PCM, TOOL_CUE_PCM, ERROR_CUE_PCM]) {
            expect(pcm.length).toBeGreaterThan(0);
            expect(pcm.length % (CHANNELS * 2)).toBe(0); // whole s16 stereo frames
            // Short by design: an ack, not an interruption (well under a second)
            const ms = (pcm.length / (SAMPLE_RATE * CHANNELS * 2)) * 1000;
            expect(ms).toBeLessThan(1000);
        }
    });

    test('the three cues are audibly different clips', () => {
        expect(RESPONSE_CUE_PCM.equals(TOOL_CUE_PCM)).toBe(false);
        expect(RESPONSE_CUE_PCM.equals(ERROR_CUE_PCM)).toBe(false);
        expect(TOOL_CUE_PCM.equals(ERROR_CUE_PCM)).toBe(false);
    });
});

describe('playback safety', () => {
    test('resolves false (never throws) without a usable connection', async () => {
        await expect(playResponseCue(null)).resolves.toBe(false);
        await expect(playToolCue(undefined)).resolves.toBe(false);
        await expect(playErrorCue({})).resolves.toBe(false); // no subscribe()
    });

    test('plays through a connection and hands it back to the previous player', async () => {
        const previousPlayer = { previous: true };
        const connection = {
            state: { subscription: { player: previousPlayer, unsubscribe: jest.fn() } },
            subscribe: jest.fn((player) => {
                connection.state.subscription = { player, unsubscribe: jest.fn() };
                return connection.state.subscription;
            })
        };

        const played = await playToolCue(connection);
        expect(played).toBe(true);

        // First subscribed its own cue player, then restored the previous one
        expect(connection.subscribe).toHaveBeenCalledTimes(2);
        expect(connection.subscribe.mock.calls[1][0]).toBe(previousPlayer);
    }, 15000);
});
