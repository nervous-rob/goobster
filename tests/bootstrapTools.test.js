/**
 * The pinned bootstrap tools (documentation/bootstrap_tools.md): `scripts/lib/bootstrapTools.js`,
 * `scripts/bootstrap-tools.js`, the pins file and the workflows that run them.
 *
 * Network and GitHub are faked: a download is a lookup in a table of URLs, the REST client is a
 * table of paths. What is real: the pins file, the committed upstream key, the hashing, and
 * `gpg` for the signature checks (skipped where gpg is not installed). What this cannot prove is
 * that GitHub accepts the release and upload calls; the `mirror` job proves that on main.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const yaml = require('js-yaml');

const tools = require('../scripts/lib/bootstrapTools');
const cli = require('../scripts/bootstrap-tools');

const REPO_ROOT = path.resolve(__dirname, '..');
const PINS = tools.readPins();
const HAS_GPG = childProcess.spawnSync('gpg', ['--version'], { stdio: 'ignore' }).status === 0;
const withGpg = HAS_GPG ? test : test.skip;

// A throwaway signing key made for this file (its private half was discarded) and its detached
// signature over SIGNED_TEXT.
const FIXTURE_FINGERPRINT = '186C21B2204E49E8FA9E08D468F35D4F4168A43F';
const FIXTURE_KEY = [
    '-----BEGIN PGP PUBLIC KEY BLOCK-----',
    '',
    'mDMEavJ1zBYJKwYBBAHaRw8BAQdADCKP25//U4EWHMBgvFrxB3G6dHdEyIojUm3A',
    'Tl3Vwgu0QEdvb2JzdGVyIHRlc3QgZml4dHVyZSAobm90IGEgcmVhbCBrZXkpIDxm',
    'aXh0dXJlQGV4YW1wbGUuaW52YWxpZD6IkwQTFgoAOxYhBBhsIbIgTkno+p4I1Gjz',
    'XU9BaKQ/BQJq8nXMAhsDBQsJCAcCAiICBhUKCQgLAgQWAgMBAh4HAheAAAoJEGjz',
    'XU9BaKQ/Mf0A/2t1CwTygAZR95lrto7MI/O5Lkt1f8SbqQ8QB1CrIUGsAQD0bvTr',
    'i1f0742atTxXn1d7cSD/jfJhgOlspspvKPoADw==',
    '=SFZ7',
    '-----END PGP PUBLIC KEY BLOCK-----',
    ''
].join('\n');
const SIGNED_TEXT = 'goobster bootstrap-tools signature fixture\n';
const FIXTURE_SIGNATURE = 'iHUEABYKAB0WIQQYbCGyIE5J6PqeCNRo811PQWikPwUCavJ1zAAKCRBo811PQWikPwA/AP0Vq3UHKZ7D5NIs2RGnVI8z9IufpDwwzEPRDq1YkGIHMQD/Zs0AQHrI2mcTCbWrpWHjk3qFyPdOnz5h+Qx1Bd2zaA0=';

const OLD_COMMIT = '1111111111111111111111111111111111111111';
const NEW_COMMIT = '2222222222222222222222222222222222222222';
const TOOL_COMMIT = '3333333333333333333333333333333333333333';
const HOST_COMMIT = '4444444444444444444444444444444444444444';

const scratches = [];
function scratch(name) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `goobster-tools-${name}-`));
    scratches.push(dir);
    return dir;
}
afterAll(() => {
    for (const dir of scratches) fs.rmSync(dir, { recursive: true, force: true });
});

function sha(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
}

function runtimeBytes(commit, extra = '') {
    return Buffer.from(`runtime ${extra} https://github.com/acme/runtime/commit/${commit.slice(0, 7)}\n`);
}

const OLD_RUNTIME = runtimeBytes(OLD_COMMIT);
const NEW_RUNTIME = runtimeBytes(NEW_COMMIT);
const TOOL_X64 = Buffer.from('tool 1.9.0 x64');
const TOOL_ARM64 = Buffer.from('tool 1.9.0 arm64');
const HOST = Buffer.from('host 2.12.0');

function keysDir() {
    const dir = scratch('keys');
    fs.mkdirSync(path.join(dir, 'keys'));
    fs.writeFileSync(path.join(dir, 'keys', 'fixture.asc'), FIXTURE_KEY);
    return dir;
}

function fixturePins() {
    return {
        version: 2,
        mirror: { repository: 'goob/ster', tag: 'bootstrap-tools' },
        keys: { runtime: { fingerprint: FIXTURE_FINGERPRINT, file: 'keys/fixture.asc' } },
        runtime: {
            source: 'https://github.com/acme/runtime/releases/tag/continuous',
            note: 'a rolling release',
            upstream: { repository: 'acme/runtime', track: 'tag', tag: 'continuous', commit: OLD_COMMIT, uploader: 'github-actions[bot]', workflow: '.github/workflows/build.yaml', run: 1, embedsCommit: true, signingKey: 'runtime' },
            x64: { url: 'https://github.com/acme/runtime/releases/download/continuous/runtime-x86_64', sha256: sha(OLD_RUNTIME), signature: 'b2xk' }
        },
        tool: {
            version: '1.9.0',
            source: 'https://github.com/acme/tool/releases/tag/1.9.0',
            upstream: { repository: 'acme/tool', track: 'versions', tag: '1.9.0', commit: TOOL_COMMIT, uploader: 'github-actions[bot]' },
            x64: { url: 'https://github.com/acme/tool/releases/download/1.9.0/tool-x86_64.AppImage', sha256: sha(TOOL_X64) },
            arm64: { url: 'https://github.com/acme/tool/releases/download/1.9.0/tool-aarch64.AppImage', sha256: sha(TOOL_ARM64) }
        },
        host: {
            version: '2.12.0',
            source: 'https://github.com/acme/host/releases/tag/v2.12.0',
            upstream: { repository: 'acme/host', track: 'versions', tag: 'v2.12.0', commit: HOST_COMMIT, uploader: 'maintainer' },
            file: 'Host.exe',
            url: 'https://github.com/acme/host/releases/download/v2.12.0/Host.exe',
            sha256: sha(HOST)
        }
    };
}

/** A table of URLs standing in for the network; a URL it does not hold answers 404. */
function network(files = {}) {
    const table = new Map(Object.entries(files));
    const calls = [];
    const doDownload = async (url, destination) => {
        calls.push(url);
        const body = table.get(url);
        if (body === undefined) {
            const error = new Error(`GET ${url} -> HTTP 404`);
            error.statusCode = 404;
            throw error;
        }
        if (body instanceof Error) throw body;
        fs.writeFileSync(destination, body);
    };
    return { table, calls, doDownload };
}

