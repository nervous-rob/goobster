/**
 * Sandbox limit clamping (config/sandboxConfig.js).
 *
 * Every numeric knob is clamped into [floor, ceiling] so a config typo can
 * never remove a guardrail. The ceilings are deliberately roomy - two orders
 * of magnitude above the conservative defaults, so a beefy host can be
 * configured for real work - which makes it worth pinning both ends: an
 * absurd value must land exactly on the documented ceiling (never pass
 * through), and the ceiling must still leave the intended headroom.
 */

/** Load a fresh copy of the module with `sandbox` supplied via config.json. */
const load = (sandbox) => {
    let mod;
    jest.isolateModules(() => {
        // config.json is gitignored and usually absent, so mock it virtually.
        jest.doMock('../config.json', () => ({ sandbox }), { virtual: true });
        mod = require('@goobster/core/config/sandboxConfig');
    });
    return mod;
};

/** knob -> [default, floor, ceiling] */
const LIMITS = {
    timeoutMs: [20_000, 1_000, 12_000_000],
    maxCpuSeconds: [20, 1, 6_000],
    maxMemoryMb: [2048, 64, 409_600],
    maxWriteMb: [256, 1, 25_600],
    maxFetchMb: [512, 1, 4_096],
    maxOverlayMb: [512, 16, 51_200],
    maxOutputBytes: [64 * 1024, 1024, 100 * 1024 * 1024],
    maxOutputFiles: [8, 1, 2_500],
    maxFileSizeBytes: [8 * 1024 * 1024, 1024, 6_400 * 1024 * 1024],
    runsPerWindow: [10, 1, 10_000],
    maxFetchRequestsPerHour: [10, 1, 1_000],
    maxConcurrent: [1, 1, 400],
    retentionHours: [24, 1, 24 * 700]
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
        expect(load({ [knob]: 0 })[knob]).toBe(min);
        expect(load({ [knob]: -5 })[knob]).toBe(min);
    });

    test.each(knobs)('%s honours a raised-but-legal value verbatim', (knob, [def, , max]) => {
        const asked = Math.min(def * 10, max);
        expect(load({ [knob]: asked })[knob]).toBe(asked);
    });

    test('the ceilings leave two orders of magnitude of headroom above the defaults', () => {
        // maxFetchMb is exempt on purpose: it is a download/SSRF guard, and
        // "8x the default" (4 GB) is where its ceiling deliberately sits -
        // a 100x ceiling on an outbound fetch would be a hole, not headroom.
        for (const [knob, [def, , max]] of knobs) {
            if (knob !== 'maxFetchMb') expect(max / def).toBeGreaterThanOrEqual(100);
            expect(Number.isFinite(max)).toBe(true);
        }
        // A run can still never be scheduled longer than the Node-side
        // backstop timer can represent (setTimeout tops out at ~24.8 days).
        expect(LIMITS.timeoutMs[2] + 3000).toBeLessThan(2 ** 31 - 1);
    });
});

describe('non-numeric knobs', () => {
    test('the sandbox is off unless explicitly enabled', () => {
        expect(load({}).enabled).toBe(false);
        expect(load({ enabled: 'yes' }).enabled).toBe(false);
        expect(load({ enabled: true }).enabled).toBe(true);
    });

    test('scope is web unless "everywhere" is spelled exactly', () => {
        expect(load({}).scope).toBe('web');
        expect(load({ scope: 'discord' }).scope).toBe('web');
        expect(load({ scope: 'everywhere' }).scope).toBe('everywhere');
    });

    test('network access is off unless explicitly allowed', () => {
        expect(load({}).allowNetwork).toBe(false);
        expect(load({ allowNetwork: 'true' }).allowNetwork).toBe(false);
        expect(load({ allowNetwork: true }).allowNetwork).toBe(true);
    });

    test('extraBinds keeps only absolute paths', () => {
        expect(load({ extraBinds: ['/opt/venv', 'relative', 42] }).extraBinds).toEqual(['/opt/venv']);
        expect(load({ extraBinds: '/opt/venv' }).extraBinds).toEqual([]);
    });
});
