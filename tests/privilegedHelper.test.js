/**
 * The privileged helper (#333, documentation/linux_install.md "Elevation"):
 * the stdin/stdout JSON protocol and its strict validation, every Linux
 * operation against fake `systemctl` / `useradd` / `getent` / `chown`
 * programs on a private PATH, the refusals (a foreign unit is never
 * overwritten, a duplicate is refused, an unowned root is never chowned),
 * idempotent re-runs, the manager-side runner (fallbacks, hash verification,
 * nothing on argv or in the environment, a scrubbed journal), and the
 * helper's code closure (node built-ins plus its own four files).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');

const protocol = require('@goobster/manager/privileged/protocol');
const helper = require('@goobster/manager/privileged/helper');
const linux = require('@goobster/manager/privileged/linux');
const elevate = require('@goobster/manager/privileged/elevate');
const privileged = require('@goobster/manager/privileged');
const unitText = require('@goobster/manager/platform/systemdUnit');

const INSTALLATION_ID = '0b9f3c1e-6a58-4c1e-9d5f-2f3b1c0a7e11';
const OTHER_ID = '7d7d7d7d-1111-4222-8333-444455556666';
const cleanup = [];

afterAll(() => {
    for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
});

function makeSandbox() {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-helper-'));
    cleanup.push(base);
    const fake = path.join(base, 'fake');
    const bin = path.join(base, 'bin');
    const unitDir = path.join(base, 'etc', 'systemd', 'system');
    const cronDir = path.join(base, 'etc', 'cron.d');
    for (const dir of [fake, bin, unitDir, cronDir]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(fake, 'passwd'), '');
    const script = (name, body) => {
        fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nPATH=/usr/bin:/bin\n${body}\n`, { mode: 0o755 });
    };
    script('getent', `grep -E "^$2:|^[^:]*:[^:]*:$2:" "${fake}/passwd"`);
    script('useradd', `for last; do :; done\necho "useradd $*" >> "${fake}/commands.log"\necho "$last:x:990:990::/nonexistent:/usr/sbin/nologin" >> "${fake}/passwd"`);
    script('chown', `echo "chown $*" >> "${fake}/commands.log"`);
    script('systemctl', [
        `echo "systemctl $*" >> "${fake}/commands.log"`,
        'case "$1" in',
        `  enable) [ -e "${fake}/stuck" ] || : > "${fake}/active" ;;`,
        `  disable) [ -e "${fake}/stuck" ] || rm -f "${fake}/active" ;;`,
        `  is-active) if [ -e "${fake}/active" ]; then echo active; exit 0; else echo inactive; exit 3; fi ;;`,
        `  is-enabled) if [ -e "${fake}/enabled" ]; then echo enabled; exit 0; else echo disabled; exit 1; fi ;;`,
        `  show) prop=$(echo "$3" | sed 's/--property=//'); [ -e "${fake}/prop-$2-$prop" ] && cat "${fake}/prop-$2-$prop"; exit 0 ;;`,
        'esac',
        'exit 0'
    ].join('\n'));
    return { base, fake, bin, unitDir, cronDir, commands: () => (fs.existsSync(path.join(fake, 'commands.log')) ? fs.readFileSync(path.join(fake, 'commands.log'), 'utf8').split('\n').filter(Boolean) : []) };
}

function makeInstallation(sandbox, { withPayload = true, recordId = INSTALLATION_ID } = {}) {
    const root = path.join(sandbox.base, 'opt', 'goobster test');
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

function registerInput(roots, extra = {}) {
    return { kind: 'systemd', name: 'goobster', layout: 'standalone', codeRoot: roots.code, runtimeUser: 'goobster', installationId: INSTALLATION_ID, roots, mode: 'payload', ...extra };
}

function userInput(roots, extra = {}) {
    return { name: 'goobster', home: path.dirname(roots.data), system: true, installationId: INSTALLATION_ID, roots, mode: 'payload', ...extra };
}

function depsFor(sandbox, extra = {}) {
    return { sandbox: true, unitDir: sandbox.unitDir, cronDir: sandbox.cronDir, updateConf: path.join(sandbox.base, 'etc', 'goobster-update.conf'), commandDirs: [sandbox.bin], ...extra };
}

function call(sandbox, operation, input, extra = {}) {
    return helper.execute(protocol.buildRequest(operation, input), { platform: 'linux', deps: depsFor(sandbox, extra) });
}

describe('protocol validation', () => {
    const roots = (() => {
        const out = {};
        for (const role of protocol.ROOT_ROLES) out[role] = `/srv/data/goobster/${role}`;
        return out;
    })();
    const valid = registerInput(roots);

    test('a well-formed request parses and round-trips', () => {
        const parsed = protocol.parseRequest(protocol.buildRequest('service.register', valid));
        expect(parsed.operation).toBe('service.register');
        expect(parsed.input.roots.managerStore).toBe(roots.managerStore);
    });

    test.each([
        ['an empty request', '', 'INVALID_REQUEST'],
        ['text that is not JSON', 'sudo rm -rf /', 'INVALID_REQUEST'],
        ['a different protocol version', JSON.stringify({ v: 2, operation: 'user.create', input: {} }), 'INVALID_REQUEST'],
        ['an extra top-level field', JSON.stringify({ v: 1, operation: 'package.install', input: { names: [] }, shell: 'x' }), 'INVALID_INPUT'],
        ['an unknown operation', JSON.stringify({ v: 1, operation: 'shell.exec', input: {} }), 'UNKNOWN_OPERATION'],
        ['an oversized request', JSON.stringify({ v: 1, operation: 'package.install', input: { names: ['a'.repeat(70000)] } }), 'INVALID_REQUEST']
    ])('%s is refused', (_label, text, code) => {
        expect(() => protocol.parseRequest(text)).toThrow(expect.objectContaining({ code }));
    });

    const mutate = (fn) => {
        const copy = JSON.parse(JSON.stringify(valid));
        fn(copy);
        return protocol.buildRequest('service.register', copy);
    };

    test.each([
        ['a field the operation does not accept', input => { input.extra = 1; }, 'INVALID_INPUT'],
        ['a service name with upper case', input => { input.name = 'Goobster'; }, 'INVALID_INPUT'],
        ['a service name with a dot', input => { input.name = 'goobster.service'; }, 'INVALID_INPUT'],
        ['a service name starting with a digit', input => { input.name = '1goobster'; }, 'INVALID_INPUT'],
        ['a service name over 32 characters', input => { input.name = 'a'.repeat(33); }, 'INVALID_INPUT'],
        ['an unknown service kind', input => { input.kind = 'sysvinit'; }, 'INVALID_INPUT'],
        ['a layout that does not exist', input => { input.layout = 'cluster'; }, 'INVALID_INPUT'],
        ['a runtime user that is root', input => { input.runtimeUser = 'root'; }, 'USER_REFUSED'],
        ['a runtime user with a space', input => { input.runtimeUser = 'a b'; }, 'INVALID_INPUT'],
        ['an installation id that is not a uuid', input => { input.installationId = 'abc'; }, 'INVALID_INPUT'],
        ['a relative code root', input => { input.codeRoot = 'goobster'; input.roots.code = 'goobster'; }, 'INVALID_PATH'],
        ['a code root that differs from the roots', input => { input.codeRoot = '/srv/data/other'; }, 'INVALID_INPUT'],
        ['a path with a quote', input => { input.roots.data = '/srv/data/"x'; }, 'INVALID_PATH'],
        ['a path with a dollar sign', input => { input.roots.data = '/srv/data/$HOME'; }, 'INVALID_PATH'],
        ['a path with a percent sign', input => { input.roots.data = '/srv/data/%h'; }, 'INVALID_PATH'],
        ['a path with a newline', input => { input.roots.data = '/srv/data/a\nExecStartPre=/bin/sh'; }, 'INVALID_PATH'],
        ['a path with a backslash', input => { input.roots.data = '/srv/data/a\\b'; }, 'INVALID_PATH'],
        ['a path that is not normalised', input => { input.roots.data = '/srv/data/../etc'; }, 'INVALID_PATH'],
        ['a path with a trailing slash', input => { input.roots.data = '/srv/data/x/'; }, 'INVALID_PATH'],
        ['a data root inside /etc', input => { input.roots.data = '/etc/goobster/data'; }, 'PATH_NOT_ALLOWED'],
        ['a data root that is /usr/lib', input => { input.roots.data = '/usr/lib'; }, 'PATH_NOT_ALLOWED'],
        ['a data root that is /var', input => { input.roots.data = '/var'; }, 'PATH_NOT_ALLOWED'],
        ['a root one level below the file system root', input => { input.roots.data = '/data'; }, 'PATH_NOT_ALLOWED'],
        ['a roots object missing a role', input => { delete input.roots.uploads; }, 'INVALID_INPUT'],
        ['a roots object with an extra role', input => { input.roots.shadow = '/srv/data/x'; }, 'INVALID_INPUT']
    ])('%s is refused', (_label, fn, code) => {
        expect(() => protocol.parseRequest(mutate(fn))).toThrow(expect.objectContaining({ code }));
    });

    test('user.create only creates system accounts', () => {
        expect(() => protocol.validateInput('user.create', userInput(roots, { system: false }))).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
        expect(() => protocol.validateInput('user.create', userInput(roots, { name: 'root' }))).toThrow(expect.objectContaining({ code: 'USER_REFUSED' }));
    });

    test('service.unregister only takes a service the installer registered', () => {
        expect(() => protocol.validateInput('service.unregister', { kind: 'systemd', name: 'goobster', registeredBy: 'system', installationId: INSTALLATION_ID })).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
    });

    test('updater.disable takes a timer name or a cron file name, nothing else', () => {
        expect(() => protocol.validateInput('updater.disable', { mechanism: 'systemd-timer', unit: 'goobster-update.service', codeRoot: roots.code })).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
        expect(() => protocol.validateInput('updater.disable', { mechanism: 'cron-system', unit: '../shadow', codeRoot: roots.code })).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
        expect(protocol.validateInput('updater.disable', { mechanism: 'systemd-timer', unit: 'goobster-update.timer', codeRoot: roots.code }).unit).toBe('goobster-update.timer');
    });

    test('a reply that is not the one expected document is not data', () => {
        expect(protocol.parseReply('hello', 'user.create')).toBeNull();
        expect(protocol.parseReply(JSON.stringify(protocol.okReply('service.register', 'done')), 'user.create')).toBeNull();
        expect(protocol.parseReply(JSON.stringify(protocol.okReply('user.create', 'done', { a: 1 }, ['x'])), 'user.create')).toMatchObject({ ok: true, outcome: 'done' });
        expect(protocol.parseReply(JSON.stringify({ v: 1, ok: false, operation: 'user.create', code: 'bad code', message: 'm' }), 'user.create').code).toBe('HELPER_FAILED');
    });
});

describe('service.register / service.unregister', () => {
    test('writes the unit with the installation marker, reloads and enables it, and the unit is exactly the rendered one', () => {
        const sandbox = makeSandbox();
        const roots = makeInstallation(sandbox);
        fs.appendFileSync(path.join(sandbox.fake, 'passwd'), 'goobster:x:990:990::/nonexistent:/usr/sbin/nologin\n');

        const { reply, code } = call(sandbox, 'service.register', registerInput(roots));
        expect(code).toBe(0);
        expect(reply).toMatchObject({ ok: true, operation: 'service.register', outcome: 'done', detail: { unit: 'goobster.service', written: true, active: 'active' } });

        const unitFile = path.join(sandbox.unitDir, 'goobster.service');
        const text = fs.readFileSync(unitFile, 'utf8');
        expect(text).toBe(unitText.renderUnit({ name: 'goobster', installationId: INSTALLATION_ID, runtimeUser: 'goobster', codeRoot: roots.code, roots, layout: 'standalone', mode: 'payload' }));
        expect(unitText.parseUnit(text).installationId).toBe(INSTALLATION_ID);
        expect(fs.statSync(unitFile).mode & 0o777).toBe(0o644);
        expect(sandbox.commands()).toEqual(expect.arrayContaining(['systemctl daemon-reload', 'systemctl enable --now goobster.service']));
    });

    test('registering again changes nothing and does not duplicate the unit', () => {
        const sandbox = makeSandbox();
        const roots = makeInstallation(sandbox);
        fs.appendFileSync(path.join(sandbox.fake, 'passwd'), 'goobster:x:990:990::/nonexistent:/usr/sbin/nologin\n');
        call(sandbox, 'service.register', registerInput(roots));
        const before = fs.readdirSync(sandbox.unitDir);
        const again = call(sandbox, 'service.register', registerInput(roots));
        expect(again.reply).toMatchObject({ ok: true, outcome: 'noop', detail: { written: false } });
        expect(fs.readdirSync(sandbox.unitDir)).toEqual(before);
    });

    test('a unit that exists and is not ours is never overwritten', () => {
        const sandbox = makeSandbox();
        const roots = makeInstallation(sandbox);
        fs.appendFileSync(path.join(sandbox.fake, 'passwd'), 'goobster:x:990:990::/nonexistent:/usr/sbin/nologin\n');
        const unitFile = path.join(sandbox.unitDir, 'goobster.service');
        const legacy = '[Unit]\nDescription=legacy\n[Service]\nExecStart=/usr/bin/node /home/pi/goobster/apps/bot/index.js\n';
        fs.writeFileSync(unitFile, legacy);
        const { reply, code } = call(sandbox, 'service.register', registerInput(roots));
        expect(code).toBe(1);
        expect(reply).toMatchObject({ ok: false, code: 'SERVICE_FOREIGN' });
        expect(fs.readFileSync(unitFile, 'utf8')).toBe(legacy);
        expect(sandbox.commands()).toEqual([]);

        fs.writeFileSync(unitFile, `[Unit]\n${unitText.MARKER_KEY}=${OTHER_ID}\n[Service]\nExecStart=/bin/true\n`);
        expect(call(sandbox, 'service.register', registerInput(roots)).reply).toMatchObject({ ok: false, code: 'SERVICE_FOREIGN' });
    });

    test('another unit that carries this installation id is a duplicate and is refused', () => {
        const sandbox = makeSandbox();
        const roots = makeInstallation(sandbox);
        fs.appendFileSync(path.join(sandbox.fake, 'passwd'), 'goobster:x:990:990::/nonexistent:/usr/sbin/nologin\n');
        fs.writeFileSync(path.join(sandbox.unitDir, 'goobster-old.service'), `[Unit]\n${unitText.MARKER_KEY}=${INSTALLATION_ID}\n[Service]\nExecStart=/bin/true\n`);
        const { reply } = call(sandbox, 'service.register', registerInput(roots));
        expect(reply).toMatchObject({ ok: false, code: 'SERVICE_DUPLICATE' });
        expect(fs.existsSync(path.join(sandbox.unitDir, 'goobster.service'))).toBe(false);
    });

    test('the installation record must agree with the request', () => {
        const sandbox = makeSandbox();
        const roots = makeInstallation(sandbox, { recordId: OTHER_ID });
        fs.appendFileSync(path.join(sandbox.fake, 'passwd'), 'goobster:x:990:990::/nonexistent:/usr/sbin/nologin\n');
        expect(call(sandbox, 'service.register', registerInput(roots)).reply).toMatchObject({ ok: false, code: 'INSTALLATION_MISMATCH' });

        const none = makeSandbox();
        const noRecord = makeInstallation(none, { recordId: null });
        expect(call(none, 'service.register', registerInput(noRecord)).reply).toMatchObject({ ok: false, code: 'INSTALLATION_MISMATCH' });
    });

    test('refuses before the payload is activated and before the runtime user exists', () => {
        const sandbox = makeSandbox();
        const roots = makeInstallation(sandbox, { withPayload: false });
        fs.appendFileSync(path.join(sandbox.fake, 'passwd'), 'goobster:x:990:990::/nonexistent:/usr/sbin/nologin\n');
        expect(call(sandbox, 'service.register', registerInput(roots)).reply).toMatchObject({ code: 'PAYLOAD_MISSING' });

        const noUser = makeSandbox();
        const withPayload = makeInstallation(noUser);
        expect(call(noUser, 'service.register', registerInput(withPayload)).reply).toMatchObject({ code: 'RUNTIME_USER_MISSING' });
    });

    test('a root the runtime user cannot reach is refused with the directory to fix', () => {
        const sandbox = makeSandbox();
        const roots = makeInstallation(sandbox);
        fs.appendFileSync(path.join(sandbox.fake, 'passwd'), 'goobster:x:990:990::/nonexistent:/usr/sbin/nologin\n');
        const parent = path.dirname(roots.data);
        const mode = (value) => { for (const dir of [sandbox.base, path.join(sandbox.base, 'opt'), parent]) fs.chmodSync(dir, value); };
        mode(0o755);
        fs.chmodSync(parent, 0o700);
        const refused = call(sandbox, 'service.register', registerInput(roots), { checkReachability: true });
        expect(refused.reply).toMatchObject({ ok: false, code: 'ROOT_NOT_REACHABLE' });
        expect(refused.reply.message).toContain(parent);
        expect(fs.existsSync(path.join(sandbox.unitDir, 'goobster.service'))).toBe(false);

        fs.chmodSync(parent, 0o755);
        const accepted = call(sandbox, 'service.register', registerInput(roots), { checkReachability: true });
        expect(accepted.reply.ok).toBe(true);
    });

    test('a missing systemctl is reported, not guessed at', () => {
        const sandbox = makeSandbox();
        const roots = makeInstallation(sandbox);
        fs.appendFileSync(path.join(sandbox.fake, 'passwd'), 'goobster:x:990:990::/nonexistent:/usr/sbin/nologin\n');
        fs.rmSync(path.join(sandbox.bin, 'systemctl'));
        const { reply } = call(sandbox, 'service.register', registerInput(roots));
        expect(reply.ok).toBe(true);
        expect(reply.detail.active).toBe('unknown');
    });

    test('unregister removes only a unit carrying this installation id', () => {
        const sandbox = makeSandbox();
        const roots = makeInstallation(sandbox);
        fs.appendFileSync(path.join(sandbox.fake, 'passwd'), 'goobster:x:990:990::/nonexistent:/usr/sbin/nologin\n');
        call(sandbox, 'service.register', registerInput(roots));
        const unregister = { kind: 'systemd', name: 'goobster', registeredBy: 'installer', installationId: INSTALLATION_ID };

        const other = call(sandbox, 'service.unregister', { ...unregister, installationId: OTHER_ID });
        expect(other.reply).toMatchObject({ ok: false, code: 'SERVICE_FOREIGN' });
        expect(fs.existsSync(path.join(sandbox.unitDir, 'goobster.service'))).toBe(true);

        const done = call(sandbox, 'service.unregister', unregister);
        expect(done.reply).toMatchObject({ ok: true, outcome: 'done', detail: { removed: true } });
        expect(fs.existsSync(path.join(sandbox.unitDir, 'goobster.service'))).toBe(false);
        expect(sandbox.commands()).toEqual(expect.arrayContaining(['systemctl disable --now goobster.service']));

        const again = call(sandbox, 'service.unregister', unregister);
        expect(again.reply).toMatchObject({ ok: true, outcome: 'noop' });
    });

    test('a unit that does not stop is not removed', () => {
        const sandbox = makeSandbox();
        const roots = makeInstallation(sandbox);
        fs.appendFileSync(path.join(sandbox.fake, 'passwd'), 'goobster:x:990:990::/nonexistent:/usr/sbin/nologin\n');
        call(sandbox, 'service.register', registerInput(roots));
        fs.writeFileSync(path.join(sandbox.fake, 'stuck'), '');
        const { reply } = call(sandbox, 'service.unregister', { kind: 'systemd', name: 'goobster', registeredBy: 'installer', installationId: INSTALLATION_ID });
        expect(reply).toMatchObject({ ok: false, code: 'SERVICE_STILL_ACTIVE' });
        expect(fs.existsSync(path.join(sandbox.unitDir, 'goobster.service'))).toBe(true);
    });

    test('unregistering a service with no unit is a no-op, not an error', () => {
        const sandbox = makeSandbox();
        const roots = makeInstallation(sandbox);
        expect(roots).toBeTruthy();
        expect(call(sandbox, 'service.unregister', { kind: 'systemd', name: 'goobster', registeredBy: 'installer', installationId: INSTALLATION_ID }).reply).toMatchObject({ ok: true, outcome: 'noop' });
    });
});

describe('user.create', () => {
    test('creates a no-login system account only when it is absent and hands over exactly the mutable roots', () => {
        const sandbox = makeSandbox();
        const roots = makeInstallation(sandbox);
        const { reply, code } = call(sandbox, 'user.create', userInput(roots));
        expect(code).toBe(0);
        expect(reply).toMatchObject({ ok: true, outcome: 'done', detail: { user: 'goobster', created: true } });
        const commands = sandbox.commands();
        const useradd = commands.find(line => line.startsWith('useradd'));
        expect(useradd).toContain('--system');
        expect(useradd).toContain('--no-create-home');
        expect(useradd).toContain(`--home-dir ${path.dirname(roots.data)}`);
        expect(useradd).toMatch(/--shell \/usr\/sbin\/nologin|--shell \/sbin\/nologin|--shell \/usr\/bin\/false|--shell \/bin\/false/);
        const chowned = commands.filter(line => line.startsWith('chown')).map(line => line.split(' -- ')[1]);
        expect(chowned).toEqual(expect.arrayContaining([roots.data, roots.cache, roots.logs, roots.uploads, roots.managerStore]));
        expect(chowned).not.toContain(roots.code);
        for (const line of commands.filter(l => l.startsWith('chown'))) expect(line).toContain('-R -h goobster:');
    });

    test('an account that exists is not created again, and the roots are handed over again (idempotent)', () => {
        const sandbox = makeSandbox();
        const roots = makeInstallation(sandbox);
        call(sandbox, 'user.create', userInput(roots));
        const second = call(sandbox, 'user.create', userInput(roots));
        expect(second.reply).toMatchObject({ ok: true, outcome: 'noop', detail: { created: false } });
        expect(sandbox.commands().filter(line => line.startsWith('useradd'))).toHaveLength(1);
    });

    test('the superuser is never a runtime user', () => {
        const sandbox = makeSandbox();
        const roots = makeInstallation(sandbox);
        fs.appendFileSync(path.join(sandbox.fake, 'passwd'), 'toor:x:0:0::/root:/bin/sh\n');
        expect(call(sandbox, 'user.create', userInput(roots, { name: 'toor' })).reply).toMatchObject({ ok: false, code: 'USER_REFUSED' });
        expect(sandbox.commands().filter(line => line.startsWith('chown'))).toEqual([]);
    });

    test('a root that is a symbolic link is refused and nothing is handed over there', () => {
        const sandbox = makeSandbox();
        const roots = makeInstallation(sandbox);
        const elsewhere = path.join(sandbox.base, 'elsewhere');
        fs.mkdirSync(elsewhere);
        fs.rmSync(roots.logs, { recursive: true });
        fs.symlinkSync(elsewhere, roots.logs);
        const { reply } = call(sandbox, 'user.create', userInput(roots));
        expect(reply).toMatchObject({ ok: false, code: 'ROOT_IS_SYMLINK' });
        expect(sandbox.commands().filter(line => line.startsWith('chown')).some(line => line.includes(elsewhere))).toBe(false);
    });

    test('a root with a symbolic link above it is refused', () => {
        const sandbox = makeSandbox();
        const roots = makeInstallation(sandbox);
        const real = path.join(sandbox.base, 'real');
        fs.mkdirSync(path.join(real, 'cache'), { recursive: true });
        fs.symlinkSync(real, path.join(sandbox.base, 'link'));
        const viaLink = { ...roots, cache: path.join(sandbox.base, 'link', 'cache') };
        fs.writeFileSync(path.join(roots.managerStore, 'installation.json'), JSON.stringify({ installationId: INSTALLATION_ID, roots: viaLink }));
        expect(call(sandbox, 'user.create', userInput(viaLink)).reply).toMatchObject({ ok: false, code: 'ROOT_IS_SYMLINK' });
    });

    test('a root that is or holds the invoker\'s home directory is refused before any chown', () => {
        const sandbox = makeSandbox();
        const roots = makeInstallation(sandbox);
        const passwd = path.join(sandbox.fake, 'passwd');
        for (const home of [roots.data, path.join(roots.cache, 'alice')]) {
            fs.writeFileSync(passwd, `alice:x:1000:1000::${home}:/bin/bash\n`);
            const { reply } = call(sandbox, 'user.create', userInput(roots), { invokerUid: 1000 });
            expect(reply).toMatchObject({ ok: false, code: 'ROOT_IS_HOME' });
            expect(sandbox.commands().filter(line => line.startsWith('chown'))).toEqual([]);
        }
        // The state directory above the roots is the usual home of the service account's parent: allowed.
        fs.writeFileSync(passwd, `alice:x:1000:1000::${path.dirname(roots.data)}:/bin/bash\n`);
        expect(call(sandbox, 'user.create', userInput(roots), { invokerUid: 1000 }).reply).toMatchObject({ ok: true });
    });

    test('a missing mutable root is created, the code root is left alone', () => {
        const sandbox = makeSandbox();
        const roots = makeInstallation(sandbox);
        fs.rmSync(roots.uploads, { recursive: true });
        call(sandbox, 'user.create', userInput(roots));
        expect(fs.existsSync(roots.uploads)).toBe(true);
    });
});

describe('updater.disable', () => {
    const codeRoot = '/srv/legacy/goobster';

    test('comments only the cron line that updates this installation, keeps the file mode, and is idempotent', () => {
        const sandbox = makeSandbox();
        const file = path.join(sandbox.cronDir, 'goobster-update');
        const unrelated = '0 4 * * * root /usr/local/bin/other-job.sh';
        const ours = `*/30 * * * * pi GOOBSTER_REPO_DIR=${codeRoot} ${codeRoot}/scripts/auto-update.sh`;
        fs.writeFileSync(file, `# managed by hand\n${ours}\n${unrelated}\n`, { mode: 0o640 });
        fs.chmodSync(file, 0o640);

        const input = { mechanism: 'cron-system', unit: 'goobster-update', codeRoot };
        const first = call(sandbox, 'updater.disable', input);
        expect(first.reply).toMatchObject({ ok: true, outcome: 'done', detail: { lines: 1 } });
        const text = fs.readFileSync(file, 'utf8');
        expect(text).toContain(`#goobster-manager-disabled: ${ours}`);
        expect(text).toContain(`\n${unrelated}\n`);
        expect(fs.statSync(file).mode & 0o777).toBe(0o640);
        expect(call(sandbox, 'updater.disable', input).reply).toMatchObject({ ok: true, outcome: 'noop' });
    });

    test('a cron file with no line for this installation is left alone', () => {
        const sandbox = makeSandbox();
        const file = path.join(sandbox.cronDir, 'goobster-update');
        const body = `0 4 * * * pi /elsewhere/scripts/auto-update.sh\n`;
        fs.writeFileSync(file, body);
        expect(call(sandbox, 'updater.disable', { mechanism: 'cron-system', unit: 'goobster-update', codeRoot }).reply).toMatchObject({ ok: false, code: 'UPDATER_NOT_OURS' });
        expect(fs.readFileSync(file, 'utf8')).toBe(body);
    });

    test('a timer is disabled only when its service points at this code root', () => {
        const sandbox = makeSandbox();
        fs.writeFileSync(path.join(sandbox.fake, 'enabled'), '');
        fs.writeFileSync(path.join(sandbox.fake, 'prop-goobster-update.timer-Unit'), 'goobster-update.service');
        fs.writeFileSync(path.join(sandbox.fake, 'prop-goobster-update.service-WorkingDirectory'), '/elsewhere/goobster');
        const input = { mechanism: 'systemd-timer', unit: 'goobster-update.timer', codeRoot };
        expect(call(sandbox, 'updater.disable', input).reply).toMatchObject({ ok: false, code: 'UPDATER_NOT_OURS' });
        expect(sandbox.commands().some(line => line.startsWith('systemctl disable'))).toBe(false);

        fs.writeFileSync(path.join(sandbox.fake, 'prop-goobster-update.service-WorkingDirectory'), codeRoot);
        expect(call(sandbox, 'updater.disable', input).reply).toMatchObject({ ok: true, outcome: 'done', detail: { disabled: true } });
        expect(sandbox.commands()).toContain('systemctl disable --now goobster-update.timer');
    });
});

