/**
 * The macOS privileged helper (#332, documentation/macos_install.md,
 * "Elevation"): every operation against a fake directory service and a fake
 * launchd that record each `launchctl`, `dscl`, `chown` and `sleep` argument
 * vector, the refusals (a foreign job is never overwritten, nothing runs
 * before a request is refused), idempotent re-runs, the manager half
 * (`elevation()`, `transport()` with a file transport and a pre-created reply
 * file, `refusal()`), and the runner end to end with a fake `osascript`.
 *
 * This suite runs on Linux: no macOS program is started. What a real launchd,
 * `dscl` and the administrator prompt do is proven by the macOS workflow
 * (.github/workflows/macos-bootstrap.yml), not here.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const protocol = require('@goobster/manager/privileged/protocol');
const helper = require('@goobster/manager/privileged/helper');
const darwin = require('@goobster/manager/privileged/darwin');
const elevate = require('@goobster/manager/privileged/elevate');
const privileged = require('@goobster/manager/privileged');
const plist = require('@goobster/manager/platform/launchdPlist');

const ID = '0b9f3c1e-6a58-4c1e-9d5f-2f3b1c0a7e11';
const OTHER_ID = '7d7d7d7d-1111-4222-8333-444455556666';
const LABEL = 'io.goobster.goobster';
const cleanup = [];

afterAll(() => {
    for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
});

/** A directory service, a launchd and the files around them, all in memory or under one temporary directory. */
function makeMac({ users = [], groups = [], withLaunchctl = true, domains = ['system', 'gui/501'] } = {}) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-mac-'));
    cleanup.push(base);
    const bin = path.join(base, 'bin');
    const daemonDir = path.join(base, 'Library', 'LaunchDaemons');
    const agentDir = path.join(base, 'Users', 'alice', 'Library', 'LaunchAgents');
    for (const dir of [bin, daemonDir]) fs.mkdirSync(dir, { recursive: true });
    for (const name of ['dscl', 'chown', 'sleep', ...(withLaunchctl ? ['launchctl'] : [])]) fs.writeFileSync(path.join(bin, name), '', { mode: 0o755 });

    const state = {
        users: new Map(users.map(user => [user.name, { shell: '/usr/bin/false', ...user }])),
        groups: new Map(groups.map(group => [group.name, group])),
        domains: new Set(domains),
        loaded: new Set(),
        stuck: new Set(),
        failures: {},
        calls: []
    };
    const text = (...lines) => `${lines.join('\n')}\n`;

    function dscl(args) {
        const [, verb, target, ...rest] = args;
        const [, kind, name] = /^\/(Users|Groups)(?:\/(.+))?$/.exec(target) || [];
        const table = kind === 'Users' ? state.users : state.groups;
        if (verb === '-read') {
            const entry = table.get(name);
            if (!entry) return { status: 56, stdout: '', stderr: `<dscl_cmd> DS Error: -14136 (eDSRecordNotFound)\n` };
            if (kind === 'Users') {
                const lines = [];
                for (const key of rest) {
                    const value = { UniqueID: entry.uid, PrimaryGroupID: entry.gid, NFSHomeDirectory: entry.home, UserShell: entry.shell }[key];
                    if (value !== undefined && value !== null) lines.push(/\s/.test(String(value)) ? `${key}:\n ${value}` : `${key}: ${value}`);
                }
                return { status: 0, stdout: text(...lines), stderr: '' };
            }
            return { status: 0, stdout: text(`PrimaryGroupID: ${entry.gid}`), stderr: '' };
        }
        if (verb === '-list') {
            const attribute = target.endsWith('Users') ? 'uid' : 'gid';
            const rows = target === '/Users' ? [...state.users.values()].map(entry => `${entry.name}   ${entry.uid}`) : [...state.groups.values()].map(entry => `${entry.name}   ${entry.gid}`);
            void attribute;
            return { status: 0, stdout: text(...rows), stderr: '' };
        }
        if (verb === '-create') {
            const [key, value] = rest;
            if (!table.has(name)) table.set(name, { name });
            const entry = table.get(name);
            if (key === 'UniqueID') entry.uid = Number(value);
            if (key === 'PrimaryGroupID') entry.gid = Number(value);
            if (key === 'NFSHomeDirectory') entry.home = value;
            if (key === 'UserShell') entry.shell = value;
            if (key === 'IsHidden') entry.hidden = value;
            return { status: 0, stdout: '', stderr: '' };
        }
        return { status: 1, stdout: '', stderr: 'usage' };
    }

    function launchctl(args) {
        const [verb, target, file] = args;
        if (verb === 'print') {
            if (state.domains.has(target) || state.loaded.has(target)) return { status: 0, stdout: state.loaded.has(target) ? 'state = running\n' : 'domain\n', stderr: '' };
            return { status: 113, stdout: '', stderr: 'Could not find service' };
        }
        if (verb === 'enable') return { status: 0, stdout: '', stderr: '' };
        if (verb === 'bootstrap') {
            const parsed = plist.parsePlist(fs.readFileSync(file, 'utf8'));
            state.loaded.add(`${target}/${parsed.label}`);
            return { status: 0, stdout: '', stderr: '' };
        }
        if (verb === 'bootout') {
            if (!state.stuck.has(target)) state.loaded.delete(target);
            return { status: 0, stdout: '', stderr: '' };
        }
        return { status: 1, stdout: '', stderr: 'usage' };
    }

    function exec(file, args) {
        const name = path.basename(file);
        state.calls.push({ name, args: [...args] });
        const failure = state.failures[`${name} ${args[0]}`] || state.failures[name];
        if (failure) return { status: failure, stdout: '', stderr: `${name} failed\n` };
        if (name === 'dscl') return dscl(args);
        if (name === 'launchctl') return launchctl(args);
        return { status: 0, stdout: '', stderr: '' };
    }

    const argvOf = (name) => state.calls.filter(call => call.name === name).map(call => call.args);
    const commands = () => state.calls.filter(call => !(call.name === 'dscl' && (call.args[1] === '-read' || call.args[1] === '-list')) && call.name !== 'sleep').map(call => `${call.name} ${call.args.join(' ')}`);
    return { base, bin, daemonDir, agentDir, state, exec, argvOf, commands, reset: () => { state.calls.length = 0; } };
}

function makeInstallation(mac, { withPayload = true, recordId = ID, under = null } = {}) {
    const root = under || path.join(mac.base, 'opt', 'goobster test é');
    const roots = {};
    for (const role of protocol.ROOT_ROLES) roots[role] = path.join(root, role === 'managerStore' ? 'manager state' : role);
    for (const dir of Object.values(roots)) fs.mkdirSync(dir, { recursive: true });
    if (recordId) fs.writeFileSync(path.join(roots.managerStore, 'installation.json'), JSON.stringify({ installationId: recordId, roots }));
    if (withPayload) {
        const current = path.join(roots.code, 'current');
        fs.mkdirSync(path.join(current, 'runtime', 'bin'), { recursive: true });
        fs.mkdirSync(path.join(current, 'app', 'apps', 'manager'), { recursive: true });
        fs.writeFileSync(path.join(current, 'payload-manifest.json'), '{}');
        fs.writeFileSync(path.join(current, 'runtime', 'bin', 'node'), '');
        fs.writeFileSync(path.join(current, 'app', 'apps', 'manager', 'index.js'), '');
    }
    return roots;
}