function upstreamFiles(pins = fixturePins()) {
    return {
        [pins.runtime.x64.url]: OLD_RUNTIME,
        [pins.tool.x64.url]: TOOL_X64,
        [pins.tool.arm64.url]: TOOL_ARM64,
        [pins.host.url]: HOST
    };
}

function mirrorFiles(pins = fixturePins()) {
    const files = {};
    for (const entry of tools.listPins(pins)) {
        files[tools.mirrorUrl(pins, entry.pin)] = { runtime: OLD_RUNTIME, tool: entry.variant === 'x64' ? TOOL_X64 : TOOL_ARM64, host: HOST }[entry.tool];
    }
    return files;
}

/** A table of REST paths standing in for GitHub; a path it does not hold answers 404. */
function fakeGithub(routes = {}) {
    const calls = [];
    const fail = (method, url) => {
        const error = new Error(`${method} ${url} -> HTTP 404`);
        error.status = 404;
        return error;
    };
    return {
        calls,
        routes,
        async getJson(url) {
            calls.push(['GET', url]);
            if (!(url in routes)) throw fail('GET', url);
            return routes[url];
        },
        async postJson(url, body) {
            calls.push(['POST', url, body]);
            if (typeof routes[`POST ${url}`] !== 'function') throw fail('POST', url);
            return routes[`POST ${url}`](body);
        },
        async patchJson(url, body) {
            calls.push(['PATCH', url, body]);
            return {};
        },
        async uploadAsset({ uploadUrl, name, file }) {
            calls.push(['UPLOAD', name]);
            if (typeof routes.upload === 'function') routes.upload({ uploadUrl, name, file });
            return { name };
        }
    };
}

function asset(name, data, { digest = true, uploader = 'github-actions[bot]', created = '2026-10-19T20:37:00Z' } = {}) {
    return { name, digest: digest ? `sha256:${sha(data)}` : null, uploader: { login: uploader }, created_at: created };
}

/** GitHub as it looks while upstream still serves exactly what the fixture pins. */
function upstreamRoutes() {
    return {
        '/repos/acme/runtime/releases/tags/continuous': { tag_name: 'continuous', assets: [asset('runtime-x86_64', OLD_RUNTIME), asset('runtime-x86_64.sig', Buffer.from('old'))] },
        '/repos/acme/runtime/git/ref/tags/continuous': { object: { type: 'commit', sha: OLD_COMMIT } },
        '/repos/acme/tool/releases?per_page=100': [{ tag_name: 'continuous' }, { tag_name: '1.9.0' }],
        '/repos/acme/tool/releases/tags/1.9.0': { tag_name: '1.9.0', assets: [asset('tool-x86_64.AppImage', TOOL_X64, { digest: false }), asset('tool-aarch64.AppImage', TOOL_ARM64, { digest: false })] },
        '/repos/acme/tool/git/ref/tags/1.9.0': { object: { type: 'commit', sha: TOOL_COMMIT } },
        '/repos/acme/host/releases?per_page=100': [{ tag_name: 'v3.0.0-alpha.11', prerelease: true }, { tag_name: 'v2.12.0' }],
        '/repos/acme/host/releases/tags/v2.12.0': { tag_name: 'v2.12.0', assets: [asset('Host.exe', HOST, { digest: false, uploader: 'maintainer' })] },
        '/repos/acme/host/git/ref/tags/v2.12.0': { object: { type: 'commit', sha: HOST_COMMIT } }
    };
}

/** The same, after upstream rebuilt its rolling runtime release from NEW_COMMIT. */
function rebuiltRoutes(overrides = {}) {
    const routes = upstreamRoutes();
    routes['/repos/acme/runtime/releases/tags/continuous'] = {
        tag_name: 'continuous',
        assets: [asset('runtime-x86_64', NEW_RUNTIME, overrides.asset), asset('runtime-x86_64.sig', Buffer.from('new'))]
    };
    routes['/repos/acme/runtime/git/ref/tags/continuous'] = { object: { type: 'commit', sha: NEW_COMMIT } };
    routes[`/repos/acme/runtime/actions/runs?head_sha=${NEW_COMMIT}&per_page=100`] = {
        workflow_runs: [
            { id: 7, path: '.github/workflows/pr-comment.yaml', head_sha: NEW_COMMIT, event: 'workflow_run', conclusion: 'success', run_started_at: '2026-10-19T20:37:25Z' },
            { id: 42, path: '.github/workflows/build.yaml', head_sha: NEW_COMMIT, event: 'push', conclusion: 'success', run_started_at: '2026-10-19T20:35:29Z', ...overrides.run }
        ]
    };
    return routes;
}

function rebuiltNetwork(pins = fixturePins()) {
    return network({ ...upstreamFiles(pins), [pins.runtime.x64.url]: NEW_RUNTIME, [`${pins.runtime.x64.url}.sig`]: Buffer.from('new signature bytes') });
}

const goodSig = () => ({ ok: true, signedAt: '2026-10-19T20:36:16.000Z' });
const badSig = () => ({ ok: false, code: 'SIGNATURE_INVALID', detail: 'the signature is not a good signature by the pinned key' });