describe('what Linux does not do', () => {
    test('package.install is not implemented: system packages are the operator\'s', () => {
        const sandbox = makeSandbox();
        const { reply, code } = call(sandbox, 'package.install', { names: ['ffmpeg'] });
        expect(code).toBe(1);
        expect(reply).toMatchObject({ ok: false, code: 'NOT_IMPLEMENTED' });
        expect(sandbox.commands()).toEqual([]);
    });

    test('another platform has no helper yet', () => {
        const { reply } = helper.execute(protocol.buildRequest('package.install', { names: [] }), { platform: 'win32' });
        expect(reply).toMatchObject({ ok: false, code: 'PLATFORM_UNSUPPORTED' });
    });

    test('an unreadable request is answered with exit code 2 and no side effect', () => {
        const { reply, code } = helper.execute('{"v":1', { platform: 'linux', deps: {} });
        expect(code).toBe(2);
        expect(reply.ok).toBe(false);
    });

    test('a request outside root is refused when the helper is not elevated and not in the sandbox', () => {
        const sandbox = makeSandbox();
        const roots = makeInstallation(sandbox);
        const handler = linux.createHandler({ ...depsFor(sandbox), sandbox: false, euid: 1000, invokerUid: null });
        expect(() => handler.handle('user.create', protocol.validateInput('user.create', userInput(roots)))).toThrow(expect.objectContaining({ code: 'NOT_ELEVATED' }));
    });
});

