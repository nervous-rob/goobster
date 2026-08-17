/**
 * Operator-approved sandbox requests (services/sandboxRequestService.js).
 *
 * The contract under test: the model only ever proposes; the service
 * legalizes (names, versions, hosts, budgets, quotas); only a configured
 * approver executes; and what executes is EXACTLY the stored, hash-pinned
 * resolution the approver saw. pip and the network are injected fakes -
 * the real end-to-end paths are exercised manually (and in CI the safeFetch
 * spec covers the transfer itself).
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

process.env.GOOBSTER_DB_PATH = path.join(os.tmpdir(), `goobster-sandbox-requests-test-${process.pid}.sqlite`);

const db = require('../db');
const store = require('../services/sandboxPackagesStore');
const { SandboxRequestService, PENDING_TTL_MINUTES } = require('../services/sandboxRequestService');

const REQUESTER = '111111111111111111';
const APPROVER = '222222222222222222';
const STRANGER = '333333333333333333';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-requests-test-'));

/** A pip fake that "resolves" requested specs plus one dependency. */
function fakePip(record = {}) {
    return async (args, timeoutMs) => {
        record.calls = record.calls || [];
        record.calls.push({ args, timeoutMs });
        const reportIdx = args.indexOf('--report');
        if (args.includes('--dry-run')) {
            const specs = args.slice(args.indexOf('--report') + 2).filter(a => !a.startsWith('-'));
            const install = specs.map(spec => {
                const [name, version] = spec.split('==');
                return {
                    metadata: { name, version: version || '9.9.9' },
                    download_info: {
                        url: `https://files.pythonhosted.org/packages/x/${name}.whl`,
                        archive_info: { hashes: { sha256: 'a'.repeat(64) } }
                    }
                };
            });
            install.push({
                metadata: { name: 'some-dep', version: '1.0.0' },
                download_info: {
                    url: 'https://files.pythonhosted.org/packages/x/some-dep.whl',
                    archive_info: { hash: `sha256=${'b'.repeat(64)}` }
                }
            });
            fs.writeFileSync(args[reportIdx + 1], JSON.stringify({ version: '1', install }));
            return { code: 0, stdout: '', stderr: '' };
        }
        record.installArgs = args;
        return { code: 0, stdout: '', stderr: '' };
    };
}

/** A Discord-client fake capturing every DM sent per user id. */
function fakeClient(dms = {}) {
    return {
        users: {
            fetch: async (id) => ({
                createDM: async () => ({
                    send: async (message) => {
                        (dms[id] = dms[id] || []).push(message);
                        return {};
                    }
                })
            })
        },
        _dms: dms
    };
}

function fakeInteraction(userId, client = fakeClient()) {
    const state = { followUps: [] };
    return {
        user: { id: userId },
        client,
        followUp: async (payload) => { state.followUps.push(payload); },
        _state: state
    };
}

/** An observatory fake exposing exactly the surface the service uses. */
function fakeObservatory(slug = 'jwst-atlas', { usedMb = 0, quotaMb = 256 } = {}) {
    const dir = path.join(tmpRoot, `proj-${slug}-${Math.random().toString(16).slice(2)}`);
    fs.mkdirSync(dir, { recursive: true });
    return {
        dir,
        config: { maxProjectMb: quotaMb },
        resolveProject: ({ project }) => {
            if (project !== slug) {
                const err = new Error(`No project called "${project}"`);
                err.status = 404;
                throw err;
            }
            return { id: 1, slug, name: slug, dir };
        },
        workspaceSizeMb: () => usedMb
    };
}

function makeService(overrides = {}, deps = {}) {
    const config = {
        enabled: true,
        pythonCommand: 'python3',
        approverUserIds: [APPROVER],
        fetchAllowedHosts: ['data.example.org'],
        maxFetchMb: 4,
        maxOverlayMb: 512,
        overlayDir: path.join(tmpRoot, 'overlay'),
        ...overrides
    };
    return new SandboxRequestService(config, deps);
}

/** The stored fetch/install fake: writes bytes so quota math is real. */
function fakeFetchToFile({ bytes = 1000, contentType = 'text/csv' } = {}) {
    return async ({ destPath }) => {
        fs.writeFileSync(destPath, Buffer.alloc(bytes));
        return { bytes, contentType };
    };
}

