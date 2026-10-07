/**
 * The shared config.json loader (config/configJson.js, packaging finding B1).
 *
 * Every reader of config.json goes through `load()`, which honours
 * GOOBSTER_CONFIG_PATH instead of a path relative to the package. These
 * specs point that variable at a temp directory so the repository's own
 * config.json (or the placeholder Jest writes) can never be what is read.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ENV_KEYS = ['GOOBSTER_CONFIG_PATH', 'GOOBSTER_DISCORD_ENABLED'];

describe('config/configJson', () => {
    let dir;
    const saved = {};

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-configjson-'));
        for (const key of ENV_KEYS) saved[key] = process.env[key];
        delete process.env.GOOBSTER_DISCORD_ENABLED;
    });

    afterEach(() => {
        for (const key of ENV_KEYS) {
            if (saved[key] === undefined) delete process.env[key];
            else process.env[key] = saved[key];
        }
        fs.rmSync(dir, { recursive: true, force: true });
    });

    /** Run `fn` with a module registry that sees GOOBSTER_CONFIG_PATH as set now. */
    const isolated = (fn) => {
        let result;
        jest.isolateModules(() => { result = fn(); });
        return result;
    };

    test('returns the file placed only at GOOBSTER_CONFIG_PATH', () => {
        const file = path.join(dir, 'elsewhere', 'config.json');
        fs.mkdirSync(path.dirname(file));
        fs.writeFileSync(file, JSON.stringify({ marker: 'relocated', nested: { a: 1 } }));
        process.env.GOOBSTER_CONFIG_PATH = file;
        const { load, configJsonPath } = isolated(() => require('@goobster/core/config/configJson'));
        expect(configJsonPath()).toBe(file);
        expect(load()).toEqual({ marker: 'relocated', nested: { a: 1 } });
    });

    test('a missing file is an empty object, not an error', () => {
        process.env.GOOBSTER_CONFIG_PATH = path.join(dir, 'absent.json');
        const { load } = isolated(() => require('@goobster/core/config/configJson'));
        expect(load()).toEqual({});
        expect(load({ fresh: true })).toEqual({});
    });

    test('a file that exists but is not JSON throws CONFIG_INVALID_JSON without leaking the path or contents', () => {
        const file = path.join(dir, 'config.json');
        fs.writeFileSync(file, '{ "token": "super-secret-value", ');
        process.env.GOOBSTER_CONFIG_PATH = file;
        const { load, ConfigJsonError } = isolated(() => require('@goobster/core/config/configJson'));
        let caught;
        try { load(); } catch (err) { caught = err; }
        expect(caught).toBeInstanceOf(ConfigJsonError);
        expect(caught.code).toBe('CONFIG_INVALID_JSON');
        expect(caught.message).not.toContain('super-secret-value');
        expect(caught.message).not.toContain(dir);
    });

    test('a UTF-8 byte-order mark is tolerated', () => {
        const file = path.join(dir, 'config.json');
        fs.writeFileSync(file, `\uFEFF${JSON.stringify({ ok: true })}`);
        process.env.GOOBSTER_CONFIG_PATH = file;
        const { load } = isolated(() => require('@goobster/core/config/configJson'));
        expect(load()).toEqual({ ok: true });
    });

    test('the parsed object is cached per path and fresh re-reads', () => {
        const file = path.join(dir, 'config.json');
        fs.writeFileSync(file, JSON.stringify({ n: 1 }));
        process.env.GOOBSTER_CONFIG_PATH = file;
        const { load } = isolated(() => require('@goobster/core/config/configJson'));
        const first = load();
        fs.writeFileSync(file, JSON.stringify({ n: 2 }));
        expect(load()).toBe(first);
        expect(load({ fresh: true })).toEqual({ n: 2 });
        expect(load()).toEqual({ n: 2 });
    });

    test('discordConfig sees a token placed only at GOOBSTER_CONFIG_PATH (B1 reproduction)', () => {
        const file = path.join(dir, 'config.json');
        fs.writeFileSync(file, JSON.stringify({ token: 'not-a-real-token', clientId: '1', guildIds: ['1'] }));
        process.env.GOOBSTER_CONFIG_PATH = file;
        const withFile = isolated(() => require('@goobster/core/config/discordConfig'));
        expect(withFile.tokenConfigured).toBe(true);
        expect(withFile.enabled).toBe(true);

        process.env.GOOBSTER_CONFIG_PATH = path.join(dir, 'absent.json');
        const without = isolated(() => require('@goobster/core/config/discordConfig'));
        expect(without.tokenConfigured).toBe(false);
        expect(without.enabled).toBe(false);
    });

    test('services/serviceManager requires cleanly with no config file', () => {
        // Child process with a scratch cwd: the voice service creates cache/music
        // under process.cwd() as a load-time side effect.
        const target = require.resolve('@goobster/core/services/serviceManager');
        const out = execFileSync(process.execPath, ['-e', `require(${JSON.stringify(target)}); process.stdout.write('loaded')`], {
            cwd: dir,
            env: { ...process.env, GOOBSTER_CONFIG_PATH: path.join(dir, 'absent.json'), GOOBSTER_DB_PATH: path.join(dir, 'x.sqlite') },
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
        });
        expect(out).toContain('loaded');
    });

    test('no module under core or the bot requires config.json by relative path', () => {
        const root = path.join(__dirname, '..');
        const offenders = [];
        const walk = (current) => {
            for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
                if (entry.name === 'node_modules' || entry.name === 'dist') continue;
                const full = path.join(current, entry.name);
                if (entry.isDirectory()) walk(full);
                else if (entry.name.endsWith('.js')
                    && /require\(\s*['"][^'"]*config\.json['"]\s*\)/.test(fs.readFileSync(full, 'utf8'))) {
                    offenders.push(path.relative(root, full));
                }
            }
        };
        walk(path.join(root, 'packages'));
        walk(path.join(root, 'apps'));
        expect(offenders).toEqual([]);
    });

    test('a child process reads the relocated file through the real entry point', () => {
        const file = path.join(dir, 'config.json');
        fs.writeFileSync(file, JSON.stringify({ token: 'not-a-real-token' }));
        const script = "process.stdout.write(String(require('@goobster/core/config/discordConfig').enabled))";
        const run = (env) => execFileSync(process.execPath, ['-e', script], {
            cwd: path.join(__dirname, '..'),
            env: { ...process.env, GOOBSTER_DISCORD_ENABLED: '', ...env },
            encoding: 'utf8'
        });
        expect(run({ GOOBSTER_CONFIG_PATH: file })).toBe('true');
        expect(run({ GOOBSTER_CONFIG_PATH: path.join(dir, 'absent.json') })).toBe('false');
    });
});