const runsAsRoot = typeof process.geteuid === 'function' && process.geteuid() === 0;
(runsAsRoot ? describe.skip : describe)('the helper as a real process', () => {
    test('reads one JSON document on stdin, answers one on stdout, and honours the sandbox only when not root', () => {
        const sandbox = makeSandbox();
        const roots = makeInstallation(sandbox);
        const result = childProcess.spawnSync(process.execPath, [path.join(__dirname, '..', 'apps', 'manager', 'privileged', 'helper.js')], {
            input: protocol.buildRequest('user.create', userInput(roots)),
            encoding: 'utf8',
            env: { PATH: '/usr/bin:/bin', GOOBSTER_HELPER_SANDBOX: sandbox.base }
        });
        expect(result.status).toBe(0);
        const lines = result.stdout.trim().split('\n');
        expect(lines).toHaveLength(1);
        expect(JSON.parse(lines[0])).toMatchObject({ v: 1, ok: true, operation: 'user.create', outcome: 'done' });
    });

    test('without the sandbox variable a non-root helper refuses', () => {
        const sandbox = makeSandbox();
        const roots = makeInstallation(sandbox);
        const result = childProcess.spawnSync(process.execPath, [path.join(__dirname, '..', 'apps', 'manager', 'privileged', 'helper.js')], {
            input: protocol.buildRequest('user.create', userInput(roots)),
            encoding: 'utf8',
            env: { PATH: '/usr/bin:/bin' }
        });
        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout.trim())).toMatchObject({ ok: false, code: 'NOT_ELEVATED' });
    });

    test('garbage on stdin exits 2', () => {
        const result = childProcess.spawnSync(process.execPath, [path.join(__dirname, '..', 'apps', 'manager', 'privileged', 'helper.js')], { input: 'not json', encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
        expect(result.status).toBe(2);
        expect(JSON.parse(result.stdout.trim()).ok).toBe(false);
    });
});

