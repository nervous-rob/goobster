/**
 * The elevated half of the Windows service (apps/manager/privileged/win32.js):
 * the closed protocol rules for Windows paths, the helper that registers and
 * removes the service with `sc.exe` and `icacls.exe`, and the manager's half
 * (elevation choice, the UAC file transport, a dismissed prompt). This is a
 * Linux machine: a fake Windows (an in-memory file system, a service control
 * manager and fixed programs) stands in for the real one; the
 * `windows-bootstrap` workflow runs the same code on windows-2022
 * (documentation/windows_install.md, "What CI proves").
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const protocol = require('@goobster/manager/privileged/protocol');
const helper = require('@goobster/manager/privileged/helper');
const elevate = require('@goobster/manager/privileged/elevate');
const privileged = require('@goobster/manager/privileged');
const win32 = require('@goobster/manager/privileged/win32');
const xml = require('@goobster/manager/platform/windowsServiceXml');

const ID = '5f3c0e0e-3e8e-4a52-9d57-0e4a5f6f8a11';
const OTHER_ID = '0b9a7c6d-1111-4222-8333-444455556666';
const SYSTEM32 = 'C:\\Windows\\System32';
const HOST_BYTES = Buffer.from('MZ pretend WinSW host');
const HOST_PIN = { ...xml.WINSW, sha256: crypto.createHash('sha256').update(HOST_BYTES).digest('hex') };
const STAGE_HOST = 'C:\\Stage\\service-host\\goobster-service.exe';

const roots = (base = 'C:\\Goobster') => ({
    code: `${base}\\code`,
    data: `${base}\\data`,
    config: `${base}\\config\\config.json`,
    cache: `${base}\\cache`,
    logs: `${base}\\logs`,
    uploads: `${base}\\data\\web-uploads`,
    managerStore: `${base}\\data\\manager`
});

const registerInput = (over = {}) => ({
    kind: 'windows-service',
    name: 'goobster',
    layout: 'lite',
    codeRoot: 'C:\\Goobster\\code',
    runtimeUser: 'goobster',
    installationId: ID,
    roots: roots(),
    mode: 'payload',
    ...over
});

const unregisterInput = (over = {}) => ({ kind: 'windows-service', name: 'goobster', registeredBy: 'installer', installationId: ID, ...over });

const key = (file) => String(file).toLowerCase();

/** An in-memory Windows: a file system, the service control manager, and the four fixed programs. */
function fakeWindows({ elevated = true, service = null, stopTicks = 2, stubbornStop = false } = {}) {
    const files = new Map();
    const dirs = new Set();
    const calls = [];
    const state = { service, ticks: 0 };

    const enoent = (file) => Object.assign(new Error(`ENOENT ${file}`), { code: 'ENOENT' });
    const fakeFs = {
        readFileSync(file, enc) {
            const data = files.get(key(file));
            if (data === undefined) throw enoent(file);
            return enc ? data.toString(enc) : Buffer.from(data);
        },
        existsSync: (file) => files.has(key(file)) || dirs.has(key(file)),
        writeFileSync(file, data) { files.set(key(file), Buffer.from(data)); },
        renameSync(from, to) {
            files.set(key(to), files.get(key(from)));
            files.delete(key(from));
        },
        mkdirSync(dir) { dirs.add(key(dir)); },
        rmSync(file) { files.delete(key(file)); },
        rmdirSync(dir) {
            if ([...files.keys()].some(item => item.startsWith(`${key(dir)}\\`))) throw Object.assign(new Error('ENOTEMPTY'), { code: 'ENOTEMPTY' });
            dirs.delete(key(dir));
        }
    };

    const advance = () => {
        const svc = state.service;
        if (!svc) return;
        if (svc.state === 'stop-pending' && !stubbornStop) {
            state.ticks -= 1;
            if (state.ticks <= 0) svc.state = 'stopped';
        } else if (svc.state === 'start-pending') {
            svc.state = 'running';
        }
    };
    const numeric = { stopped: 1, 'start-pending': 2, 'stop-pending': 3, running: 4 };

    const exec = (file, args) => {
        const name = path.win32.basename(file).toLowerCase();
        calls.push({ name, args: [...args], file });
        if (name === 'whoami.exe') {
            if (args[0] === '/groups') return { status: 0, stdout: elevated ? 'Mandatory Label\\High Mandatory Level   Label   S-1-16-12288\r\n' : 'Mandatory Label\\Medium Mandatory Level   Label   S-1-16-8192\r\n', stderr: '' };
            return { status: 0, stdout: '"PC\\alice","S-1-5-21-111-222-333-1001"\r\n', stderr: '' };
        }
        if (name === 'powershell.exe') {
            const script = Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
            expect(script).toBe(win32.IMAGE_PATH_SCRIPT);
            const text = state.service ? Buffer.from(state.service.imagePath, 'utf8').toString('base64') : 'ABSENT';
            return { status: 0, stdout: text, stderr: '' };
        }
        if (name === 'icacls.exe') return { status: 0, stdout: 'Successfully processed 1 files; Failed processing 0 files', stderr: '' };
        if (name === 'sc.exe') {
            const [verb, svcName] = args;
            if (verb === 'query' && svcName === 'state=') return { status: 0, stdout: 'SERVICE_NAME: x', stderr: '' };
            if (verb === 'create') {
                if (state.service) return { status: 1073, stdout: '[SC] CreateService FAILED 1073:', stderr: '' };
                const bin = args[args.indexOf('binPath=') + 1];
                state.service = { imagePath: bin, state: 'stopped', config: {} };
                return { status: 0, stdout: '[SC] CreateService SUCCESS', stderr: '' };
            }
            if (!state.service) return { status: 1060, stdout: `[SC] OpenService FAILED 1060:`, stderr: '' };
            if (verb === 'query') {
                advance();
                return { status: 0, stdout: `SERVICE_NAME: goobster\r\n        STATE              : ${numeric[state.service.state]}  ${state.service.state.toUpperCase()}\r\n`, stderr: '' };
            }
            if (verb === 'stop') {
                if (state.service.state === 'running') {
                    state.service.state = 'stop-pending';
                    state.ticks = stopTicks;
                }
                return { status: 0, stdout: '', stderr: '' };
            }
            if (verb === 'start') {
                state.service.state = 'start-pending';
                return { status: 0, stdout: '', stderr: '' };
            }
            if (verb === 'delete') {
                state.service = null;
                return { status: 0, stdout: '[SC] DeleteService SUCCESS', stderr: '' };
            }
            if (verb === 'config') {
                const bin = args[args.indexOf('binPath=') + 1];
                if (bin) state.service.imagePath = bin;
                return { status: 0, stdout: '', stderr: '' };
            }
            return { status: 0, stdout: '', stderr: '' };
        }
        return { status: 127, stdout: '', stderr: 'unknown program' };
    };

    const world = {
        files,
        dirs,
        calls,
        state,
        fs: fakeFs,
        exec,
        sc: (verb) => calls.filter(call => call.name === 'sc.exe' && call.args[0] === verb),
        icacls: () => calls.filter(call => call.name === 'icacls.exe'),
        put(file, text) { files.set(key(file), Buffer.from(text)); },
        text: (file) => (files.has(key(file)) ? files.get(key(file)).toString('utf8') : null),
        installation({ id = ID, installationRoots = roots(), layout = 'lite', payload = true } = {}) {
            world.put(`${installationRoots.managerStore}\\installation.json`, JSON.stringify({ installationId: id, roots: installationRoots }));
            if (payload) {
                const current = `${installationRoots.code}\\current`;
                for (const rel of ['payload-manifest.json', 'runtime\\node.exe', 'app\\apps\\manager\\index.js']) world.put(`${current}\\${rel}`, 'x');
            }
            void layout;
        },
        stageHost(bytes = HOST_BYTES) { world.put(STAGE_HOST, bytes); },
        deps(over = {}) {
            return { fs: fakeFs, exec, sleep: () => {}, systemRoot: 'C:\\Windows', payloadRoot: 'C:\\Stage\\payload', pin: HOST_PIN, waits: { stop: 10_000, start: 10_000, remove: 5_000 }, ...over };
        }
    };
    return world;
}