describe('the pins file', () => {
    test('is valid, and is written the way a refresh rewrites it', () => {
        expect(tools.pinProblems(PINS)).toEqual([]);
        expect(PINS.version).toBe(tools.PINS_VERSION);
        expect(fs.readFileSync(tools.PINS_FILE, 'utf8')).toBe(`${JSON.stringify(PINS, null, 4)}\n`);
    });

    test('every pinned file has a hash-named copy on Goobster\'s mirror and names where upstream published it', () => {
        const entries = tools.listPins(PINS);
        expect(entries.map(entry => entry.id)).toEqual(['appimagetool.x64', 'appimagetool.arm64', 'appimageRuntime.x64', 'appimageRuntime.arm64', 'winsw']);
        for (const entry of entries) {
            expect(tools.mirrorUrl(PINS, entry.pin)).toBe(`https://github.com/nervous-rob/goobster/releases/download/bootstrap-tools/${entry.file}.${entry.sha256}`);
            expect(tools.sourcesFor(PINS, entry.pin).map(source => source.name)).toEqual(['mirror', 'upstream']);
            const upstream = entry.group.upstream;
            expect(entry.url).toBe(`https://github.com/${upstream.repository}/releases/download/${upstream.tag}/${entry.file}`);
            expect(upstream.commit).toMatch(/^[0-9a-f]{40}$/);
        }
    });

    test('the AppImage runtime carries upstream\'s signatures and the key they are checked against', () => {
        const key = PINS.keys[PINS.appimageRuntime.upstream.signingKey];
        expect(key.fingerprint).toBe('570C77ACEA40C0F1B758902CBF96CCA56490F695');
        expect(fs.existsSync(path.join(REPO_ROOT, 'scripts', key.file))).toBe(true);
        for (const arch of ['x64', 'arm64']) expect(Buffer.from(PINS.appimageRuntime[arch].signature, 'base64').length).toBeGreaterThan(64);
    });

    withGpg('the committed upstream key is the key with the pinned fingerprint', () => {
        const key = PINS.keys[PINS.appimageRuntime.upstream.signingKey];
        const file = path.join(scratch('probe'), 'probe');
        fs.writeFileSync(file, 'not the runtime');
        const result = tools.verifySignature({ file, signature: Buffer.from(PINS.appimageRuntime.x64.signature, 'base64'), keyFile: path.join(REPO_ROOT, 'scripts', key.file), fingerprint: key.fingerprint });
        expect(result).toMatchObject({ ok: false, code: 'SIGNATURE_INVALID' });
    });

    test('a pin that lost its hash, its upstream, its signature or its mirror is named as a problem', () => {
        const dir = keysDir();
        const check = (mutate) => {
            const pins = fixturePins();
            mutate(pins);
            return tools.pinProblems(pins, { keysDir: dir }).join('\n');
        };
        expect(check(() => {})).toBe('');
        expect(check(pins => { delete pins.mirror; })).toMatch(/mirror must name/);
        expect(check(pins => { pins.version = 1; })).toMatch(/version must be 2/);
        expect(check(pins => { pins.host.sha256 = 'ABC'; })).toMatch(/host\.sha256/);
        expect(check(pins => { pins.tool.x64.url = 'https://example.com/tool-x86_64.AppImage'; })).toMatch(/tool\.x64\.url must be a file of the upstream release/);
        expect(check(pins => { pins.tool.x64.url = 'https://github.com/acme/tool/releases/download/9.9.9/tool-x86_64.AppImage'; })).toMatch(/tool\.x64\.url/);
        expect(check(pins => { delete pins.runtime.x64.signature; })).toMatch(/runtime\.x64\.signature/);
        expect(check(pins => { pins.runtime.upstream.signingKey = 'nobody'; })).toMatch(/signingKey names no key/);
        expect(check(pins => { pins.keys.runtime.file = 'keys/missing.asc'; })).toMatch(/does not exist/);
        expect(check(pins => { pins.host.upstream.commit = 'abc'; })).toMatch(/host\.upstream\.commit/);
        expect(check(pins => { delete pins.tool.upstream; })).toMatch(/tool\.upstream is missing/);
        expect(() => tools.assertValidPins({ version: 2 })).toThrow(/bootstrap-pins\.json/);
    });
});

describe('fetching a pinned file', () => {
    const pins = fixturePins();
    const pin = pins.host;
    const mirror = tools.mirrorUrl(pins, pin);

    test('takes Goobster\'s copy first and never asks upstream when it matches', async () => {
        const net = network({ [mirror]: HOST, [pin.url]: HOST });
        const destination = path.join(scratch('fetch'), 'Host.exe');
        const got = await tools.fetchPinned({ pins, pin, destination, doDownload: net.doDownload });
        expect(got).toMatchObject({ ok: true, cached: false, source: 'mirror' });
        expect(net.calls).toEqual([mirror]);
        expect(fs.readFileSync(destination)).toEqual(HOST);
    });

    test('falls back to upstream while the mirror does not hold the file', async () => {
        const net = network({ [pin.url]: HOST });
        const got = await tools.fetchPinned({ pins, pin, destination: path.join(scratch('fetch'), 'Host.exe'), doDownload: net.doDownload });
        expect(got).toMatchObject({ ok: true, source: 'upstream' });
        expect(got.attempts.map(attempt => `${attempt.source}:${attempt.outcome}`)).toEqual(['mirror:UNAVAILABLE', 'upstream:OK']);
    });

    test('an upstream rebuild does not matter once the mirror holds the pinned file', async () => {
        const net = network({ [mirror]: HOST, [pin.url]: Buffer.from('upstream rebuilt this') });
        const got = await tools.fetchPinned({ pins, pin, destination: path.join(scratch('fetch'), 'Host.exe'), doDownload: net.doDownload });
        expect(got).toMatchObject({ ok: true, source: 'mirror' });
    });

    test('a copy that does not match its pin is discarded, whichever source served it', async () => {
        const dir = scratch('fetch');
        const destination = path.join(dir, 'Host.exe');
        const wrongMirror = network({ [mirror]: Buffer.from('tampered'), [pin.url]: HOST });
        const rescued = await tools.fetchPinned({ pins, pin, destination, doDownload: wrongMirror.doDownload });
        expect(rescued).toMatchObject({ ok: true, source: 'upstream' });
        expect(rescued.attempts[0]).toMatchObject({ source: 'mirror', outcome: 'HASH_MISMATCH' });
        fs.rmSync(destination);
        const allWrong = network({ [mirror]: Buffer.from('tampered'), [pin.url]: Buffer.from('rebuilt') });
        const refused = await tools.fetchPinned({ pins, pin, destination, doDownload: allWrong.doDownload });
        expect(refused).toMatchObject({ ok: false, reason: 'HASH_MISMATCH' });
        expect(refused.detail).toMatch(/does not match its pinned SHA-256/);
        expect(fs.readdirSync(dir)).toEqual([]);
    });

    test('no source reachable is UNAVAILABLE with the last error, and nothing is left behind', async () => {
        const dir = scratch('fetch');
        const got = await tools.fetchPinned({ pins, pin, destination: path.join(dir, 'Host.exe'), doDownload: async () => { throw new Error('offline'); } });
        expect(got).toMatchObject({ ok: false, reason: 'UNAVAILABLE', detail: 'offline' });
        expect(fs.readdirSync(dir)).toEqual([]);
    });

    test('a cached copy is reused only while it still matches the pin', async () => {
        const destination = path.join(scratch('fetch'), 'Host.exe');
        fs.writeFileSync(destination, HOST);
        const net = network({ [mirror]: HOST });
        expect(await tools.fetchPinned({ pins, pin, destination, doDownload: net.doDownload })).toMatchObject({ ok: true, cached: true, source: 'cache' });
        expect(net.calls).toEqual([]);
        fs.writeFileSync(destination, 'stale');
        expect(await tools.fetchPinned({ pins, pin, destination, doDownload: net.doDownload })).toMatchObject({ ok: true, cached: false, source: 'mirror' });
    });

    test('pins without a mirror are fetched from upstream alone', async () => {
        const net = network({ [pin.url]: HOST });
        const got = await tools.fetchPinned({ pins: { host: pin }, pin, destination: path.join(scratch('fetch'), 'Host.exe'), doDownload: net.doDownload });
        expect(got).toMatchObject({ ok: true, source: 'upstream' });
        expect(net.calls).toEqual([pin.url]);
    });
});