describe('the manager-side runner', () => {
    const roots = (() => {
        const out = {};
        for (const role of protocol.ROOT_ROLES) out[role] = `/srv/data/goobster/${role}`;
        return out;
    })();

    function fakeSpawn(replyFor, seen = {}) {
        const { EventEmitter } = require('node:events');
        const { PassThrough } = require('node:stream');
        return (file, args, options) => {
            seen.file = file;
            seen.args = args;
            seen.options = options;
            const child = new EventEmitter();
            child.stdout = new PassThrough();
            child.stderr = new PassThrough();
            let body = '';
            child.stdin = new PassThrough();
            child.stdin.on('data', chunk => { body += chunk; });
            child.stdin.on('end', () => {
                seen.stdin = body;
                child.stdout.end(replyFor(body));
                child.stderr.end();
                setImmediate(() => child.emit('close', 0, null));
            });
            child.kill = () => {};
            return child;
        };
    }

    test('the request goes on stdin only; argv and the environment carry no value', async () => {
        const seen = {};
        const reply = (body) => JSON.stringify(protocol.okReply('service.register', 'done', { unit: 'goobster.service' }, ['unit written', 'systemctl enable -> 0']));
        const result = await elevate.runHelper({
            operation: 'service.register',
            input: registerInput(roots),
            implementation: linux,
            spawn: fakeSpawn(reply, seen),
            elevation: { kind: 'root', prefix: [] },
            facts: { available: true },
            env: { PATH: '/usr/bin', OPENAI_API_KEY: 'sk-super-secret', GOOBSTER_TOKEN: 'tok' },
            nodePath: '/opt/goobster/current/runtime/bin/node',
            helperPath: '/opt/goobster/current/app/apps/manager/privileged/helper.js'
        });
        expect(result).toMatchObject({ status: 'done', outcome: 'done' });
        expect(JSON.parse(seen.stdin).input.runtimeUser).toBe('goobster');
        expect(seen.args.join(' ')).not.toContain('runtimeUser');
        expect(seen.args).toEqual(['/opt/goobster/current/app/apps/manager/privileged/helper.js']);
        expect(JSON.stringify(seen.options.env)).not.toMatch(/secret|tok/);
        expect(Object.keys(seen.options.env).sort()).toEqual(['LC_ALL', 'PATH']);
    });

    test('a refusal comes back as a failed result with the helper code, and the log holds no env value or unnamed path', async () => {
        const reply = () => JSON.stringify(protocol.errorReply('service.register', 'SERVICE_FOREIGN', 'goobster.service exists at /etc/systemd/system/goobster.service', ['saw TOKEN=abc123 in /etc/shadow', `wrote ${roots.code}/x`]));
        const result = await elevate.runHelper({
            operation: 'service.register',
            input: registerInput(roots),
            implementation: linux,
            spawn: fakeSpawn(reply),
            elevation: { kind: 'root', prefix: [] },
            facts: { available: true }
        });
        expect(result).toMatchObject({ status: 'failed', code: 'SERVICE_FOREIGN' });
        const text = JSON.stringify(result);
        expect(text).not.toContain('abc123');
        expect(text).not.toContain('/etc/shadow');
        expect(result.log).toEqual(['saw <value> in <path>', `wrote ${roots.code}/x`.replace(`${roots.code}/x`, '<path>')]);
    });

    test('systemd that is offline falls back before anything is requested', async () => {
        const spawn = jest.fn();
        const result = await elevate.runHelper({
            operation: 'service.register',
            input: registerInput(roots),
            implementation: linux,
            spawn,
            elevation: { kind: 'root', prefix: [] },
            facts: { available: false, state: 'offline', reason: 'SYSTEMD_OFFLINE' }
        });
        expect(result).toMatchObject({ status: 'fallback', reason: 'SYSTEMD_OFFLINE' });
        expect(spawn).not.toHaveBeenCalled();
    });

    test('with no way to elevate the runner writes a 0600 request file and the exact by-hand command', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-req-'));
        cleanup.push(dir);
        const spawn = jest.fn();
        const result = await elevate.runHelper({
            operation: 'user.create',
            input: userInput(roots),
            implementation: linux,
            spawn,
            elevation: { kind: 'none', prefix: [], reason: 'NO_DISPLAY_AND_NO_SUDO' },
            requestDir: path.join(dir, 'requests'),
            nodePath: '/opt/g o/node',
            helperPath: '/opt/g o/helper.js'
        });
        expect(spawn).not.toHaveBeenCalled();
        expect(result).toMatchObject({ status: 'fallback', reason: 'ELEVATION_UNAVAILABLE' });
        const requestFile = path.join(dir, 'requests', 'user.create.request.json');
        expect(fs.statSync(requestFile).mode & 0o777).toBe(0o600);
        expect(result.manual).toBe(`sudo '/opt/g o/node' '/opt/g o/helper.js' < '${requestFile}'`);
        expect(JSON.parse(fs.readFileSync(requestFile, 'utf8')).operation).toBe('user.create');
    });

    test('the platform\'s elevation() sees the operation and the validated input, so it can answer that none is needed', async () => {
        const seen = [];
        const implementation = {
            ...linux,
            elevation: (params) => {
                seen.push(params);
                return { kind: 'none', prefix: [], reason: 'TEST' };
            }
        };
        const result = await elevate.runHelper({ operation: 'user.create', input: userInput(roots), implementation, spawn: jest.fn() });
        expect(result).toMatchObject({ status: 'fallback', reason: 'ELEVATION_UNAVAILABLE', detail: { why: 'TEST' } });
        expect(seen).toHaveLength(1);
        expect(seen[0].operation).toBe('user.create');
        expect(seen[0].input).toMatchObject({ name: userInput(roots).name, roots: roots });
        expect(seen[0].env).toBeDefined();
        expect(seen[0].fs).toBeDefined();
    });

    test('an input the shape rules refuse is a thrown refusal, never a spawn', async () => {
        const spawn = jest.fn();
        await expect(elevate.runHelper({ operation: 'service.register', input: { ...registerInput(roots), name: 'Bad Name' }, implementation: linux, spawn, elevation: { kind: 'root', prefix: [] }, facts: { available: true } }))
            .rejects.toMatchObject({ code: 'INVALID_INPUT' });
        expect(spawn).not.toHaveBeenCalled();
    });

    test('sudo is used non-interactively, and a password prompt is a refusal fallback, not a failure', async () => {
        const seen = {};
        const { EventEmitter } = require('node:events');
        const { PassThrough } = require('node:stream');
        const spawn = (file, args) => {
            seen.argv = [file, ...args];
            const child = new EventEmitter();
            child.stdout = new PassThrough();
            child.stderr = new PassThrough();
            child.stdin = new PassThrough();
            child.stdin.resume();
            child.kill = () => {};
            child.stdin.on('end', () => {
                child.stderr.end('sudo: a password is required\n');
                child.stdout.end('');
                setImmediate(() => child.emit('close', 1, null));
            });
            return child;
        };
        const result = await elevate.runHelper({
            operation: 'user.create',
            input: userInput(roots),
            implementation: linux,
            spawn,
            elevation: { kind: 'sudo', prefix: ['/usr/bin/sudo', '-n', '--'] },
            nodePath: process.execPath,
            helperPath: path.join(__dirname, '..', 'apps', 'manager', 'privileged', 'helper.js')
        });
        expect(seen.argv.slice(0, 3)).toEqual(['/usr/bin/sudo', '-n', '--']);
        expect(result).toMatchObject({ status: 'fallback', reason: 'ELEVATION_REFUSED' });
    });

    test('elevation prefers root, then non-interactive sudo, then pkexec only with a display', () => {
        const fsStub = { accessSync: () => undefined };
        expect(linux.elevation({ euid: 0 }).kind).toBe('root');
        expect(linux.elevation({ euid: 1000, env: { PATH: '/x' }, fs: fsStub, probe: () => 0 })).toMatchObject({ kind: 'sudo', prefix: ['/x/sudo', '-n', '--'] });
        expect(linux.elevation({ euid: 1000, env: { PATH: '/x', DISPLAY: ':0' }, fs: fsStub, probe: () => 1 }).kind).toBe('pkexec');
        expect(linux.elevation({ euid: 1000, env: { PATH: '/x' }, fs: fsStub, probe: () => 1 })).toMatchObject({ kind: 'none', reason: 'SUDO_NEEDS_PASSWORD' });
        const noTools = { accessSync: () => { throw new Error('nope'); } };
        expect(linux.elevation({ euid: 1000, env: { PATH: '/x' }, fs: noTools })).toMatchObject({ kind: 'none', reason: 'NO_DISPLAY_AND_NO_SUDO' });
    });

    test('systemd facts: no /run/systemd/system, offline and running are told apart', () => {
        const none = { existsSync: () => false, accessSync: () => undefined };
        expect(linux.systemdFacts({ fs: none })).toMatchObject({ available: false, reason: 'SYSTEMD_NOT_INIT' });
        const present = { existsSync: () => true, accessSync: () => undefined };
        expect(linux.systemdFacts({ fs: present, env: { PATH: '/x' }, exec: () => ({ status: 1, stdout: 'offline\n' }) })).toMatchObject({ available: false, reason: 'SYSTEMD_OFFLINE' });
        expect(linux.systemdFacts({ fs: present, env: { PATH: '/x' }, exec: () => ({ status: 0, stdout: 'running\n' }) })).toMatchObject({ available: true });
        expect(linux.systemdFacts({ fs: present, env: { PATH: '/x' }, exec: () => ({ status: 1, stdout: 'degraded\n' }) })).toMatchObject({ available: true });
    });
});