const registerInput = (roots, extra = {}) => ({ kind: 'launchd', scope: 'machine', name: 'goobster', layout: 'standalone', codeRoot: roots.code, runtimeUser: '_goobster', installationId: ID, roots, mode: 'payload', ...extra });
const userInput = (roots, extra = {}) => ({ name: '_goobster', home: path.dirname(roots.data), system: true, installationId: ID, roots, mode: 'payload', ...extra });
const GOOBSTER = { name: '_goobster', uid: 300, gid: 300, home: '/opt/goobster' };
const ALICE = { name: 'alice', uid: 501, gid: 20, home: '/Users/alice' };

/** A real file system with the identity of root-owned, sealed directories: the helper judges owners and modes, the suite is not root. */
function sealedFs(overrides = {}) {
    const wrap = (stat, patch) => new Proxy(stat, { get: (target, key) => (key in patch ? patch[key] : target[key]) });
    return {
        ...fs,
        statSync: (file) => {
            const stat = fs.statSync(file);
            const patch = overrides.statSync ? overrides.statSync(file, stat) : null;
            return wrap(stat, { uid: 0, gid: 0, mode: stat.isDirectory() ? 0o40755 : stat.mode, ...(patch || {}) });
        },
        lstatSync: (file) => {
            const stat = fs.lstatSync(file);
            const patch = overrides.lstatSync ? overrides.lstatSync(file, stat) : null;
            return wrap(stat, { uid: 0, ...(patch || {}) });
        }
    };
}

function rootHandler(mac, extra = {}) {
    return darwin.createHandler({ fs: sealedFs(), daemonDir: mac.daemonDir, agentDir: mac.agentDir, commandDirs: [mac.bin], euid: 0, invokerUid: 501, exec: mac.exec, ...extra });
}

function personHandler(mac, extra = {}) {
    return darwin.createHandler({ fs, daemonDir: mac.daemonDir, agentDir: mac.agentDir, commandDirs: [mac.bin], euid: 501, invokerUid: 501, exec: mac.exec, ...extra });
}

const thrown = (fn) => {
    try {
        fn();
    } catch (error) {
        return error;
    }
    return null;
};

describe('the platform surface', () => {
    test('the module names its operations and helper files, and the dispatcher and helper know macOS', () => {
        expect(darwin.PLATFORM).toBe('darwin');
        expect(darwin.OPERATIONS).toEqual(['service.register', 'service.unregister', 'user.create']);
        expect(darwin.HELPER_FILES).toEqual([
            'app/apps/manager/privileged/helper.js',
            'app/apps/manager/privileged/protocol.js',
            'app/apps/manager/privileged/darwin.js',
            'app/apps/manager/platform/launchdPlist.js',
            'app/apps/manager/platform/systemdUnit.js'
        ]);
        expect(privileged.describe('darwin')).toMatchObject({ implemented: true, implementedOperations: ['service.register', 'service.unregister', 'user.create'] });
        expect(privileged.isImplemented('updater.disable', 'darwin')).toBe(false);
    });

    test('the helper process dispatches darwin requests through the real protocol, and an unsupported operation is NOT_IMPLEMENTED', () => {
        const mac = makeMac();
        const roots = makeInstallation(mac);
        const request = protocol.buildRequest('service.register', registerInput(roots));
        const sandboxed = helper.execute(request, { platform: 'darwin', deps: { sandbox: true, daemonDir: mac.daemonDir, agentDir: mac.agentDir, commandDirs: [mac.bin], exec: mac.exec } });
        expect(sandboxed.code).toBe(1);
        expect(sandboxed.reply).toMatchObject({ ok: false, code: 'RUNTIME_USER_MISSING' });
        expect(thrown(() => darwin.createHandler({ sandbox: true, commandDirs: [mac.bin], exec: mac.exec }).handle('updater.disable', {}))).toMatchObject({ code: 'NOT_IMPLEMENTED' });
        expect(helper.execute(request, { platform: 'aix', deps: {} }).reply).toMatchObject({ ok: false, code: 'PLATFORM_UNSUPPORTED' });
        expect(darwin.sandboxDeps('/tmp/x')).toEqual({ sandbox: true, daemonDir: '/tmp/x/Library/LaunchDaemons', agentDir: '/tmp/x/Library/LaunchAgents', commandDirs: ['/tmp/x/bin'] });
    });

    test('parsers: dscl -read joins a wrapped value, dscl -list gives name and id pairs', () => {
        expect(darwin.parseDsclRead('UniqueID: 300\nNFSHomeDirectory:\n /opt/goobster with space\nUserShell: /usr/bin/false\n')).toEqual({ UniqueID: '300', NFSHomeDirectory: '/opt/goobster with space', UserShell: '/usr/bin/false' });
        expect(darwin.parseDsclList('_goobster   300\nroot                    0\nnobody   -2\nbad line\n')).toEqual([['_goobster', 300], ['root', 0], ['nobody', -2]]);
        expect(darwin.invokerFromEnv({ SUDO_UID: '501' })).toBe(501);
        expect(darwin.invokerFromEnv({ GOOBSTER_INVOKER_UID: '502', SUDO_UID: '501' })).toBe(502);
        expect(darwin.invokerFromEnv({ SUDO_UID: 'x; rm' })).toBeNull();
        expect(darwin.invokerFromEnv({})).toBeNull();
    });
});

