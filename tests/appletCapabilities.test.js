/**
 * Capability declarations for sandboxed mini-apps.
 */
const {
    extractObservatoryReadProjects,
    observatoryContentUrl,
    normalizeObservatoryGrants,
    legalizeObservatoryGrants,
    isObservatoryReadAllowed
} = require('@goobster/core/utils/appletCapabilities');

describe('extractObservatoryReadProjects', () => {
    test('reads one or more meta tags, including comma lists', () => {
        const source = `
            <html><head>
              <meta name="goobster-observatory-read" content="jwst-atlas">
              <meta content="other-lab, third" name="goobster-observatory-read">
            </head></html>
        `;
        expect(extractObservatoryReadProjects(source)).toEqual([
            'jwst-atlas', 'other-lab', 'third'
        ]);
    });

    test('drops invalid slugs, duplicates, and unrelated meta tags', () => {
        const source = `
            <meta name="viewport" content="width=device-width">
            <meta name="goobster-observatory-read" content="Good-Slug, ../etc, JWST-ATLAS, good-slug">
        `;
        expect(extractObservatoryReadProjects(source)).toEqual(['good-slug', 'jwst-atlas']);
    });

    test('returns empty when nothing is declared', () => {
        expect(extractObservatoryReadProjects('<html></html>')).toEqual([]);
        expect(extractObservatoryReadProjects('')).toEqual([]);
    });
});

describe('observatoryContentUrl', () => {
    test('encodes each path segment and the project slug', () => {
        expect(observatoryContentUrl('jwst-atlas', 'live_pointings/pointings 2026.json'))
            .toBe('/api/app/observatory/projects/jwst-atlas/content/live_pointings/pointings%202026.json');
    });
});

describe('grant legalization', () => {
    test('keeps only declared, well-formed slugs', () => {
        const source = '<meta name="goobster-observatory-read" content="jwst-atlas">';
        expect(legalizeObservatoryGrants(source, {
            observatoryRead: ['jwst-atlas', 'other-lab', '../x']
        })).toEqual({ observatoryRead: ['jwst-atlas'] });
        expect(normalizeObservatoryGrants(['JWST-Atlas', 'jwst-atlas'])).toEqual({
            observatoryRead: ['jwst-atlas']
        });
    });
});

describe('own-project vs cross-project grant resolution', () => {
    const ownSource = '<html><title>Dashboard</title></html>';
    const crossSource = '<html><head><meta name="goobster-observatory-read" content="other-lab"></head></html>';

    test('an app rendered inside its project may read that workspace with no tag and no grant', () => {
        expect(isObservatoryReadAllowed('neurogene-lab', {
            source: ownSource,
            grants: { observatoryRead: [] },
            ownProject: 'neurogene-lab'
        })).toBe(true);
        expect(isObservatoryReadAllowed('Neurogene-Lab', {
            source: ownSource,
            ownProject: 'neurogene-lab'
        })).toBe(true);
    });

    test('cross-project reads still need a declared tag plus an approved grant', () => {
        expect(isObservatoryReadAllowed('other-lab', {
            source: ownSource,
            grants: { observatoryRead: ['other-lab'] },
            ownProject: 'neurogene-lab'
        })).toBe(false);
        expect(isObservatoryReadAllowed('other-lab', {
            source: crossSource,
            grants: { observatoryRead: [] },
            ownProject: 'neurogene-lab'
        })).toBe(false);
        expect(isObservatoryReadAllowed('other-lab', {
            source: crossSource,
            grants: { observatoryRead: ['other-lab'] },
            ownProject: 'neurogene-lab'
        })).toBe(true);
    });

    test('legacy Workshop pins (no ownProject) keep the declare+grant rule', () => {
        expect(isObservatoryReadAllowed('jwst-atlas', {
            source: '<meta name="goobster-observatory-read" content="jwst-atlas">',
            grants: { observatoryRead: ['jwst-atlas'] }
        })).toBe(true);
        expect(isObservatoryReadAllowed('jwst-atlas', {
            source: '<html></html>',
            grants: { observatoryRead: ['jwst-atlas'] }
        })).toBe(false);
        expect(isObservatoryReadAllowed('jwst-atlas', {
            source: '<meta name="goobster-observatory-read" content="jwst-atlas">',
            grants: { observatoryRead: [] },
            ownProject: null
        })).toBe(false);
    });

    test('an invalid or empty requested slug is never allowed', () => {
        expect(isObservatoryReadAllowed('../etc', { ownProject: '../etc' })).toBe(false);
        expect(isObservatoryReadAllowed('', { ownProject: 'lab' })).toBe(false);
    });
});