/** A DNS fake answering every name with one public address. */
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    try { fs.rmSync(process.env.GOOBSTER_DB_PATH, { force: true }); } catch { /* ignore */ }
});

beforeEach(() => {
    db.run('DELETE FROM sandbox_requests', {});
    db.run('DELETE FROM sandbox_packages', {});
});

describe('package request proposal', () => {
    test('a valid request resolves a pinned set, stores PENDING, and DMs the approvers', async () => {
        const record = {};
        const client = fakeClient();
        const svc = makeService({}, { runPip: fakePip(record) });

        const out = await svc.requestPackages({
            userId: REQUESTER, packages: ['emcee', 'corner==2.2.2'], reason: 'MCMC fits', client
        });

        expect(out).toContain('🟡');
        expect(out).toContain('emcee==9.9.9');
        expect(out).toContain('corner==2.2.2');
        expect(out).toContain('waiting for approval');
        // The dry run was wheels-only against pinned PyPI, and nothing installed
        expect(record.calls).toHaveLength(1);
        expect(record.calls[0].args).toEqual(expect.arrayContaining(['--dry-run', '--only-binary=:all:', '--isolated']));
        expect(record.installArgs).toBeUndefined();

        const row = db.get(`SELECT * FROM sandbox_requests WHERE type = 'package-install'`, {});
        expect(row.status).toBe('PENDING');
        const payload = JSON.parse(row.payload);
        expect(payload.resolved.map(p => p.name)).toEqual(['emcee', 'corner', 'some-dep']);
        expect(payload.resolved.every(p => /^[0-9a-f]{64}$/.test(p.sha256))).toBe(true);

        expect(client._dms[APPROVER]).toHaveLength(1);
        expect(client._dms[APPROVER][0].components).toHaveLength(1);
    });

    test('bad specs are refused before pip ever runs', async () => {
        const record = {};
        const svc = makeService({}, { runPip: fakePip(record) });
        for (const bad of ['--index-url=evil', 'name; rm -rf /', 'git+https://x/y.git', '../etc', 'a==', 'pkg==1.0 --hash=x']) {
            await expect(svc.requestPackages({ userId: REQUESTER, packages: [bad] }))
                .rejects.toMatchObject({ code: 'BAD_SPEC' });
        }
        await expect(svc.requestPackages({ userId: REQUESTER, packages: [] }))
            .rejects.toMatchObject({ code: 'NO_PACKAGES' });
        await expect(svc.requestPackages({
            userId: REQUESTER,
            packages: Array.from({ length: 9 }, (_, i) => `pkg${i}`)
        })).rejects.toMatchObject({ code: 'TOO_MANY_PACKAGES' });
        expect(record.calls).toBeUndefined();
    });

    test('packages already in the catalog or overlay are not re-requested', async () => {
        store.record({ pip: 'emcee', module: 'emcee', version: '3.1.6', requirement: 'emcee==3.1.6 --hash=sha256:x' });
        const svc = makeService({}, { runPip: fakePip() });
        const out = await svc.requestPackages({ userId: REQUESTER, packages: ['numpy', 'emcee'] });
        expect(out).toContain('✅ Nothing to request');
    });

    test('with no approvers configured, requests are refused with the honest reason', async () => {
        const svc = makeService({ approverUserIds: [] }, { runPip: fakePip() });
        const out = await svc.requestPackages({ userId: REQUESTER, packages: ['emcee'] });
        expect(out).toContain('❌');
        expect(out).toContain('approverUserIds');
        expect(db.get('SELECT COUNT(*) AS c FROM sandbox_requests', {}).c).toBe(0);
    });

    test('a set that would blow the overlay budget is refused up front', async () => {
        const svc = makeService({ maxOverlayMb: 16 }, { runPip: fakePip() });
        jest.spyOn(svc, '_attachWheelSizes').mockImplementation(async (resolved) => {
            for (const pkg of resolved) pkg.sizeBytes = 20 * 1024 * 1024;
        });
        const out = await svc.requestPackages({ userId: REQUESTER, packages: ['emcee'] });
        expect(out).toContain('❌');
        expect(out).toContain('budget');
    });

    test('a failed pip resolution surfaces as a clean refusal', async () => {
        const svc = makeService({}, {
            runPip: async () => ({ code: 1, stdout: '', stderr: 'ERROR: No matching distribution found for nope-xyz' })
        });
        await expect(svc.requestPackages({ userId: REQUESTER, packages: ['nope-xyz'] }))
            .rejects.toMatchObject({ code: 'RESOLVE_FAILED' });
    });
});