describe('service.register: the machine job', () => {
    test('writes the plist root:wheel 0644 and bootstraps it into the system domain, with exactly these commands', () => {
        const mac = makeMac({ users: [GOOBSTER] });
        const roots = makeInstallation(mac);
        const result = rootHandler(mac).handle('service.register', registerInput(roots));
        const file = path.join(mac.daemonDir, `${LABEL}.plist`);
        expect(result).toMatchObject({ outcome: 'done', detail: { unit: `${LABEL}.plist`, label: LABEL, scope: 'machine', written: true, active: 'running' } });
        expect(mac.commands()).toEqual([
            `chown root:wheel -- ${file}`,
            `launchctl print system/${LABEL}`,
            `launchctl enable system/${LABEL}`,
            `launchctl bootstrap system ${file}`,
            `launchctl print system/${LABEL}`
        ]);
        expect(fs.statSync(file).mode & 0o777).toBe(0o644);
        const parsed = plist.parsePlist(fs.readFileSync(file, 'utf8'));
        expect(parsed).toMatchObject({ label: LABEL, installationId: ID, user: '_goobster', workingDirectory: roots.code });
        expect(parsed.programArguments).toEqual([`${roots.code}/current/runtime/bin/node`, `${roots.code}/current/app/apps/manager/index.js`, '--supervise']);
        expect(result.log.join('\n')).not.toContain(mac.base);
    });

    test('a second identical request changes nothing: no rewrite, no reload', () => {
        const mac = makeMac({ users: [GOOBSTER] });
        const roots = makeInstallation(mac);
        const handler = rootHandler(mac);
        handler.handle('service.register', registerInput(roots));
        mac.reset();
        const again = handler.handle('service.register', registerInput(roots));
        expect(again).toMatchObject({ outcome: 'noop', detail: { written: false, active: 'running' } });
        expect(mac.commands().filter(line => /bootstrap|bootout/.test(line))).toEqual([]);
        expect(mac.commands()).toContain(`launchctl enable system/${LABEL}`);
    });

    test('a changed plist is booted out, waited for, and bootstrapped again', () => {
        const mac = makeMac({ users: [GOOBSTER] });
        const roots = makeInstallation(mac);
        const handler = rootHandler(mac);
        handler.handle('service.register', registerInput(roots));
        mac.reset();
        const changed = handler.handle('service.register', registerInput(roots, { layout: 'lite' }));
        expect(changed).toMatchObject({ outcome: 'done', detail: { written: true } });
        const lines = mac.commands();
        expect(lines.findIndex(line => line === `launchctl bootout system/${LABEL}`)).toBeGreaterThan(-1);
        expect(lines.findIndex(line => line.startsWith('launchctl bootstrap system '))).toBeGreaterThan(lines.findIndex(line => line === `launchctl bootout system/${LABEL}`));
    });

    test('a job that will not stop is reported, not reloaded', () => {
        const mac = makeMac({ users: [GOOBSTER] });
        const roots = makeInstallation(mac);
        const handler = rootHandler(mac);
        handler.handle('service.register', registerInput(roots));
        mac.state.stuck.add(`system/${LABEL}`);
        const error = thrown(() => handler.handle('service.register', registerInput(roots, { layout: 'lite' })));
        expect(error).toMatchObject({ code: 'SERVICE_STILL_ACTIVE' });
        expect(mac.argvOf('sleep').length).toBeGreaterThanOrEqual(10);
    });

    test('a plist with our label and no marker is foreign: nothing is written, chowned or loaded', () => {
        const mac = makeMac({ users: [GOOBSTER] });
        const roots = makeInstallation(mac);
        const file = path.join(mac.daemonDir, `${LABEL}.plist`);
        const foreign = `<?xml version="1.0"?>\n<plist version="1.0"><dict><key>Label</key><string>${LABEL}</string></dict></plist>\n`;
        fs.writeFileSync(file, foreign);
        expect(thrown(() => rootHandler(mac).handle('service.register', registerInput(roots)))).toMatchObject({ code: 'SERVICE_FOREIGN' });
        expect(fs.readFileSync(file, 'utf8')).toBe(foreign);
        expect(mac.commands()).toEqual([]);
    });

    test('a plist marked for another installation is foreign too', () => {
        const mac = makeMac({ users: [GOOBSTER] });
        const roots = makeInstallation(mac);
        const file = path.join(mac.daemonDir, `${LABEL}.plist`);
        const text = plist.renderPlist({ name: 'goobster', installationId: OTHER_ID, runtimeUser: '_goobster', codeRoot: roots.code, roots, layout: 'standalone', mode: 'payload' });
        fs.writeFileSync(file, text);
        expect(thrown(() => rootHandler(mac).handle('service.register', registerInput(roots)))).toMatchObject({ code: 'SERVICE_FOREIGN' });
        expect(fs.readFileSync(file, 'utf8')).toBe(text);
    });

    test('another job of this installation under another name is a duplicate', () => {
        const mac = makeMac({ users: [GOOBSTER] });
        const roots = makeInstallation(mac);
        const text = plist.renderPlist({ name: 'second', installationId: ID, runtimeUser: '_goobster', codeRoot: roots.code, roots, layout: 'standalone', mode: 'payload' });
        fs.writeFileSync(path.join(mac.daemonDir, 'io.goobster.second.plist'), text);
        fs.writeFileSync(path.join(mac.daemonDir, 'com.apple.unrelated.plist'), 'x');
        expect(thrown(() => rootHandler(mac).handle('service.register', registerInput(roots)))).toMatchObject({ code: 'SERVICE_DUPLICATE' });
    });

    test.each([
        ['not elevated', (mac) => personHandler(mac, { fs: sealedFs() }), (roots) => registerInput(roots), 'NOT_ELEVATED'],
        ['an installation record that names another id', (mac) => rootHandler(mac), (roots) => registerInput(roots, { installationId: OTHER_ID }), 'INSTALLATION_MISMATCH'],
        ['a code root with no activated payload', (mac) => rootHandler(mac), (roots) => registerInput(roots), 'PAYLOAD_MISSING', { withPayload: false }],
        ['a runtime user the directory does not know', (mac) => rootHandler(mac), (roots) => registerInput(roots, { runtimeUser: '_nobody1' }), 'RUNTIME_USER_MISSING'],
        ['a record that is not there', (mac) => rootHandler(mac), (roots) => registerInput(roots), 'INSTALLATION_MISMATCH', { recordId: null }]
    ])('%s is refused before anything is written or run', (_label, handlerFor, inputFor, code, installOptions = {}) => {
        const mac = makeMac({ users: [GOOBSTER] });
        const roots = makeInstallation(mac, installOptions);
        expect(thrown(() => handlerFor(mac).handle('service.register', inputFor(roots)))).toMatchObject({ code });
        expect(mac.commands()).toEqual([]);
        expect(fs.readdirSync(mac.daemonDir)).toEqual([]);
    });

    test('a data root the service account cannot reach is named, with the fix', () => {
        const mac = makeMac({ users: [GOOBSTER] });
        const roots = makeInstallation(mac);
        const closed = path.dirname(roots.data);
        const handler = rootHandler(mac, { fs: sealedFs({ statSync: (file) => (file === closed ? { mode: 0o40700, uid: 0, gid: 0 } : null) }) });
        const error = thrown(() => handler.handle('service.register', registerInput(roots)));
        expect(error).toMatchObject({ code: 'ROOT_NOT_REACHABLE' });
        expect(error.message).toContain(`chmod o+x '${closed}'`);
        expect(mac.commands()).toEqual([]);
    });

    test('a code root the account could replace is refused (the daemon must not run code others can rewrite)', () => {
        const mac = makeMac({ users: [GOOBSTER] });
        const roots = makeInstallation(mac);
        const handler = rootHandler(mac, { fs: sealedFs({ statSync: (file) => (file === roots.code ? { uid: 300 } : null) }) });
        expect(thrown(() => handler.handle('service.register', registerInput(roots)))).toMatchObject({ code: 'CODE_ROOT_NOT_SEALED' });
        const writable = rootHandler(mac, { fs: sealedFs({ statSync: (file) => (file === roots.code ? { mode: 0o40777 } : null) }) });
        expect(thrown(() => writable.handle('service.register', registerInput(roots)))).toMatchObject({ code: 'CODE_ROOT_NOT_SEALED' });
    });

    test('no launchctl on the machine: LAUNCHD_UNAVAILABLE', () => {
        const mac = makeMac({ users: [GOOBSTER], withLaunchctl: false });
        const roots = makeInstallation(mac);
        expect(thrown(() => rootHandler(mac).handle('service.register', registerInput(roots)))).toMatchObject({ code: 'LAUNCHD_UNAVAILABLE' });
    });

    test('a launchctl that fails to bootstrap is a COMMAND_FAILED refusal with the reason, and the log keeps the steps', () => {
        const mac = makeMac({ users: [GOOBSTER] });
        const roots = makeInstallation(mac);
        mac.state.failures['launchctl bootstrap'] = 5;
        const error = thrown(() => rootHandler(mac).handle('service.register', registerInput(roots)));
        expect(error).toMatchObject({ code: 'COMMAND_FAILED' });
        expect(error.log.join('\n')).toContain('plist written');
    });

    test('a non-launchd kind is not this platform\'s', () => {
        const mac = makeMac({ users: [GOOBSTER] });
        const roots = makeInstallation(mac);
        expect(thrown(() => rootHandler(mac).handle('service.register', registerInput(roots, { kind: 'systemd' })))).toMatchObject({ code: 'NOT_IMPLEMENTED' });
    });
});