describe('signatures and the embedded commit', () => {
    function fixture(text = SIGNED_TEXT) {
        const dir = keysDir();
        const file = path.join(dir, 'signed');
        fs.writeFileSync(file, text);
        return { file, keyFile: path.join(dir, 'keys', 'fixture.asc'), signature: Buffer.from(FIXTURE_SIGNATURE, 'base64') };
    }

    withGpg('a good signature by the pinned key is accepted', () => {
        const result = tools.verifySignature({ ...fixture(), fingerprint: FIXTURE_FINGERPRINT });
        expect(result.ok).toBe(true);
        expect(result.signedAt).toMatch(/^20\d\d-/);
    });

    withGpg('a changed file, a foreign signature and a key with another fingerprint are each refused', () => {
        expect(tools.verifySignature({ ...fixture(`${SIGNED_TEXT}x`), fingerprint: FIXTURE_FINGERPRINT })).toMatchObject({ ok: false, code: 'SIGNATURE_INVALID' });
        expect(tools.verifySignature({ ...fixture(), signature: Buffer.from(PINS.appimageRuntime.x64.signature, 'base64'), fingerprint: FIXTURE_FINGERPRINT })).toMatchObject({ ok: false, code: 'SIGNATURE_INVALID' });
        expect(tools.verifySignature({ ...fixture(), signature: Buffer.from('not a signature'), fingerprint: FIXTURE_FINGERPRINT })).toMatchObject({ ok: false, code: 'SIGNATURE_INVALID' });
        expect(tools.verifySignature({ ...fixture(), fingerprint: '570C77ACEA40C0F1B758902CBF96CCA56490F695' })).toMatchObject({ ok: false, code: 'KEY_MISMATCH' });
    });

    test('a machine without gpg says so instead of passing', () => {
        const result = tools.verifySignature({ ...fixture(), fingerprint: FIXTURE_FINGERPRINT, run: () => ({ error: new Error('ENOENT'), status: null }) });
        expect(result).toMatchObject({ ok: false, code: 'GPG_UNAVAILABLE' });
    });

    test('a binary names its commit only when it carries an abbreviation of exactly that commit', () => {
        const file = path.join(scratch('commit'), 'runtime');
        fs.writeFileSync(file, NEW_RUNTIME);
        expect(tools.embedsCommit(file, 'acme/runtime', NEW_COMMIT)).toBe(true);
        expect(tools.embedsCommit(file, 'acme/runtime', OLD_COMMIT)).toBe(false);
        expect(tools.embedsCommit(file, 'acme/other', NEW_COMMIT)).toBe(false);
        fs.writeFileSync(file, 'https://github.com/acme/runtime/commit/2222');
        expect(tools.embedsCommit(file, 'acme/runtime', NEW_COMMIT)).toBe(false);
    });
});