// Exercise the actual browser bridge module with isolated synthetic stores/API.
describe('project app approval identity and scoped job bridge', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const vm = require('node:vm');
    const ts = require('typescript');
    const { webcrypto } = require('node:crypto');
    const source = '<meta name="goobster-project-access" content="write delete run"><!--Aa-->';
    const changed = source.replace('Aa', 'B@');
    const storage = () => {
        const values = new Map();
        return { getItem: k => values.get(k), setItem: (k, v) => values.set(k, v), removeItem: k => values.delete(k) };
    };
    function load(crypto = webcrypto) {
        const api = {
            putProjectContent: jest.fn(), deleteProjectContent: jest.fn(), runProjectFile: jest.fn(),
            projectJobLive: jest.fn(), observatoryJobLive: jest.fn()
        };
        const exports = {};
        const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../apps/web/src/renderers/appletProjectAccess.js'), 'utf8'), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
        }).outputText;
        vm.runInNewContext(code, {
            exports, crypto, Uint8Array, DataView, setTimeout,
            localStorage: storage(), sessionStorage: storage(),
            require: name => name.endsWith('/api') ? { api } : { accountStoragePrefix: () => 'test:', accountFetch: jest.fn() }
        });
        return { ...exports, api };
    }
    const requests = [
        { type: 'project.write', path: 'synthetic.txt', content: 'test' },
        { type: 'project.delete', path: 'synthetic.txt' },
        { type: 'project.run', path: 'synthetic.py' }
    ];
    test('the equal-length DJB2 collision cannot reuse any grant; unchanged source and same asset can', async () => {
        const oldHash = text => [...text].reduce((h, c) => ((h << 5) + h + c.charCodeAt(0)) | 0, 5381);
        expect(source.length).toBe(changed.length);
        expect(oldHash(source)).toBe(oldHash(changed));
        const mod = load();
        const approve = jest.fn(async () => true);
        const options = { project: 'a', owner: 'owner', asset: 'ledger', source, requestGrant: approve };
        const original = mod.createProjectAccess(options);
        for (const req of requests) expect((await original.handle(req)).ok).toBe(true);
        expect(approve).toHaveBeenCalledTimes(3);
        const same = mod.createProjectAccess(options);
        for (const req of requests) expect((await same.handle(req)).ok).toBe(true);
        expect(approve).toHaveBeenCalledTimes(3);
        for (const change of [{ source: changed }, { source: source + ' ' }, { asset: 'other' }, { owner: 'other' }, { project: 'b' }]) {
            const deny = jest.fn(async () => false);
            const app = mod.createProjectAccess({ ...options, ...change, requestGrant: deny });
            for (const req of requests) expect((await app.handle(req)).error.code).toBe('ACCESS_DENIED');
            expect(deny).toHaveBeenCalledTimes(3);
        }
        expect((await mod.readAppletAccess(options)).allowed.sort()).toEqual(['delete', 'run', 'write']);
        await mod.resetAppletAccess(options);
        expect((await mod.readAppletAccess(options)).allowed).toEqual([]);
        expect((await same.handle(requests[0])).ok).toBe(true);
        expect(approve).toHaveBeenCalledTimes(4);
    });
    test('identity resolution blocks operations until ready and fails closed on failure or absent asset', async () => {
        let resolve;
        const digest = new Promise(r => { resolve = r; });
        const mod = load({ subtle: { digest: () => digest } });
        const ask = jest.fn(async () => true);
        const opts = { project: 'a', asset: 'ledger', source, requestGrant: ask };
        const pending = mod.createProjectAccess(opts).handle(requests[0]);
        await Promise.resolve();
        expect(ask).not.toHaveBeenCalled();
        expect(mod.api.putProjectContent).not.toHaveBeenCalled();
        resolve(new ArrayBuffer(32));
        expect((await pending).ok).toBe(true);
        for (const broken of [load({}), load({ subtle: { digest: async () => { throw new Error('failed'); } } })]) {
            const app = broken.createProjectAccess(opts);
            for (const req of requests) expect((await app.handle(req)).error.code).toBe('IDENTITY_UNAVAILABLE');
            expect(broken.api.putProjectContent).not.toHaveBeenCalled();
        }
        expect((await mod.createProjectAccess({ ...opts, asset: null }).handle(requests[0])).error.code).toBe('IDENTITY_UNAVAILABLE');
    });
    test('job reads, watch startup and every poll carry trusted project and owner; a denied poll stops output', async () => {
        jest.useFakeTimers();
        try {
            const mod = load();
            const app = mod.createProjectAccess({ project: 'a', owner: 'owner-a', asset: 'ledger', source, requestGrant: async () => true });
            mod.api.projectJobLive.mockResolvedValueOnce({ running: false, stdout: 'synthetic' })
                .mockResolvedValueOnce({ running: true, stdout: 'first', at: 't1' })
                .mockRejectedValueOnce(Object.assign(new Error('No such job.'), { code: 'NO_SUCH_JOB' }));
            expect((await app.handle({ type: 'project.job', jobId: 7, project: 'b', owner: 'b' })).ok).toBe(true);
            const post = jest.fn();
            expect((await app.handle({ type: 'project.watch', jobId: 7, watchId: 'w', project: 'b' }, post)).ok).toBe(true);
            await jest.advanceTimersByTimeAsync(1200);
            expect(mod.api.projectJobLive.mock.calls).toEqual([
                ['a', 7, null, 'owner-a'], ['a', 7, null, 'owner-a'], ['a', 7, 't1', 'owner-a']
            ]);
            expect(post).toHaveBeenLastCalledWith(expect.objectContaining({ done: true, error: expect.objectContaining({ code: 'NO_SUCH_JOB' }) }));
            await jest.advanceTimersByTimeAsync(2400);
            expect(mod.api.projectJobLive).toHaveBeenCalledTimes(3);
            expect(mod.api.observatoryJobLive).not.toHaveBeenCalled();
            app.stopWatches();
        } finally { jest.useRealTimers(); }
    });
});