describe('approval buttons', () => {
    async function proposePackages(svc, client) {
        await svc.requestPackages({ userId: REQUESTER, packages: ['emcee:emcee'], reason: 'x', client });
        return db.get(`SELECT id FROM sandbox_requests WHERE status = 'PENDING'`, {}).id;
    }

    test('only configured approvers may resolve; others leave the buttons up', async () => {
        const svc = makeService({}, { runPip: fakePip() });
        const id = await proposePackages(svc, fakeClient());
        const interaction = fakeInteraction(STRANGER);
        const edit = await svc.handleButton('approve', id, interaction);
        expect(edit).toBeNull();
        expect(interaction._state.followUps[0].content).toContain('Only a configured sandbox approver');
        expect(db.get('SELECT status FROM sandbox_requests WHERE id = @id', { id }).status).toBe('PENDING');
    });

    test('the requester being an approver-wannabe changes nothing (not their call)', async () => {
        const svc = makeService({}, { runPip: fakePip() });
        const id = await proposePackages(svc, fakeClient());
        const edit = await svc.handleButton('approve', id, fakeInteraction(REQUESTER));
        expect(edit).toBeNull();
    });

    test('deny resolves the row and tells the requester', async () => {
        const svc = makeService({}, { runPip: fakePip() });
        const id = await proposePackages(svc, fakeClient());
        const client = fakeClient();
        const edit = await svc.handleButton('deny', id, fakeInteraction(APPROVER, client));
        expect(edit.content).toContain('🚫 Denied');
        expect(db.get('SELECT status, resolvedBy FROM sandbox_requests WHERE id = @id', { id }))
            .toEqual({ status: 'DENIED', resolvedBy: APPROVER });
        expect(client._dms[REQUESTER][0]).toContain('denied');
    });

    test('approve installs EXACTLY the stored resolution: hashes required, deps forbidden', async () => {
        const record = {};
        const svc = makeService({}, { runPip: fakePip(record) });
        const sandboxService = require('../services/sandboxService');
        const refresh = jest.spyOn(sandboxService, 'refreshPythonModules').mockReturnValue([]);

        const id = await proposePackages(svc, fakeClient());
        const client = fakeClient();
        const edit = await svc.handleButton('approve', id, fakeInteraction(APPROVER, client));

        expect(edit.content).toContain('✅ Approved');
        expect(record.installArgs).toEqual(expect.arrayContaining([
            '--require-hashes', '--no-deps', '--only-binary=:all:', '--isolated',
            '--target', svc.config.overlayDir
        ]));
        // No bare package names in the install argv - only the pinned file
        expect(record.installArgs).toContain('-r');
        expect(record.installArgs).not.toContain('emcee');

        expect(db.get('SELECT status FROM sandbox_requests WHERE id = @id', { id }).status).toBe('COMPLETED');
        const rows = store.list();
        expect(rows.map(r => r.pip).sort()).toEqual(['emcee', 'some-dep']);
        expect(rows.find(r => r.pip === 'emcee')).toMatchObject({
            module: 'emcee', approvedBy: APPROVER, requestedBy: REQUESTER
        });
        expect(rows.find(r => r.pip === 'some-dep').module).toBeNull();
        expect(rows.every(r => r.requirement.includes('--hash=sha256:'))).toBe(true);
        expect(refresh).toHaveBeenCalled();
        expect(client._dms[REQUESTER][0]).toContain('✅ Approved');
        refresh.mockRestore();
    });

    test('a failed install keeps the request pending for a retry', async () => {
        let firstInstall = true;
        const record = {};
        const pip = fakePip(record);
        const svc = makeService({}, {
            runPip: async (args, timeoutMs) => {
                if (!args.includes('--dry-run') && firstInstall) {
                    firstInstall = false;
                    return { code: 1, stdout: '', stderr: 'network unreachable' };
                }
                return pip(args, timeoutMs);
            }
        });
        const id = await proposePackages(svc, fakeClient());
        const interaction = fakeInteraction(APPROVER);
        const edit = await svc.handleButton('approve', id, interaction);
        expect(edit).toBeNull();
        expect(interaction._state.followUps[0].content).toContain('Still pending');
        expect(db.get('SELECT status FROM sandbox_requests WHERE id = @id', { id }).status).toBe('PENDING');
    });

    test('expired requests resolve to EXPIRED on touch', async () => {
        const svc = makeService({}, { runPip: fakePip() });
        const id = await proposePackages(svc, fakeClient());
        db.run(
            `UPDATE sandbox_requests SET createdAt = datetime('now', '-${PENDING_TTL_MINUTES + 1} minutes') WHERE id = @id`,
            { id }
        );
        const edit = await svc.handleButton('approve', id, fakeInteraction(APPROVER));
        expect(edit.content).toContain('no longer pending');
        expect(db.get('SELECT status FROM sandbox_requests WHERE id = @id', { id }).status).toBe('EXPIRED');
    });
});