describe('looking for a newer upstream build', () => {
    function run({ pins = fixturePins(), routes = upstreamRoutes(), net = network(upstreamFiles()), verifySig = goodSig } = {}) {
        return tools.refresh({ pins, github: fakeGithub(routes), workDir: scratch('refresh'), doDownload: net.doDownload, verifySig, keysDir: keysDir() });
    }

    test('nothing is proposed while upstream serves what is pinned, and a recorded digest saves the download', async () => {
        const pins = fixturePins();
        const net = network(upstreamFiles(pins));
        const result = await run({ pins, net });
        expect(result).toMatchObject({ changed: false, changes: [], files: [] });
        expect(result.pins).toEqual(pins);
        expect(net.calls).not.toContain(pins.runtime.x64.url);
        expect(net.calls).toEqual(expect.arrayContaining([pins.tool.x64.url, pins.host.url]));
    });

    test('a rebuilt rolling release is proposed with its hash, signature, commit and the build run that made it', async () => {
        const pins = fixturePins();
        const result = await run({ pins, routes: rebuiltRoutes(), net: rebuiltNetwork(pins) });
        expect(result.changed).toBe(true);
        expect(result.changes.map(change => change.tool)).toEqual(['runtime']);
        expect(result.pins.runtime.x64).toEqual({ url: pins.runtime.x64.url, sha256: sha(NEW_RUNTIME), signature: Buffer.from('new signature bytes').toString('base64') });
        expect(result.pins.runtime.upstream).toMatchObject({ tag: 'continuous', commit: NEW_COMMIT, run: 42 });
        expect(result.pins.tool).toEqual(pins.tool);
        expect(result.pins.host).toEqual(pins.host);
        expect(tools.pinProblems(result.pins, { keysDir: keysDir() })).toEqual([]);
        expect(result.files).toEqual([{ id: 'runtime.x64', name: `runtime-x86_64.${sha(NEW_RUNTIME)}`, file: expect.any(String) }]);
        expect(fs.readFileSync(result.files[0].file)).toEqual(NEW_RUNTIME);
        expect(pins.runtime.x64.sha256).toBe(sha(OLD_RUNTIME));
        const report = tools.renderRefreshReport(result);
        expect(report).toContain(sha(OLD_RUNTIME));
        expect(report).toContain(sha(NEW_RUNTIME));
        expect(report).toContain(`compare/${OLD_COMMIT}...${NEW_COMMIT}`);
        expect(report).toMatch(/Upstream replaced the files under the tag `continuous`/);
        expect(report).toMatch(/Nothing is published and nothing changes for builds until a person merges/);
    });

    test.each([
        ['the download differs from the digest GitHub records', 'UPSTREAM_DIGEST_MISMATCH', pins => ({ net: network({ ...upstreamFiles(pins), [pins.runtime.x64.url]: Buffer.from('not what the release lists'), [`${pins.runtime.x64.url}.sig`]: Buffer.from('s') }) })],
        ['another account uploaded the file', 'UPSTREAM_UPLOADER_CHANGED', () => ({ routes: rebuiltRoutes({ asset: { uploader: 'someone-else' } }) })],
        ['the signature is not good under the pinned key', 'SIGNATURE_INVALID', () => ({ verifySig: badSig })],
        ['upstream published no signature', 'UPSTREAM_SIGNATURE_MISSING', () => {
            const routes = rebuiltRoutes();
            routes['/repos/acme/runtime/releases/tags/continuous'].assets.pop();
            return { routes };
        }],
        ['the binary names another commit than the release', 'COMMIT_NOT_EMBEDDED', () => {
            const routes = rebuiltRoutes();
            routes['/repos/acme/runtime/git/ref/tags/continuous'] = { object: { type: 'commit', sha: HOST_COMMIT } };
            routes[`/repos/acme/runtime/actions/runs?head_sha=${HOST_COMMIT}&per_page=100`] = routes[`/repos/acme/runtime/actions/runs?head_sha=${NEW_COMMIT}&per_page=100`];
            return { routes };
        }],
        ['upstream\'s build did not succeed for the commit', 'UPSTREAM_BUILD_NOT_FOUND', () => ({ routes: rebuiltRoutes({ run: { conclusion: 'failure' } }) })],
        ['the file is older than the build that should have made it', 'UPSTREAM_ASSET_PREDATES_BUILD', () => ({ routes: rebuiltRoutes({ asset: { created: '2026-10-19T20:00:00Z' } }) })],
        ['the release no longer has the file', 'UPSTREAM_ASSET_MISSING', () => {
            const routes = rebuiltRoutes();
            routes['/repos/acme/runtime/releases/tags/continuous'].assets = [];
            return { routes };
        }]
    ])('a newer build is refused when %s', async (_, code, arrange) => {
        const pins = fixturePins();
        const setup = { pins, routes: rebuiltRoutes(), net: rebuiltNetwork(pins), ...arrange(pins) };
        await expect(run(setup)).rejects.toMatchObject({ code });
    });

    test('a tool that follows versions moves to the highest published version, never to a rolling, draft or pre-release one', async () => {
        const pins = fixturePins();
        const routes = upstreamRoutes();
        const newX64 = Buffer.from('tool 1.10.0 x64');
        const newArm64 = Buffer.from('tool 1.10.0 arm64');
        routes['/repos/acme/tool/releases?per_page=100'] = [
            { tag_name: 'continuous' }, { tag_name: '2.0.0-rc1' }, { tag_name: '3.0.0', prerelease: true }, { tag_name: '4.0.0', draft: true },
            { tag_name: '1.9.1' }, { tag_name: '1.10.0' }, { tag_name: '1.9.0' }
        ];
        routes['/repos/acme/tool/releases/tags/1.10.0'] = { tag_name: '1.10.0', assets: [asset('tool-x86_64.AppImage', newX64), asset('tool-aarch64.AppImage', newArm64)] };
        routes['/repos/acme/tool/git/ref/tags/1.10.0'] = { object: { type: 'tag', sha: 'annotated' } };
        routes['/repos/acme/tool/git/tags/annotated'] = { object: { type: 'commit', sha: NEW_COMMIT } };
        const net = network({
            ...upstreamFiles(pins),
            'https://github.com/acme/tool/releases/download/1.10.0/tool-x86_64.AppImage': newX64,
            'https://github.com/acme/tool/releases/download/1.10.0/tool-aarch64.AppImage': newArm64
        });
        const result = await run({ pins, routes, net });
        expect(result.changes.map(change => [change.tool, change.sameTag, change.to.tag])).toEqual([['tool', false, '1.10.0']]);
        expect(result.pins.tool).toMatchObject({
            version: '1.10.0',
            source: 'https://github.com/acme/tool/releases/tag/1.10.0',
            upstream: { tag: '1.10.0', commit: NEW_COMMIT, track: 'versions' },
            x64: { url: 'https://github.com/acme/tool/releases/download/1.10.0/tool-x86_64.AppImage', sha256: sha(newX64) },
            arm64: { url: 'https://github.com/acme/tool/releases/download/1.10.0/tool-aarch64.AppImage', sha256: sha(newArm64) }
        });
        expect(tools.renderRefreshReport(result)).toMatch(/Upstream published `1\.10\.0`; the pin was at `1\.9\.0`/);
    });

    test('a file replaced under a released tag is proposed as exactly that, and an older version is never taken', async () => {
        const pins = fixturePins();
        const replaced = Buffer.from('host 2.12.0, replaced');
        const routes = upstreamRoutes();
        routes['/repos/acme/host/releases?per_page=100'] = [{ tag_name: 'v2.11.0' }, { tag_name: 'v2.12.0' }];
        routes['/repos/acme/host/releases/tags/v2.12.0'].assets = [asset('Host.exe', replaced, { uploader: 'maintainer' })];
        const result = await run({ pins, routes, net: network({ ...upstreamFiles(pins), [pins.host.url]: replaced }) });
        expect(result.changes.map(change => [change.tool, change.sameTag])).toEqual([['host', true]]);
        expect(result.pins.host).toMatchObject({ version: '2.12.0', url: pins.host.url, sha256: sha(replaced), file: 'Host.exe' });
    });
});

