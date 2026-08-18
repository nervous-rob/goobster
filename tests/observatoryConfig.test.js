/**
 * Observatory limit clamping (config/observatoryConfig.js).
 *
 * Same contract as the sandbox config: every numeric knob is clamped into
 * [floor, ceiling] so a config typo can never remove a guardrail, the
 * feature is off unless explicitly enabled, and the scope defaults to the
 * smallest audience (the web app).
 */

/** Load a fresh copy of the module with `observatory` supplied via config.json. */
const load = (observatory) => {
    let mod;
    jest.isolateModules(() => {
        // config.json is gitignored and usually absent, so mock it virtually.
        jest.doMock('../config.json', () => ({ observatory }), { virtual: true });
        mod = require('@goobster/core/config/observatoryConfig');
    });
    return mod;
};

/** knob -> [default, floor, ceiling] */
const LIMITS = {
    maxProjectsPerUser: [5, 1, 200],
    maxProjectMb: [1024, 1, 102_400],
    maxActiveJobsPerUser: [1, 1, 50],
    maxResumes: [12, 0, 500],
    maxWorkspaceFiles: [50, 1, 5_000],
    maxRenderFrames: [2_000, 2, 100_000],
    renderFps: [24, 1, 120]
};
const knobs = Object.entries(LIMITS);

describe('numeric knob clamping', () => {
    test.each(knobs)('%s falls back to its default when unset or unparseable', (knob, [def]) => {
        expect(load({})[knob]).toBe(def);
        expect(load({ [knob]: 'lots' })[knob]).toBe(def);
        expect(load({ [knob]: null })[knob]).toBe(def);
        expect(load({ [knob]: Infinity })[knob]).toBe(def);
    });

    test.each(knobs)('%s clamps to its ceiling instead of passing an absurd value through',
        (knob, [, , max]) => {
            expect(load({ [knob]: max * 10 })[knob]).toBe(max);
            expect(load({ [knob]: Number.MAX_SAFE_INTEGER })[knob]).toBe(max);
        });

    test.each(knobs)('%s clamps up to its floor', (knob, [, min]) => {
        expect(load({ [knob]: -5 })[knob]).toBe(min);
    });
});

describe('non-numeric knobs', () => {
    test('the Observatory is off unless explicitly enabled', () => {
        expect(load({}).enabled).toBe(false);
        expect(load({ enabled: 'yes' }).enabled).toBe(false);
        expect(load({ enabled: true }).enabled).toBe(true);
    });

    test('scope is web unless "everywhere" is spelled exactly', () => {
        expect(load({}).scope).toBe('web');
        expect(load({ scope: 'discord' }).scope).toBe('web');
        expect(load({ scope: 'everywhere' }).scope).toBe('everywhere');
    });

    test('ffmpeg command defaults to the system binary', () => {
        expect(load({}).ffmpegCommand).toBe('ffmpeg');
        expect(load({ ffmpegCommand: '/opt/ffmpeg/bin/ffmpeg' }).ffmpegCommand)
            .toBe('/opt/ffmpeg/bin/ffmpeg');
    });
});