describe('data fetches', () => {
    test('an allowlisted host fetches immediately into the workspace data/ dir', async () => {
        const observatory = fakeObservatory();
        const svc = makeService({}, { observatory, lookup: publicLookup, fetchToFile: fakeFetchToFile({ bytes: 2048 }) });

        const out = await svc.requestFetch({
            userId: REQUESTER, project: 'jwst-atlas',
            url: 'https://data.example.org/catalogs/jades.csv'
        });

        expect(out).toContain('✅ Fetched');
        expect(out).toContain('$GOOBSTER_PROJECT_DIR/data/jades.csv');
        expect(fs.existsSync(path.join(observatory.dir, 'data', 'jades.csv'))).toBe(true);
        const row = db.get(`SELECT * FROM sandbox_requests WHERE type = 'data-fetch'`, {});
        expect(row.status).toBe('COMPLETED');
        expect(row.resolvedBy).toBe('allowlist');
    });

    test('an off-list host becomes a pending request and DMs approvers', async () => {
        const observatory = fakeObservatory();
        const client = fakeClient();
        const svc = makeService({}, { observatory, lookup: publicLookup, fetchToFile: fakeFetchToFile() });

        const out = await svc.requestFetch({
            userId: REQUESTER, project: 'jwst-atlas',
            url: 'https://unknown-host.example/file.fits', reason: 'NIRCam cutout', client
        });

        expect(out).toContain('🟡 Proposed fetch');
        expect(out).toContain('waiting for approval');
        expect(client._dms[APPROVER]).toHaveLength(1);
        expect(fs.readdirSync(observatory.dir)).toEqual([]); // nothing fetched yet

        // Approval executes it (fresh DNS pin is faked away by fetchToFile)
        const id = db.get(`SELECT id FROM sandbox_requests WHERE status = 'PENDING'`, {}).id;
        const edit = await svc.handleButton('approve', id, fakeInteraction(APPROVER, fakeClient()));
        expect(edit.content).toContain('✅ Approved');
        expect(fs.existsSync(path.join(observatory.dir, 'data', 'file.fits'))).toBe(true);
    });

    test('off-list with no approvers is refused with the honest reason', async () => {
        const svc = makeService({ approverUserIds: [] }, { observatory: fakeObservatory(), lookup: publicLookup, fetchToFile: fakeFetchToFile() });
        const out = await svc.requestFetch({
            userId: REQUESTER, project: 'jwst-atlas', url: 'https://unknown.example/x.csv'
        });
        expect(out).toContain('❌');
        expect(out).toContain('fetchAllowedHosts');
    });

    test('URL legalization happens before anything else', async () => {
        const svc = makeService({}, { observatory: fakeObservatory(), lookup: publicLookup, fetchToFile: fakeFetchToFile() });
        await expect(svc.requestFetch({ userId: REQUESTER, project: 'jwst-atlas', url: 'http://data.example.org/x' }))
            .rejects.toMatchObject({ code: 'HTTPS_ONLY' });
        await expect(svc.requestFetch({ userId: REQUESTER, project: 'jwst-atlas', url: 'https://169.254.169.254/meta' }))
            .rejects.toMatchObject({ code: 'ADDRESS_FORBIDDEN' });
    });

    test('filenames are flattened to safe basenames inside data/', async () => {
        const observatory = fakeObservatory();
        const svc = makeService({}, { observatory, lookup: publicLookup, fetchToFile: fakeFetchToFile() });
        const out = await svc.requestFetch({
            userId: REQUESTER, project: 'jwst-atlas',
            url: 'https://data.example.org/x.csv', saveAs: '../../../etc/passwd'
        });
        // Path components are stripped: only the basename lands, inside data/
        expect(out).toContain('data/passwd');
        expect(fs.existsSync(path.join(observatory.dir, 'data', 'passwd'))).toBe(true);
        expect(fs.readdirSync(observatory.dir).sort()).toEqual(['data']);
    });

    test('an existing file is never overwritten', async () => {
        const observatory = fakeObservatory();
        fs.mkdirSync(path.join(observatory.dir, 'data'), { recursive: true });
        fs.writeFileSync(path.join(observatory.dir, 'data', 'x.csv'), 'old');
        const svc = makeService({}, { observatory, lookup: publicLookup, fetchToFile: fakeFetchToFile() });
        await expect(svc.requestFetch({
            userId: REQUESTER, project: 'jwst-atlas', url: 'https://data.example.org/x.csv'
        })).rejects.toMatchObject({ code: 'FILE_EXISTS' });
        expect(fs.readFileSync(path.join(observatory.dir, 'data', 'x.csv'), 'utf8')).toBe('old');
    });

    test('a workspace at quota refuses the fetch before any bytes move', async () => {
        const observatory = fakeObservatory('jwst-atlas', { usedMb: 256, quotaMb: 256 });
        const svc = makeService({}, { observatory, lookup: publicLookup, fetchToFile: fakeFetchToFile() });
        await expect(svc.requestFetch({
            userId: REQUESTER, project: 'jwst-atlas', url: 'https://data.example.org/x.csv'
        })).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    });
});

