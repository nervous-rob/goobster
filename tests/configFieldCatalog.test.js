/**
 * The field catalog (#324): one descriptor per installation setting, checked
 * against the runtime modules it mirrors so the two cannot drift. Covers the
 * shape of every descriptor, env-name inventory over config/**, defaults
 * pinned to what each runtime module resolves with nothing set, coverage of
 * config.example.json and of the feature descriptors' key lists, help links,
 * the secret set, and value validation.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const catalog = require('@goobster/core/config/fieldCatalog');
const featureCatalog = require('@goobster/core/features/catalog');
const example = require('../config.example.json');

const ROOT = path.join(__dirname, '..');
const CORE = path.join(ROOT, 'packages', 'core');
const TYPES = ['secret', 'string', 'enum', 'integer', 'number', 'boolean', 'url', 'duration', 'list'];
const FEATURE_IDS = new Set(featureCatalog.FEATURE_IDS);

function sourceFiles(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...sourceFiles(full));
        else if (entry.name.endsWith('.js')) out.push(full);
    }
    return out;
}

function envNamesIn(text) {
    const names = new Set();
    for (const match of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) names.add(match[1]);
    for (const match of text.matchAll(/\b(?:str|bool|int|flag|tri|value)\(\s*'([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)'/g)) names.add(match[1]);
    return names;
}

function slug(heading) {
    return heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-');
}

function anchorsOf(file) {
    const anchors = new Set();
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        const match = /^#{1,6}\s+(.*)$/.exec(line);
        if (match) anchors.add(slug(match[1]));
    }
    return anchors;
}

function flatten(object, prefix = '') {
    const out = [];
    for (const [key, value] of Object.entries(object)) {
        const id = prefix ? `${prefix}.${key}` : key;
        if (value && typeof value === 'object' && !Array.isArray(value)) out.push(...flatten(value, id));
        else out.push([id, value]);
    }
    return out;
}

describe('descriptor shape', () => {
    const fields = catalog.list();

    test('ids are unique and every descriptor is complete', () => {
        const ids = fields.map(field => field.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const field of fields) {
            expect(TYPES).toContain(field.type);
            expect(Array.isArray(field.env)).toBe(true);
            expect(['hot', 'restart']).toContain(field.apply);
            expect(typeof field.secret).toBe('boolean');
            expect(field.secret).toBe(field.type === 'secret');
            expect(field.section).toBeTruthy();
            expect(catalog.SECTIONS.map(section => section.id)).toContain(field.section);
            expect(field.description.length).toBeGreaterThan(5);
            expect(field.sources.length).toBeGreaterThan(0);
            for (const source of field.sources) expect(['env', 'config', 'db']).toContain(source);
            if (field.sources.includes('env')) expect(field.env.length).toBeGreaterThan(0);
            if (field.env.length) expect(field.sources).toContain('env');
            if (field.type === 'enum') expect(field.validate.enum.length).toBeGreaterThan(0);
            if (field.dbOverride) {
                expect(field.sources).toContain('db');
                expect(field.dbOverride.store).toBe('instance_state');
                expect(field.apply).toBe('hot');
            }
            if (field.secret) expect(field.default).toBeNull();
        }
    });

    test('an env name belongs to exactly one field', () => {
        const owner = new Map();
        for (const field of fields) {
            for (const name of field.env) {
                expect(owner.has(name)).toBe(false);
                owner.set(name, field.id);
            }
        }
    });

    test('every feature is core or a catalog feature id', () => {
        for (const field of fields) {
            expect(field.feature === 'core' || FEATURE_IDS.has(field.feature)).toBe(true);
            for (const extra of field.alsoFeatures) expect(FEATURE_IDS.has(extra)).toBe(true);
        }
    });

    test('every help is an https URL or an existing repo document with an existing anchor', () => {
        for (const field of fields) {
            if (field.help.startsWith('https://')) continue;
            const [doc, anchor] = field.help.split('#');
            const file = path.join(ROOT, doc);
            expect({ id: field.id, doc, exists: fs.existsSync(file) }).toEqual({ id: field.id, doc, exists: true });
            if (anchor) expect({ id: field.id, anchor, found: anchorsOf(file).has(anchor) }).toEqual({ id: field.id, anchor, found: true });
        }
    });
});

describe('inventory against the runtime modules', () => {
    test('every process.env name read by config/** and config.js is declared by exactly one field', () => {
        const files = [...sourceFiles(path.join(CORE, 'config')), path.join(CORE, 'config.js')];
        const found = new Map();
        for (const file of files) {
            for (const name of envNamesIn(fs.readFileSync(file, 'utf8'))) {
                if (!found.has(name)) found.set(name, []);
                found.get(name).push(path.relative(CORE, file));
            }
        }
        expect(found.size).toBeGreaterThan(80);
        const undeclared = [...found.keys()].filter(name => !catalog.byEnv(name));
        expect(undeclared).toEqual([]);
        for (const name of found.keys()) {
            const owners = catalog.list().filter(field => field.env.includes(name));
            expect({ name, owners: owners.length }).toEqual({ name, owners: 1 });
        }
    });

    test('every env name the feature descriptors list is declared', () => {
        for (const id of featureCatalog.FEATURE_IDS) {
            const descriptor = featureCatalog.FEATURES[id];
            for (const key of descriptor.apiKeys) {
                const field = catalog.byEnv(key.name);
                expect({ feature: id, name: key.name, declared: Boolean(field) }).toEqual({ feature: id, name: key.name, declared: true });
                const dotted = field.configPath || field.id;
                expect({ name: key.name, path: dotted }).toEqual({ name: key.name, path: key.configPath });
                expect([field.feature, ...field.alsoFeatures]).toContain(id);
            }
            const legacyEnv = descriptor.legacy && descriptor.legacy.envVar;
            if (legacyEnv) expect(catalog.byEnv(legacyEnv)).not.toBeNull();
        }
    });

    test('every config key a feature descriptor lists is a field', () => {
        const paths = new Map(catalog.list().map(field => [field.configPath || field.id, field]));
        for (const id of featureCatalog.FEATURE_IDS) {
            for (const key of featureCatalog.FEATURES[id].configKeys) {
                expect({ feature: id, key, field: paths.has(key) }).toEqual({ feature: id, key, field: true });
                expect([paths.get(key).feature, ...paths.get(key).alsoFeatures]).toContain(id);
            }
        }
    });

    test('every key config.example.json documents is a field, and its documented value matches the default', () => {
        const paths = new Map(catalog.list().map(field => [field.configPath || field.id, field]));
        const sampleOnly = new Set(['DEFAULT_PROMPT']);
        const missing = [];
        const mismatched = [];
        for (const [dotted, value] of flatten(example)) {
            const field = paths.get(dotted);
            if (!field) {
                missing.push(dotted);
                continue;
            }
            const meaningful = value !== '' && value !== null && !(typeof value === 'string' && value.includes('YOUR_'))
                && !(Array.isArray(value) && (value.length === 0 || JSON.stringify(value).includes('YOUR_')));
            if (!meaningful || field.secret || sampleOnly.has(dotted)) continue;
            if (JSON.stringify(value) !== JSON.stringify(field.default)) mismatched.push(dotted);
        }
        expect(missing).toEqual([]);
        expect(mismatched).toEqual([]);
    });

    test('every default equals what the runtime module resolves with an empty environment and an empty config.json', () => {
        const named = catalog.list().filter(field => field.runtime);
        expect(named.length).toBeGreaterThan(80);
        const saved = {};
        const names = new Set(['GOOBSTER_DATA_DIR', 'GOOBSTER_CONFIG_PATH', 'GOOBSTER_WORKSPACE_ROOT']);
        for (const field of catalog.list()) for (const name of field.env) names.add(name);
        for (const name of names) {
            saved[name] = process.env[name];
            delete process.env[name];
        }
        process.env.GOOBSTER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-324-catalog-'));
        const resolved = {};
        try {
            jest.isolateModules(() => {
                jest.doMock('dotenv', () => ({ config: () => ({}) }));
                jest.doMock('../config.json', () => ({}));
                for (const field of named) {
                    const [modulePath, valuePath] = field.runtime.split('#');
                    const mod = require(`@goobster/core/${modulePath}`);
                    resolved[field.id] = catalog.getPath(mod, valuePath);
                }
            });
        } finally {
            for (const name of names) {
                if (saved[name] === undefined) delete process.env[name];
                else process.env[name] = saved[name];
            }
        }
        const normal = (value) => (value === undefined || value === '' ? null : value);
        const drift = [];
        for (const field of named) {
            if (JSON.stringify(normal(resolved[field.id])) !== JSON.stringify(normal(field.default))) {
                drift.push({ id: field.id, runtime: resolved[field.id], catalog: field.default });
            }
        }
        expect(drift).toEqual([]);
    });

    test('the secret set is the set the runtime treats as keys', () => {
        const secretIds = catalog.list().filter(field => field.secret).map(field => field.id).sort();
        const looksSecret = (field) => /(apikey|secret|\.pass|\.token|privatekey|\.url)$/i.test(field.id) && field.id !== 'ollama.host'
            && !/(publicKey|Url)$/.test(field.id);
        const expected = catalog.list().filter(field => looksSecret(field) && !field.id.endsWith('publicUrl')).map(field => field.id);
        for (const id of expected) expect(secretIds).toContain(id);
        for (const id of ['ai.openai.apiKey', 'ai.anthropic.apiKey', 'ai.gemini.apiKey', 'perplexity.apiKey',
            'elevenlabs.apiKey', 'discord.token', 'mail.smtp.pass', 'mail.smtp.url', 'mail.resend.apiKey',
            'webapp.push.vapidPrivateKey', 'github.token', 'github.webhookSecret', 'cursor.apiKey', 'cursor.webhookSecret',
            'activity.clientSecret', 'spotify.clientSecret']) {
            expect(secretIds).toContain(id);
        }
        expect(secretIds).not.toContain('webapp.push.vapidPublicKey');
        expect(secretIds).not.toContain('mcp.maxTokensPerUser');
        expect(secretIds).not.toContain('limits.dailyTokens');
        const aiConfig = fs.readFileSync(path.join(CORE, 'config', 'aiConfig.js'), 'utf8');
        const apiKeyEnvs = [...aiConfig.matchAll(/apiKey: process\.env\.([A-Z_]+)/g)].map(match => match[1]);
        expect(apiKeyEnvs.length).toBe(4);
        for (const name of apiKeyEnvs) expect(catalog.byEnv(name).secret).toBe(true);
    });

    test('limits and defaults are database-backed hot fields, the rest of the file/env fields restart', () => {
        for (const field of catalog.inSection('limits')) {
            expect(field.dbOverride).toMatchObject({ store: 'instance_state', key: 'limits', wins: true });
            expect(field.apply).toBe('hot');
        }
        for (const field of catalog.inSection('defaults')) {
            expect(field.sources).toEqual(['db']);
            expect(field.dbOverride.key).toBe('defaults');
            expect(catalog.filePath(field)).toBeNull();
        }
        expect(catalog.get('ai.openai.apiKey').apply).toBe('restart');
    });
});

describe('value validation', () => {
    const check = (id, value) => catalog.validateValue(catalog.get(id), value);

    test('coerces the types a form or a script sends', () => {
        expect(check('sandbox.timeoutMs', '30000')).toEqual({ ok: true, value: 30000 });
        expect(check('mcp.enabled', 'true')).toEqual({ ok: true, value: true });
        expect(check('identity.operators', '123456 654321,111111')).toEqual({ ok: true, value: ['123456', '654321', '111111'] });
        expect(check('ai.provider', 'OpenAI')).toEqual({ ok: true, value: 'openai' });
        expect(check('ai.provider', '')).toEqual({ ok: true, value: '' });
    });

    test('refuses out-of-range, wrong-type and wrong-shape values without echoing them', () => {
        const refusals = [
            ['identity.passwordMinLength', 4, 'OUT_OF_RANGE'],
            ['identity.passwordMinLength', 15.5, 'INVALID_TYPE'],
            ['identity.registration', 'anyone', 'INVALID_CHOICE'],
            ['mcp.enabled', 'maybe', 'INVALID_TYPE'],
            ['ollama.host', 'http://user:pass@host:11434', 'INVALID_VALUE'],
            ['ollama.host', 'ftp://host', 'INVALID_VALUE'],
            ['identity.operators', ['not-a-snowflake'], 'INVALID_VALUE'],
            ['ai.openai.chatModel', 'bad model!', 'INVALID_VALUE'],
            ['mail.smtp.url', 'https://example.org', 'INVALID_VALUE'],
            ['limits.dailyTokens', 0, 'OUT_OF_RANGE'],
            ['elevenlabs.apiKey', 'bad key with spaces', 'INVALID_VALUE'],
            ['ai.openai.apiKey', '', 'REQUIRED']
        ];
        for (const [id, value, code] of refusals) {
            const result = check(id, value);
            expect({ id, ok: result.ok, code: result.code }).toEqual({ id, ok: false, code });
            if (typeof value === 'string' && value.length > 3) expect(result.message).not.toContain(value);
        }
    });

    test('validateDocument checks catalogued paths, ignores unknown keys and placeholders', () => {
        expect(catalog.validateDocument(example)).toEqual({ ok: true, errors: [] });
        expect(catalog.validateDocument({ somethingNew: { nested: 1 }, identity: { registration: 'invite' } }).ok).toBe(true);
        const bad = catalog.validateDocument({ identity: { passwordMinLength: 3, registration: 'anyone' }, mcp: { enabled: 'x' } });
        expect(bad.errors.map(error => error.id).sort()).toEqual(['identity.passwordMinLength', 'identity.registration', 'mcp.enabled']);
        expect(catalog.validateDocument([]).ok).toBe(false);
    });
});

describe('masks and fingerprints', () => {
    test('a fingerprint is the last four characters only for a long enough secret', () => {
        expect(catalog.fingerprintOf('sk-live-abcdefghijkl')).toBe('ijkl');
        expect(catalog.fingerprintOf('short')).toBeNull();
        expect(catalog.fingerprintOf('12345678901')).toBeNull();
        expect(catalog.fingerprintOf('123456789012')).toBe('9012');
    });

    test('every display form of a secret is recognised as a mask, a real key is not', () => {
        const fingerprint = 'ijkl';
        for (const value of ['••••', '••••ijkl', '[redacted]', 'sk-…[redacted]', 'ijkl', '…ijkl']) {
            expect({ value, mask: catalog.isMaskedValue(value, { fingerprint }) }).toEqual({ value, mask: true });
        }
        expect(catalog.isMaskedValue('sk-live-abcdefghijkl', { fingerprint })).toBe(false);
        expect(catalog.isMaskedValue('', { fingerprint })).toBe(false);
    });

    test('path helpers set, read and prune nested keys', () => {
        const doc = { a: { b: { c: 1 } }, keep: true };
        expect(catalog.getPath(doc, 'a.b.c')).toBe(1);
        catalog.setPath(doc, 'x.y', 2);
        expect(doc.x.y).toBe(2);
        expect(catalog.deletePath(doc, 'a.b.c')).toBe(true);
        expect(doc).toEqual({ keep: true, x: { y: 2 } });
        expect(catalog.deletePath(doc, 'nope.nothing')).toBe(false);
    });
});

describe('generated reference', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const { render } = require('../scripts/generate-config-reference');

    test('documentation/config_reference.md is exactly what the catalog renders, and lists every setting once', () => {
        const file = fs.readFileSync(path.join(__dirname, '..', 'documentation', 'config_reference.md'), 'utf8');
        expect(file).toBe(render());
        for (const field of catalog.list()) {
            expect(file.split(`| \`${field.id}\` |`).length - 1).toBe(1);
        }
    });

    test('no secret default or example value is rendered', () => {
        const text = render();
        expect(text).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
        expect(text).not.toMatch(/xox[bp]-/);
    });
});