function ready(options) {
    const world = fakeWindows(options);
    world.installation();
    world.stageHost();
    return world;
}

const handle = (world, operation, input, over) => helper.execute(protocol.buildRequest(operation, input), { platform: 'win32', deps: world.deps(over) });

describe('the Windows path rules of the protocol', () => {
    const accepted = ['C:\\Goobster\\code', 'D:\\Apps\\Goobster Tést\\data', 'C:\\ProgramData\\Goobster\\data', 'C:\\Users\\alice\\AppData\\Local\\Goobster\\code'];
    const refused = [
        ['C:\\', 'INVALID_PATH'],
        ['C:', 'INVALID_PATH'],
        ['C:\\Windows\\Goobster', 'PATH_NOT_ALLOWED'],
        ['C:\\Windows', 'PATH_NOT_ALLOWED'],
        ['c:\\PROGRAM FILES\\Goobster', 'PATH_NOT_ALLOWED'],
        ['C:\\Program Files (x86)\\Goobster\\x', 'PATH_NOT_ALLOWED'],
        ['C:\\System Volume Information\\x\\y', 'PATH_NOT_ALLOWED'],
        ['C:\\Users', 'PATH_NOT_ALLOWED'],
        ['C:\\Users\\alice', 'PATH_NOT_ALLOWED'],
        ['C:\\ProgramData', 'PATH_NOT_ALLOWED'],
        ['C:\\Goobster', 'PATH_NOT_ALLOWED'],
        ['\\\\server\\share\\goobster', 'INVALID_PATH'],
        ['\\\\?\\C:\\Goobster\\code', 'INVALID_PATH'],
        ['C:\\Goobster\\..\\Windows\\x', 'INVALID_PATH'],
        ['C:\\Goobster\\code\\', 'INVALID_PATH'],
        ['C:/Goobster/code', 'INVALID_PATH'],
        ['C:\\Goobster\\a<b', 'INVALID_PATH'],
        ['C:\\Goobster\\a"b', 'INVALID_PATH'],
        ['C:\\Goobster\\a|b', 'INVALID_PATH'],
        ['C:\\Goobster\\a?b', 'INVALID_PATH'],
        ['C:\\Goobster\\a*b', 'INVALID_PATH'],
        ['C:\\Goobster\\%APPDATA%', 'INVALID_PATH'],
        ['C:\\Goobster\\a\u0001', 'INVALID_PATH'],
        ['C:\\Goobster\\a:stream', 'INVALID_PATH'],
        ['C:\\Goobster\\con', 'INVALID_PATH'],
        ['C:\\Goobster\\nul.txt', 'INVALID_PATH'],
        ['C:\\Goobster\\trailing.', 'INVALID_PATH'],
        ['C:\\Goobster\\trailing ', 'INVALID_PATH'],
        ['relative\\path', 'INVALID_PATH'],
        [`C:\\${'a'.repeat(210)}\\b`, 'INVALID_PATH'],
        [42, 'INVALID_PATH']
    ];

    test('accepts ordinary drive paths, spaces and non-ASCII letters included', () => {
        for (const value of accepted) expect(protocol.windowsRoot(value, 'The root')).toBe(value);
    });

    test.each(refused)('refuses %j with %s', (value, code) => {
        expect(() => protocol.windowsRoot(value, 'The root')).toThrow(expect.objectContaining({ code }));
    });

    test('service.register for the windows-service kind uses them for every root, the code root and the node path', () => {
        const parsed = protocol.validateInput('service.register', registerInput());
        expect(parsed).toMatchObject({ kind: 'windows-service', scope: 'machine', codeRoot: 'C:\\Goobster\\code' });
        expect(() => protocol.validateInput('service.register', registerInput({ codeRoot: 'C:\\Windows\\code', roots: { ...roots(), code: 'C:\\Windows\\code' } }))).toThrow(expect.objectContaining({ code: 'PATH_NOT_ALLOWED' }));
        expect(() => protocol.validateInput('service.register', registerInput({ roots: { ...roots(), logs: 'C:\\Program Files\\x\\logs' } }))).toThrow(expect.objectContaining({ code: 'PATH_NOT_ALLOWED' }));
        expect(() => protocol.validateInput('service.register', registerInput({ nodePath: '\\\\evil\\share\\node.exe' }))).toThrow(expect.objectContaining({ code: 'INVALID_PATH' }));
    });

    test('a POSIX path is refused for the windows-service kind, a drive path for the systemd kind', () => {
        const posix = { code: '/opt/g', data: '/var/lib/g', config: '/etc/g/config.json', cache: '/var/cache/g', logs: '/var/log/g', uploads: '/var/lib/g/up', managerStore: '/var/lib/g/manager' };
        expect(() => protocol.validateInput('service.register', registerInput({ codeRoot: '/opt/g', roots: posix }))).toThrow(expect.objectContaining({ code: 'INVALID_PATH' }));
        expect(() => protocol.validateInput('service.register', registerInput({ kind: 'systemd', runtimeUser: 'goobster' }))).toThrow(expect.objectContaining({ code: 'INVALID_PATH' }));
    });

    test('the Windows service is named goobster and runs as the virtual account goobster, nothing else', () => {
        expect(() => protocol.validateInput('service.register', registerInput({ runtimeUser: 'alice' }))).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
        expect(() => protocol.validateInput('service.register', registerInput({ name: 'other' }))).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
        expect(protocol.validateInput('service.unregister', unregisterInput())).toMatchObject({ kind: 'windows-service' });
    });
});