describe('verifying the pins against their sources', () => {
    function run({ pins = fixturePins(), files, ...options } = {}) {
        const net = network(files);
        return tools.verifyPins({ pins, workDir: scratch('verify'), doDownload: net.doDownload, verifySig: goodSig, keysDir: keysDir(), ...options });
    }

    test('before the mirror is published the upstream copies pass, and are kept under their mirror names', async () => {
        const stageTo = scratch('stage');
        const result = await run({ files: upstreamFiles(), stageTo });
        expect(result.ok).toBe(true);
        expect(result.rows.map(row => [row.id, row.mirror, row.upstream])).toEqual([
            ['runtime.x64', 'absent', 'ok'], ['tool.x64', 'absent', 'ok'], ['tool.arm64', 'absent', 'ok'], ['host', 'absent', 'ok']
        ]);
        expect(fs.readdirSync(stageTo).sort()).toEqual(tools.listPins(fixturePins()).map(entry => tools.mirrorAssetName(entry.pin)).sort());
    });

    test('on main the mirror must hold every pinned file', async () => {
        const missing = await run({ files: upstreamFiles(), requireMirror: true });
        expect(missing.ok).toBe(false);
        expect(missing.rows.every(row => row.problems.some(problem => problem.code === 'MIRROR_MISSING'))).toBe(true);
        const held = await run({ files: { ...mirrorFiles(), ...upstreamFiles() }, requireMirror: true });
        expect(held.ok).toBe(true);
    });

    test('upstream moving on is reported, not failed, while the mirror holds the pinned file', async () => {
        const pins = fixturePins();
        const result = await run({ pins, files: { ...mirrorFiles(pins), ...upstreamFiles(pins), [pins.runtime.x64.url]: NEW_RUNTIME }, requireMirror: true });
        expect(result.ok).toBe(true);
        expect(result.rows[0]).toMatchObject({ id: 'runtime.x64', mirror: 'ok', upstream: 'different' });
    });

    test('a mirror that serves other bytes fails even when upstream is fine', async () => {
        const pins = fixturePins();
        const result = await run({ pins, files: { ...mirrorFiles(pins), ...upstreamFiles(pins), [tools.mirrorUrl(pins, pins.host)]: Buffer.from('swapped') } });
        expect(result.ok).toBe(false);
        expect(result.rows.find(row => row.id === 'host').problems).toEqual([expect.objectContaining({ code: 'MIRROR_HASH_MISMATCH' })]);
    });

    test('a pin nothing serves fails unless a staged copy with that hash exists', async () => {
        const pins = fixturePins();
        const files = { ...upstreamFiles(pins), [pins.runtime.x64.url]: NEW_RUNTIME };
        const lost = await run({ pins, files });
        expect(lost.rows[0].problems).toEqual([expect.objectContaining({ code: 'PIN_UNOBTAINABLE' })]);
        const stagedDir = scratch('staged');
        fs.mkdirSync(path.join(stagedDir, '17'));
        fs.writeFileSync(path.join(stagedDir, '17', 'whatever-name'), OLD_RUNTIME);
        fs.writeFileSync(path.join(stagedDir, 'decoy'), 'not it');
        const found = await run({ pins, files, stagedDir });
        expect(found.ok).toBe(true);
        expect(found.rows[0]).toMatchObject({ staged: true, upstream: 'different' });
    });

    test('a copy with the right hash still fails on a bad signature or a commit it does not name', async () => {
        const unsigned = await run({ files: upstreamFiles(), verifySig: badSig });
        expect(unsigned.rows[0].problems).toEqual([expect.objectContaining({ code: 'SIGNATURE_INVALID' })]);
        expect(unsigned.rows.slice(1).every(row => row.problems.length === 0)).toBe(true);
        const pins = fixturePins();
        pins.runtime.upstream.commit = NEW_COMMIT;
        const wrongCommit = await run({ pins, files: upstreamFiles(pins) });
        expect(wrongCommit.rows[0].problems).toEqual([expect.objectContaining({ code: 'COMMIT_NOT_EMBEDDED' })]);
    });
});

describe('publishing to the mirror', () => {
    const RELEASE_PATH = '/repos/goob/ster/releases/tags/bootstrap-tools';

    /** A mirror that starts with `held` assets and serves whatever is uploaded to it afterwards. */
    function mirror({ pins = fixturePins(), held = [], files = upstreamFiles(pins), latest = 'companion-v2.1.0', exists = held.length > 0 } = {}) {
        const net = network(files);
        const routes = { '/repos/goob/ster/releases/latest': { tag_name: latest } };
        const release = { id: 9, upload_url: 'https://uploads.example/repos/goob/ster/releases/9/assets{?name,label}', assets: held };
        if (exists) routes[RELEASE_PATH] = release;
        routes['POST /repos/goob/ster/releases'] = () => release;
        routes.upload = ({ name, file }) => net.table.set(`https://github.com/goob/ster/releases/download/bootstrap-tools/${name}`, fs.readFileSync(file));
        const github = fakeGithub(routes);
        const run = (options = {}) => tools.publish({ pins, github, workDir: scratch('publish'), doDownload: net.doDownload, verifySig: goodSig, keysDir: keysDir(), ...options });
        return { pins, net, github, run, names: tools.listPins(pins).map(entry => tools.mirrorAssetName(entry.pin)) };
    }

    const sent = (github, method) => github.calls.filter(call => call[0] === method);

    test('the first publish creates a release that is never "latest", uploads every pinned file and reads each one back', async () => {
        const world = mirror();
        const result = await world.run({ target: 'abc123' });
        expect(result).toMatchObject({ created: true, dryRun: false, present: [] });
        expect(result.uploaded.sort()).toEqual([...world.names].sort());
        const [create] = sent(world.github, 'POST');
        expect(create[2]).toMatchObject({ tag_name: 'bootstrap-tools', prerelease: true, make_latest: 'false', target_commitish: 'abc123' });
        expect(create[2].body).toContain(world.names[0]);
        expect(sent(world.github, 'UPLOAD').map(call => call[1]).sort()).toEqual([...world.names].sort());
        for (const entry of tools.listPins(world.pins)) expect(world.net.calls).toContain(tools.mirrorUrl(world.pins, entry.pin));
        expect(sent(world.github, 'PATCH')).toHaveLength(1);
    });

    test('publishing again changes nothing', async () => {
        const pins = fixturePins();
        const held = tools.listPins(pins).map(entry => ({ name: tools.mirrorAssetName(entry.pin), digest: `sha256:${entry.sha256}` }));
        const world = mirror({ pins, held });
        const result = await world.run();
        expect(result).toMatchObject({ created: false, uploaded: [] });
        expect(result.present).toHaveLength(4);
        expect(sent(world.github, 'POST')).toEqual([]);
        expect(sent(world.github, 'UPLOAD')).toEqual([]);
        expect(sent(world.github, 'PATCH')).toEqual([]);
    });

    test('only the files a merged pin added are uploaded; earlier files are left alone', async () => {
        const pins = fixturePins();
        const earlier = { name: 'runtime-x86_64.0000', digest: `sha256:${'0'.repeat(64)}` };
        const held = [earlier, ...tools.listPins(pins).filter(entry => entry.tool !== 'runtime').map(entry => ({ name: tools.mirrorAssetName(entry.pin), digest: null }))];
        const world = mirror({ pins, held, files: { ...upstreamFiles(pins), ...mirrorFiles(pins) } });
        const result = await world.run();
        expect(result.uploaded).toEqual([`runtime-x86_64.${sha(OLD_RUNTIME)}`]);
        expect(result.present).toHaveLength(3);
        expect(sent(world.github, 'POST')).toEqual([]);
    });

    test('a mirror file that differs from its pin stops the publish; it is never replaced', async () => {
        const pins = fixturePins();
        const held = [{ name: tools.mirrorAssetName(pins.host), digest: `sha256:${'f'.repeat(64)}` }];
        const world = mirror({ pins, held });
        await expect(world.run()).rejects.toMatchObject({ code: 'MIRROR_HASH_MISMATCH' });
        expect(sent(world.github, 'UPLOAD')).toEqual([]);
    });

    test('when upstream has moved on, the staged copy is published; with none, nothing is created or uploaded', async () => {
        const pins = fixturePins();
        const files = { ...upstreamFiles(pins), [pins.runtime.x64.url]: NEW_RUNTIME };
        const stranded = mirror({ pins, files });
        await expect(stranded.run()).rejects.toMatchObject({ code: 'PIN_UNOBTAINABLE' });
        expect(sent(stranded.github, 'POST')).toEqual([]);
        expect(sent(stranded.github, 'UPLOAD')).toEqual([]);
        const stagedDir = scratch('staged');
        fs.writeFileSync(path.join(stagedDir, `runtime-x86_64.${sha(OLD_RUNTIME)}`), OLD_RUNTIME);
        const rescued = mirror({ pins, files });
        const result = await rescued.run({ stagedDir });
        expect(result.uploaded).toContain(`runtime-x86_64.${sha(OLD_RUNTIME)}`);
        expect(rescued.net.table.get(tools.mirrorUrl(pins, pins.runtime.x64))).toEqual(OLD_RUNTIME);
    });

    test('a file that fails its signature is not uploaded, and neither is anything else', async () => {
        const world = mirror();
        await expect(world.run({ verifySig: badSig })).rejects.toMatchObject({ code: 'SIGNATURE_INVALID' });
        expect(sent(world.github, 'POST')).toEqual([]);
        expect(sent(world.github, 'UPLOAD')).toEqual([]);
    });

    test('a dry run reports what it would do and writes nothing', async () => {
        const world = mirror();
        const lines = [];
        const result = await world.run({ dryRun: true, log: line => lines.push(line) });
        expect(result).toMatchObject({ created: true, dryRun: true });
        expect(result.uploaded).toHaveLength(4);
        expect(world.github.calls.every(call => call[0] === 'GET')).toBe(true);
        expect(lines.join('\n')).toMatch(/would create the release bootstrap-tools/);
    });

    test('the mirror release must not become the repository\'s latest release', async () => {
        const world = mirror({ latest: 'bootstrap-tools' });
        await expect(world.run()).rejects.toMatchObject({ code: 'MIRROR_IS_LATEST' });
    });
});