describe('service.register: the person\'s agent', () => {
    const personRoots = (mac) => makeInstallation(mac, { under: path.join(mac.base, 'Users', 'alice', 'Library', 'Application Support', 'Goobster') });
    const agentInput = (roots, extra = {}) => registerInput(roots, { scope: 'user', runtimeUser: 'alice', ...extra });

    test('writes the plist in the person\'s LaunchAgents and bootstraps into gui/<uid>, with no chown and no administrator step', () => {
        const mac = makeMac({ users: [ALICE] });
        const roots = personRoots(mac);
        const result = personHandler(mac).handle('service.register', agentInput(roots));
        const file = path.join(mac.agentDir, `${LABEL}.plist`);
        expect(result).toMatchObject({ outcome: 'done', detail: { scope: 'user', written: true, active: 'running' } });
        expect(mac.commands()).toEqual([
            'launchctl print gui/501',
            `launchctl print gui/501/${LABEL}`,
            `launchctl enable gui/501/${LABEL}`,
            `launchctl bootstrap gui/501 ${file}`,
            `launchctl print gui/501/${LABEL}`
        ]);
        const parsed = plist.parsePlist(fs.readFileSync(file, 'utf8'));
        expect(parsed).toMatchObject({ installationId: ID, user: null });
    });

    test('no login session for the person: the file is written and the agent loads at the next login', () => {
        const mac = makeMac({ users: [ALICE], domains: ['system'] });
        const roots = personRoots(mac);
        const result = personHandler(mac).handle('service.register', agentInput(roots));
        expect(result).toMatchObject({ outcome: 'done', detail: { active: 'loads at next login' } });
        expect(mac.commands().filter(line => line.includes('bootstrap'))).toEqual([]);
        expect(fs.existsSync(path.join(mac.agentDir, `${LABEL}.plist`))).toBe(true);
    });

    test('root does not register an agent, and nobody registers an agent for another account', () => {
        const mac = makeMac({ users: [ALICE, { name: 'bob', uid: 502, gid: 20, home: '/Users/bob' }] });
        const roots = personRoots(mac);
        expect(thrown(() => rootHandler(mac).handle('service.register', agentInput(roots)))).toMatchObject({ code: 'AGENT_AS_ROOT' });
        expect(thrown(() => personHandler(mac).handle('service.register', agentInput(roots, { runtimeUser: 'bob' })))).toMatchObject({ code: 'RUNTIME_USER_MISMATCH' });
        expect(fs.existsSync(mac.agentDir)).toBe(false);
    });

    test('a daemon of this installation blocks a second registration as an agent', () => {
        const mac = makeMac({ users: [ALICE] });
        const roots = personRoots(mac);
        const text = plist.renderPlist({ name: 'other', installationId: ID, runtimeUser: '_goobster', codeRoot: roots.code, roots, layout: 'standalone', mode: 'payload' });
        fs.writeFileSync(path.join(mac.daemonDir, 'io.goobster.other.plist'), text);
        expect(thrown(() => personHandler(mac).handle('service.register', agentInput(roots)))).toMatchObject({ code: 'SERVICE_DUPLICATE' });
    });
});

describe('service.unregister', () => {
    function registered(scopeIsMachine = true) {
        const mac = makeMac({ users: [GOOBSTER, ALICE] });
        const roots = scopeIsMachine ? makeInstallation(mac) : makeInstallation(mac, { under: path.join(mac.base, 'Users', 'alice', 'Goobster') });
        const handler = scopeIsMachine ? rootHandler(mac) : personHandler(mac);
        handler.handle('service.register', scopeIsMachine ? registerInput(roots) : registerInput(roots, { scope: 'user', runtimeUser: 'alice' }));
        mac.reset();
        return { mac, roots, handler };
    }
    const unregisterInput = (extra = {}) => ({ kind: 'launchd', name: 'goobster', registeredBy: 'installer', installationId: ID, ...extra });

    test('boots the daemon out, waits until it is gone, then removes only that file', () => {
        const { mac, handler } = registered(true);
        fs.writeFileSync(path.join(mac.daemonDir, 'com.example.other.plist'), 'x');
        const result = handler.handle('service.unregister', unregisterInput());
        expect(result).toMatchObject({ outcome: 'done', detail: { unit: `${LABEL}.plist`, removed: true, scope: 'machine' } });
        expect(mac.commands()).toEqual([`launchctl print system/${LABEL}`, `launchctl bootout system/${LABEL}`, `launchctl print system/${LABEL}`]);
        expect(fs.readdirSync(mac.daemonDir)).toEqual(['com.example.other.plist']);
    });

    test('an absent plist is a no-op, a foreign one is left alone', () => {
        const mac = makeMac();
        expect(rootHandler(mac).handle('service.unregister', unregisterInput())).toMatchObject({ outcome: 'noop', detail: { removed: false } });
        const file = path.join(mac.daemonDir, `${LABEL}.plist`);
        fs.writeFileSync(file, `<plist><dict><key>Label</key><string>${LABEL}</string></dict></plist>`);
        expect(thrown(() => rootHandler(mac).handle('service.unregister', unregisterInput()))).toMatchObject({ code: 'SERVICE_FOREIGN' });
        expect(fs.existsSync(file)).toBe(true);
        const other = makeMac();
        const roots = makeInstallation(other);
        fs.writeFileSync(path.join(other.daemonDir, `${LABEL}.plist`), plist.renderPlist({ name: 'goobster', installationId: OTHER_ID, runtimeUser: '_goobster', codeRoot: roots.code, roots, layout: 'standalone', mode: 'payload' }));
        expect(thrown(() => rootHandler(other).handle('service.unregister', unregisterInput()))).toMatchObject({ code: 'SERVICE_FOREIGN' });
        expect(other.commands()).toEqual([]);
    });

    test('a person cannot remove the daemon, and root does not look in a person\'s LaunchAgents', () => {
        const { mac } = registered(true);
        expect(thrown(() => personHandler(mac).handle('service.unregister', unregisterInput()))).toMatchObject({ code: 'NOT_ELEVATED' });
        expect(fs.existsSync(path.join(mac.daemonDir, `${LABEL}.plist`))).toBe(true);

        const agent = registered(false);
        const asRoot = rootHandler(agent.mac);
        expect(asRoot.handle('service.unregister', unregisterInput())).toMatchObject({ outcome: 'noop' });
        expect(fs.existsSync(path.join(agent.mac.agentDir, `${LABEL}.plist`))).toBe(true);
    });

    test('the person\'s own agent is booted out of gui/<uid> and removed', () => {
        const { mac, handler } = registered(false);
        const result = handler.handle('service.unregister', unregisterInput());
        expect(result).toMatchObject({ outcome: 'done', detail: { scope: 'user' } });
        expect(mac.commands()).toEqual([`launchctl print gui/501/${LABEL}`, `launchctl bootout gui/501/${LABEL}`, `launchctl print gui/501/${LABEL}`]);
        expect(fs.existsSync(path.join(mac.agentDir, `${LABEL}.plist`))).toBe(false);
    });

    test('a job that will not stop keeps its plist', () => {
        const { mac, handler } = registered(true);
        mac.state.stuck.add(`system/${LABEL}`);
        expect(thrown(() => handler.handle('service.unregister', unregisterInput()))).toMatchObject({ code: 'SERVICE_STILL_ACTIVE' });
        expect(fs.existsSync(path.join(mac.daemonDir, `${LABEL}.plist`))).toBe(true);
    });
});

