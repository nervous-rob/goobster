/**
 * Writing config.json safely (#324): content-hash revisions, stale-revision
 * refusal, validation before any byte is written, owner-only files, atomic
 * replacement (an injected rename or write failure leaves the previous file
 * intact and no temporary file behind), and round-tripping keys the catalog
 * does not know.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const configFile = require('@goobster/core/config/configFile');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-324-file-'));
let counter = 0;

function target(name = 'config.json') {
    const dir = path.join(ROOT, `case-${counter++}`);
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, name);
}

function seed(doc, raw) {
    const file = target();
    fs.writeFileSync(file, raw !== undefined ? raw : `${JSON.stringify(doc, null, 4)}\n`, { mode: 0o644 });
    return file;
}

function leftovers(file) {
    return fs.readdirSync(path.dirname(file)).filter(name => name !== path.basename(file));
}

async function codeOf(fn) {
    try {
        await fn();
    } catch (error) {
        return { code: error.code, details: error.details };
    }
    return null;
}

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe('read', () => {
    test('a missing file is present:false with no revision; a good file has a stable content revision', () => {
        const missing = configFile.read(target());
        expect(missing).toMatchObject({ present: false, readable: true, doc: null, revision: null });

        const file = seed({ ai: { provider: 'openai' } });
        const first = configFile.read(file);
        expect(first).toMatchObject({ present: true, readable: true, doc: { ai: { provider: 'openai' } } });
        expect(first.revision).toMatch(/^[0-9a-f]{16}$/);
        expect(configFile.read(file).revision).toBe(first.revision);
        fs.appendFileSync(file, ' ');
        expect(configFile.read(file).revision).not.toBe(first.revision);
    });

    test('corrupt, non-object and oversized files are unreadable, with a revision for the damaged bytes', () => {
        const corrupt = configFile.read(seed(null, '{ "ai": '));
        expect(corrupt).toMatchObject({ present: true, readable: false, doc: null, error: 'CORRUPT' });
        expect(corrupt.revision).toMatch(/^[0-9a-f]{16}$/);
        expect(configFile.read(seed(null, '[1,2]'))).toMatchObject({ readable: false, error: 'NOT_AN_OBJECT' });
        expect(configFile.read(seed(null, ' '.repeat(configFile.MAX_BYTES + 1)))).toMatchObject({ readable: false, error: 'TOO_LARGE' });
    });
});

describe('write', () => {
    test('creates a new file owner-only, four-space JSON with a trailing newline', () => {
        const file = target();
        const out = configFile.write(file, { ai: { provider: 'openai' }, mcp: { enabled: true } }, { expectedRevision: null });
        const text = fs.readFileSync(file, 'utf8');
        expect(text).toBe('{\n    "ai": {\n        "provider": "openai"\n    },\n    "mcp": {\n        "enabled": true\n    }\n}\n');
        expect(out.revision).toBe(configFile.read(file).revision);
        expect(out.previousRevision).toBeNull();
        if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
        expect(leftovers(file)).toEqual([]);
    });

    test('replacing a world-readable file tightens it to owner-only and keeps unknown keys exactly', () => {
        const doc = {
            token: 'x'.repeat(40),
            futureFeature: { nested: [1, 'two', { three: null }], flag: false },
            'weird key': 'kept',
            ai: { provider: 'openai' }
        };
        const file = seed(doc);
        const before = configFile.read(file);
        const edited = { ...before.doc, ai: { provider: 'anthropic' } };
        const out = configFile.write(file, edited, { expectedRevision: before.revision });
        const after = configFile.read(file);
        expect(after.doc).toEqual(edited);
        expect(after.doc.futureFeature).toEqual(doc.futureFeature);
        expect(after.doc['weird key']).toBe('kept');
        expect(Object.keys(after.doc)).toEqual(Object.keys(doc));
        expect(out.previousRevision).toBe(before.revision);
        if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
        expect(leftovers(file)).toEqual([]);
    });

    test('a write needs the revision it was computed from', async () => {
        const file = seed({});
        expect(await codeOf(() => configFile.write(file, {}, {}))).toMatchObject({ code: 'REVISION_REQUIRED' });
        expect(await codeOf(() => configFile.write(file, {}, { expectedRevision: undefined }))).toMatchObject({ code: 'REVISION_REQUIRED' });
    });

    test('a stale revision is refused and the file is untouched; two editors cannot both win', async () => {
        const file = seed({ ai: { provider: 'openai' } });
        const first = configFile.read(file);
        const second = configFile.read(file);
        configFile.write(file, { ai: { provider: 'gemini' } }, { expectedRevision: first.revision });
        const written = fs.readFileSync(file);
        const stale = await codeOf(() => configFile.write(file, { ai: { provider: 'anthropic' } }, { expectedRevision: second.revision }));
        expect(stale).toMatchObject({ code: 'STALE_REVISION', details: { expected: second.revision } });
        expect(Buffer.compare(fs.readFileSync(file), written)).toBe(0);

        const fresh = target();
        const missingStale = await codeOf(() => configFile.write(fresh, {}, { expectedRevision: first.revision }));
        expect(missingStale).toMatchObject({ code: 'STALE_REVISION', details: { actual: null } });
        expect(fs.existsSync(fresh)).toBe(false);

        const existing = await codeOf(() => configFile.write(file, {}, { expectedRevision: null }));
        expect(existing).toMatchObject({ code: 'STALE_REVISION' });
    });

    test('a document that fails validation leaves the previous file intact, naming settings and never values', async () => {
        const file = seed({ ai: { provider: 'openai' } });
        const before = fs.readFileSync(file);
        const revision = configFile.read(file).revision;
        const secretish = 'sk-planted-do-not-print-0123456789';
        const outcome = await codeOf(() => configFile.write(file, {
            ai: { provider: secretish },
            identity: { passwordMinLength: 2 },
            token: 'YOUR_DISCORD_BOT_TOKEN'
        }, { expectedRevision: revision }));
        expect(outcome.code).toBe('INVALID_CONFIG');
        const ids = outcome.details.problems.map(problem => problem.id).sort();
        expect(ids).toEqual(['', 'ai.provider', 'identity.passwordMinLength']);
        expect(JSON.stringify(outcome)).not.toContain(secretish);
        expect(Buffer.compare(fs.readFileSync(file), before)).toBe(0);
        expect(leftovers(file)).toEqual([]);
        expect(await codeOf(() => configFile.write(file, [], { expectedRevision: revision }))).toMatchObject({ code: 'INVALID_CONFIG' });
    });

    test('an installation without Discord can still be written; a wrongly typed token cannot', async () => {
        const file = target();
        expect(() => configFile.write(file, { ai: { provider: 'ollama' } }, { expectedRevision: null })).not.toThrow();
        const revision = configFile.read(file).revision;
        expect(await codeOf(() => configFile.write(file, { token: 12345 }, { expectedRevision: revision }))).toMatchObject({ code: 'INVALID_CONFIG' });
    });

    test('an injected rename failure leaves the previous file intact and no temporary file', async () => {
        const file = seed({ ai: { provider: 'openai' } });
        const before = fs.readFileSync(file);
        const revision = configFile.read(file).revision;
        const failing = { ...fs, renameSync: () => { throw Object.assign(new Error(`EXDEV at ${file}`), { code: 'EXDEV' }); } };
        const outcome = await codeOf(() => configFile.write(file, { ai: { provider: 'gemini' } }, { expectedRevision: revision, fs: failing }));
        expect(outcome).toMatchObject({ code: 'WRITE_FAILED' });
        expect(JSON.stringify(outcome)).not.toContain(path.basename(path.dirname(file)));
        expect(Buffer.compare(fs.readFileSync(file), before)).toBe(0);
        expect(leftovers(file)).toEqual([]);
    });

    test('a write that fails midway (disk full) leaves the previous file intact and no temporary file', async () => {
        const file = seed({ ai: { provider: 'openai' } });
        const before = fs.readFileSync(file);
        const revision = configFile.read(file).revision;
        let calls = 0;
        const failing = {
            ...fs,
            writeSync: (...args) => {
                calls++;
                throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC', args });
            }
        };
        expect(await codeOf(() => configFile.write(file, { ai: { provider: 'gemini' } }, { expectedRevision: revision, fs: failing }))).toMatchObject({ code: 'WRITE_FAILED' });
        expect(calls).toBe(1);
        expect(Buffer.compare(fs.readFileSync(file), before)).toBe(0);
        expect(leftovers(file)).toEqual([]);
    });

    test('a corrupt existing file is never overwritten', async () => {
        const file = seed(null, '{ "ai": ');
        const revision = configFile.read(file).revision;
        expect(await codeOf(() => configFile.write(file, { ai: { provider: 'openai' } }, { expectedRevision: revision }))).toMatchObject({ code: 'CONFIG_UNREADABLE' });
        expect(fs.readFileSync(file, 'utf8')).toBe('{ "ai": ');
    });

    test('a live lock refuses a second writer; a stale lock is cleared', async () => {
        const file = seed({});
        const revision = configFile.read(file).revision;
        fs.writeFileSync(`${file}.lock`, '');
        expect(await codeOf(() => configFile.write(file, {}, { expectedRevision: revision }))).toMatchObject({ code: 'CONFIG_BUSY' });
        const old = new Date(Date.now() - 120_000);
        fs.utimesSync(`${file}.lock`, old, old);
        expect(() => configFile.write(file, { mcp: { enabled: true } }, { expectedRevision: revision })).not.toThrow();
        expect(fs.existsSync(`${file}.lock`)).toBe(false);
    });
});
