/**
 * `update.check` and `update.policy` (#342, documentation/manager_update.md): what a check says
 * about a signed release index from each kind of source, that it writes only its own result
 * file, and the policy rules (off by default, `apply` only for a manager-owned installation).
 */
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');

const policy = require('@goobster/manager/update/policy');
const { drive, codeOf, snapshot } = require('./helpers/installFixture');
const { newKey, makePayload, publish, installBase, TARGET } = require('./helpers/updateFixture');
const { tempDir } = require('./helpers/installFixture');

const roots = [];
afterAll(() => {
    for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

async function world({ next = '2.5.0', publishOptions = {}, key = newKey(roots, 'trusted') } = {}) {
    const base = makePayload(tempDir(roots, 'base'), key, { core: '2.4.0' });
    const second = makePayload(tempDir(roots, 'next'), key, { core: next });
    const source = await publish(roots, key, second, publishOptions);
    const harness = await installBase({ roots, key, base, sourceDir: source.dir });
    return { key, base, second, source, harness };
}

const ledger = (harness, id) => Object.fromEntries(harness.manager.journal.read(id).record.progress.map(item => [item.name, item.status]));
const codeState = (harness) => ['current', 'previous', 'staging', 'releases'].map(name => snapshot(path.join(harness.code, name))).join('\n--\n');
const lastCheck = (harness) => JSON.parse(fs.readFileSync(path.join(harness.settings.storeDir, 'update', 'last-check.json'), 'utf8'));

describe('update.check', () => {
    test('says what a signed index offers and writes only last-check.json', async () => {
        const { harness, second } = await world();
        const before = codeState(harness);
        const record = harness.manager.store.readInstallation().doc;
        const { applied } = await drive(harness, 'update.check', {});
        expect(applied.operation.status).toBe('applied');
        expect(applied.result).toMatchObject({ outcome: 'available', latest: { version: '2.5.0', signed: true } });
        expect(ledger(harness, applied.operation.id)).toEqual({ 'fetch-index': 'done', 'verify-index': 'done', compare: 'done', record: 'done' });
        expect(codeState(harness)).toBe(before);
        expect(harness.manager.store.readInstallation().doc).toEqual(record);
        expect(lastCheck(harness)).toMatchObject({ outcome: 'available', latest: { version: '2.5.0' }, installed: { version: '2.4.0' } });
        expect(second.core).toBe('2.5.0');
        const files = fs.readdirSync(path.join(harness.settings.storeDir, 'update')).filter(name => !name.startsWith('tmp-'));
        expect(files).toEqual(['last-check.json']);
    });

    test('says up-to-date when the source offers the installed version', async () => {
        const { harness } = await world({ next: '2.4.0' });
        const { applied } = await drive(harness, 'update.check', {});
        expect(applied.result).toMatchObject({ outcome: 'up-to-date' });
    });

    test('records a refusal as blocked, with the index code, and never throws a path or address', async () => {
        const trusted = newKey(roots, 'trusted');
        const stranger = newKey(roots, 'stranger');
        const { harness } = await world({ key: trusted, publishOptions: { signWith: stranger } });
        const { applied } = await drive(harness, 'update.check', {});
        expect(applied.result).toMatchObject({ outcome: 'blocked', code: 'UNTRUSTED_KEY' });
        expect(lastCheck(harness)).toMatchObject({ outcome: 'blocked', code: 'UNTRUSTED_KEY' });
        const text = JSON.stringify([applied.operation, harness.manager.journal.read(applied.operation.id).record]);
        expect(text).not.toContain(harness.root);
        expect(text).not.toContain(path.dirname(harness.root));
    });

    test('refuses a downgrade and a prerelease on the stable channel', async () => {
        const older = await world({ next: '2.3.0' });
        expect((await drive(older.harness, 'update.check', {})).applied.result).toMatchObject({ outcome: 'blocked', code: 'DOWNGRADE' });

        const pre = await world({ next: '2.5.0-rc.1', publishOptions: { channel: 'prerelease' } });
        expect((await drive(pre.harness, 'update.check', {})).applied.result).toMatchObject({ outcome: 'blocked', code: 'CHANNEL_MISMATCH' });
        await drive(pre.harness, 'update.policy', { channel: 'prerelease' });
        expect((await drive(pre.harness, 'update.check', {})).applied.result).toMatchObject({ outcome: 'available', latest: { version: '2.5.0-rc.1', channel: 'prerelease' } });
    });

    test('a source with no index is a blocked check, not a crash', async () => {
        const { harness, source } = await world();
        for (const name of fs.readdirSync(source.dir)) fs.rmSync(path.join(source.dir, name));
        const { applied } = await drive(harness, 'update.check', {});
        expect(applied.result).toMatchObject({ outcome: 'blocked', code: 'SOURCE_UNREACHABLE' });
    });

    test('takes no input, so a caller cannot point it at a source of its choosing', async () => {
        const { harness } = await world();
        expect(await codeOf(drive(harness, 'update.check', { dir: '/tmp' }))).toBe('INVALID_INPUT');
    });
});

describe('the github-release source, over an injected fetch', () => {
    function githubFetch({ source, redirect = null, status = 200, calls = [] }) {
        const assets = fs.readdirSync(source.dir).map(name => ({ name, browser_download_url: `https://github.com/releases/download/v2.5.0/${name}` }));
        const respond = (url, body, ok = true, finalUrl = url) => ({
            ok,
            status: ok ? status : 404,
            url: finalUrl,
            body: Readable.toWeb(Readable.from([body])),
            json: async () => JSON.parse(body.toString())
        });
        const fetchImpl = async (url) => {
            calls.push(String(url));
            if (String(url).startsWith('https://api.github.com/repos/')) {
                return respond(url, Buffer.from(JSON.stringify([{ tag_name: 'v2.5.0', draft: false, prerelease: false, assets }])));
            }
            const name = decodeURIComponent(String(url).split('/').pop());
            return respond(url, fs.readFileSync(path.join(source.dir, name)), true, redirect || url);
        };
        return fetchImpl;
    }

    test('lists releases from the API, takes the index from the assets and never leaves GitHub', async () => {
        const calls = [];
        const trusted = newKey(roots, 'trusted');
        const base = makePayload(tempDir(roots, 'base'), trusted, { core: '2.4.0' });
        const second = makePayload(tempDir(roots, 'next'), trusted, { core: '2.5.0' });
        const source = await publish(roots, trusted, second);
        const harness = await installBase({ roots, key: trusted, base, updateDeps: { fetch: githubFetch({ source, calls }) } });
        await drive(harness, 'update.policy', { source: { kind: 'github-release', owner: 'nervous-rob', repo: 'goobster' } });
        const { applied } = await drive(harness, 'update.check', {});
        expect(applied.result).toMatchObject({ outcome: 'available', latest: { version: '2.5.0' } });
        expect(calls[0]).toMatch(/^https:\/\/api\.github\.com\/repos\/nervous-rob\/goobster\/releases/);
        expect(calls.slice(1).every(url => url.startsWith('https://github.com/'))).toBe(true);
    });

    test('refuses a redirect to another host', async () => {
        const trusted = newKey(roots, 'trusted');
        const base = makePayload(tempDir(roots, 'base'), trusted, { core: '2.4.0' });
        const second = makePayload(tempDir(roots, 'next'), trusted, { core: '2.5.0' });
        const source = await publish(roots, trusted, second);
        const harness = await installBase({ roots, key: trusted, base, updateDeps: { fetch: githubFetch({ source, redirect: 'https://evil.example.com/x' }) } });
        await drive(harness, 'update.policy', { source: { kind: 'github-release', owner: 'nervous-rob', repo: 'goobster' } });
        const { applied } = await drive(harness, 'update.check', {});
        expect(applied.result).toMatchObject({ outcome: 'blocked', code: 'SOURCE_REDIRECTED' });
        expect(JSON.stringify(applied.operation)).not.toContain('evil.example.com');
    });

    test('an unreachable source is a blocked check', async () => {
        const trusted = newKey(roots, 'trusted');
        const base = makePayload(tempDir(roots, 'base'), trusted, { core: '2.4.0' });
        const harness = await installBase({ roots, key: trusted, base, updateDeps: { fetch: async () => { throw new Error('ENOTFOUND api.github.com'); } } });
        const { applied } = await drive(harness, 'update.check', {});
        expect(applied.result).toMatchObject({ outcome: 'blocked', code: 'SOURCE_UNREACHABLE' });
        expect(JSON.stringify(applied.operation)).not.toContain('ENOTFOUND');
    });
});

describe('update.policy', () => {
    test('is off until somebody chooses, and normalises what is stored', async () => {
        const { harness } = await world();
        const doc = harness.manager.store.readInstallation().doc;
        expect(policy.current(doc)).toMatchObject({ mode: 'off', channel: 'stable' });
        const { applied } = await drive(harness, 'update.policy', { mode: 'apply', channel: 'stable', window: { days: [0], startHour: 3, endHour: 5, tz: 'UTC' } });
        expect(applied.result.policy).toMatchObject({ mode: 'apply', window: { startHour: 3, endHour: 5, tz: 'UTC' } });
        expect(harness.manager.store.readInstallation().doc.update).toMatchObject({ mode: 'apply' });
    });

    test('refuses an unknown mode, a bad window and an unknown key', async () => {
        const { harness } = await world();
        expect(await codeOf(drive(harness, 'update.policy', { mode: 'always' }))).toBe('INVALID_INPUT');
        expect(await codeOf(drive(harness, 'update.policy', { window: { days: [9], startHour: 30, endHour: 5, tz: 'UTC' } }))).toBe('INVALID_INPUT');
        expect(await codeOf(drive(harness, 'update.policy', { sudo: true }))).toBe('INVALID_INPUT');
    });

    test('the install question records the answer once; an install that was not asked stays off; a bad answer is refused', async () => {
        const key = newKey(roots, 'trusted');
        const base = makePayload(tempDir(roots, 'base'), key, { core: '2.4.0' });
        const asked = await installBase({ roots, key, base, answer: { mode: 'check' } });
        expect(asked.manager.store.readInstallation().doc.update).toEqual({ channel: 'stable', mode: 'check' });
        const prerelease = await installBase({ roots, key, base, answer: { mode: 'download', channel: 'prerelease' } });
        expect(prerelease.manager.store.readInstallation().doc.update).toMatchObject({ mode: 'download', channel: 'prerelease' });
        const silent = await installBase({ roots, key, base });
        expect(silent.manager.store.readInstallation().doc.update || null).toBeNull();
        expect(policy.current(silent.manager.store.readInstallation().doc).mode).toBe('off');
        for (const answer of [{ mode: 'always' }, { mode: 'check', source: { kind: 'directory', dir: '/tmp' } }, 'check']) {
            await expect(installBase({ roots, key, base, answer })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
        }
    });

    test('apply is honoured only while the manager is the updater', async () => {
        const { harness } = await world();
        const { planned } = await drive(harness, 'update.policy', { mode: 'apply' }, { apply: false });
        expect(planned.plan.effectiveMode).toBe('apply');
        const doc = harness.manager.store.readInstallation().doc;
        expect(policy.effectiveMode({ ...doc.update, mode: 'apply' }, { kind: 'auto-update.sh' })).toMatchObject({ mode: 'download', capped: true });
        expect(TARGET).toMatch(/-/);
    });
});