describe('helper integrity', () => {
    function fakePayload() {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-payload-'));
        cleanup.push(root);
        const files = [];
        const put = (rel, text) => {
            const file = path.join(root, ...rel.split('/'));
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, text);
            files.push({ path: rel, sha256: crypto.createHash('sha256').update(text).digest('hex') });
        };
        for (const rel of elevate.HELPER_FILES) put(rel, `// ${rel}\n`);
        put('runtime/bin/node', 'node-binary');
        fs.writeFileSync(path.join(root, 'payload-manifest.json'), JSON.stringify({ files }));
        return root;
    }

    test('matching hashes verify; a changed helper file or runtime does not', () => {
        const root = fakePayload();
        const nodePath = path.join(root, 'runtime', 'bin', 'node');
        expect(elevate.verifyHelperFiles({ payloadRoot: root, nodePath })).toMatchObject({ checked: true, ok: true, files: 5 });
        fs.appendFileSync(path.join(root, 'app', 'apps', 'manager', 'privileged', 'linux.js'), '// backdoor\n');
        expect(elevate.verifyHelperFiles({ payloadRoot: root, nodePath })).toMatchObject({ ok: false, reason: 'HASH_MISMATCH' });

        const second = fakePayload();
        fs.writeFileSync(path.join(second, 'runtime', 'bin', 'node'), 'swapped');
        expect(elevate.verifyHelperFiles({ payloadRoot: second, nodePath: path.join(second, 'runtime', 'bin', 'node') })).toMatchObject({ ok: false, reason: 'HASH_MISMATCH' });
    });

    test('a source checkout has no manifest and says so instead of pretending to verify', () => {
        const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-nomanifest-'));
        cleanup.push(empty);
        expect(elevate.verifyHelperFiles({ payloadRoot: empty, nodePath: process.execPath })).toMatchObject({ checked: false, ok: true, reason: 'NO_MANIFEST' });
    });

    test('the helper\'s code is node built-ins plus its own files and nothing else', () => {
        const dir = path.join(__dirname, '..', 'apps', 'manager');
        const darwin = require('../apps/manager/privileged/darwin');
        const own = new Set([...elevate.HELPER_FILES, ...darwin.HELPER_FILES].map(rel => path.join(dir, '..', '..', rel.replace(/^app\//, ''))).map(file => path.normalize(file)));
        const seen = new Set();
        const queue = [path.join(dir, 'privileged', 'helper.js'), path.join(dir, 'privileged', 'linux.js'), path.join(dir, 'privileged', 'darwin.js')];
        while (queue.length > 0) {
            const file = queue.pop();
            if (seen.has(file)) continue;
            seen.add(file);
            expect(own.has(path.normalize(file))).toBe(true);
            const text = fs.readFileSync(file, 'utf8');
            for (const match of text.matchAll(/require\((['"])([^'"]+)\1\)/g)) {
                const target = match[2];
                if (target.startsWith('node:')) continue;
                // darwin.js's manager half (transport) loads elevate lazily; the helper process never calls it.
                if (target === './elevate' && path.basename(file) === 'darwin.js') continue;
                expect(target.startsWith('.')).toBe(true);
                let resolved = path.resolve(path.dirname(file), target);
                if (!resolved.endsWith('.js')) resolved += '.js';
                queue.push(resolved);
            }
        }
        expect(seen.size).toBe(6);
    });
});

describe('the dispatcher', () => {
    test('the HTTP-facing request() stays closed: declared operations answer 501, unknown ones 404', () => {
        for (const name of privileged.PRIVILEGED_OPERATIONS) {
            expect(() => privileged.request(name)).toThrow(expect.objectContaining({ status: 501, code: 'NOT_IMPLEMENTED' }));
        }
        expect(() => privileged.request('shell.exec')).toThrow(expect.objectContaining({ status: 404 }));
    });

    test('run() reports the implemented set per platform', () => {
        expect(privileged.describe('linux')).toMatchObject({ implemented: true, implementedOperations: ['service.register', 'service.unregister', 'updater.disable', 'user.create'] });
        expect(privileged.describe('win32')).toMatchObject({ implemented: false });
        expect(privileged.isImplemented('package.install', 'linux')).toBe(false);
    });

    test('run() throws 501 for an operation or a platform with no helper, 404 for an unknown name, 400 for a refused input', async () => {
        await expect(privileged.run('package.install', { names: [] }, { platform: 'linux' })).rejects.toMatchObject({ status: 501 });
        await expect(privileged.run('service.register', {}, { platform: 'win32' })).rejects.toMatchObject({ status: 501 });
        await expect(privileged.run('shell.exec', {}, {})).rejects.toMatchObject({ status: 404 });
        await expect(privileged.run('user.create', { name: 'root' }, { platform: 'linux' })).rejects.toMatchObject({ status: 400 });
    });

    test('INPUT_SHAPES names exactly the declared operations', () => {
        expect(Object.keys(privileged.INPUT_SHAPES).sort()).toEqual([...privileged.PRIVILEGED_OPERATIONS].sort());
    });
});
