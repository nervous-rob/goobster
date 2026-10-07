/**
 * Effective settings (#324): precedence (env, config.json, default; the
 * database first for host policy), env-controlled flags, masked secrets
 * that never leak a value, the database-down report, and legacy keys.
 */
const catalog = require('@goobster/core/config/fieldCatalog');
const { resolveEffective, resolveSecretValue, resolveValue } = require('@goobster/core/config/effectiveConfig');

const PLANTED = 'sk-test-planted-0123456789abcdef';

const byId = (report, id) => report.fields.find(field => field.id === id);

describe('secrets', () => {
    test('a secret reports presence, source and a four-character fingerprint, never a value', () => {
        const report = resolveEffective({ env: { OPENAI_API_KEY: PLANTED }, fileConfig: { anthropicKey: 'sk-ant-file-0123456789abcdef' } });
        const openai = byId(report, 'ai.openai.apiKey');
        expect(openai).toMatchObject({ present: true, source: 'env', envControlled: true, controlledBy: 'env', masked: true, fingerprint: 'cdef', envName: 'OPENAI_API_KEY' });
        expect(openai).not.toHaveProperty('value');
        const anthropic = byId(report, 'ai.anthropic.apiKey');
        expect(anthropic).toMatchObject({ present: true, source: 'config', envControlled: false, fingerprint: 'cdef' });
        const gemini = byId(report, 'ai.gemini.apiKey');
        expect(gemini).toMatchObject({ present: false, source: 'unset', fingerprint: null });
        const text = JSON.stringify(report);
        expect(text).not.toContain(PLANTED);
        expect(text).not.toContain('sk-ant-file');
    });

    test('a secret shorter than twelve characters has no fingerprint', () => {
        const report = resolveEffective({ env: { GITHUB_TOKEN: 'short-token' } });
        expect(byId(report, 'github.token')).toMatchObject({ present: true, fingerprint: null });
    });

    test('a template placeholder is not a configured secret', () => {
        const report = resolveEffective({ fileConfig: { token: 'YOUR_DISCORD_BOT_TOKEN', openaiKey: 'YOUR_OPENAI_KEY' } });
        expect(byId(report, 'discord.token')).toMatchObject({ present: false, source: 'unset', placeholder: true });
        expect(byId(report, 'ai.openai.apiKey').present).toBe(false);
    });

    test('resolveSecretValue is the one reader of a value and applies the same precedence', () => {
        const fileConfig = { openaiKey: 'from-file-0123456789', cursor: { apiKey: 'YOUR_CURSOR_KEY' } };
        expect(resolveSecretValue('ai.openai.apiKey', { env: {}, fileConfig })).toBe('from-file-0123456789');
        expect(resolveSecretValue('ai.openai.apiKey', { env: { OPENAI_API_KEY: PLANTED }, fileConfig })).toBe(PLANTED);
        expect(resolveSecretValue('cursor.apiKey', { env: {}, fileConfig })).toBeNull();
        expect(resolveSecretValue('ai.provider', { env: { AI_PROVIDER: 'openai' } })).toBeNull();
        expect(resolveSecretValue('nope', {})).toBeNull();
    });
});