describe('user.create', () => {
    const dsclCreates = (mac) => mac.argvOf('dscl').filter(args => args[1] === '-create').map(args => args.slice(2).join(' '));

    test('creates a hidden service group and account on the first free id in 200..400, then hands over exactly the mutable roots', () => {
        const mac = makeMac({
            users: [{ name: 'root', uid: 0, gid: 0, home: '/var/root' }, { name: '_one', uid: 200, gid: 1, home: '/var/empty' }, ALICE],
            groups: [{ name: '_two', gid: 202 }, { name: 'staff', gid: 20 }]
        });
        const roots = makeInstallation(mac);
        const result = rootHandler(mac).handle('user.create', userInput(roots));
        expect(result).toMatchObject({ outcome: 'done', detail: { user: '_goobster', created: true } });
        expect(dsclCreates(mac)).toEqual([
            '/Groups/_goobster',
            '/Groups/_goobster PrimaryGroupID 201',
            '/Groups/_goobster RealName Goobster',
            '/Groups/_goobster Password *',
            '/Users/_goobster',
            '/Users/_goobster UserShell /usr/bin/false',
            '/Users/_goobster RealName Goobster',
            '/Users/_goobster UniqueID 201',
            '/Users/_goobster PrimaryGroupID 201',
            `/Users/_goobster NFSHomeDirectory ${path.dirname(roots.data)}`,
            '/Users/_goobster IsHidden 1',
            '/Users/_goobster Password *'
        ]);
        const chowns = mac.argvOf('chown');
        expect(chowns.length).toBe(result.detail.roots);
        for (const args of chowns) expect(args.slice(0, 3)).toEqual(['-R', '-h', '_goobster:201']);
        const targets = chowns.map(args => args[4]);
        expect(targets).toEqual(expect.arrayContaining([roots.data, roots.cache, roots.logs]));
        expect(targets).not.toContain(roots.code);
    });

    test('an existing account is left alone: no directory writes, the roots are still handed over', () => {
        const mac = makeMac({ users: [GOOBSTER], groups: [{ name: '_goobster', gid: 300 }] });
        const roots = makeInstallation(mac);
        const result = rootHandler(mac).handle('user.create', userInput(roots));
        expect(result).toMatchObject({ outcome: 'noop', detail: { created: false } });
        expect(dsclCreates(mac)).toEqual([]);
        expect(mac.argvOf('chown').every(args => args[2] === '_goobster:300')).toBe(true);
    });

    test('missing roots are created private (0750) before they are handed over', () => {
        const mac = makeMac({ users: [GOOBSTER] });
        const roots = makeInstallation(mac);
        fs.rmSync(roots.cache, { recursive: true, force: true });
        rootHandler(mac).handle('user.create', userInput(roots));
        expect(fs.statSync(roots.cache).mode & 0o777).toBe(0o750);
    });

    test('an account whose record is incomplete, or is the superuser, changes nothing', () => {
        const incomplete = makeMac({ users: [{ name: '_goobster', home: '/x' }] });
        const rootsA = makeInstallation(incomplete);
        expect(thrown(() => rootHandler(incomplete).handle('user.create', userInput(rootsA)))).toMatchObject({ code: 'USER_INCOMPLETE' });
        const superuser = makeMac({ users: [{ name: '_goobster', uid: 0, gid: 0, home: '/var/root' }] });
        const rootsB = makeInstallation(superuser);
        expect(thrown(() => rootHandler(superuser).handle('user.create', userInput(rootsB)))).toMatchObject({ code: 'USER_REFUSED' });
        expect(superuser.argvOf('chown')).toEqual([]);
    });

    test('no free id between 200 and 400 is a refusal before anything is created', () => {
        const users = [];
        for (let id = 200; id <= 400; id++) users.push({ name: `_s${id}`, uid: id, gid: id, home: '/var/empty' });
        const mac = makeMac({ users });
        const roots = makeInstallation(mac);
        expect(thrown(() => rootHandler(mac).handle('user.create', userInput(roots)))).toMatchObject({ code: 'ACCOUNT_ID_EXHAUSTED' });
        expect(dsclCreates(mac)).toEqual([]);
    });

    test('a root that is, or holds, the asking person\'s home is refused before it is handed over', () => {
        const mac = makeMac({ users: [GOOBSTER] });
        const roots = makeInstallation(mac);
        mac.state.users.set('alice', { name: 'alice', uid: 501, gid: 20, home: roots.data });
        const error = thrown(() => rootHandler(mac).handle('user.create', userInput(roots)));
        expect(error).toMatchObject({ code: 'ROOT_IS_HOME' });
        expect(mac.argvOf('chown')).toEqual([]);
        const inner = makeMac({ users: [GOOBSTER] });
        const innerRoots = makeInstallation(inner);
        inner.state.users.set('alice', { name: 'alice', uid: 501, gid: 20, home: path.join(innerRoots.data, 'alice') });
        expect(thrown(() => rootHandler(inner).handle('user.create', userInput(innerRoots)))).toMatchObject({ code: 'ROOT_IS_HOME' });
    });

    test('a symbolic link or a root owned by someone else is never chowned', () => {
        const linked = makeMac({ users: [GOOBSTER] });
        const rootsA = makeInstallation(linked);
        const elsewhere = path.join(linked.base, 'elsewhere');
        fs.mkdirSync(elsewhere);
        fs.rmSync(rootsA.logs, { recursive: true, force: true });
        fs.symlinkSync(elsewhere, rootsA.logs);
        expect(thrown(() => rootHandler(linked).handle('user.create', userInput(rootsA)))).toMatchObject({ code: 'ROOT_IS_SYMLINK' });

        const foreign = makeMac({ users: [GOOBSTER] });
        const rootsB = makeInstallation(foreign);
        const handler = rootHandler(foreign, { fs: sealedFs({ lstatSync: (file) => (file === rootsB.data ? { uid: 777 } : null) }) });
        expect(thrown(() => handler.handle('user.create', userInput(rootsB)))).toMatchObject({ code: 'ROOT_NOT_OWNED' });
        expect(foreign.argvOf('chown').some(args => args.includes(rootsB.data))).toBe(false);
    });

    test('only root creates an account, and the record must name the installation', () => {
        const mac = makeMac({ users: [GOOBSTER] });
        const roots = makeInstallation(mac);
        expect(thrown(() => personHandler(mac).handle('user.create', userInput(roots)))).toMatchObject({ code: 'NOT_ELEVATED' });
        expect(thrown(() => rootHandler(mac).handle('user.create', userInput(roots, { installationId: OTHER_ID })))).toMatchObject({ code: 'INSTALLATION_MISMATCH' });
        expect(mac.commands()).toEqual([]);
    });

    test('a dscl that fails stops the creation with COMMAND_FAILED and the log of what ran', () => {
        const mac = makeMac();
        const roots = makeInstallation(mac);
        const original = mac.exec;
        const failing = (file, args) => (path.basename(file) === 'dscl' && args[1] === '-create' && args[2] === '/Users/_goobster' && args[3] === 'UserShell' ? { status: 40, stdout: '', stderr: 'eDSPermissionError\n' } : original(file, args));
        const error = thrown(() => rootHandler(mac, { exec: failing }).handle('user.create', userInput(roots)));
        expect(error).toMatchObject({ code: 'COMMAND_FAILED' });
        expect(error.message).toContain('eDSPermissionError');
    });
});