describe('service.register', () => {
    test('registers on a clean machine with sc.exe and icacls.exe, in a safe order, and starts it', () => {
        const world = ready();
        const { reply, code } = handle(world, 'service.register', registerInput());
        expect(code).toBe(0);
        expect(reply).toMatchObject({ ok: true, outcome: 'done', detail: { service: 'goobster', written: true, active: 'running' } });

        const dir = 'C:\\Goobster\\data\\manager\\service';
        expect(world.text(`${dir}\\goobster-service.xml`)).toBe(xml.renderXml({ installationId: ID, codeRoot: 'C:\\Goobster\\code', roots: roots(), layout: 'lite' }));
        expect(world.files.get(key(`${dir}\\goobster-service.exe`)).equals(HOST_BYTES)).toBe(true);

        expect(world.sc('create')).toHaveLength(1);
        expect(world.sc('create')[0].args).toEqual(['create', 'goobster', 'binPath=', `"${dir}\\goobster-service.exe"`, 'DisplayName=', 'Goobster', 'start=', 'auto', 'obj=', 'NT SERVICE\\goobster']);
        expect(world.sc('failure')[0].args).toEqual(['failure', 'goobster', 'reset=', '86400', 'actions=', 'restart/10000/restart/10000/restart/10000']);
        expect(world.sc('start')).toHaveLength(1);
        expect(world.sc('sidtype')[0].args).toEqual(['sidtype', 'goobster', 'unrestricted']);

        const order = world.calls.map(call => `${call.name}:${call.args[0]}`);
        expect(order.indexOf('icacls.exe:C:\\Goobster\\data\\manager\\service')).toBeLessThan(order.indexOf('sc.exe:create'));
        expect(order.lastIndexOf('sc.exe:start')).toBeGreaterThan(order.indexOf('sc.exe:create'));
    });

    test('every program is a fixed one from System32; nothing opens a firewall port or runs a shell', () => {
        const world = ready();
        handle(world, 'service.register', registerInput());
        for (const call of world.calls) {
            const allowed = [`${SYSTEM32}\\sc.exe`, `${SYSTEM32}\\icacls.exe`, `${SYSTEM32}\\whoami.exe`, `${SYSTEM32}\\WindowsPowerShell\\v1.0\\powershell.exe`];
            expect(allowed).toContain(call.file);
            expect(call.args.join(' ')).not.toMatch(/netsh|advfirewall|cmd\.exe|firewall/i);
        }
        const powershell = world.calls.filter(call => call.name === 'powershell.exe');
        expect(powershell.length).toBeGreaterThan(0);
        for (const call of powershell) expect(call.args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand']);
    });

    test('access: modify on the mutable roots, read and execute on the code root, the service folder locked to administrators, nothing outside the request', () => {
        const world = ready();
        handle(world, 'service.register', registerInput());
        const grants = world.icacls().filter(call => call.args[1] === '/grant');
        const byTarget = Object.fromEntries(grants.map(call => [call.args[0], call.args[2]]));
        expect(byTarget).toEqual({
            'C:\\Goobster\\data\\manager\\service': 'NT SERVICE\\goobster:(OI)(CI)RX',
            'C:\\Goobster\\code': 'NT SERVICE\\goobster:(OI)(CI)RX',
            'C:\\Goobster\\data': 'NT SERVICE\\goobster:(OI)(CI)M',
            'C:\\Goobster\\logs': 'NT SERVICE\\goobster:(OI)(CI)M',
            'C:\\Goobster\\cache': 'NT SERVICE\\goobster:(OI)(CI)M',
            'C:\\Goobster\\config': 'NT SERVICE\\goobster:(OI)(CI)M'
        });
        const lock = world.icacls().find(call => call.args.includes('/inheritance:r'));
        expect(lock.args).toEqual(['C:\\Goobster\\data\\manager\\service', '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F', '*S-1-5-32-545:(OI)(CI)RX']);
        const inside = Object.values(roots());
        for (const target of Object.keys(byTarget)) expect(inside.some(root => target === root || root.startsWith(`${target}\\`) || target.startsWith(`${root}\\`))).toBe(true);
    });

    test('the helper never executes the service host: only the service manager does, later', () => {
        const world = ready();
        handle(world, 'service.register', registerInput());
        expect(world.calls.some(call => call.name === 'goobster-service.exe' || call.file.endsWith('goobster-service.exe'))).toBe(false);
        expect(world.calls.some(call => call.args.includes('install'))).toBe(false);
    });

    test('a second registration of the same installation changes nothing', () => {
        const world = ready();
        handle(world, 'service.register', registerInput());
        const before = world.calls.length;
        const { reply } = handle(world, 'service.register', registerInput());
        expect(reply).toMatchObject({ ok: true, outcome: 'noop', detail: { written: false, active: 'running' } });
        const added = world.calls.slice(before);
        expect(added.some(call => call.name === 'sc.exe' && ['create', 'stop', 'start', 'config', 'delete'].includes(call.args[0]))).toBe(false);
        expect(added.some(call => call.name === 'icacls.exe')).toBe(false);
    });

    test('a changed definition on a running service stops it, rewrites the folder and starts it again, without a second create', () => {
        const world = ready();
        handle(world, 'service.register', registerInput());
        const { reply } = handle(world, 'service.register', registerInput({ layout: 'standalone' }));
        expect(reply).toMatchObject({ ok: true, outcome: 'done', detail: { written: true, active: 'running' } });
        expect(world.sc('create')).toHaveLength(1);
        expect(world.sc('stop')).toHaveLength(1);
        expect(world.sc('start')).toHaveLength(2);
        expect(world.text('C:\\Goobster\\data\\manager\\service\\goobster-service.xml')).toContain('value="standalone"');
    });

    test('a stopped service of ours that is already current is only started', () => {
        const world = ready();
        handle(world, 'service.register', registerInput());
        world.state.service.state = 'stopped';
        const { reply } = handle(world, 'service.register', registerInput());
        expect(reply).toMatchObject({ ok: true, detail: { written: false, active: 'running' } });
        expect(world.sc('start')).toHaveLength(2);
        expect(world.sc('create')).toHaveLength(1);
    });

    test('a manager store that moved: the service points at the new folder and the old one is removed', () => {
        const world = ready();
        handle(world, 'service.register', registerInput());
        const moved = roots('D:\\Goobster2');
        world.installation({ installationRoots: moved });
        const { reply } = handle(world, 'service.register', registerInput({ codeRoot: moved.code, roots: moved }));
        expect(reply).toMatchObject({ ok: true, outcome: 'done' });
        expect(world.sc('config')[0].args).toEqual(['config', 'goobster', 'binPath=', '"D:\\Goobster2\\data\\manager\\service\\goobster-service.exe"', 'start=', 'auto']);
        expect(world.text('C:\\Goobster\\data\\manager\\service\\goobster-service.xml')).toBeNull();
        expect(world.text('D:\\Goobster2\\data\\manager\\service\\goobster-service.xml')).toContain(ID);
    });

    test.each([
        ['an image outside a goobster-service.exe', { imagePath: '"C:\\Tools\\other.exe"' }, null],
        ['our host beside no definition', { imagePath: '"C:\\Elsewhere\\goobster-service.exe"' }, null],
        ['our host beside another installation\'s definition', { imagePath: '"C:\\Elsewhere\\goobster-service.exe"' }, `<!-- X-Goobster-Installation: ${OTHER_ID} -->\n<service><id>goobster</id></service>`],
        ['a definition without a marker', { imagePath: '"C:\\Elsewhere\\goobster-service.exe"' }, '<service><id>goobster</id></service>']
    ])('a goobster service that is %s is SERVICE_FOREIGN and nothing is changed', (_label, svc, definition) => {
        const world = ready({ service: { state: 'running', config: {}, ...svc } });
        if (definition) world.put('C:\\Elsewhere\\goobster-service.xml', definition);
        const { reply, code } = handle(world, 'service.register', registerInput());
        expect(code).toBe(1);
        expect(reply).toMatchObject({ ok: false, code: 'SERVICE_FOREIGN' });
        expect(world.calls.filter(call => call.name === 'sc.exe' && ['create', 'stop', 'start', 'config', 'delete'].includes(call.args[0]))).toEqual([]);
        expect(world.icacls()).toEqual([]);
        expect(world.state.service.imagePath).toBe(svc.imagePath);
    });

    test('not elevated: refused before anything runs', () => {
        const world = ready({ elevated: false });
        const { reply } = helper.execute(protocol.buildRequest('service.register', registerInput()), { platform: 'win32', deps: { ...world.deps(), elevated: undefined } });
        expect(reply).toMatchObject({ ok: false, code: 'NOT_ELEVATED' });
        expect(world.calls.map(call => call.name)).toEqual(['whoami.exe']);
    });

    test('source checkouts have no Windows service', () => {
        const world = ready();
        const { reply } = handle(world, 'service.register', registerInput({ mode: 'checkout' }));
        expect(reply).toMatchObject({ ok: false, code: 'NOT_IMPLEMENTED' });
        expect(world.calls.map(call => call.name)).toEqual(['whoami.exe']);
    });

    test('the installation record must name this installation and these roots', () => {
        const world = ready();
        world.installation({ id: OTHER_ID });
        expect(handle(world, 'service.register', registerInput()).reply).toMatchObject({ ok: false, code: 'INSTALLATION_MISMATCH' });
        const other = fakeWindows();
        other.installation({ installationRoots: { ...roots(), logs: 'C:\\Goobster\\other-logs' } });
        other.stageHost();
        expect(handle(other, 'service.register', registerInput()).reply).toMatchObject({ ok: false, code: 'INSTALLATION_MISMATCH' });
        const bare = fakeWindows();
        bare.stageHost();
        expect(handle(bare, 'service.register', registerInput()).reply).toMatchObject({ ok: false, code: 'INSTALLATION_MISMATCH' });
    });

    test('an installation with no activated payload is refused', () => {
        const world = fakeWindows();
        world.installation({ payload: false });
        world.stageHost();
        expect(handle(world, 'service.register', registerInput()).reply).toMatchObject({ ok: false, code: 'PAYLOAD_MISSING' });
        expect(world.sc('create')).toEqual([]);
    });

    test('the host executable must be there and must match the pin; a copy already in the store is accepted when it does', () => {
        const none = fakeWindows();
        none.installation();
        expect(handle(none, 'service.register', registerInput()).reply).toMatchObject({ ok: false, code: 'SERVICE_HOST_MISSING' });

        const tampered = fakeWindows();
        tampered.installation();
        tampered.stageHost(Buffer.from('not winsw'));
        expect(handle(tampered, 'service.register', registerInput()).reply).toMatchObject({ ok: false, code: 'SERVICE_HOST_UNVERIFIED' });
        expect(tampered.sc('create')).toEqual([]);
        expect(tampered.text('C:\\Goobster\\data\\manager\\service\\goobster-service.exe')).toBeNull();

        const real = fakeWindows();
        real.installation();
        real.stageHost();
        const { reply } = helper.execute(protocol.buildRequest('service.register', registerInput()), { platform: 'win32', deps: { ...real.deps(), pin: undefined } });
        expect(reply).toMatchObject({ ok: false, code: 'SERVICE_HOST_UNVERIFIED' });

        const stored = fakeWindows();
        stored.installation();
        stored.put('C:\\Goobster\\data\\manager\\service\\goobster-service.exe', HOST_BYTES);
        expect(handle(stored, 'service.register', registerInput()).reply).toMatchObject({ ok: true });
    });

    test('a service that will not stop is SERVICE_STILL_ACTIVE and the folder is not touched', () => {
        const world = ready({ stubbornStop: true });
        handle(world, 'service.register', registerInput());
        const before = world.text('C:\\Goobster\\data\\manager\\service\\goobster-service.xml');
        const { reply } = handle(world, 'service.register', registerInput({ layout: 'standalone' }), { waits: { stop: 3000, start: 3000, remove: 3000 } });
        expect(reply).toMatchObject({ ok: false, code: 'SERVICE_STILL_ACTIVE' });
        expect(world.text('C:\\Goobster\\data\\manager\\service\\goobster-service.xml')).toBe(before);
    });

    test('a failing command is COMMAND_FAILED with the status and the error number, never the program\'s own words', () => {
        const world = ready();
        const exec = (file, args) => {
            if (path.win32.basename(file) === 'sc.exe' && args[0] === 'create') return { status: 5, stdout: '[SC] CreateService FAILED 5:\r\nAccess is denied. C:\\secret\\place', stderr: '' };
            return world.exec(file, args);
        };
        const { reply } = handle(world, 'service.register', registerInput(), { exec });
        expect(reply).toMatchObject({ ok: false, code: 'COMMAND_FAILED' });
        expect(reply.message).toBe('sc.exe create failed with status 5 (error 5).');
    });

    test('the reply log is words only: nothing the scrubber would change, no URL, no password', () => {
        const world = ready();
        const { reply } = handle(world, 'service.register', registerInput());
        expect(reply.log.length).toBeGreaterThan(5);
        expect(reply.log.length).toBeLessThanOrEqual(40);
        expect(elevate.scrubLines(reply.log, [])).toEqual(reply.log);
        for (const line of reply.log) expect(line).not.toMatch(/https?:|password|token|[A-Za-z]:\\/i);
    });
});

describe('service.unregister', () => {
    test('stops the service, deletes it and removes its folder', () => {
        const world = ready();
        handle(world, 'service.register', registerInput());
        const { reply } = handle(world, 'service.unregister', unregisterInput());
        expect(reply).toMatchObject({ ok: true, outcome: 'done', detail: { removed: true } });
        const order = world.calls.filter(call => call.name === 'sc.exe').map(call => call.args[0]);
        expect(order.indexOf('stop')).toBeLessThan(order.lastIndexOf('delete'));
        expect(world.state.service).toBeNull();
        expect(world.text('C:\\Goobster\\data\\manager\\service\\goobster-service.exe')).toBeNull();
        expect(world.text('C:\\Goobster\\data\\manager\\service\\goobster-service.xml')).toBeNull();
        expect(world.dirs.has(key('C:\\Goobster\\data\\manager\\service'))).toBe(false);
    });

    test('an absent service is a noop', () => {
        const world = ready();
        const { reply } = handle(world, 'service.unregister', unregisterInput());
        expect(reply).toMatchObject({ ok: true, outcome: 'noop', detail: { removed: false } });
        expect(world.sc('delete')).toEqual([]);
    });

    test('a service without this installation\'s marker is SERVICE_FOREIGN: not stopped, not deleted', () => {
        const world = ready();
        handle(world, 'service.register', registerInput());
        const { reply } = handle(world, 'service.unregister', unregisterInput({ installationId: OTHER_ID }));
        expect(reply).toMatchObject({ ok: false, code: 'SERVICE_FOREIGN' });
        expect(world.sc('stop')).toEqual([]);
        expect(world.sc('delete')).toEqual([]);
        expect(world.state.service).not.toBeNull();

        const alien = fakeWindows({ service: { imagePath: '"C:\\Other\\svc.exe"', state: 'running', config: {} } });
        expect(handle(alien, 'service.unregister', unregisterInput()).reply).toMatchObject({ ok: false, code: 'SERVICE_FOREIGN' });
        expect(alien.sc('delete')).toEqual([]);
    });

    test('a service that does not stop within the bound is left registered', () => {
        const world = ready({ stubbornStop: true });
        handle(world, 'service.register', registerInput());
        const { reply } = handle(world, 'service.unregister', unregisterInput(), { waits: { stop: 3000, start: 3000, remove: 3000 } });
        expect(reply).toMatchObject({ ok: false, code: 'SERVICE_STILL_ACTIVE' });
        expect(world.sc('delete')).toEqual([]);
        expect(world.text('C:\\Goobster\\data\\manager\\service\\goobster-service.xml')).not.toBeNull();
    });
});

describe('the platform module surface', () => {
    test('is wired into the dispatcher and the helper', () => {
        expect(privileged.IMPLEMENTED.win32).toEqual(['service.register', 'service.unregister']);
        expect(win32.OPERATIONS).toEqual(['service.register', 'service.unregister']);
        expect(win32.PLATFORM).toBe('win32');
        for (const name of ['createHandler', 'elevation', 'transport', 'refusal', 'manualCommand', 'serviceFacts', 'sandboxDeps']) expect(typeof win32[name]).toBe('function');
        expect(Array.isArray(win32.HELPER_FILES)).toBe(true);
    });

    test('the other operations answer NOT_IMPLEMENTED', () => {
        const world = ready();
        // A name from the protocol's fixed package table, so the request reaches the Windows handler instead of being refused first.
        const { reply } = handle(world, 'package.install', { names: ['postgresql-17'] });
        expect(reply).toMatchObject({ ok: false, code: 'NOT_IMPLEMENTED' });
        expect(world.calls).toEqual([]);
        expect(win32.createHandler(world.deps()).handle.length).toBe(2);
        expect(() => win32.createHandler(world.deps()).handle('user.create', {})).toThrow(expect.objectContaining({ code: 'NOT_IMPLEMENTED' }));
    });

    test('the helper\'s code is node built-ins plus the files HELPER_FILES names, and nothing else', () => {
        const dir = path.join(__dirname, '..', 'apps', 'manager');
        const own = new Set(win32.HELPER_FILES.map(rel => path.normalize(path.join(dir, '..', '..', rel.replace(/^app\//, '')))));
        const seen = new Set();
        const queue = [path.join(dir, 'privileged', 'helper.js'), path.join(dir, 'privileged', 'win32.js')];
        while (queue.length > 0) {
            const file = queue.pop();
            if (seen.has(file)) continue;
            seen.add(file);
            expect(own.has(path.normalize(file))).toBe(true);
            for (const match of fs.readFileSync(file, 'utf8').matchAll(/require\((['"])([^'"]+)\1\)/g)) {
                const target = match[2];
                if (target.startsWith('node:')) continue;
                expect(target.startsWith('.')).toBe(true);
                if (path.basename(file) === 'helper.js' && /^\.\/(linux|darwin)$/.test(target)) continue;
                let resolved = path.resolve(path.dirname(file), target);
                if (!resolved.endsWith('.js')) resolved += '.js';
                queue.push(resolved);
            }
        }
        expect(seen.size).toBe(win32.HELPER_FILES.length);
    });

    test('the helper never honours a sandbox on Windows, and a sandbox elsewhere is not elevated by an environment variable', () => {
        const real = process.platform;
        Object.defineProperty(process, 'platform', { value: 'win32' });
        try {
            expect(win32.sandboxDeps('/tmp/x')).toEqual({});
        } finally {
            Object.defineProperty(process, 'platform', { value: real });
        }
    });
});

describe('elevation', () => {
    const exec = (elevated) => () => ({ status: 0, stdout: elevated ? 'Label S-1-16-12288' : 'Label S-1-16-8192', stderr: '' });

    test('an administrator process needs no prompt', () => {
        expect(win32.elevation({ env: { SESSIONNAME: 'Console' }, exec: exec(true) })).toEqual({ kind: 'administrator', prefix: [] });
        expect(win32.isElevated({ exec: () => ({ status: 0, stdout: 'Label S-1-16-16384' }) })).toBe(true);
        expect(win32.isElevated({ exec: () => ({ status: 1, stdout: 'Label S-1-16-12288' }) })).toBe(false);
    });

    test('a person at a desktop session may be asked through UAC', () => {
        expect(win32.elevation({ env: { SESSIONNAME: 'Console' }, exec: exec(false) })).toEqual({ kind: 'uac', prefix: [] });
        expect(win32.elevation({ env: { SESSIONNAME: 'RDP-Tcp#3' }, exec: exec(false) }).kind).toBe('uac');
    });

    test.each([
        ['a service session', { SESSIONNAME: 'Services' }],
        ['no session at all', {}],
        ['an SSH login', { SESSIONNAME: 'Console', SSH_CONNECTION: '1 2 3 4' }]
    ])('%s has no way to answer a prompt: none, NO_INTERACTIVE_SESSION', (_label, env) => {
        expect(win32.elevation({ env, exec: exec(false) })).toEqual({ kind: 'none', prefix: [], reason: 'NO_INTERACTIVE_SESSION' });
    });

    test('serviceFacts asks the service control manager and reports SCM_UNAVAILABLE when it cannot answer', () => {
        const calls = [];
        expect(win32.serviceFacts({ env: {}, exec: (file, args) => { calls.push([path.win32.basename(file), ...args]); return { status: 0, stdout: '' }; } })).toMatchObject({ available: true });
        expect(calls).toEqual([['sc.exe', 'query', 'state=', 'all']]);
        expect(win32.serviceFacts({ env: {}, exec: () => ({ status: 1, stdout: '' }) })).toEqual({ available: false, state: null, reason: 'SCM_UNAVAILABLE' });
        if (process.platform !== 'win32') expect(win32.serviceFacts({ env: {} })).toMatchObject({ available: false, reason: 'SCM_UNAVAILABLE' });
    });

    test('the by-hand command names the request and the reply file', () => {
        const line = win32.manualCommand({ nodePath: 'C:\\G\\code\\current\\runtime\\node.exe', helperPath: 'C:\\G\\code\\current\\app\\apps\\manager\\privileged\\helper.js', requestFile: 'C:\\G\\data\\manager\\requests\\service.register.request.json' });
        expect(line).toBe('"C:\\G\\code\\current\\runtime\\node.exe" "C:\\G\\code\\current\\app\\apps\\manager\\privileged\\helper.js" --request "C:\\G\\data\\manager\\requests\\service.register.request.json" --reply "C:\\G\\data\\manager\\requests\\service.register.reply.json"');
    });

    test('refusal maps a dismissed UAC prompt to ELEVATION_DECLINED and nothing else', () => {
        expect(win32.refusal({ status: 1223, stderr: '' })).toEqual({ reason: 'ELEVATION_DECLINED' });
        expect(win32.refusal({ status: 1, stderr: 'This command cannot be run due to the error: The operation was canceled by the user.' })).toEqual({ reason: 'ELEVATION_DECLINED' });
        expect(win32.refusal({ status: 1, stderr: 'boom' })).toBeNull();
        expect(win32.refusal({ status: 0, stderr: '' })).toBeNull();
    });
});

/** A child process that ends when told to, optionally leaving the helper's reply behind. */
function fakeSpawn({ reply = null, status = 0, stderr = '', replyFile = () => null, never = false } = {}) {
    const calls = [];
    const spawn = (file, args, options) => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.killed = false;
        child.kill = () => { child.killed = true; child.emit('close', null, 'SIGTERM'); };
        calls.push({ file, args, options, child });
        if (!never) {
            setImmediate(() => {
                const target = replyFile(args);
                if (reply && target) fs.writeFileSync(target, JSON.stringify(reply));
                if (stderr) child.stderr.emit('data', Buffer.from(stderr));
                child.emit('close', status, null);
            });
        }
        return child;
    };
    spawn.calls = calls;
    return spawn;
}

describe('the UAC file transport', () => {
    const request = protocol.buildRequest('service.register', registerInput());
    const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-win32-'));
    const toClean = [];
    afterAll(() => toClean.forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));
    const execOk = (calls) => (file, args) => {
        calls.push({ name: path.win32.basename(file).toLowerCase(), args });
        if (path.win32.basename(file).toLowerCase() === 'whoami.exe') return { status: 0, stdout: '"PC\\alice","S-1-5-21-111-222-333-1001"', stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
    };
    const okReply = protocol.okReply('service.register', 'done', { service: 'goobster', active: 'running' }, ['sc.exe create -> 0']);

    test('writes the request readable only by the asker and the administrators, runs the fixed Start-Process script, and brings the reply back', async () => {
        const dir = scratch();
        toClean.push(dir);
        const execCalls = [];
        const requestFile = path.join(dir, 'service.register.request.json');
        const replyFile = path.join(dir, 'service.register.reply.json');
        const spawn = fakeSpawn({ reply: okReply, replyFile: () => replyFile });
        const result = await win32.transport({ plan: { kind: 'uac', prefix: [] }, request, nodePath: '/p/runtime/node.exe', helperPath: '/p/app/helper.js', requestDir: dir, spawn, exec: execOk(execCalls), env: {} });

        expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, operation: 'service.register' });
        const acl = execCalls.find(call => call.name === 'icacls.exe');
        expect(acl.args).toEqual([requestFile, '/inheritance:r', '/grant:r', '*S-1-5-21-111-222-333-1001:F', '*S-1-5-32-544:F']);
        expect(spawn.calls).toHaveLength(1);
        expect(spawn.calls[0].file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
        expect(spawn.calls[0].args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand']);
        const script = Buffer.from(spawn.calls[0].args[3], 'base64').toString('utf16le');
        expect(script).toContain('Start-Process');
        expect(script).toContain('-Verb RunAs -Wait -PassThru');
        expect(script).toContain(`'/p/runtime/node.exe'`);
        expect(script).toContain(`--request "${requestFile}" --reply "${replyFile}"`);
        expect(script).toContain('canceled by the user');
        expect(fs.existsSync(requestFile)).toBe(false);
        expect(fs.existsSync(replyFile)).toBe(false);
        expect(Object.keys(spawn.calls[0].options.env).sort()).toEqual(['PATH', 'SystemRoot', 'windir']);
        expect(request).not.toMatch(/token|password|http/i);
    });

    test('an administrator process runs the helper directly with the same files', async () => {
        const dir = scratch();
        toClean.push(dir);
        const replyFile = path.join(dir, 'service.register.reply.json');
        const spawn = fakeSpawn({ reply: okReply, replyFile: () => replyFile });
        const result = await win32.transport({ plan: { kind: 'administrator', prefix: [] }, request, nodePath: '/p/runtime/node.exe', helperPath: '/p/app/helper.js', requestDir: dir, spawn, exec: execOk([]), env: {} });
        expect(spawn.calls[0].file).toBe('/p/runtime/node.exe');
        expect(spawn.calls[0].args).toEqual(['/p/app/helper.js', '--request', path.join(dir, 'service.register.request.json'), '--reply', replyFile]);
        expect(JSON.parse(result.stdout).ok).toBe(true);
    });

    test('a dismissed prompt returns no reply and leaves the request for the by-hand command; refusal() turns it into a fallback', async () => {
        const dir = scratch();
        toClean.push(dir);
        const spawn = fakeSpawn({ status: 1223, stderr: 'The operation was canceled by the user.' });
        const result = await win32.transport({ plan: { kind: 'uac', prefix: [] }, request, nodePath: '/p/runtime/node.exe', helperPath: '/p/app/helper.js', requestDir: dir, spawn, exec: execOk([]), env: {} });
        expect(result).toMatchObject({ status: 1223, stdout: '' });
        expect(fs.existsSync(path.join(dir, 'service.register.request.json'))).toBe(true);
        expect(win32.refusal(result)).toEqual({ reason: 'ELEVATION_DECLINED' });
    });

    test('a helper that fails keeps the reply: the refusal reaches the caller and the files are removed', async () => {
        const dir = scratch();
        toClean.push(dir);
        const failure = protocol.errorReply('service.register', 'SERVICE_FOREIGN', 'A goobster service exists that this installation did not register; it was left as it is.', ['registry query -> 0']);
        const spawn = fakeSpawn({ reply: failure, status: 1, replyFile: () => path.join(dir, 'service.register.reply.json') });
        const result = await win32.transport({ plan: { kind: 'uac', prefix: [] }, request, nodePath: '/p/runtime/node.exe', helperPath: '/p/app/helper.js', requestDir: dir, spawn, exec: execOk([]), env: {} });
        expect(protocol.parseReply(result.stdout, 'service.register')).toMatchObject({ ok: false, code: 'SERVICE_FOREIGN' });
        expect(fs.readdirSync(dir)).toEqual([]);
    });

    test('refuses before elevating when the request cannot be protected, when a path is unsafe, or when there is nowhere to put it', async () => {
        const dir = scratch();
        toClean.push(dir);
        const spawn = fakeSpawn();
        const noAcl = (file, args) => (path.win32.basename(file) === 'icacls.exe' ? { status: 5, stdout: '', stderr: '' } : execOk([])(file, args));
        expect(await win32.transport({ plan: { kind: 'uac', prefix: [] }, request, nodePath: '/p/node.exe', helperPath: '/p/h.js', requestDir: dir, spawn, exec: noAcl, env: {} })).toMatchObject({ spawnError: 'ACL_FAILED' });
        expect(fs.readdirSync(dir)).toEqual([]);
        expect(await win32.transport({ plan: { kind: 'uac', prefix: [] }, request, nodePath: '/p/"node.exe', helperPath: '/p/h.js', requestDir: dir, spawn, exec: execOk([]), env: {} })).toMatchObject({ spawnError: 'UNSAFE_PATH' });
        expect(await win32.transport({ plan: { kind: 'uac', prefix: [] }, request, nodePath: '/p/node.exe', helperPath: '/p/h.js', requestDir: null, spawn, exec: execOk([]), env: {} })).toMatchObject({ spawnError: 'NO_REQUEST_DIR' });
        expect(spawn.calls).toEqual([]);
    });

    test('a prompt nobody answers is ended after the bound', async () => {
        jest.useFakeTimers();
        try {
            const dir = scratch();
            toClean.push(dir);
            const spawn = fakeSpawn({ never: true });
            const pending = win32.transport({ plan: { kind: 'uac', prefix: [] }, request, nodePath: '/p/node.exe', helperPath: '/p/h.js', requestDir: dir, spawn, exec: execOk([]), env: {}, timeoutMs: 1000 });
            await jest.advanceTimersByTimeAsync(0);
            await jest.advanceTimersByTimeAsync(8 * 60 * 1000);
            const result = await pending;
            expect(spawn.calls[0].child.killed).toBe(true);
            expect(result.stdout).toBe('');
        } finally {
            jest.useRealTimers();
        }
    });
});

describe('through the manager: runHelper with the Windows module', () => {
    const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-win32-run-'));
    const toClean = [];
    afterAll(() => toClean.forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));
    const execOk = (file) => (path.win32.basename(file).toLowerCase() === 'whoami.exe' ? { status: 0, stdout: '"PC\\alice","S-1-5-21-1-2-3-1001"' } : { status: 0, stdout: '' });
    const implementation = { ...win32, transport: (params) => win32.transport({ ...params, exec: execOk }) };

    test('a registration that UAC carried out is done, its log scrubbed', async () => {
        const dir = scratch();
        toClean.push(dir);
        const reply = protocol.okReply('service.register', 'done', { active: 'running' }, ['sc.exe create -> 0']);
        const result = await elevate.runHelper({ operation: 'service.register', input: registerInput(), implementation, requestDir: dir, elevation: { kind: 'uac', prefix: [] }, facts: { available: true }, spawn: fakeSpawn({ reply, replyFile: () => path.join(dir, 'service.register.reply.json') }), env: {} });
        expect(result).toMatchObject({ status: 'done', outcome: 'done', via: 'uac' });
        expect(result.log).toEqual(['sc.exe create -> 0']);
    });

    test('a dismissed UAC prompt is a fallback with ELEVATION_DECLINED', async () => {
        const dir = scratch();
        toClean.push(dir);
        const result = await elevate.runHelper({ operation: 'service.register', input: registerInput(), implementation, requestDir: dir, elevation: { kind: 'uac', prefix: [] }, facts: { available: true }, spawn: fakeSpawn({ status: 1223, stderr: 'The operation was canceled by the user.' }), env: {} });
        expect(result).toMatchObject({ status: 'fallback', reason: 'ELEVATION_DECLINED' });
    });

    test('no interactive session: a fallback carrying the by-hand line, the request left in the store', async () => {
        const dir = scratch();
        toClean.push(dir);
        const result = await elevate.runHelper({ operation: 'service.register', input: registerInput(), implementation, requestDir: dir, elevation: { kind: 'none', prefix: [], reason: 'NO_INTERACTIVE_SESSION' }, facts: { available: true }, env: {}, nodePath: '/p/node.exe', helperPath: '/p/helper.js' });
        expect(result).toMatchObject({ status: 'fallback', reason: 'ELEVATION_UNAVAILABLE', detail: { why: 'NO_INTERACTIVE_SESSION' } });
        expect(result.manual).toContain('--request');
        expect(result.manual).toContain('service.register.reply.json');
        expect(fs.existsSync(path.join(dir, 'service.register.request.json'))).toBe(true);
    });

    test('an unreachable service control manager is a fallback before any elevation', async () => {
        const result = await elevate.runHelper({ operation: 'service.register', input: registerInput(), implementation, elevation: { kind: 'uac', prefix: [] }, facts: { available: false, reason: 'SCM_UNAVAILABLE' }, env: {} });
        expect(result).toMatchObject({ status: 'fallback', reason: 'SCM_UNAVAILABLE' });
    });

    test('the dispatcher routes win32 through the module and refuses a non-Windows path before anything starts', async () => {
        await expect(privileged.run('service.register', registerInput({ codeRoot: '/opt/g', roots: { ...roots(), code: '/opt/g' } }), { platform: 'win32', elevation: { kind: 'uac', prefix: [] }, facts: { available: true } })).rejects.toMatchObject({ status: 400 });
        await expect(privileged.run('updater.disable', {}, { platform: 'win32' })).rejects.toMatchObject({ status: 501 });
    });
});