describe('precedence and sources', () => {
    test('environment wins over config.json, config.json over the default, and the report says which', () => {
        const report = resolveEffective({
            env: { OPENAI_CHAT_MODEL: 'env-model', MEMORY_RECALL_LIMIT: '9' },
            fileConfig: { ai: { openai: { chatModel: 'file-model' }, anthropic: { chatModel: 'file-claude' } }, ollama: { host: 'http://box:11434/' } }
        });
        expect(byId(report, 'ai.openai.chatModel')).toMatchObject({ value: 'env-model', source: 'env', envControlled: true });
        expect(byId(report, 'ai.anthropic.chatModel')).toMatchObject({ value: 'file-claude', source: 'config', envControlled: false });
        expect(byId(report, 'ai.gemini.chatModel')).toMatchObject({ value: 'gemini-3.5-flash', source: 'default', present: false });
        expect(byId(report, 'ai.memory.recallLimit')).toMatchObject({ value: 9, source: 'env' });
        expect(byId(report, 'ollama.host')).toMatchObject({ value: 'http://box:11434/', source: 'config' });
        expect(byId(report, 'ai.provider')).toMatchObject({ value: null, source: 'unset', present: false });
    });

    test('env aliases and legacy config paths are honoured', () => {
        const report = resolveEffective({
            env: { ANTHROPIC_MODEL: 'alias-claude' },
            fileConfig: { ai: { gemini: { model: 'legacy-gemini' } } }
        });
        expect(byId(report, 'ai.anthropic.chatModel')).toMatchObject({ value: 'alias-claude', source: 'env', envName: 'ANTHROPIC_MODEL' });
        expect(byId(report, 'ai.gemini.chatModel')).toMatchObject({ value: 'legacy-gemini', source: 'config' });
    });

    test('booleans read the way the runtime reads them', () => {
        const off = resolveEffective({ env: { MEMORY_ENABLED: 'off', GOOBSTER_SANDBOX_ENABLED: 'yes', GOOBSTER_OBSERVATORY_ENABLED: 'true' } });
        expect(byId(off, 'ai.memory.enabled').value).toBe(false);
        expect(byId(off, 'sandbox.enabled').value).toBe(false);
        expect(byId(off, 'observatory.enabled').value).toBe(true);
        const file = resolveEffective({ fileConfig: { mcp: { enabled: true } } });
        expect(byId(file, 'mcp.enabled')).toMatchObject({ value: true, source: 'config' });
    });

    test('an unusable value is flagged and the default is shown, not guessed', () => {
        const report = resolveEffective({ env: { MEMORY_RECALL_LIMIT: 'lots', GOOBSTER_IDENTITY_REGISTRATION: 'anyone' } });
        expect(byId(report, 'ai.memory.recallLimit')).toMatchObject({ invalid: true, issue: 'INVALID_TYPE', value: 5 });
        expect(byId(report, 'identity.registration')).toMatchObject({ invalid: true, issue: 'INVALID_CHOICE', value: 'invite' });
    });

    test('lists parse from env strings and files', () => {
        const report = resolveEffective({
            env: { GOOBSTER_IDENTITY_OPERATORS: '100000000000000001, 100000000000000002' },
            fileConfig: { sandbox: { fetchAllowedHosts: ['zenodo.org'] } }
        });
        expect(byId(report, 'identity.operators').value).toEqual(['100000000000000001', '100000000000000002']);
        expect(byId(report, 'sandbox.fetchAllowedHosts')).toMatchObject({ value: ['zenodo.org'], source: 'config' });
    });

    test('sections come out in catalog order and omit nothing', () => {
        const report = resolveEffective({});
        expect(report.fields).toHaveLength(catalog.list().length);
        expect(report.sections.map(section => section.id)).toEqual(catalog.SECTIONS.map(section => section.id));
        expect(report.sections.reduce((n, section) => n + section.fields.length, 0)).toBe(report.fields.length);
    });

    test('the feature state flags fields of an inactive feature', () => {
        const report = resolveEffective({ features: { mail: { active: false }, core: { active: true } } });
        expect(byId(report, 'mail.from').featureActive).toBe(false);
        expect(byId(report, 'identity.installationId').featureActive).toBe(true);
        expect(byId(report, 'mcp.enabled')).not.toHaveProperty('featureActive');
    });
});

describe('database-backed fields', () => {
    test('a host limit in the database wins over the environment and config.json', () => {
        const report = resolveEffective({
            env: { GOOBSTER_LIMITS_DAILY_TOKENS: '500' },
            fileConfig: { limits: { windowHours: 12 } },
            overrides: { limits: { dailyTokens: 900 } }
        });
        expect(byId(report, 'limits.dailyTokens')).toMatchObject({ value: 900, source: 'db', controlledBy: 'db', envControlled: false, apply: 'hot' });
        expect(byId(report, 'limits.windowHours')).toMatchObject({ value: 12, source: 'config' });
        expect(byId(report, 'limits.retentionDays')).toMatchObject({ value: 90, source: 'default' });
    });

    test('a cleared cap stored as null is still a database override', () => {
        const report = resolveEffective({ env: { GOOBSTER_LIMITS_DAILY_TOKENS: '500' }, overrides: { limits: { dailyTokens: null } } });
        expect(byId(report, 'limits.dailyTokens')).toMatchObject({ value: null, source: 'db', present: true });
    });

    test('instance defaults are database-only and read nested keys', () => {
        const report = resolveEffective({ overrides: { defaults: { appearance: { theme: 'light' } } } });
        expect(byId(report, 'defaults.appearance.theme')).toMatchObject({ value: 'light', source: 'db' });
        expect(byId(report, 'defaults.appearance.startPage')).toMatchObject({ value: 'home', source: 'default' });
        expect(byId(report, 'defaults.chat.provider')).toMatchObject({ value: null, source: 'unset' });
    });

    test('with the database unreadable the database-backed fields say so and keep the best known value', () => {
        const report = resolveEffective({ env: { GOOBSTER_LIMITS_DAILY_TOKENS: '500' }, overrides: null });
        expect(byId(report, 'limits.dailyTokens')).toMatchObject({ source: 'unknown-db', knownSource: 'env', value: 500 });
        expect(byId(report, 'defaults.appearance.theme')).toMatchObject({ source: 'unknown-db' });
        expect(byId(report, 'ai.provider').source).toBe('unset');
    });

    test('resolveValue returns the plain value of a non-secret field only', () => {
        expect(resolveValue('ollama.host', { env: { OLLAMA_HOST: 'http://gpu:11434' } })).toBe('http://gpu:11434');
        expect(resolveValue('mail.smtp.port', { env: {}, fileConfig: { mail: { smtp: { port: 2525 } } } })).toBe(2525);
        expect(resolveValue('ai.openai.apiKey', { env: { OPENAI_API_KEY: PLANTED } })).toBeNull();
    });
});