// ------------------------------------------------------ the manager's half
describe('elevation()', () => {
    const fsWith = (...present) => ({ ...fs, accessSync: (file, mode) => { if (!present.includes(file)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); void mode; } });

    test('root needs nothing; a per-user registration needs nothing', () => {
        expect(darwin.elevation({ euid: 0 })).toEqual({ kind: 'root', prefix: [] });
        expect(darwin.elevation({ euid: 501, scope: 'user' })).toEqual({ kind: 'user', prefix: [] });
    });

    test('the request itself decides: a LaunchAgent registration or removal is the person\'s even with no sudo and no graphical session', () => {
        const probe = () => 1;
        const noTool = { euid: 501, fs: fsWith('/usr/bin/sudo'), probe, aqua: () => false };
        expect(darwin.elevation({ ...noTool, operation: 'service.register', input: { scope: 'user', name: 'goobster' } })).toEqual({ kind: 'user', prefix: [] });
        expect(darwin.elevation({ ...noTool, operation: 'service.register', input: { scope: 'machine', name: 'goobster' } })).toEqual({ kind: 'none', prefix: [], reason: 'NO_ELEVATION_TOOL' });
        expect(darwin.elevation({ ...noTool, operation: 'service.register', input: { name: 'goobster' } })).toEqual({ kind: 'none', prefix: [], reason: 'NO_ELEVATION_TOOL' });
        expect(darwin.elevation({ ...noTool, operation: 'user.create', input: { name: '_goobster' } })).toEqual({ kind: 'none', prefix: [], reason: 'NO_ELEVATION_TOOL' });
        const emptyDaemons = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-daemons-'));
        expect(darwin.elevation({ ...noTool, operation: 'service.unregister', input: { name: 'goobster' }, daemonDir: emptyDaemons })).toEqual({ kind: 'user', prefix: [] });
        fs.writeFileSync(path.join(emptyDaemons, 'io.goobster.goobster.plist'), '<plist/>');
        expect(darwin.elevation({ ...noTool, operation: 'service.unregister', input: { name: 'goobster' }, daemonDir: emptyDaemons })).toEqual({ kind: 'none', prefix: [], reason: 'NO_ELEVATION_TOOL' });
        fs.rmSync(emptyDaemons, { recursive: true, force: true });
    });

    test('sudo that answers without a password is used, with a fixed prefix', () => {
        const probe = jest.fn(() => 0);
        const plan = darwin.elevation({ euid: 501, fs: fsWith('/usr/bin/sudo'), probe, aqua: () => true });
        expect(plan).toEqual({ kind: 'sudo', prefix: ['/usr/bin/sudo', '-n', '--'] });
        expect(probe).toHaveBeenCalledWith('/usr/bin/sudo', ['-n', 'true']);
    });

    test('with no passwordless sudo, a graphical session gets the administrator prompt; otherwise there is no way', () => {
        const probe = () => 1;
        expect(darwin.elevation({ euid: 501, fs: fsWith('/usr/bin/sudo'), probe, aqua: () => true })).toEqual({ kind: 'osascript', prefix: [] });
        expect(darwin.elevation({ euid: 501, fs: fsWith(), probe, aqua: () => true })).toEqual({ kind: 'osascript', prefix: [] });
        expect(darwin.elevation({ euid: 501, fs: fsWith('/usr/bin/sudo'), probe, aqua: () => false })).toEqual({ kind: 'none', prefix: [], reason: 'NO_ELEVATION_TOOL' });
        expect(darwin.elevation({ euid: 501, env: { SECURITYSESSIONID: '186a7' }, fs: fsWith(), probe })).toEqual({ kind: 'osascript', prefix: [] });
    });

    test('the by-hand command quotes both paths and reads the request from a file', () => {
        expect(darwin.manualCommand({ nodePath: '/opt/g o/node', helperPath: "/opt/it's/helper.js", requestFile: '/tmp/r q.json' }))
            .toBe("sudo '/opt/g o/node' '/opt/it'\\''s/helper.js' < '/tmp/r q.json'");
    });
});

describe('serviceFacts()', () => {
    const fsWith = (...present) => ({ ...fs, accessSync: (file) => { if (!present.includes(file)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); } });

    test('launchd is available when the system domain answers, or at least the manager name does; otherwise LAUNCHD_UNAVAILABLE', () => {
        const calls = [];
        const exec = (answers) => (file, args) => { calls.push([file, ...args]); return answers[args[0]] || { status: 1, stdout: '' }; };
        expect(darwin.serviceFacts({ fs: fsWith('/bin/launchctl'), exec: exec({ print: { status: 0, stdout: '' } }) })).toEqual({ available: true, state: 'system', reason: null });
        expect(darwin.serviceFacts({ fs: fsWith('/bin/launchctl'), exec: exec({ managername: { status: 0, stdout: 'Aqua\n' } }) })).toEqual({ available: true, state: 'Aqua', reason: null });
        expect(darwin.serviceFacts({ fs: fsWith('/bin/launchctl'), exec: exec({}) })).toEqual({ available: false, state: null, reason: 'LAUNCHD_UNAVAILABLE' });
        expect(darwin.serviceFacts({ fs: fsWith(), exec: exec({}) })).toEqual({ available: false, state: null, reason: 'LAUNCHD_UNAVAILABLE' });
        expect(calls[0]).toEqual(['/bin/launchctl', 'print', 'system']);
    });
});

describe('the administrator prompt command', () => {
    test('is one fixed osascript line built from absolute, single-quoted paths and an integer', () => {
        const argv = darwin.osascriptCommand({ nodePath: '/opt/goobster/current/runtime/bin/node', helperPath: '/opt/goobster/current/app/apps/manager/privileged/helper.js', requestFile: '/Users/a/Library/Application Support/Goobster/requests/r.json', replyFile: '/Users/a/Library/Application Support/Goobster/requests/p.json', uid: 501 });
        expect(argv).toHaveLength(2);
        expect(argv[0]).toBe('-e');
        expect(argv[1]).toBe('do shell script "GOOBSTER_INVOKER_UID=501 \'/opt/goobster/current/runtime/bin/node\' \'/opt/goobster/current/app/apps/manager/privileged/helper.js\' --request \'/Users/a/Library/Application Support/Goobster/requests/r.json\' --reply \'/Users/a/Library/Application Support/Goobster/requests/p.json\'" with administrator privileges');
    });

    test('a quote or a backslash in a path is escaped for the shell and for AppleScript, never passed raw', () => {
        const [, script] = darwin.osascriptCommand({ nodePath: '/n/it\'s "x" \\y', helperPath: '/h.js', requestFile: '/r.json', replyFile: '/p.json', uid: 0 });
        expect(script).toContain('\'/n/it\'\\\\\'\'s \\"x\\" \\\\y\'');
    });

    test.each([
        ['a relative path', { nodePath: 'node' }],
        ['a path with a newline', { requestFile: '/r\n.json' }],
        ['a path with a control character', { replyFile: '/p\u0001.json' }],
        ['a path of absurd length', { helperPath: `/${'a'.repeat(2000)}` }],
        ['a non-integer uid', { uid: '501; rm -rf /' }],
        ['a negative uid', { uid: -1 }]
    ])('%s is refused', (_label, patch) => {
        const params = { nodePath: '/n', helperPath: '/h.js', requestFile: '/r.json', replyFile: '/p.json', uid: 501, ...patch };
        expect(() => darwin.osascriptCommand(params)).toThrow();
    });
});

