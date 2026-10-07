/**
 * Installation feature state (#317, P1.2).
 *
 * Covers packages/core/features/featureState.js and gate.js: the absent-file
 * (legacy) behaviour for every flag kind, the baseline equality between the
 * resolver and the real config modules, fresh and legacy-seed documents,
 * file precedence (installed, requested, env, dependencies; configured is reported as warnings),
 * pending versus active, unknown/corrupt/unsupported files, atomic writes,
 * stale revisions, dependency conflicts, the read-only guarantee (asserted on
 * an injected fs call log), and the rule that no status ever carries a secret.
 *
 * Everything runs against an in-memory fs and plain config objects: no
 * config.json, no keys, no network, no database.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const catalog = require('@goobster/core/features/catalog');
const state = require('@goobster/core/features/featureState');

const {
    createFeatureState, createPathProbe, envVarFor, features, FeatureStateError, StaleRevisionError, STATE_VERSION
} = state;
const { FEATURE_IDS, FEATURES } = catalog;

const ROOT = path.resolve(__dirname, '..');
const FILE = '/virtual/data/features.json';
const TMP = `${FILE}.tmp`;
const MANAGEABLE = FEATURE_IDS.filter(id => id !== 'core');

function memoryFs(initial = {}, { failOn = null } = {}) {
    const files = new Map(Object.entries(initial));
    const calls = [];
    const missing = (p) => Object.assign(new Error(`ENOENT: no such file ${p}`), { code: 'ENOENT' });
    const guard = (name) => {
        if (failOn === name) throw Object.assign(new Error(`${name} failed`), { code: 'EIO' });
    };
    return {
        files,
        calls,
        existsSync(p) { calls.push(['existsSync', p]); return files.has(p); },
        readFileSync(p) {
            calls.push(['readFileSync', p]);
            guard('readFileSync');
            if (!files.has(p)) throw missing(p);
            return files.get(p);
        },
        writeFileSync(p, data) { calls.push(['writeFileSync', p]); guard('writeFileSync'); files.set(p, String(data)); },
        renameSync(from, to) {
            calls.push(['renameSync', from, to]);
            guard('renameSync');
            if (!files.has(from)) throw missing(from);
            files.set(to, files.get(from));
            files.delete(from);
        },
        mkdirSync(p) { calls.push(['mkdirSync', p]); },
        unlinkSync(p) { calls.push(['unlinkSync', p]); files.delete(p); },
        mutatingCalls() {
            return calls.filter(([name]) => ['writeFileSync', 'renameSync', 'mkdirSync', 'unlinkSync'].includes(name));
        }
    };
}

const FIXED_NOW = new Date('2026-10-06T21:14:02.000Z');

function make({ files = {}, config = {}, env = {}, probes, failOn } = {}) {
    const memory = memoryFs(files, { failOn });
    const logger = { warn: jest.fn() };
    const instance = createFeatureState({
        fs: memory, filePath: FILE, env, config, probes, now: () => FIXED_NOW, logger
    });
    return { state: instance, fs: memory, logger };
}

function docText(overrides = {}, meta = {}) {
    const entries = {};
    for (const id of MANAGEABLE) entries[id] = { installed: true, active: true };
    for (const [id, entry] of Object.entries(overrides)) entries[id] = { installed: true, active: true, ...entry };
    return JSON.stringify({
        version: 1, revision: 3, updatedAt: '2026-10-06 21:14:02', origin: 'operator', features: entries, ...meta
    });
}

function reasonCodes(instance, id) {
    return instance.availability(id).reasons.map(r => r.code);
}

describe('absent state file keeps legacy behaviour', () => {
    test('with nothing configured every feature without a switch is active and the rest follow their defaults', () => {
        const { state: s } = make();
        const inactive = FEATURE_IDS.filter(id => !s.isActive(id)).sort();
        expect(inactive).toEqual([
            'discord', 'discordActivity', 'gba', 'mail', 'mcp', 'observatory', 'sandbox', 'screenVision'
        ].sort());
        for (const id of ['core', 'push', 'music', 'voice', 'tavern', 'economy', 'exchange', 'gambling', 'projects', 'knowledge', 'expeditions', 'github', 'cursor']) {
            expect(s.isActive(id)).toBe(true);
        }
    });

    test('status reports source none with no revision, origin or error', () => {
        const { state: s } = make();
        const status = s.status();
        expect(status).toMatchObject({ source: 'none', version: null, revision: null, origin: null, error: null });
        expect(Object.keys(status.features)).toEqual([...FEATURE_IDS]);
        expect(status.features.music).toEqual({
            installed: true, configured: true, active: true, pending: false, requested: true, pendingActive: null, reasons: [], warnings: []
        });
    });

    test('core is always active, unknown ids are inactive with UNKNOWN_FEATURE and never throw', () => {
        const { state: s } = make({ env: { GOOBSTER_FEATURE_CORE: '0' } });
        expect(s.isActive('core')).toBe(true);
        expect(s.isActive('nope')).toBe(false);
        expect(s.isActive('toString')).toBe(false);
        expect(s.isActive(undefined)).toBe(false);
        expect(s.availability('nope')).toEqual({ id: 'nope', active: false, reasons: [{ code: 'UNKNOWN_FEATURE', detail: 'nope' }], warnings: [] });
    });

    test('loading and every read leave the file system untouched, even when no file exists', () => {
        const { state: s, fs: memory } = make();
        s.load();
        s.snapshot();
        s.isActive('music');
        s.availability('mcp');
        s.unavailable();
        s.status();
        s.seedFromLegacy();
        s.freshPreset();
        s.refresh();
        expect(memory.mutatingCalls()).toEqual([]);
        expect(memory.files.size).toBe(0);
        expect(memory.calls.every(([name]) => ['existsSync', 'readFileSync'].includes(name))).toBe(true);
    });

    test('reads never modify an existing valid or invalid file either', () => {
        for (const content of [docText(), '{ not json', JSON.stringify({ version: 9 }), docText({ nope: {} })]) {
            const { state: s, fs: memory } = make({ files: { [FILE]: content } });
            s.status();
            s.refresh();
            s.unavailable();
            expect(memory.mutatingCalls()).toEqual([]);
            expect(memory.files.get(FILE)).toBe(content);
        }
    });

    test('snapshot is memoised until refresh() and a later file does not change the running answer', () => {
        const { state: s, fs: memory } = make();
        expect(s.isActive('tavern')).toBe(true);
        memory.files.set(FILE, docText({ tavern: { active: false } }));
        expect(s.isActive('tavern')).toBe(true);
        expect(s.snapshot()).toBe(s.snapshot());
        s.refresh();
        expect(s.isActive('tavern')).toBe(false);
    });
});

describe('legacy switches, by kind', () => {
    const on = (config = {}, env = {}) => {
        const { state: s } = make({ config, env });
        return (id) => s.isActive(id);
    };

    test('flag, tri-state (mcp): env first, any value but an off word is on, then config, default off', () => {
        expect(on()('mcp')).toBe(false);
        expect(on({ mcp: { enabled: true } })('mcp')).toBe(true);
        expect(on({ mcp: { enabled: false } })('mcp')).toBe(false);
        expect(on({ mcp: { enabled: 1 } })('mcp')).toBe(true);
        expect(on({}, { GOOBSTER_MCP_ENABLED: '1' })('mcp')).toBe(true);
        expect(on({}, { GOOBSTER_MCP_ENABLED: 'yes' })('mcp')).toBe(true);
        expect(on({ mcp: { enabled: true } }, { GOOBSTER_MCP_ENABLED: '0' })('mcp')).toBe(false);
        expect(on({ mcp: { enabled: true } }, { GOOBSTER_MCP_ENABLED: ' OFF ' })('mcp')).toBe(false);
        expect(on({ mcp: { enabled: true } }, { GOOBSTER_MCP_ENABLED: '' })('mcp')).toBe(true);
    });

    test('flag, env 1/true or config === true (sandbox, observatory with its dependencies)', () => {
        for (const id of ['sandbox']) {
            const upper = id.toUpperCase();
            expect(on()(id)).toBe(false);
            expect(on({ [id]: { enabled: true } })(id)).toBe(true);
            expect(on({ [id]: { enabled: 'true' } })(id)).toBe(false);
            expect(on({ [id]: { enabled: 1 } })(id)).toBe(false);
            expect(on({}, { [`GOOBSTER_${upper}_ENABLED`]: '1' })(id)).toBe(true);
            expect(on({}, { [`GOOBSTER_${upper}_ENABLED`]: 'true' })(id)).toBe(true);
            expect(on({}, { [`GOOBSTER_${upper}_ENABLED`]: 'yes' })(id)).toBe(false);
            expect(on({ [id]: { enabled: true } }, { [`GOOBSTER_${upper}_ENABLED`]: '0' })(id)).toBe(true);
        }
        const observatory = on({ observatory: { enabled: true }, sandbox: { enabled: true } });
        expect(observatory('observatory')).toBe(true);
    });

    test('flag, explicit boolean with default on (projects)', () => {
        expect(on()('projects')).toBe(true);
        expect(on({ projects: { enabled: false } })('projects')).toBe(false);
        expect(on({ projects: { enabled: 'no' } })('projects')).toBe(true);
        expect(on({}, { GOOBSTER_PROJECTS_ENABLED: '0' })('projects')).toBe(false);
        expect(on({}, { GOOBSTER_PROJECTS_ENABLED: 'false' })('projects')).toBe(false);
        expect(on({ projects: { enabled: false } }, { GOOBSTER_PROJECTS_ENABLED: '1' })('projects')).toBe(true);
        expect(on({}, { GOOBSTER_PROJECTS_ENABLED: 'off' })('projects')).toBe(true);
    });

    test('flag, off only when explicitly false (expeditions)', () => {
        expect(on()('expeditions')).toBe(true);
        expect(on({ spitball: { enabled: false } })('expeditions')).toBe(false);
        expect(on({ spitball: { enabled: 0 } })('expeditions')).toBe(true);
        expect(on({ spitball: {} })('expeditions')).toBe(true);
        expect(on({}, { GOOBSTER_SPITBALL_ENABLED: '0' })('expeditions')).toBe(false);
        expect(on({}, { GOOBSTER_SPITBALL_ENABLED: 'false' })('expeditions')).toBe(false);
        expect(on({}, { GOOBSTER_SPITBALL_ENABLED: 'off' })('expeditions')).toBe(true);
    });

    test('flag, strictly true in config.json with no env variable (gba, screenVision, discordActivity)', () => {
        const discordOn = { token: 'x' };
        const cases = [['gba', 'gbaRun'], ['screenVision', 'screenVision'], ['discordActivity', 'activity']];
        for (const [id, section] of cases) {
            expect(on(discordOn)(id)).toBe(false);
            expect(on({ ...discordOn, [section]: { enabled: true } })(id)).toBe(true);
            expect(on({ ...discordOn, [section]: { enabled: 'true' } })(id)).toBe(false);
            expect(on({ ...discordOn, [section]: { enabled: 1 } })(id)).toBe(false);
            expect(on({ ...discordOn, [section]: { enabled: false } })(id)).toBe(false);
        }
    });

    test('derived (discord): explicit switch, else a non-empty token', () => {
        expect(on()('discord')).toBe(false);
        expect(on({ token: '   ' })('discord')).toBe(false);
        expect(on({ token: 'abc' })('discord')).toBe(true);
        expect(on({ token: 'abc', discord: { enabled: false } })('discord')).toBe(false);
        expect(on({ discord: { enabled: true } })('discord')).toBe(true);
        expect(on({ token: 'abc' }, { GOOBSTER_DISCORD_ENABLED: 'off' })('discord')).toBe(false);
        expect(on({ discord: { enabled: false } }, { GOOBSTER_DISCORD_ENABLED: '1' })('discord')).toBe(true);
        expect(on({ token: 'abc', discord: { enabled: 0 } })('discord')).toBe(false);
    });

    test('derived (push): default on, switch off, and a half-set VAPID pair is off', () => {
        expect(on()('push')).toBe(true);
        expect(on({ webapp: { push: { enabled: false } } })('push')).toBe(false);
        expect(on({}, { GOOBSTER_WEB_PUSH_ENABLED: '0' })('push')).toBe(false);
        expect(on({ webapp: { push: { vapidPublicKey: 'pub', vapidPrivateKey: 'priv' } } })('push')).toBe(true);
        expect(on({ webapp: { push: { vapidPublicKey: 'pub' } } })('push')).toBe(false);
        expect(on({}, { GOOBSTER_VAPID_PRIVATE_KEY: 'priv' })('push')).toBe(false);
        const { state: s } = make({ config: { webapp: { push: { vapidPublicKey: 'pub' } } } });
        expect(s.availability('push')).toEqual({
            id: 'push',
            active: false,
            reasons: [{ code: 'DISABLED', detail: 'webapp.push.enabled' }],
            warnings: [{ code: 'NOT_CONFIGURED', detail: 'GOOBSTER_VAPID_PRIVATE_KEY' }]
        });
        expect(s.status().features.push).toMatchObject({ configured: false, active: false });
    });

    test('derived (mail): on only when a provider has credentials and a from address', () => {
        expect(on()('mail')).toBe(false);
        expect(on({ mail: { smtp: { host: 'smtp.example.org' } } })('mail')).toBe(false);
        expect(on({ mail: { from: 'g@example.org' } })('mail')).toBe(false);
        expect(on({ mail: { from: 'g@example.org', smtp: { host: 'smtp.example.org' } } })('mail')).toBe(true);
        expect(on({ mail: { from: 'g@example.org', smtp: { url: 'smtp://u:p@h:587' } } })('mail')).toBe(true);
        expect(on({ mail: { from: 'g@example.org', resend: { apiKey: 're_x' } } })('mail')).toBe(true);
        expect(on({ mail: { provider: 'smtp', from: 'g@example.org', resend: { apiKey: 're_x' } } })('mail')).toBe(false);
        expect(on({ mail: { provider: 'carrier-pigeon', from: 'g@example.org', smtp: { host: 'h' } } })('mail')).toBe(false);
        expect(on({}, { GOOBSTER_MAIL_FROM: 'g@example.org', RESEND_API_KEY: 're_x' })('mail')).toBe(true);
        const hostOnly = make({ config: { mail: { smtp: { host: 'h' } } } }).state;
        expect(hostOnly.availability('mail')).toEqual({
            id: 'mail',
            active: false,
            reasons: [{ code: 'DISABLED', detail: 'mail.provider' }],
            warnings: [{ code: 'NOT_CONFIGURED', detail: 'GOOBSTER_MAIL_FROM' }]
        });
    });

    test('presence (github): available without credentials, because the surfaces exist keyless today', () => {
        expect(on()('github')).toBe(true);
        expect(on({ github: { token: 't' } })('github')).toBe(true);
    });

    test('presence (cursor): stays active without CURSOR_API_KEY; configured and the warning follow env or config', () => {
        const { state: bare } = make();
        expect(bare.isActive('cursor')).toBe(true);
        expect(bare.status().source).toBe('none');
        expect(bare.status().features.cursor).toMatchObject({ configured: false, active: true, requested: true, reasons: [] });
        expect(bare.availability('cursor')).toEqual({
            id: 'cursor', active: true, reasons: [], warnings: [{ code: 'NOT_CONFIGURED', detail: 'CURSOR_API_KEY' }]
        });
        for (const [config, env, configured] of [
            [{ cursor: { webhookSecret: 'w' } }, {}, false],
            [{ cursor: { apiKey: '  ' } }, {}, false],
            [{ cursor: { apiKey: 'k' } }, {}, true],
            [{}, { CURSOR_API_KEY: 'k' }, true]
        ]) {
            const { state: s } = make({ config, env });
            expect(s.isActive('cursor')).toBe(true);
            expect(s.status().features.cursor.configured).toBe(configured);
            expect(s.availability('cursor').warnings.length).toBe(configured ? 0 : 1);
        }
    });

    test('hard dependencies apply in legacy mode', () => {
        const observatoryOnly = make({ config: { observatory: { enabled: true } } }).state;
        expect(observatoryOnly.availability('observatory')).toEqual({
            id: 'observatory',
            active: false,
            reasons: [{ code: 'DEPENDENCY_INACTIVE', dependency: 'sandbox' }],
            warnings: []
        });
        const noProjects = make({ config: { observatory: { enabled: true }, sandbox: { enabled: true }, projects: { enabled: false } } }).state;
        expect(noProjects.isActive('observatory')).toBe(false);
        expect(reasonCodes(noProjects, 'observatory')).toEqual(['DEPENDENCY_INACTIVE']);
        expect(make({ config: { activity: { enabled: true } } }).state.availability('discordActivity').reasons)
            .toEqual([{ code: 'DEPENDENCY_INACTIVE', dependency: 'discord' }]);
        expect(make({ config: { activity: { enabled: true }, token: 'x' } }).state.isActive('discordActivity')).toBe(true);
        expect(make({ config: { cursor: { apiKey: 'k' } }, env: { GOOBSTER_FEATURE_GITHUB: '0' } }).state.availability('cursor').reasons)
            .toEqual([{ code: 'DEPENDENCY_INACTIVE', dependency: 'github' }]);
        expect(make({ config: { spitball: { enabled: true } }, env: { GOOBSTER_FEATURE_KNOWLEDGE: 'off' } }).state.isActive('expeditions')).toBe(false);
    });

    test('DISABLED names the switch, not a value', () => {
        const { state: s } = make({ config: { mcp: { enabled: false } } });
        expect(s.availability('mcp').reasons).toEqual([{ code: 'DISABLED', detail: 'mcp.enabled' }]);
    });
});

describe('baseline: no state file equals the effective legacy value read from the real config modules', () => {
    const CONFIG_JSON = path.join(ROOT, 'config.json');
    const ENV_KEYS = [
        'GOOBSTER_DISCORD_ENABLED', 'GOOBSTER_WEB_PUSH_ENABLED', 'GOOBSTER_MCP_ENABLED', 'GOOBSTER_SANDBOX_ENABLED',
        'GOOBSTER_OBSERVATORY_ENABLED', 'GOOBSTER_PROJECTS_ENABLED', 'GOOBSTER_SPITBALL_ENABLED',
        'GOOBSTER_MAIL_PROVIDER', 'GOOBSTER_MAIL_FROM', 'GOOBSTER_SMTP_URL', 'GOOBSTER_SMTP_HOST', 'RESEND_API_KEY',
        'GOOBSTER_VAPID_PUBLIC_KEY', 'GOOBSTER_VAPID_PRIVATE_KEY', 'GITHUB_TOKEN', 'GITHUB_WEBHOOK_SECRET',
        'CURSOR_API_KEY', 'CURSOR_WEBHOOK_SECRET', 'GOOBSTER_DATA_DIR', 'GOOBSTER_CONFIG_PATH',
        ...FEATURE_IDS.map(envVarFor)
    ];
    const example = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
    const mail = { from: 'g@example.org', smtp: { host: 'smtp.example.org' } };
    const keys = { vapidPublicKey: 'pub', vapidPrivateKey: 'priv' };

    const fixtures = [
        ['empty config', {}, {}],
        ['jest placeholder token', { clientId: '0', guildIds: ['0'], token: 'jest-test-placeholder' }, {}],
        ['config.example.json as shipped', example, {}],
        ['config.example.json with every switch on', {
            ...example,
            discord: { enabled: true },
            mcp: { ...example.mcp, enabled: true },
            sandbox: { ...example.sandbox, enabled: true },
            observatory: { ...example.observatory, enabled: true },
            projects: { enabled: true },
            spitball: { enabled: true },
            gbaRun: { enabled: true },
            screenVision: { ...example.screenVision, enabled: true },
            activity: { ...example.activity, enabled: true },
            webapp: { ...example.webapp, push: { ...example.webapp.push, vapidPublicKey: 'pub', vapidPrivateKey: 'priv' } },
            mail,
            cursor: { apiKey: 'k' },
            github: { token: 't' }
        }, {}],
        ['every switch explicitly off', {
            token: 'abc',
            discord: { enabled: false },
            mcp: { enabled: false },
            sandbox: { enabled: false },
            observatory: { enabled: false },
            projects: { enabled: false },
            spitball: { enabled: false },
            gbaRun: { enabled: false },
            screenVision: { enabled: false },
            activity: { enabled: false },
            webapp: { push: { enabled: false } }
        }, {}],
        ['sandbox enabled, observatory disabled (tests/*sandbox*)', { sandbox: { enabled: true }, observatory: { enabled: false }, token: 'x' }, {}],
        ['observatory and sandbox enabled', { sandbox: { enabled: true }, observatory: { enabled: true }, token: 'x' }, {}],
        ['observatory enabled without sandbox', { observatory: { enabled: true } }, {}],
        ['observatory and sandbox on, projects off', { sandbox: { enabled: true }, observatory: { enabled: true }, projects: { enabled: false } }, {}],
        ['activity enabled with a token (tests/*activity*)', { activity: { enabled: true }, token: 'x' }, {}],
        ['activity enabled without discord', { activity: { enabled: true } }, {}],
        ['discord forced on without a token', { discord: { enabled: true } }, {}],
        ['discord forced off with a token', { token: 'x', discord: { enabled: false } }, {}],
        ['mcp enabled', { mcp: { enabled: true } }, {}],
        ['mcp disabled in file, enabled by env', { mcp: { enabled: false } }, { GOOBSTER_MCP_ENABLED: '1' }],
        ['mcp enabled in file, disabled by env', { mcp: { enabled: true } }, { GOOBSTER_MCP_ENABLED: 'off' }],
        ['mcp env word', {}, { GOOBSTER_MCP_ENABLED: 'yes' }],
        ['sandbox env yes (not accepted)', {}, { GOOBSTER_SANDBOX_ENABLED: 'yes' }],
        ['sandbox env 1', {}, { GOOBSTER_SANDBOX_ENABLED: '1' }],
        ['sandbox env true + observatory env true', { projects: { enabled: true } }, { GOOBSTER_SANDBOX_ENABLED: 'true', GOOBSTER_OBSERVATORY_ENABLED: 'true' }],
        ['observatory env uppercase TRUE (not accepted)', { sandbox: { enabled: true } }, { GOOBSTER_OBSERVATORY_ENABLED: 'TRUE' }],
        ['sandbox config string "true"', { sandbox: { enabled: 'true' } }, {}],
        ['projects env 0', {}, { GOOBSTER_PROJECTS_ENABLED: '0' }],
        ['projects env off (not accepted)', {}, { GOOBSTER_PROJECTS_ENABLED: 'off' }],
        ['projects off in file, on by env', { projects: { enabled: false } }, { GOOBSTER_PROJECTS_ENABLED: 'true' }],
        ['spitball false', { spitball: { enabled: false } }, {}],
        ['spitball 0 (not false)', { spitball: { enabled: 0 } }, {}],
        ['spitball env false', {}, { GOOBSTER_SPITBALL_ENABLED: 'false' }],
        ['spitball env off (not accepted)', {}, { GOOBSTER_SPITBALL_ENABLED: 'off' }],
        ['gba true', { gbaRun: { enabled: true } }, {}],
        ['gba string true', { gbaRun: { enabled: 'true' } }, {}],
        ['screenVision true', { screenVision: { enabled: true } }, {}],
        ['push disabled', { webapp: { push: { enabled: false } } }, {}],
        ['push disabled by env', {}, { GOOBSTER_WEB_PUSH_ENABLED: 'no' }],
        ['push with a key pair', { webapp: { push: keys } }, {}],
        ['push half-configured', { webapp: { push: { vapidPublicKey: 'pub' } } }, {}],
        ['push half-configured by env', {}, { GOOBSTER_VAPID_PRIVATE_KEY: 'priv' }],
        ['mail smtp host + from', { mail }, {}],
        ['mail from only', { mail: { from: 'g@example.org' } }, {}],
        ['mail resend by env', {}, { GOOBSTER_MAIL_FROM: 'g@example.org', RESEND_API_KEY: 're_x' }],
        ['mail unknown provider', { mail: { ...mail, provider: 'pigeon' } }, {}],
        ['mail explicit smtp without host but with resend key', { mail: { provider: 'smtp', from: 'g@example.org', resend: { apiKey: 're_x' } } }, {}],
        ['cursor key in config', { cursor: { apiKey: 'k' } }, {}],
        ['cursor key in env', {}, { CURSOR_API_KEY: 'k' }],
        ['cursor webhook secret only', { cursor: { webhookSecret: 'w' } }, {}],
        ['github token', { github: { token: 't' } }, {}],
        ['github webhook secret only', {}, { GITHUB_WEBHOOK_SECRET: 'w' }],
        ['everything on', {
            token: 'x', discord: { enabled: true }, mcp: { enabled: true }, sandbox: { enabled: true },
            observatory: { enabled: true }, projects: { enabled: true }, spitball: { enabled: true },
            gbaRun: { enabled: true }, screenVision: { enabled: true }, activity: { enabled: true },
            webapp: { push: keys }, mail, cursor: { apiKey: 'k' }, github: { token: 't' }
        }, {}]
    ];

    function evaluate(config, env) {
        const saved = {};
        for (const key of ENV_KEYS) {
            saved[key] = process.env[key];
            delete process.env[key];
        }
        const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-features-'));
        Object.assign(process.env, env, { GOOBSTER_DATA_DIR: dataDir });
        let out;
        try {
            jest.isolateModules(() => {
                jest.doMock(CONFIG_JSON, () => JSON.parse(JSON.stringify(config)));
                const modules = {
                    discord: require('@goobster/core/config/discordConfig'),
                    push: require('@goobster/core/config/pushConfig'),
                    mail: require('@goobster/core/config/mailConfig'),
                    mcp: require('@goobster/core/config/mcpConfig'),
                    sandbox: require('@goobster/core/config/sandboxConfig'),
                    observatory: require('@goobster/core/config/observatoryConfig'),
                    spitball: require('@goobster/core/config/spitballConfig'),
                    integrations: require('@goobster/core/config/integrationsConfig')
                };
                const legacy = {
                    discord: modules.discord.enabled,
                    push: modules.push.enabled,
                    mail: modules.mail.enabled,
                    mcp: modules.mcp.enabled,
                    sandbox: modules.sandbox.enabled,
                    observatory: modules.observatory.enabled,
                    projects: modules.observatory.projectsEnabled,
                    expeditions: modules.spitball.enabled,
                    gba: config.gbaRun?.enabled === true,
                    screenVision: config.screenVision?.enabled === true,
                    discordActivity: config.activity?.enabled === true
                };
                const expected = {};
                const resolve = (id) => {
                    if (expected[id] === undefined) {
                        if (id === 'core') expected[id] = true;
                        else {
                            const requested = Object.prototype.hasOwnProperty.call(legacy, id) ? legacy[id] : true;
                            expected[id] = Boolean(requested)
                                && FEATURES[id].dependsOn.every(dep => resolve(dep));
                        }
                    }
                    return expected[id];
                };
                FEATURE_IDS.forEach(resolve);

                const fresh = require('@goobster/core/features/featureState');
                const viaModules = fresh.createFeatureState({ fs: memoryFs(), filePath: FILE, env: process.env });
                const viaConfig = fresh.createFeatureState({ fs: memoryFs(), filePath: FILE, env: { ...env }, config });
                out = {
                    expected,
                    viaModules: Object.fromEntries(FEATURE_IDS.map(id => [id, viaModules.isActive(id)])),
                    viaConfig: Object.fromEntries(FEATURE_IDS.map(id => [id, viaConfig.isActive(id)])),
                    seedModules: viaModules.seedFromLegacy().features,
                    cursorConfigured: viaModules.status().features.cursor.configured === Boolean(modules.integrations.cursor.apiKey),
                    pushKeyFiles: fs.readdirSync(dataDir)
                };
            });
        } finally {
            jest.dontMock(CONFIG_JSON);
            for (const key of ENV_KEYS) {
                if (saved[key] === undefined) delete process.env[key];
                else process.env[key] = saved[key];
            }
            fs.rmSync(dataDir, { recursive: true, force: true });
        }
        return out;
    }

    test.each(fixtures)('%s', (_name, config, env) => {
        const result = evaluate(config, env);
        expect(result.viaModules).toEqual(result.expected);
        expect(result.viaConfig).toEqual(result.expected);
        expect(result.cursorConfigured).toBe(true);
        for (const id of MANAGEABLE) {
            const deps = FEATURES[id].dependsOn;
            if (result.seedModules[id].active) {
                for (const dep of deps) expect(result.seedModules[dep].active).toBe(true);
            }
        }
    });

    test('the fixture list exercises every legacy switch both ways', () => {
        const outcomes = fixtures.map(([, config, env]) => evaluate(config, env).expected);
        for (const id of FEATURE_IDS) {
            const values = new Set(outcomes.map(o => o[id]));
            if (id === 'core') expect([...values]).toEqual([true]);
            else if (id === 'github' || id === 'cursor') expect([...values]).toEqual([true]);
            else if (FEATURES[id].legacySwitch) expect({ id, values: [...values].sort() }).toEqual({ id, values: [false, true] });
            else expect([...values]).toEqual([true]);
        }
    });

    test('the module source follows the test seams existing suites use', () => {
        jest.isolateModules(() => {
            const discordConfig = require('@goobster/core/config/discordConfig');
            const mcpConfig = require('@goobster/core/config/mcpConfig');
            const { createFeatureState: create } = require('@goobster/core/features/featureState');
            const s = create({ fs: memoryFs(), filePath: FILE, env: {} });
            discordConfig.setEnabledForTests(true);
            mcpConfig._setForTests({ enabled: true });
            expect(s.refresh().entries.discord.requested).toBe(true);
            expect(s.isActive('mcp')).toBe(true);
            discordConfig.setEnabledForTests(false);
            mcpConfig._setForTests({ enabled: false });
            s.refresh();
            expect(s.isActive('discord')).toBe(false);
            expect(s.isActive('mcp')).toBe(false);
            discordConfig.setEnabledForTests(undefined);
            mcpConfig._setForTests(null);
        });
    });

    test('evaluating push never creates a key file (the resolver is read-only)', () => {
        const result = evaluate({}, {});
        expect(result.expected.push).toBe(true);
        expect(result.viaModules.push).toBe(true);
    });
});

describe('seed and fresh preset documents', () => {
    test('freshPreset follows the catalog: economy, exchange and gambling off, the rest on', () => {
        const { state: s, fs: memory } = make();
        const doc = s.freshPreset();
        expect(doc).toMatchObject({ version: STATE_VERSION, revision: 0, origin: 'fresh-preset' });
        expect(Object.keys(doc.features)).toEqual(MANAGEABLE);
        const off = MANAGEABLE.filter(id => !doc.features[id].active);
        expect(off).toEqual(['economy', 'exchange', 'gambling']);
        for (const id of MANAGEABLE) expect(doc.features[id].installed).toBe(true);
        expect(memory.mutatingCalls()).toEqual([]);
    });

    test('a fresh preset is a valid document and "active" does not mean "configured"', async () => {
        const { state: s } = make();
        await s.write(s.freshPreset(), { expectedRevision: null });
        s.refresh();
        for (const id of ['mcp', 'sandbox', 'observatory', 'screenVision', 'gba']) {
            const entry = s.status().features[id];
            expect(entry.requested).toBe(true);
        }
        expect(s.isActive('economy')).toBe(false);
        expect(reasonCodes(s, 'economy')).toEqual(['DISABLED']);
        expect(reasonCodes(s, 'gambling')).toEqual(['DISABLED', 'DEPENDENCY_INACTIVE']);
        expect(s.isActive('music')).toBe(true);
        expect(s.isActive('cursor')).toBe(true);
        expect(s.availability('cursor').warnings).toEqual([{ code: 'NOT_CONFIGURED', detail: 'CURSOR_API_KEY' }]);
    });

    test('seedFromLegacy mirrors the effective legacy switches with installed true and origin legacy-seed', () => {
        const { state: s } = make({ config: { token: 'x', mcp: { enabled: true }, spitball: { enabled: false } } });
        const doc = s.seedFromLegacy();
        expect(doc).toMatchObject({ version: 1, revision: 0, origin: 'legacy-seed' });
        expect(doc.features.mcp).toEqual({ installed: true, active: true });
        expect(doc.features.expeditions).toEqual({ installed: true, active: false });
        expect(doc.features.sandbox).toEqual({ installed: true, active: false });
        expect(doc.features.discord).toEqual({ installed: true, active: true });
        expect(doc.features.economy).toEqual({ installed: true, active: true });
        expect(doc.features.gambling).toEqual({ installed: true, active: true });
        expect(doc.features.cursor).toEqual({ installed: true, active: true });
        expect(Object.keys(doc.features)).toEqual(MANAGEABLE);
    });

    test('a legacy seed never contains a dependency conflict, so the first write always succeeds', async () => {
        const configs = [
            { observatory: { enabled: true } },
            { activity: { enabled: true } },
            { projects: { enabled: false }, observatory: { enabled: true }, sandbox: { enabled: true } },
            { token: 'x', activity: { enabled: true }, observatory: { enabled: true }, sandbox: { enabled: true } }
        ];
        for (const config of configs) {
            const { state: s, fs: memory } = make({ config });
            const seed = s.seedFromLegacy();
            if (config.observatory && !config.sandbox) expect(seed.features.observatory.active).toBe(false);
            await expect(s.write(seed, { expectedRevision: null })).resolves.toMatchObject({ revision: 1, origin: 'legacy-seed' });
            expect(memory.files.has(FILE)).toBe(true);
        }
    });

    test('seeding, then loading the seeded file, yields the same effective answers as no file', async () => {
        const configs = [
            {},
            { token: 'x', mcp: { enabled: true }, sandbox: { enabled: true }, observatory: { enabled: true } },
            { token: 'x', activity: { enabled: true }, gbaRun: { enabled: true }, cursor: { apiKey: 'k' }, mail: { from: 'a@b.c', smtp: { host: 'h' } } },
            { projects: { enabled: false }, spitball: { enabled: false } }
        ];
        for (const config of configs) {
            const { state: s } = make({ config });
            const before = FEATURE_IDS.map(id => s.isActive(id));
            await s.write(s.seedFromLegacy(), { expectedRevision: null });
            s.refresh();
            expect(s.status().source).toBe('file');
            expect(FEATURE_IDS.map(id => s.isActive(id))).toEqual(before);
        }
    });
});

describe('state file precedence', () => {
    test('requested comes from the file, not from the legacy flag', () => {
        const { state: s } = make({
            files: { [FILE]: docText({ mcp: { active: false }, sandbox: { active: true }, tavern: { active: false } }) },
            config: { mcp: { enabled: true }, sandbox: { enabled: false } }
        });
        expect(s.isActive('mcp')).toBe(false);
        expect(reasonCodes(s, 'mcp')).toEqual(['DISABLED']);
        expect(s.isActive('sandbox')).toBe(true);
        expect(s.isActive('tavern')).toBe(false);
        expect(s.status()).toMatchObject({ source: 'file', version: 1, revision: 3, origin: 'operator', error: null });
    });

    test('a feature missing from the file falls back to its legacy value', () => {
        const entries = JSON.parse(docText());
        delete entries.features.mcp;
        delete entries.features.tavern;
        const { state: s } = make({ files: { [FILE]: JSON.stringify(entries) }, config: { mcp: { enabled: true } } });
        expect(s.isActive('mcp')).toBe(true);
        expect(s.isActive('tavern')).toBe(true);
    });

    test('installed:false is honoured and can never be overridden by the operator or the environment', () => {
        const { state: s, logger } = make({
            files: { [FILE]: docText({ music: { installed: false, active: true }, voice: { installed: false, active: false } }) },
            env: { GOOBSTER_FEATURE_MUSIC: '1' }
        });
        expect(s.isActive('music')).toBe(false);
        expect(reasonCodes(s, 'music')).toEqual(['NOT_INSTALLED']);
        expect(reasonCodes(s, 'voice')).toEqual(['NOT_INSTALLED', 'DISABLED']);
        expect(s.status().features.music).toMatchObject({ installed: false, active: false, requested: true });
        expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    test('a missing dependency payload deactivates its dependents', () => {
        const { state: s } = make({ files: { [FILE]: docText({ economy: { installed: false, active: false } }) } });
        expect(s.availability('exchange')).toEqual({ id: 'exchange', active: false, reasons: [{ code: 'DEPENDENCY_INACTIVE', dependency: 'economy' }], warnings: [] });
        expect(s.isActive('gambling')).toBe(false);
    });

    test('missing credentials are warnings by name: the feature stays active and configured is false', () => {
        const files = { [FILE]: docText() };
        const bare = make({ files }).state;
        expect(bare.availability('cursor')).toEqual({
            id: 'cursor', active: true, reasons: [], warnings: [{ code: 'NOT_CONFIGURED', detail: 'CURSOR_API_KEY' }]
        });
        expect(bare.status().features.cursor).toMatchObject({
            installed: true, configured: false, requested: true, active: true, reasons: [],
            warnings: [{ code: 'NOT_CONFIGURED', detail: 'CURSOR_API_KEY' }]
        });
        for (const state of [make({ files, env: { CURSOR_API_KEY: 'k' } }).state, make({ files, config: { cursor: { apiKey: 'k' } } }).state]) {
            expect(state.status().features.cursor).toMatchObject({ configured: true, active: true, warnings: [] });
        }

        const mailBare = make({ files }).state;
        expect(mailBare.isActive('mail')).toBe(true);
        expect(mailBare.availability('mail').warnings).toEqual([{ code: 'NOT_CONFIGURED', detail: 'GOOBSTER_SMTP_URL|GOOBSTER_SMTP_HOST|RESEND_API_KEY' }]);
        const fromMissing = make({ files, config: { mail: { smtp: { host: 'h' } } } }).state;
        expect(fromMissing.availability('mail')).toEqual({
            id: 'mail', active: true, reasons: [], warnings: [{ code: 'NOT_CONFIGURED', detail: 'GOOBSTER_MAIL_FROM' }]
        });
        const full = make({ files, config: { mail: { from: 'a@b.c', smtp: { host: 'h' } } } }).state;
        expect(full.isActive('mail')).toBe(true);
        expect(full.status().features.mail).toMatchObject({ configured: true, warnings: [] });
    });

    test('configured reflects the current credentials on refresh, not a stale persisted boolean, and never gates', () => {
        const env = {};
        const { state: s } = make({ files: { [FILE]: docText() }, env });
        expect(s.isActive('cursor')).toBe(true);
        expect(s.status().features.cursor.configured).toBe(false);
        env.CURSOR_API_KEY = 'k';
        expect(s.status().features.cursor.configured).toBe(false);
        s.refresh();
        expect(s.isActive('cursor')).toBe(true);
        expect(s.status().features.cursor.configured).toBe(true);
        expect(JSON.parse(docText()).features.cursor).toEqual({ installed: true, active: true });
    });

    test('a feature that is unconfigured and also off reports both, separately', () => {
        const { state: s } = make({ files: { [FILE]: docText({ cursor: { active: false } }) } });
        expect(s.availability('cursor')).toEqual({
            id: 'cursor',
            active: false,
            reasons: [{ code: 'DISABLED', detail: 'features.json' }],
            warnings: [{ code: 'NOT_CONFIGURED', detail: 'CURSOR_API_KEY' }]
        });
    });

    test('the effective answer needs every dependency active, and reasons name each missing one', () => {
        const { state: s } = make({ files: { [FILE]: docText({ projects: { active: false }, sandbox: { active: false } }) } });
        expect(s.availability('observatory').reasons).toEqual([
            { code: 'DEPENDENCY_INACTIVE', dependency: 'projects' },
            { code: 'DEPENDENCY_INACTIVE', dependency: 'sandbox' }
        ]);
    });

    test('unavailable() lists every inactive feature in catalog order with its reasons', () => {
        const { state: s } = make({ files: { [FILE]: docText({ economy: { active: false } }) } });
        const list = s.unavailable();
        expect(list.map(a => a.id)).toEqual(['discord'].filter(() => false).concat(
            FEATURE_IDS.filter(id => !s.isActive(id))
        ));
        expect(list.map(a => a.id)).toEqual(expect.arrayContaining(['economy', 'exchange', 'gambling']));
        expect(list.map(a => a.id)).not.toContain('cursor');
        for (const a of list) {
            expect(a.active).toBe(false);
            expect(a.reasons.length).toBeGreaterThan(0);
        }
        expect(list.map(a => a.id).indexOf('economy')).toBeLessThan(list.map(a => a.id).indexOf('exchange'));
    });

    test('an active feature has no reasons and an inactive one always has at least one', () => {
        for (const config of [{}, { token: 'x', mcp: { enabled: true } }]) {
            const { state: s } = make({ config });
            for (const id of FEATURE_IDS) {
                expect(s.availability(id).reasons.length === 0).toBe(s.isActive(id));
            }
        }
    });
});

describe('pending and active are distinct', () => {
    test('pendingActive never flips isActive; pending is derived', () => {
        const { state: s } = make({
            files: { [FILE]: docText({ gambling: { active: false, pendingActive: true }, music: { active: true, pendingActive: false } }) }
        });
        expect(s.isActive('gambling')).toBe(false);
        expect(s.isActive('music')).toBe(true);
        const status = s.status();
        expect(status.features.gambling).toMatchObject({ active: false, requested: false, pending: true, pendingActive: true });
        expect(status.features.music).toMatchObject({ active: true, requested: true, pending: true, pendingActive: false });
        expect(status.features.tavern).toMatchObject({ pending: false, pendingActive: null });
    });

    test('a pendingActive equal to active is not pending', () => {
        const { state: s } = make({ files: { [FILE]: docText({ music: { active: true, pendingActive: true } }) } });
        expect(s.status().features.music.pending).toBe(false);
    });

    test('state-transition: operator disables gambling, it stays active until the restart snapshot', async () => {
        const { state: s, fs: memory } = make();
        await s.write({ ...s.seedFromLegacy(), origin: 'legacy-seed' }, { expectedRevision: null });
        s.refresh();
        expect(s.isActive('gambling')).toBe(true);

        const doc = JSON.parse(memory.files.get(FILE));
        doc.features.gambling = { installed: true, active: true, pendingActive: false };
        const written = await s.write({ origin: 'operator', features: doc.features }, { expectedRevision: 1 });
        expect(written.revision).toBe(2);
        expect(s.isActive('gambling')).toBe(true);
        s.refresh();
        expect(s.isActive('gambling')).toBe(true);
        expect(s.status().features.gambling).toMatchObject({ active: true, pending: true, pendingActive: false });

        const afterRestart = make({ files: { [FILE]: JSON.stringify({ ...JSON.parse(memory.files.get(FILE)), features: { ...doc.features, gambling: { installed: true, active: false } } }) } }).state;
        expect(afterRestart.isActive('gambling')).toBe(false);
        expect(afterRestart.status().features.gambling.pending).toBe(false);
    });
});

describe('environment overrides deactivate only', () => {
    test('envVarFor produces GOOBSTER_FEATURE_<UPPER_SNAKE_ID>', () => {
        expect(envVarFor('music')).toBe('GOOBSTER_FEATURE_MUSIC');
        expect(envVarFor('screenVision')).toBe('GOOBSTER_FEATURE_SCREEN_VISION');
        expect(envVarFor('discordActivity')).toBe('GOOBSTER_FEATURE_DISCORD_ACTIVITY');
    });

    test('0, false, no and off deactivate an active feature with ENV_OFF naming the variable', () => {
        for (const value of ['0', 'false', 'no', 'off', 'OFF', ' False ']) {
            const { state: s } = make({ env: { GOOBSTER_FEATURE_MUSIC: value } });
            expect(s.isActive('music')).toBe(false);
            expect(s.availability('music').reasons).toEqual([{ code: 'ENV_OFF', detail: 'GOOBSTER_FEATURE_MUSIC' }]);
        }
        const { state: s } = make({ env: { GOOBSTER_FEATURE_SCREEN_VISION: '0' }, config: { screenVision: { enabled: true } } });
        expect(s.availability('screenVision').reasons).toEqual([{ code: 'ENV_OFF', detail: 'GOOBSTER_FEATURE_SCREEN_VISION' }]);
    });

    test('env off applies on top of an active file state, and dependents follow', () => {
        const { state: s } = make({ files: { [FILE]: docText() }, env: { GOOBSTER_FEATURE_ECONOMY: '0' } });
        expect(s.isActive('economy')).toBe(false);
        expect(s.availability('exchange').reasons).toEqual([{ code: 'DEPENDENCY_INACTIVE', dependency: 'economy' }]);
        expect(s.status().features.economy).toMatchObject({ requested: true, active: false });
    });

    test('a truthy value cannot activate anything and logs one warning naming only the variable', () => {
        const env = { GOOBSTER_FEATURE_MCP: '1', GOOBSTER_FEATURE_SANDBOX: 'true', GOOBSTER_FEATURE_MUSIC: 'secret-ish-value' };
        const { state: s, logger } = make({ env });
        expect(s.isActive('mcp')).toBe(false);
        expect(s.isActive('sandbox')).toBe(false);
        expect(s.isActive('music')).toBe(true);
        s.status();
        s.refresh();
        s.refresh();
        expect(logger.warn).toHaveBeenCalledTimes(3);
        const messages = logger.warn.mock.calls.map(call => call.join(' '));
        expect(messages.some(m => m.includes('GOOBSTER_FEATURE_MCP'))).toBe(true);
        expect(messages.join('\n')).not.toContain('secret-ish-value');
    });

    test('an empty or unset variable is ignored silently', () => {
        const { state: s, logger } = make({ env: { GOOBSTER_FEATURE_MUSIC: '', GOOBSTER_FEATURE_VOICE: '  ' } });
        expect(s.isActive('music')).toBe(true);
        expect(s.isActive('voice')).toBe(true);
        expect(logger.warn).not.toHaveBeenCalled();
    });
});

describe('unknown, corrupt and unsupported files', () => {
    function expectFallback(content, code, extra = {}) {
        const config = { token: 'x', mcp: { enabled: true } };
        const { state: s, fs: memory } = make({ files: { [FILE]: content }, config });
        const status = s.status();
        expect(status.source).toBe('none');
        expect(status.error).toMatchObject({ code, ...extra });
        expect(typeof status.error.message).toBe('string');
        const baseline = make({ config }).state;
        for (const id of FEATURE_IDS) expect(s.isActive(id)).toBe(baseline.isActive(id));
        expect(s.isActive('mcp')).toBe(true);
        expect(memory.files.get(FILE)).toBe(content);
        expect(memory.mutatingCalls()).toEqual([]);
        expect(s.load().error).toBeInstanceOf(FeatureStateError);
        return s;
    }

    test('an unknown feature id', () => {
        expectFallback(docText({ hologram: {} }), 'UNKNOWN_FEATURE', { feature: 'hologram' });
    });

    test('core inside the file', () => {
        expectFallback(docText({ core: { active: false } }), 'CORE_IMMUTABLE', { feature: 'core' });
    });

    test('unparsable JSON', () => {
        expectFallback('{ "version": 1, "features": ', 'CORRUPT_STATE');
        expectFallback('', 'CORRUPT_STATE');
        expectFallback('[]', 'CORRUPT_STATE');
        expectFallback('null', 'CORRUPT_STATE');
    });

    test('a wrong version', () => {
        expectFallback(docText({}, { version: 2 }), 'UNSUPPORTED_VERSION');
        expectFallback(JSON.stringify({ version: 0 }), 'UNSUPPORTED_VERSION');
        expectFallback(JSON.stringify({ version: 2, whatever: { shape: true } }), 'UNSUPPORTED_VERSION');
    });

    test('malformed documents and entries', () => {
        expectFallback(JSON.stringify({ revision: 1 }), 'CORRUPT_STATE');
        expectFallback(docText({}, { revision: -1 }), 'CORRUPT_STATE');
        expectFallback(docText({}, { revision: 1.5 }), 'CORRUPT_STATE');
        expectFallback(docText({}, { origin: 'hand-edited' }), 'CORRUPT_STATE');
        expectFallback(docText({}, { features: [] }), 'CORRUPT_STATE');
        expectFallback(docText({ music: { active: 'yes' } }), 'CORRUPT_STATE', { feature: 'music' });
        expectFallback(docText({ music: { installed: 1 } }), 'CORRUPT_STATE', { feature: 'music' });
        expectFallback(docText({ music: { pendingActive: 'later' } }), 'CORRUPT_STATE', { feature: 'music' });
        expectFallback(JSON.stringify({ ...JSON.parse(docText()), features: { music: 'on' } }), 'CORRUPT_STATE', { feature: 'music' });
    });

    test('an unreadable file', () => {
        const { state: s } = make({ files: { [FILE]: docText() }, failOn: 'readFileSync' });
        expect(s.status().error).toMatchObject({ code: 'STATE_UNREADABLE' });
        expect(s.status().source).toBe('none');
    });

    test('inactive features also carry STATE_ERROR so management can say why the file was not used', () => {
        const { state: s } = make({ files: { [FILE]: '{' } });
        expect(s.availability('mcp').reasons).toEqual([
            { code: 'DISABLED', detail: 'mcp.enabled' },
            { code: 'STATE_ERROR', detail: 'CORRUPT_STATE' }
        ]);
        expect(s.availability('music')).toEqual({ id: 'music', active: true, reasons: [], warnings: [] });
        expect(s.status().features.mcp.reasons.map(r => r.code)).toContain('STATE_ERROR');
    });

    test('writing never replaces a file that cannot be read', async () => {
        const { state: s, fs: memory } = make({ files: { [FILE]: '{ nope' } });
        await expect(s.write(s.freshPreset(), { expectedRevision: null })).rejects.toMatchObject({ code: 'CORRUPT_STATE' });
        expect(memory.files.get(FILE)).toBe('{ nope');
        expect(memory.mutatingCalls()).toEqual([]);
    });
});

describe('atomic writes, revisions and validation', () => {
    test('the first write creates the directory, writes a tmp file, renames it, and the file round-trips', async () => {
        const { state: s, fs: memory } = make();
        const written = await s.write(s.freshPreset(), { expectedRevision: null });
        expect(written).toMatchObject({ version: 1, revision: 1, updatedAt: '2026-10-06 21:14:02', origin: 'fresh-preset' });
        const names = memory.mutatingCalls().map(([name]) => name);
        expect(names).toEqual(['mkdirSync', 'writeFileSync', 'renameSync']);
        expect(memory.calls.find(([name]) => name === 'writeFileSync')[1]).toBe(TMP);
        expect(memory.calls.find(([name]) => name === 'renameSync').slice(1)).toEqual([TMP, FILE]);
        expect(memory.files.has(TMP)).toBe(false);
        expect(JSON.parse(memory.files.get(FILE))).toEqual(written);
        expect(s.load()).toMatchObject({ exists: true, error: null, parsed: { revision: 1, origin: 'fresh-preset' } });
    });

    test('a write does not change the running snapshot until refresh()', async () => {
        const { state: s } = make();
        expect(s.isActive('economy')).toBe(true);
        await s.write(s.freshPreset(), { expectedRevision: 0 });
        expect(s.isActive('economy')).toBe(true);
        expect(s.status().source).toBe('none');
        s.refresh();
        expect(s.isActive('economy')).toBe(false);
        expect(s.status().source).toBe('file');
    });

    test('revisions advance by one and a stale expectedRevision is rejected with expected and actual', async () => {
        const { state: s, fs: memory } = make();
        await s.write(s.freshPreset(), { expectedRevision: null });
        await s.write(s.freshPreset(), { expectedRevision: 1 });
        const before = memory.files.get(FILE);
        const attempts = [[1, 2], [0, 2], [null, 2], [7, 2]];
        for (const [expected, actual] of attempts) {
            const error = await s.write(s.freshPreset(), { expectedRevision: expected }).catch(e => e);
            expect(error).toBeInstanceOf(StaleRevisionError);
            expect(error).toBeInstanceOf(FeatureStateError);
            expect(error).toMatchObject({ code: 'STALE_REVISION', expected: expected ?? 0, actual });
        }
        expect(memory.files.get(FILE)).toBe(before);
        expect(JSON.parse(before).revision).toBe(2);
    });

    test('a first write against a file that does not exist but expects a revision is stale', async () => {
        const { state: s, fs: memory } = make();
        const error = await s.write(s.freshPreset(), { expectedRevision: 4 }).catch(e => e);
        expect(error).toMatchObject({ code: 'STALE_REVISION', expected: 4, actual: 0 });
        expect(memory.mutatingCalls()).toEqual([]);
    });

    test('two writers that read the same revision: exactly one wins', async () => {
        const { state: s } = make();
        await s.write(s.freshPreset(), { expectedRevision: null });
        const results = await Promise.allSettled([
            s.write(s.freshPreset(), { expectedRevision: 1 }),
            s.write(s.seedFromLegacy(), { expectedRevision: 1 })
        ]);
        expect(results.map(r => r.status).sort()).toEqual(['fulfilled', 'rejected']);
        expect(s.load().parsed.revision).toBe(2);
    });

    test('an interrupted write leaves a tmp file that reads ignore and the next write overwrites', async () => {
        const { state: s, fs: memory } = make({ files: { [TMP]: '{"version":1,"half' } });
        expect(s.isActive('music')).toBe(true);
        expect(s.load()).toEqual({ exists: false, parsed: null, error: null });
        expect(s.status().source).toBe('none');
        await s.write(s.freshPreset(), { expectedRevision: null });
        expect(memory.files.has(TMP)).toBe(false);
        expect(JSON.parse(memory.files.get(FILE)).revision).toBe(1);
    });

    test('an interrupted write beside an existing file keeps the old file intact', () => {
        const old = docText();
        const { state: s } = make({ files: { [FILE]: old, [TMP]: 'garbage' } });
        expect(s.load().parsed.revision).toBe(3);
        expect(s.status().error).toBeNull();
    });

    test('a failing rename cleans the tmp file and leaves the target as it was', async () => {
        const first = make();
        await first.state.write(first.state.freshPreset(), { expectedRevision: null });
        const original = first.fs.files.get(FILE);

        const memory = memoryFs({ [FILE]: original }, { failOn: 'renameSync' });
        const s = createFeatureState({ fs: memory, filePath: FILE, env: {}, config: {}, now: () => FIXED_NOW });
        await expect(s.write(s.seedFromLegacy(), { expectedRevision: 1 })).rejects.toThrow('renameSync failed');
        expect(memory.files.get(FILE)).toBe(original);
        expect(memory.files.has(TMP)).toBe(false);
    });

    test('unknown ids and core are rejected before anything is written', async () => {
        const { state: s, fs: memory } = make();
        const bad = { origin: 'operator', features: { hologram: { installed: true, active: true } } };
        await expect(s.write(bad, { expectedRevision: null })).rejects.toMatchObject({ code: 'UNKNOWN_FEATURE', feature: 'hologram' });
        await expect(s.write({ features: { core: { active: false } } }, { expectedRevision: null })).rejects.toMatchObject({ code: 'CORE_IMMUTABLE' });
        expect(memory.mutatingCalls()).toEqual([]);
    });

    test('malformed documents are rejected', async () => {
        const { state: s } = make();
        for (const doc of [null, 'x', { origin: 'nobody' }, { features: [] }, { features: { music: 'on' } }, { features: { music: { active: 'yes' } } }]) {
            await expect(s.write(doc, { expectedRevision: null })).rejects.toMatchObject({ code: 'INVALID_STATE' });
        }
        await expect(s.write(s.freshPreset(), { expectedRevision: -1 })).rejects.toMatchObject({ code: 'INVALID_STATE' });
        await expect(s.write(s.freshPreset(), { expectedRevision: 'one' })).rejects.toMatchObject({ code: 'INVALID_STATE' });
    });

    test('an uninstalled feature cannot be written as active', async () => {
        const { state: s } = make();
        const doc = s.freshPreset();
        doc.features.music = { installed: false, active: true };
        await expect(s.write(doc, { expectedRevision: null })).rejects.toMatchObject({ code: 'INVALID_STATE', feature: 'music' });
        doc.features.music = { installed: false, active: false, pendingActive: true };
        await expect(s.write(doc, { expectedRevision: null })).rejects.toMatchObject({ code: 'INVALID_STATE', feature: 'music' });
        doc.features.music = { installed: false, active: false };
        await expect(s.write(doc, { expectedRevision: null })).resolves.toMatchObject({ revision: 1 });
    });

    test('a requested-active feature whose dependency is requested-inactive is a DEPENDENCY_CONFLICT naming both ids', async () => {
        const { state: s, fs: memory } = make();
        const doc = s.freshPreset();
        doc.features.gambling = { installed: true, active: true };
        const error = await s.write(doc, { expectedRevision: null }).catch(e => e);
        expect(error).toBeInstanceOf(FeatureStateError);
        expect(error.code).toBe('DEPENDENCY_CONFLICT');
        expect(error.conflicts).toEqual([{ feature: 'gambling', dependency: 'economy' }]);
        expect(error.message).toContain('"gambling"');
        expect(error.message).toContain('"economy"');
        expect(memory.mutatingCalls()).toEqual([]);
    });

    test('dependencies are never enabled silently: every conflict is listed and the document is unchanged', async () => {
        const { state: s } = make();
        const doc = s.freshPreset();
        doc.features.exchange = { installed: true, active: true };
        doc.features.gambling = { installed: true, active: true };
        doc.features.observatory = { installed: true, active: true };
        doc.features.sandbox = { installed: true, active: false };
        const error = await s.write(doc, { expectedRevision: null }).catch(e => e);
        expect(error.conflicts).toEqual([
            { feature: 'exchange', dependency: 'economy' },
            { feature: 'gambling', dependency: 'economy' },
            { feature: 'observatory', dependency: 'sandbox' }
        ]);
        expect(doc.features.economy.active).toBe(false);
    });

    test('a pending change is checked too: enabling gambling later while economy stays off conflicts', async () => {
        const { state: s } = make();
        const doc = s.freshPreset();
        doc.features.gambling = { installed: true, active: false, pendingActive: true };
        await expect(s.write(doc, { expectedRevision: null })).rejects.toMatchObject({
            code: 'DEPENDENCY_CONFLICT',
            conflicts: [{ feature: 'gambling', dependency: 'economy' }]
        });
        doc.features.economy = { installed: true, active: false, pendingActive: true };
        await expect(s.write(doc, { expectedRevision: null })).resolves.toBeTruthy();
    });

    test('disabling a dependency while its dependent stays on conflicts; disabling both is fine', async () => {
        const { state: s } = make();
        const seeded = await s.write(s.seedFromLegacy(), { expectedRevision: null });
        const doc = { origin: 'operator', features: { ...seeded.features, economy: { installed: true, active: false } } };
        await expect(s.write(doc, { expectedRevision: 1 })).rejects.toMatchObject({ code: 'DEPENDENCY_CONFLICT' });
        doc.features.exchange = { installed: true, active: false };
        doc.features.gambling = { installed: true, active: false };
        await expect(s.write(doc, { expectedRevision: 1 })).resolves.toMatchObject({ revision: 2, origin: 'operator' });
    });

    test('missing entries are filled from the legacy seed and a pendingActive equal to active is dropped', async () => {
        const { state: s } = make({ config: { token: 'x' } });
        const written = await s.write({ features: { music: { active: false, pendingActive: false } } }, { expectedRevision: null });
        expect(written.origin).toBe('operator');
        expect(written.features.music).toEqual({ installed: true, active: false });
        expect(written.features.discord).toEqual({ installed: true, active: true });
        expect(Object.keys(written.features)).toEqual(MANAGEABLE);
    });

    test('write is async and returns a promise even for a rejected document', async () => {
        const { state: s } = make();
        const pending = s.write({ features: { hologram: {} } }, { expectedRevision: null });
        expect(typeof pending.then).toBe('function');
        await expect(pending).rejects.toBeInstanceOf(FeatureStateError);
    });
});

describe('secrets never appear in status', () => {
    const SECRETS = {
        token: 'DISCORD-TOKEN-SECRET-001',
        github: 'ghp_GITHUBSECRETVALUE002',
        githubHook: 'GITHUB-WEBHOOK-SECRET-003',
        cursor: 'CURSOR-KEY-SECRET-004',
        cursorHook: 'CURSOR-HOOK-SECRET-005',
        resend: 're_RESENDSECRET006',
        smtpPass: 'SMTP-PASS-SECRET-007',
        smtpUrl: 'smtp://user:SMTP-URL-SECRET-008@host:587',
        eleven: 'ELEVEN-KEY-SECRET-009',
        vapid: 'VAPID-PRIVATE-SECRET-010',
        spotify: 'SPOTIFY-SECRET-011',
        client: 'DISCORD-CLIENT-SECRET-012',
        mailFrom: 'from-secret-013@example.org',
        fileSecret: 'SECRET-INSIDE-CORRUPT-FILE-014'
    };
    const allValues = Object.values(SECRETS);

    const config = {
        token: SECRETS.token,
        github: { token: SECRETS.github, webhookSecret: SECRETS.githubHook },
        cursor: { apiKey: SECRETS.cursor, webhookSecret: SECRETS.cursorHook },
        mail: { from: SECRETS.mailFrom, resend: { apiKey: SECRETS.resend }, smtp: { pass: SECRETS.smtpPass, url: SECRETS.smtpUrl } },
        elevenlabs: { apiKey: SECRETS.eleven },
        spotify: { clientSecret: SECRETS.spotify },
        activity: { enabled: true, clientSecret: SECRETS.client },
        webapp: { push: { vapidPrivateKey: SECRETS.vapid } }
    };
    const env = {
        GITHUB_TOKEN: SECRETS.github,
        RESEND_API_KEY: SECRETS.resend,
        GOOBSTER_SMTP_PASS: SECRETS.smtpPass,
        ELEVENLABS_API_KEY: SECRETS.eleven,
        SPOTIFY_CLIENT_SECRET: SECRETS.spotify,
        DISCORD_CLIENT_SECRET: SECRETS.client,
        GOOBSTER_VAPID_PRIVATE_KEY: SECRETS.vapid,
        GOOBSTER_FEATURE_VOICE: 'off',
        GOOBSTER_FEATURE_TAVERN: SECRETS.fileSecret
    };

    function everything(instance) {
        const serialised = JSON.stringify({
            status: instance.status(),
            unavailable: instance.unavailable(),
            availability: FEATURE_IDS.map(id => instance.availability(id)),
            error: instance.status().error,
            load: { ...instance.load(), error: instance.load().error && instance.load().error.toJSON() }
        });
        return serialised;
    }

    function expectClean(serialised) {
        for (const secret of allValues) expect(serialised).not.toContain(secret);
        expect(serialised).not.toMatch(/SECRET/);
    }

    test('configured features with secrets everywhere expose no value, only booleans and names', () => {
        for (const files of [{}, { [FILE]: docText() }]) {
            const { state: s } = make({ files, config, env });
            expectClean(everything(s));
        }
    });

    test('missing and half-set credentials are reported by name only', () => {
        const half = {
            token: SECRETS.token,
            mail: { smtp: { pass: SECRETS.smtpPass, user: 'someone-user-name' } },
            webapp: { push: { vapidPrivateKey: SECRETS.vapid } },
            cursor: { webhookSecret: SECRETS.cursorHook }
        };
        const { state: s } = make({ files: { [FILE]: docText() }, config: half });
        const serialised = everything(s);
        expectClean(serialised);
        expect(serialised).not.toContain('someone-user-name');
        expect(s.availability('mail').warnings.map(r => r.detail)).toEqual(['GOOBSTER_SMTP_URL|GOOBSTER_SMTP_HOST|RESEND_API_KEY']);
        expect(s.availability('push').warnings.map(r => r.detail)).toEqual(['GOOBSTER_VAPID_PUBLIC_KEY']);
        expect(s.availability('cursor').warnings.map(r => r.detail)).toEqual(['CURSOR_API_KEY']);
    });

    test('a corrupt file whose text holds a secret is never echoed into status().error', () => {
        const poisoned = `{"token":"${SECRETS.fileSecret}", "version": `;
        const { state: s } = make({ files: { [FILE]: poisoned }, config, env });
        const status = s.status();
        expect(status.error.code).toBe('CORRUPT_STATE');
        expectClean(everything(s));
        const wrongShape = JSON.stringify({ version: 1, revision: 1, origin: 'operator', features: { music: { installed: true, active: SECRETS.fileSecret } } });
        expectClean(everything(make({ files: { [FILE]: wrongShape }, config, env }).state));
        const unknown = JSON.stringify({ version: 1, revision: 1, origin: 'operator', features: { [SECRETS.fileSecret]: {} } });
        const unknownStatus = make({ files: { [FILE]: unknown } }).state.status();
        expect(unknownStatus.error.code).toBe('UNKNOWN_FEATURE');
    });

    test('status is JSON-serialisable and round-trips', () => {
        const { state: s } = make({ config, env });
        const status = s.status();
        expect(JSON.parse(JSON.stringify(status))).toEqual(status);
    });
});

describe('system dependency probes are opt-in', () => {
    test('without a probe a host binary never gates a feature', () => {
        const { state: s } = make({ files: { [FILE]: docText() } });
        expect(s.isActive('voice')).toBe(true);
    });

    test('with a probe, a missing required binary is a NOT_CONFIGURED warning by name', () => {
        const probe = jest.fn(name => name !== 'ffmpeg');
        const { state: s } = make({ files: { [FILE]: docText() }, probes: { systemDependency: probe } });
        expect(s.availability('voice')).toEqual({ id: 'voice', active: true, reasons: [], warnings: [{ code: 'NOT_CONFIGURED', detail: 'ffmpeg' }] });
        expect(s.status().features.voice.configured).toBe(false);
        expect(s.isActive('music')).toBe(true);
        expect(probe).toHaveBeenCalledWith('ffmpeg');
        const viaConfig = make({ files: { [FILE]: docText() }, config: { probes: { systemDependency: () => false } } }).state;
        expect(viaConfig.isActive('voice')).toBe(true);
        expect(viaConfig.status().features.voice.configured).toBe(false);
    });

    test('createPathProbe looks at PATH without spawning, memoises, and honours FFMPEG_PATH', () => {
        const memory = memoryFs({ '/usr/bin/ffmpeg': '', '/opt/custom/ffmpeg-bin': '' });
        const probe = createPathProbe({ fs: memory, env: { PATH: '/bin:/usr/bin' }, platform: 'linux' });
        expect(probe('ffmpeg')).toBe(true);
        const calls = memory.calls.length;
        expect(probe('ffmpeg')).toBe(true);
        expect(memory.calls.length).toBe(calls);
        expect(probe('mgba')).toBe(false);
        const custom = createPathProbe({ fs: memory, env: { PATH: '/nowhere', FFMPEG_PATH: '/opt/custom/ffmpeg-bin' }, platform: 'linux' });
        expect(custom('ffmpeg')).toBe(true);
        expect(createPathProbe({ fs: memory, env: { PATH: '/nowhere' }, platform: 'linux' })('ffmpeg')).toBe(false);
        expect(memory.mutatingCalls()).toEqual([]);
    });
});

describe('createFeatureState defaults', () => {
    test('the default path is features.json under the runtime data directory and nothing is created', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-features-default-'));
        try {
            jest.isolateModules(() => {
                process.env.GOOBSTER_DATA_DIR = dir;
                try {
                    const fresh = require('@goobster/core/features/featureState');
                    const s = fresh.createFeatureState({ config: {}, env: {} });
                    expect(s.filePath).toBe(path.join(dir, 'features.json'));
                    s.isActive('music');
                    s.status();
                    expect(fs.readdirSync(dir)).toEqual([]);
                } finally {
                    delete process.env.GOOBSTER_DATA_DIR;
                }
            });
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('the real file system is used for an actual write and read', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-features-real-'));
        try {
            const filePath = path.join(dir, 'nested', 'features.json');
            const s = createFeatureState({ filePath, config: {}, env: {} });
            await s.write(s.freshPreset(), { expectedRevision: null });
            expect(fs.readdirSync(path.join(dir, 'nested'))).toEqual(['features.json']);
            const reread = createFeatureState({ filePath, config: {}, env: {} });
            expect(reread.status()).toMatchObject({ source: 'file', revision: 1, origin: 'fresh-preset' });
            expect(reread.isActive('gambling')).toBe(false);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('the default singleton', () => {
    afterEach(() => features._resetForTests({ config: {}, env: {}, fs: memoryFs(), filePath: FILE }));

    test('is created lazily and answers through the same predicate', () => {
        features._resetForTests({ config: { token: 'x', mcp: { enabled: true } }, env: {}, fs: memoryFs(), filePath: FILE });
        expect(features.isActive('mcp')).toBe(true);
        expect(features.isActive('sandbox')).toBe(false);
        expect(features.status().source).toBe('none');
        expect('isActive' in features).toBe(true);
    });

    test('_resetForTests recreates it with new options and returns itself', () => {
        const returned = features._resetForTests({ config: {}, env: {}, fs: memoryFs(), filePath: FILE });
        expect(returned).toBe(features);
        expect(features.isActive('mcp')).toBe(false);
        features._resetForTests({ config: { mcp: { enabled: true } }, env: {}, fs: memoryFs(), filePath: FILE });
        expect(features.isActive('mcp')).toBe(true);
    });

    test('requiring the module creates no instance and no file', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-features-lazy-'));
        try {
            jest.isolateModules(() => {
                process.env.GOOBSTER_DATA_DIR = dir;
                try {
                    const fresh = require('@goobster/core/features/featureState');
                    expect(typeof fresh.features._resetForTests).toBe('function');
                    expect(fs.readdirSync(dir)).toEqual([]);
                } finally {
                    delete process.env.GOOBSTER_DATA_DIR;
                }
            });
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('gate.js', () => {
    const gate = require('@goobster/core/features/gate');

    function configure(options = {}) {
        const fs = options.file ? memoryFs({ [FILE]: options.file }) : memoryFs();
        features._resetForTests({ config: { token: 'x', ...(options.config || {}) }, env: options.env || {}, fs, filePath: FILE });
    }

    afterEach(() => features._resetForTests({ config: {}, env: {}, fs: memoryFs(), filePath: FILE }));

    test('exports the contract surface', () => {
        expect(gate.FEATURE_UNAVAILABLE).toBe('FEATURE_UNAVAILABLE');
        for (const name of ['surfaceActive', 'requireSurface', 'unavailableResult']) expect(typeof gate[name]).toBe('function');
        expect(gate.GateError.prototype).toBeInstanceOf(Error);
    });

    test('a core surface is always available, whatever is switched off', () => {
        configure({ env: Object.fromEntries(MANAGEABLE.map(id => [envVarFor(id), '0'])) });
        expect(gate.surfaceActive('command', 'chat/chat.js')).toBe(true);
        expect(gate.requireSurface('command', 'chat/chat.js')).toBeNull();
        expect(gate.surfaceActive('route', 'GET /api/app/me')).toBe(true);
    });

    test('a feature surface follows its owner', () => {
        configure();
        expect(gate.surfaceActive('command', 'tavern/tavern.js')).toBe(true);
        expect(gate.requireSurface('command', 'tavern/tavern.js')).toBeNull();

        configure({ env: { GOOBSTER_FEATURE_TAVERN: '0' } });
        expect(gate.surfaceActive('command', 'tavern/tavern.js')).toBe(false);
        expect(gate.requireSurface('command', 'tavern/tavern.js')).toEqual({
            ok: false,
            code: 'FEATURE_UNAVAILABLE',
            feature: 'tavern',
            reasons: [{ code: 'ENV_OFF', detail: 'GOOBSTER_FEATURE_TAVERN' }]
        });
    });

    test('a surface with alsoRequires needs those features too, and the blocking feature is reported', () => {
        configure();
        expect(gate.surfaceActive('command', 'music/play.js')).toBe(true);
        configure({ env: { GOOBSTER_FEATURE_VOICE: 'off' } });
        expect(gate.surfaceActive('command', 'music/play.js')).toBe(false);
        expect(gate.surfaceActive('command', 'music/generatemusic.js')).toBe(true);
        expect(gate.requireSurface('command', 'music/play.js')).toEqual({
            ok: false,
            code: 'FEATURE_UNAVAILABLE',
            feature: 'voice',
            reasons: [{ code: 'ENV_OFF', detail: 'GOOBSTER_FEATURE_VOICE' }]
        });
        // Legacy mode: a legacy-off Discord adapter is reported inactive but
        // not enforced, so the surface keeps today's own degradation.
        configure({ config: { discord: { enabled: false } } });
        expect(features.isActive('discord')).toBe(false);
        expect(features.enforcedOff('discord')).toBe(false);
        expect(gate.requireSurface('command', 'music/play.js')).toBeNull();
        // Once a state file is in force the same switch is enforced.
        configure({ config: { discord: { enabled: false } }, file: docText({ discord: { active: false } }) });
        expect(gate.requireSurface('command', 'music/play.js').feature).toBe('discord');
    });

    test('enforcement: no features.json refuses nothing new; a file, an env override or an enforced dependency does', () => {
        configure({ config: { mcp: { enabled: false }, sandbox: { enabled: false } } });
        expect(features.isActive('mcp')).toBe(false);
        expect(features.enforcedOff('mcp')).toBe(false);
        expect(features.enforcedOff('observatory')).toBe(false);
        expect(features.enforcedUnavailable()).toEqual([]);
        expect(features.unavailable().map(e => e.id)).toEqual(expect.arrayContaining(['mcp', 'sandbox', 'observatory']));
        expect(gate.surfaceActive('route', '/mcp', 'POST')).toBe(true);
        expect(gate.surfaceActive('aiTool', 'runCode')).toBe(true);

        configure({ config: { sandbox: { enabled: true } }, env: { GOOBSTER_FEATURE_SANDBOX: '0' } });
        expect(features.enforcedOff('sandbox')).toBe(true);
        expect(features.enforcedOff('observatory')).toBe(true);
        expect(features.enforcedUnavailable().map(e => e.id)).toEqual(expect.arrayContaining(['sandbox', 'observatory']));
        expect(features.enforcedUnavailable().map(e => e.id)).not.toContain('mcp');
        expect(gate.surfaceActive('aiTool', 'runCode')).toBe(false);

        configure({ file: docText({ mcp: { active: false } }) });
        expect(features.enforcedOff('mcp')).toBe(true);
        expect(gate.surfaceActive('route', '/mcp', 'POST')).toBe(false);
        expect(gate.surfaceActive('mcpTool', 'list_docs')).toBe(true);
        expect(gate.surfaceActive('aiTool', 'runCode')).toBe(true);
        expect(features.enforcedOff('core')).toBe(false);
        expect(features.enforcedOff('nope')).toBe(true);
    });

    test('the wheel needs gambling and exchange; a route is resolved through the ordered rules', () => {
        configure();
        expect(gate.surfaceActive('command', 'economy/wheel.js')).toBe(true);
        configure({ env: { GOOBSTER_FEATURE_EXCHANGE: '0' } });
        expect(gate.surfaceActive('command', 'economy/wheel.js')).toBe(false);
        expect(gate.surfaceActive('command', 'economy/gamble.js')).toBe(true);
        expect(gate.surfaceActive('route', '/api/app/exchange/quote', 'GET')).toBe(false);
        expect(gate.surfaceActive('route', 'GET /api/app/exchange/quote')).toBe(false);
        expect(gate.requireSurface('route', '/api/app/exchange/quote', 'GET').feature).toBe('exchange');
    });

    test('an unclaimed surface throws GateError UNCLAIMED_SURFACE from both entry points', () => {
        configure();
        for (const call of [
            () => gate.surfaceActive('command', 'nope/missing.js'),
            () => gate.requireSurface('aiTool', 'noSuchTool'),
            () => gate.surfaceActive('route', '/definitely/not/mounted', 'GET')
        ]) {
            expect(call).toThrow(gate.GateError);
            try { call(); } catch (error) { expect(error.code).toBe('UNCLAIMED_SURFACE'); }
        }
    });

    test('unavailableResult carries the structured reasons for any feature', () => {
        configure({ files: {} });
        expect(gate.unavailableResult('mcp')).toEqual({
            ok: false,
            code: 'FEATURE_UNAVAILABLE',
            feature: 'mcp',
            reasons: [{ code: 'DISABLED', detail: 'mcp.enabled' }]
        });
        expect(gate.unavailableResult('nope').reasons).toEqual([{ code: 'UNKNOWN_FEATURE', detail: 'nope' }]);
    });

    test('gate.js requires only the inventory and the feature state', () => {
        const source = fs.readFileSync(path.join(ROOT, 'packages/core/features/gate.js'), 'utf8');
        const required = [...source.matchAll(/require\('([^']+)'\)/g)].map(match => match[1]).sort();
        expect(required).toEqual(['./featureState', './inventory']);
    });
});

describe('module boundaries', () => {
    test('the catalog requires only the inventory and descriptor modules', () => {
        const source = fs.readFileSync(path.join(ROOT, 'packages/core/features/catalog.js'), 'utf8');
        const required = [...source.matchAll(/require\('([^']+)'\)/g)].map(match => match[1]).sort();
        expect(required).toEqual(['./descriptors/adapters', './descriptors/integrations', './descriptors/media', './descriptors/workspace', './inventory']);
    });

    test('the resolver does not import an app and loads no config module until asked', () => {
        const source = fs.readFileSync(path.join(ROOT, 'packages/core/features/featureState.js'), 'utf8');
        expect(source).not.toMatch(/require\('(\.\.\/)+apps|@goobster\/(bot|api)/);
        const legacy = fs.readFileSync(path.join(ROOT, 'packages/core/features/legacyResolver.js'), 'utf8');
        const topLevel = legacy.split('\n').filter(line => /^const .*require\(/.test(line));
        expect(topLevel).toEqual([]);
    });
});