describe('rate limits and privacy', () => {
    test('per-user request rate is capped', async () => {
        const svc = makeService({}, { observatory: fakeObservatory(), lookup: publicLookup, fetchToFile: fakeFetchToFile() });
        for (let i = 0; i < 10; i++) {
            await svc.requestFetch({
                userId: REQUESTER, project: 'jwst-atlas',
                url: `https://data.example.org/f${i}.csv`
            });
        }
        await expect(svc.requestFetch({
            userId: REQUESTER, project: 'jwst-atlas', url: 'https://data.example.org/f11.csv'
        })).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    });

    test('pending requests per user are capped', async () => {
        const svc = makeService({}, { runPip: fakePip() });
        for (let i = 0; i < 5; i++) {
            await svc.requestPackages({ userId: REQUESTER, packages: [`pkg${i}`] });
        }
        await expect(svc.requestPackages({ userId: REQUESTER, packages: ['pkg-final'] }))
            .rejects.toMatchObject({ code: 'TOO_MANY_PENDING' });
    });

    test('forgetUser deletes request rows and anonymizes package attribution', async () => {
        const record = {};
        const svc = makeService({}, { runPip: fakePip(record) });
        await svc.requestPackages({ userId: REQUESTER, packages: ['emcee'] });
        const id = db.get(`SELECT id FROM sandbox_requests`, {}).id;
        await svc.handleButton('approve', id, fakeInteraction(APPROVER));

        const result = svc.forgetUser(REQUESTER);
        expect(result.requests).toBe(1);
        expect(result.packagesAnonymized).toBeGreaterThan(0);
        expect(db.get('SELECT COUNT(*) AS c FROM sandbox_requests WHERE userId = @u', { u: REQUESTER }).c).toBe(0);
        expect(store.list().every(row => row.requestedBy !== REQUESTER)).toBe(true);
        // The packages themselves survive - shared host state
        expect(store.has('emcee')).toBe(true);
    });
});