// ------------------------------------------------------------- transport
function fakeChild() {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = jest.fn();
    return child;
}

/** A fake spawn: `behave(file, args, child, seen)` decides what the program does. */
function fakeSpawn(behave, seen = []) {
    return (file, args, options) => {
        const child = fakeChild();
        const record = { file, args, options, stdin: '' };
        seen.push(record);
        child.stdin.on('data', chunk => { record.stdin += chunk; });
        setImmediate(() => behave(record, child));
        return child;
    };
}

const closeWith = (child, status, stdout = '', stderr = '') => {
    child.stdout.end(stdout);
    child.stderr.end(stderr);
    setImmediate(() => child.emit('close', status, null));
};

describe('transport()', () => {
    const roots = (() => {
        const out = {};
        for (const role of protocol.ROOT_ROLES) out[role] = `/opt/goobster/${role}`;
        return out;
    })();
    const request = (operation = 'service.register', input = registerInput(roots)) => protocol.buildRequest(operation, input);

    function setup() {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-requests-'));
        cleanup.push(dir);
        return { dir, requestDir: path.join(dir, 'requests') };
    }

    test('an administrator prompt carries the request in a 0600 file, the reply in a pre-created 0600 file, and deletes both', async () => {
        const { requestDir } = setup();
        const seen = [];
        const during = {};
        const reply = `${JSON.stringify(protocol.okReply('service.register', 'done', { unit: `${LABEL}.plist` }, ['plist written']))}\n`;
        const spawn = fakeSpawn((record, child) => {
            const [, requestFile, replyFile] = /--request '([^']+)' --reply '([^']+)'/.exec(record.args[1]);
            during.request = fs.readFileSync(requestFile, 'utf8');
            during.requestMode = fs.statSync(requestFile).mode & 0o777;
            during.replyMode = fs.statSync(replyFile).mode & 0o777;
            during.replyOwner = fs.statSync(replyFile).uid;
            during.replyBefore = fs.readFileSync(replyFile, 'utf8');
            fs.writeFileSync(replyFile, reply);
            during.files = [requestFile, replyFile];
            closeWith(child, 0, '');
        }, seen);
        const result = await darwin.transport({ plan: { kind: 'osascript', prefix: [] }, request: request(), nodePath: '/opt/goobster/current/runtime/bin/node', helperPath: '/opt/goobster/current/app/apps/manager/privileged/helper.js', requestDir, spawn, timeoutMs: 1000, uid: process.getuid() });
        expect(seen).toHaveLength(1);
        expect(seen[0].file).toBe('/usr/bin/osascript');
        expect(seen[0].args[0]).toBe('-e');
        expect(seen[0].args[1]).toContain(`GOOBSTER_INVOKER_UID=${process.getuid()}`);
        expect(seen[0].args[1]).toContain('with administrator privileges');
        expect(seen[0].stdin).toBe('');
        expect(during.request.trim()).toBe(request());
        expect(during.requestMode).toBe(0o600);
        expect(during.replyMode).toBe(0o600);
        expect(during.replyOwner).toBe(process.getuid());
        expect(during.replyBefore).toBe('');
        expect(result.stdout).toBe(reply);
        expect(result.status).toBe(0);
        for (const file of during.files) expect(fs.existsSync(file)).toBe(false);
        expect(fs.readdirSync(requestDir)).toEqual([]);
    });

    test('a request or reply file that was swapped for a link before the prompt is never handed to root', async () => {
        const { dir, requestDir } = setup();
        const target = path.join(dir, 'victim');
        fs.writeFileSync(target, 'keep');
        const realFs = { ...fs, writeSync: fs.writeSync };
        const swapping = { ...realFs, lstatSync: (file) => { const stat = fs.lstatSync(file); return /reply\.json$/.test(file) ? new Proxy(stat, { get: (t, key) => (key === 'isSymbolicLink' ? () => true : (typeof t[key] === 'function' ? t[key].bind(t) : t[key])) }) : stat; } };
        const spawn = jest.fn();
        const result = await darwin.transport({ plan: { kind: 'osascript', prefix: [] }, request: request(), nodePath: '/n', helperPath: '/h.js', requestDir, spawn, fs: swapping, timeoutMs: 1000, uid: process.getuid() });
        expect(result.spawnError).toBe('REQUEST_FILE_CHANGED');
        expect(spawn).not.toHaveBeenCalled();
        expect(fs.readFileSync(target, 'utf8')).toBe('keep');
        expect(fs.readdirSync(requestDir)).toEqual([]);
    });

    test('a dismissed prompt leaves no reply, no file, and is read as ELEVATION_DECLINED', async () => {
        const { requestDir } = setup();
        const spawn = fakeSpawn((record, child) => closeWith(child, 1, '', '0:44: execution error: User canceled. (-128)\n'));
        const result = await darwin.transport({ plan: { kind: 'osascript', prefix: [] }, request: request(), nodePath: '/n', helperPath: '/h.js', requestDir, spawn, timeoutMs: 1000, uid: process.getuid() });
        expect(result.stdout).toBe('');
        expect(fs.readdirSync(requestDir)).toEqual([]);
        expect(darwin.refusal({ plan: { kind: 'osascript' }, status: result.status, stderr: result.stderr })).toEqual({ reason: 'ELEVATION_DECLINED' });
    });

    test('root and sudo pass the request on stdin like every other platform; sudo is prefixed', async () => {
        const seen = [];
        const reply = JSON.stringify(protocol.okReply('service.register', 'done', {}, []));
        const spawn = fakeSpawn((record, child) => closeWith(child, 0, reply), seen);
        await darwin.transport({ plan: { kind: 'sudo', prefix: ['/usr/bin/sudo', '-n', '--'] }, request: request(), nodePath: '/n', helperPath: '/h.js', spawn, timeoutMs: 1000 });
        await darwin.transport({ plan: { kind: 'root', prefix: [] }, request: request(), nodePath: '/n', helperPath: '/h.js', spawn, timeoutMs: 1000 });
        expect([seen[0].file, ...seen[0].args]).toEqual(['/usr/bin/sudo', '-n', '--', '/n', '/h.js']);
        expect([seen[1].file, ...seen[1].args]).toEqual(['/n', '/h.js']);
        expect(JSON.parse(seen[0].stdin).operation).toBe('service.register');
    });

    test('a per-user registration runs the helper as the person with no elevation at all, even when an administrator prompt is available', async () => {
        const seen = [];
        const spawn = fakeSpawn((record, child) => closeWith(child, 0, '{}'), seen);
        await darwin.transport({ plan: { kind: 'osascript', prefix: [] }, request: request('service.register', registerInput(roots, { scope: 'user', runtimeUser: 'alice' })), nodePath: '/n', helperPath: '/h.js', spawn, timeoutMs: 1000 });
        expect([seen[0].file, ...seen[0].args]).toEqual(['/n', '/h.js']);
        const unregister = { kind: 'launchd', name: 'goobster', registeredBy: 'installer', installationId: ID };
        const noDaemon = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-nodaemon-'));
        cleanup.push(noDaemon);
        await darwin.transport({ plan: { kind: 'osascript', prefix: [] }, request: request('service.unregister', unregister), nodePath: '/n', helperPath: '/h.js', spawn, timeoutMs: 1000, daemonDir: noDaemon });
        expect(seen[1].file).toBe('/n');
    });

    test('work that needs root with no way to get it is reported as unavailable, not attempted', async () => {
        const spawn = jest.fn();
        const result = await darwin.transport({ plan: { kind: 'user', prefix: [] }, request: request(), nodePath: '/n', helperPath: '/h.js', spawn, timeoutMs: 1000 });
        expect(spawn).not.toHaveBeenCalled();
        expect(result).toMatchObject({ status: 126, stdout: '' });
        expect(darwin.refusal({ plan: { kind: 'user' }, stderr: result.stderr })).toEqual({ reason: 'ELEVATION_UNAVAILABLE' });
    });

    test('needsRoot: a machine job, an account and a daemon removal need root; an agent and an absent daemon do not', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-daemons-'));
        cleanup.push(dir);
        expect(darwin.needsRoot({ operation: 'service.register', input: { scope: 'machine' } })).toBe(true);
        expect(darwin.needsRoot({ operation: 'service.register', input: {} })).toBe(true);
        expect(darwin.needsRoot({ operation: 'service.register', input: { scope: 'user' } })).toBe(false);
        expect(darwin.needsRoot({ operation: 'user.create', input: {} })).toBe(true);
        expect(darwin.needsRoot({ operation: 'service.unregister', input: { name: 'goobster' } }, { daemonDir: dir })).toBe(false);
        fs.writeFileSync(path.join(dir, `${LABEL}.plist`), 'x');
        expect(darwin.needsRoot({ operation: 'service.unregister', input: { name: 'goobster' } }, { daemonDir: dir })).toBe(true);
    });
});