describe('the GitHub client', () => {
    function recorder(status = 200, body = { ok: true }) {
        const requests = [];
        const fetchImpl = async (url, init) => {
            requests.push({ url, ...init });
            return { ok: status >= 200 && status < 300, status, json: async () => body };
        };
        return { requests, fetchImpl };
    }

    test('reads and writes the REST API with the token, and uploads a file to the release\'s upload address', async () => {
        const { requests, fetchImpl } = recorder();
        const github = tools.createGithub({ fetchImpl, token: 'secret-token' });
        await github.getJson('/repos/goob/ster/releases/tags/bootstrap-tools');
        await github.postJson('/repos/goob/ster/releases', { tag_name: 'bootstrap-tools' });
        await github.patchJson('/repos/goob/ster/releases/9', { prerelease: true });
        const file = path.join(scratch('upload'), 'tool');
        fs.writeFileSync(file, HOST);
        await github.uploadAsset({ uploadUrl: 'https://uploads.github.com/repos/goob/ster/releases/9/assets{?name,label}', name: 'Host.exe.abc', file });
        expect(requests.map(request => [request.method, request.url])).toEqual([
            ['GET', 'https://api.github.com/repos/goob/ster/releases/tags/bootstrap-tools'],
            ['POST', 'https://api.github.com/repos/goob/ster/releases'],
            ['PATCH', 'https://api.github.com/repos/goob/ster/releases/9'],
            ['POST', 'https://uploads.github.com/repos/goob/ster/releases/9/assets?name=Host.exe.abc']
        ]);
        for (const request of requests) expect(request.headers.Authorization).toBe('Bearer secret-token');
        expect(JSON.parse(requests[1].body)).toEqual({ tag_name: 'bootstrap-tools' });
        expect(requests[1].headers['Content-Type']).toBe('application/json');
        expect(requests[3].headers['Content-Type']).toBe('application/octet-stream');
        expect(Buffer.from(requests[3].body)).toEqual(HOST);
    });

    test('works without a token for reads, and a failed call carries its status', async () => {
        const anonymous = recorder();
        await tools.createGithub({ fetchImpl: anonymous.fetchImpl, token: '' }).getJson('/repos/acme/tool/releases?per_page=100');
        expect(anonymous.requests[0].headers.Authorization).toBeUndefined();
        const missing = recorder(404);
        await expect(tools.createGithub({ fetchImpl: missing.fetchImpl, token: '' }).getJson('/repos/acme/tool/releases/tags/none')).rejects.toMatchObject({ status: 404 });
    });
});