describe('refusal()', () => {
    test.each([
        ['osascript', 'execution error: User canceled. (-128)', 'ELEVATION_DECLINED'],
        ['osascript', 'execution error: The administrator user name or password was incorrect. (-60007)', 'ELEVATION_REFUSED'],
        ['osascript', 'execution error: Authorization failed (-60005)', 'ELEVATION_REFUSED'],
        ['sudo', 'sudo: a password is required', 'ELEVATION_REFUSED'],
        ['sudo', 'sudo: sorry, you are not allowed to run sudo on this host', 'ELEVATION_REFUSED'],
        ['sudo', 'sudo: a terminal is required to read the password', 'ELEVATION_REFUSED']
    ])('%s saying "%s" is %s', (kind, stderr, reason) => {
        expect(darwin.refusal({ plan: { kind }, stderr })).toEqual({ reason });
    });

    test('anything else is not a refusal: a crashed helper stays a protocol failure', () => {
        expect(darwin.refusal({ plan: { kind: 'sudo' }, stderr: 'Segmentation fault' })).toBeNull();
        expect(darwin.refusal({ plan: { kind: 'root' }, stderr: 'User canceled' })).toBeNull();
        expect(darwin.refusal({ plan: null, stderr: '' })).toBeNull();
    });
});

describe('the runner end to end with a fake administrator prompt', () => {
    const roots = (() => {
        const out = {};
        for (const role of protocol.ROOT_ROLES) out[role] = `/opt/goobster/${role}`;
        return out;
    })();

    test('a machine registration through osascript returns the helper\'s reply, scrubbed of the request\'s paths', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-e2e-'));
        cleanup.push(dir);
        const requestDir = path.join(dir, 'requests');
        const seen = [];
        const spawn = fakeSpawn((record, child) => {
            const replyFile = /--reply '([^']+)'/.exec(record.args[1])[1];
            fs.writeFileSync(replyFile, `${JSON.stringify(protocol.okReply('service.register', 'done', { unit: `${LABEL}.plist` }, [`plist written ${roots.code}/x`, 'launchctl bootstrap system -> 0']))}\n`);
            closeWith(child, 0, '');
        }, seen);
        const result = await elevate.runHelper({
            operation: 'service.register',
            input: registerInput(roots),
            implementation: darwin,
            spawn,
            elevation: { kind: 'osascript', prefix: [] },
            facts: { available: true },
            requestDir,
            nodePath: '/opt/goobster/code/current/runtime/bin/node',
            helperPath: '/opt/goobster/code/current/app/apps/manager/privileged/helper.js',
            env: { PATH: '/usr/bin', OPENAI_API_KEY: 'sk-secret' }
        });
        expect(result).toMatchObject({ status: 'done', outcome: 'done', via: 'osascript' });
        expect(seen[0].file).toBe('/usr/bin/osascript');
        expect(JSON.stringify(seen[0])).not.toContain('sk-secret');
        expect(result.log.join('\n')).not.toContain(roots.code);
        expect(fs.readdirSync(requestDir)).toEqual([]);
    });

    test('a dismissed prompt is a fallback the engine turns into the manual path, with no failure', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-e2e-'));
        cleanup.push(dir);
        const spawn = fakeSpawn((record, child) => closeWith(child, 1, '', 'execution error: User canceled. (-128)'));
        const result = await elevate.runHelper({ operation: 'service.register', input: registerInput(roots), implementation: darwin, spawn, elevation: { kind: 'osascript', prefix: [] }, facts: { available: true }, requestDir: path.join(dir, 'requests') });
        expect(result).toMatchObject({ status: 'fallback', reason: 'ELEVATION_DECLINED' });
    });

    test('with no elevation at all the request waits in a 0600 file with the exact command to run it by hand', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-e2e-'));
        cleanup.push(dir);
        const requestDir = path.join(dir, 'requests');
        const spawn = jest.fn();
        const result = await elevate.runHelper({ operation: 'service.register', input: registerInput(roots), implementation: darwin, spawn, elevation: { kind: 'none', prefix: [], reason: 'NO_ELEVATION_TOOL' }, facts: { available: true }, requestDir, nodePath: '/n', helperPath: '/h.js' });
        expect(spawn).not.toHaveBeenCalled();
        expect(result).toMatchObject({ status: 'fallback', reason: 'ELEVATION_UNAVAILABLE', detail: { why: 'NO_ELEVATION_TOOL' } });
        const file = path.join(requestDir, 'service.register.request.json');
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
        expect(result.manual).toBe(`sudo '/n' '/h.js' < '${file}'`);
    });

    test('launchd absent: the registration is a fallback before any prompt', async () => {
        const spawn = jest.fn();
        const result = await elevate.runHelper({ operation: 'service.register', input: registerInput(roots), implementation: darwin, spawn, elevation: { kind: 'osascript', prefix: [] }, facts: { available: false, reason: 'LAUNCHD_UNAVAILABLE' } });
        expect(result).toMatchObject({ status: 'fallback', reason: 'LAUNCHD_UNAVAILABLE' });
        expect(spawn).not.toHaveBeenCalled();
    });
});