describe('the command line', () => {
    test('knows three commands and refuses anything else', () => {
        expect(cli.parseArgs(['verify', '--require-mirror', '--stage', 'out'])).toEqual({ command: 'verify', requireMirror: true, stage: 'out' });
        expect(cli.parseArgs(['refresh', '--write', '--report', 'r.md'])).toEqual({ command: 'refresh', write: true, report: 'r.md' });
        expect(cli.parseArgs(['publish', '--dry-run', '--target', 'abc'])).toEqual({ command: 'publish', dryRun: true, target: 'abc' });
        expect(() => cli.parseArgs(['merge'])).toThrow(/unknown command/);
        expect(() => cli.parseArgs(['publish', '--write'])).toThrow(/unknown option/);
        expect(() => cli.parseArgs(['verify', '--stage'])).toThrow(/needs a value/);
        expect(() => cli.parseArgs([])).toThrow(/a command is required/);
    });

    function pinsOnDisk(pins = fixturePins()) {
        const dir = keysDir();
        const pinsFile = path.join(dir, 'bootstrap-pins.json');
        fs.writeFileSync(pinsFile, `${JSON.stringify(pins, null, 4)}\n`);
        return pinsFile;
    }

    test('refresh rewrites the pins file only with --write, and tells the workflow whether anything changed', async () => {
        // The CLI checks signatures with the real gpg, so this fixture has no signed tool.
        const pins = fixturePins();
        delete pins.runtime.upstream.signingKey;
        delete pins.runtime.x64.signature;
        const pinsFile = pinsOnDisk(pins);
        const before = fs.readFileSync(pinsFile, 'utf8');
        const outputFile = path.join(scratch('output'), 'github-output');
        const env = { GITHUB_OUTPUT: outputFile };
        const net = rebuiltNetwork(pins);
        const lines = [];
        const io = { env, out: line => lines.push(line), pinsFile, github: fakeGithub(rebuiltRoutes()), doDownload: net.doDownload };
        const reportFile = path.join(scratch('report'), 'report.md');
        expect(await cli.main(['refresh', '--report', reportFile], io)).toBe(0);
        expect(fs.readFileSync(pinsFile, 'utf8')).toBe(before);
        expect(fs.readFileSync(outputFile, 'utf8')).toMatch(/^changed=true\nsummary=runtime rebuilt at 2222222\n$/);
        expect(fs.readFileSync(reportFile, 'utf8')).toContain(sha(NEW_RUNTIME));
        const stage = scratch('cli-stage');
        expect(await cli.main(['refresh', '--write', '--stage', stage], io)).toBe(0);
        const after = JSON.parse(fs.readFileSync(pinsFile, 'utf8'));
        expect(after.runtime.x64.sha256).toBe(sha(NEW_RUNTIME));
        expect(after.runtime.upstream.commit).toBe(NEW_COMMIT);
        expect(fs.readdirSync(stage)).toEqual([`runtime-x86_64.${sha(NEW_RUNTIME)}`]);
    });

    test('verify exits 0 when every pin checks out and 1 when one does not', async () => {
        const pins = fixturePins();
        delete pins.runtime.upstream.signingKey;
        delete pins.runtime.x64.signature;
        const pinsFile = pinsOnDisk(pins);
        const lines = [];
        const io = { env: {}, out: line => lines.push(line), pinsFile, github: fakeGithub() };
        expect(await cli.main(['verify'], { ...io, doDownload: network(upstreamFiles(pins)).doDownload })).toBe(0);
        expect(lines.join('\n')).toMatch(/ok {3}host/);
        expect(await cli.main(['verify', '--require-mirror'], { ...io, doDownload: network(upstreamFiles(pins)).doDownload })).toBe(1);
        expect(lines.join('\n')).toMatch(/MIRROR_MISSING/);
    });
});

describe('the workflows', () => {
    const load = (name) => {
        const text = fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', name), 'utf8');
        const workflow = yaml.load(text);
        return { text, workflow, triggers: workflow.on || workflow[true] };
    };
    const toolsWorkflow = load('bootstrap-tools.yml');

    test('the tools workflow verifies on pull requests, and publishes and refreshes on main only', () => {
        const { workflow, triggers } = toolsWorkflow;
        expect(Object.keys(triggers).sort()).toEqual(['pull_request', 'push', 'schedule', 'workflow_dispatch']);
        expect(triggers.push.branches).toEqual(['main']);
        expect(triggers.pull_request.paths).toEqual(expect.arrayContaining(['scripts/bootstrap-pins.json', 'scripts/bootstrap-keys/**', 'scripts/lib/bootstrapTools.js']));
        expect(triggers.schedule).toHaveLength(1);
        expect(Object.keys(workflow.jobs)).toEqual(['verify', 'mirror', 'refresh']);
        expect(workflow.jobs.mirror.if).toMatch(/github\.event_name != 'pull_request'/);
        expect(workflow.jobs.mirror.if).toMatch(/github\.ref == 'refs\/heads\/main'/);
        expect(workflow.jobs.refresh.if).toMatch(/github\.ref == 'refs\/heads\/main'/);
        expect(workflow.concurrency['cancel-in-progress']).toBe(false);
    });

    test('the default token is read-only; only the mirror and refresh jobs can write, and verify cannot', () => {
        const { workflow } = toolsWorkflow;
        expect(workflow.permissions).toEqual({ contents: 'read' });
        expect(workflow.jobs.verify.permissions).toBeUndefined();
        expect(workflow.jobs.mirror.permissions).toEqual({ contents: 'write', actions: 'read' });
        expect(workflow.jobs.refresh.permissions).toEqual({ contents: 'write', 'pull-requests': 'write', actions: 'write' });
    });

    test('nothing in it merges a pull request, and only the mirror job publishes', () => {
        const { text, workflow } = toolsWorkflow;
        expect(text).not.toMatch(/pr merge|--auto|auto-merge|automerge|pulls\/[^\s]*\/merge|pr review/);
        const commands = (job) => workflow.jobs[job].steps.map(step => String(step.run || '')).join('\n');
        expect(commands('mirror')).toMatch(/bootstrap-tools\.js publish --target/);
        expect(commands('mirror')).toMatch(/bootstrap-tools\.js verify --require-mirror/);
        expect(commands('verify')).toMatch(/bootstrap-tools\.js publish --dry-run/);
        expect(commands('verify').replace(/publish --dry-run/g, '')).not.toMatch(/publish/);
        expect(commands('refresh')).not.toMatch(/bootstrap-tools\.js publish/);
        expect(commands('refresh')).toMatch(/bootstrap-tools\.js refresh --write/);
        expect(commands('refresh')).toMatch(/gh pr create/);
    });

    test('every script command it runs is one the command line knows', () => {
        const used = [...toolsWorkflow.text.matchAll(/node scripts\/bootstrap-tools\.js ([a-z-]+)/g)].map(match => match[1]);
        expect(used.length).toBeGreaterThan(0);
        for (const command of used) expect(() => cli.parseArgs([command])).not.toThrow();
        expect(fs.existsSync(path.join(REPO_ROOT, 'scripts', 'bootstrap-tools.js'))).toBe(true);
    });

    test.each(['linux-bootstrap.yml', 'windows-bootstrap.yml'])('%s also runs on a schedule and when the pins or the code that fetches them change', (name) => {
        const { triggers } = load(name);
        expect(triggers.schedule).toHaveLength(1);
        expect(triggers.schedule[0].cron).toMatch(/^\d+ \d+ \* \* \d$/);
        expect(triggers).toHaveProperty('workflow_dispatch');
        for (const event of ['pull_request', 'push']) {
            expect(triggers[event].paths).toEqual(expect.arrayContaining(['scripts/bootstrap-pins.json', 'scripts/lib/bootstrapTools.js']));
        }
    });
});
