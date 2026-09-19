/**
 * Declared output contracts (utils/outputContract.js), in isolation:
 * write-time normalization, fire-time resolution/freezing, and the
 * settle-time evaluation against a real directory. No database, no
 * sandbox - just the pure contract rules the Observatory relies on.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.GOOBSTER_DB_PATH = path.join(os.tmpdir(), `goobster-output-contract-${process.pid}.sqlite`);

const {
    OUTPUT_CONTRACT_FAILED,
    OutputContractError,
    MAX_REQUIRED_OUTPUTS,
    normalizeRequiredOutputs,
    resolveOutputContract,
    normalizeFrozenContract,
    evaluateOutputContract,
    summarizeContractFailure,
    parseStoredJson
} = require('@goobster/core/utils/outputContract');

const NOW = new Date('2026-09-18T23:59:30Z');

function expectContractError(fn, pattern) {
    let caught = null;
    try {
        fn();
    } catch (error) {
        caught = error;
    }
    expect(caught).toBeInstanceOf(OutputContractError);
    expect(caught).toMatchObject({ status: 400, code: 'BAD_OUTPUT_CONTRACT' });
    if (pattern) expect(caught.message).toMatch(pattern);
}

describe('normalizeRequiredOutputs (write time)', () => {
    test('nothing declared normalizes to null so callers drop the key', () => {
        for (const raw of [undefined, null, '', [], '[]']) {
            expect(normalizeRequiredOutputs(raw)).toBeNull();
        }
    });

    test('accepts bare strings and objects, defaults type to file, coerces minBytes', () => {
        expect(normalizeRequiredOutputs([
            'pipeline/fetch_manifest_{utc_date}.json',
            { path: ' out/rows.csv ', type: 'FILE', minBytes: '10' },
            { path: 'out/report.json', type: 'json', minBytes: 0 }
        ])).toEqual([
            { path: 'pipeline/fetch_manifest_{utc_date}.json', type: 'file' },
            { path: 'out/rows.csv', type: 'file', minBytes: 10 },
            { path: 'out/report.json', type: 'json', minBytes: 0 }
        ]);
        // A JSON string (as the portal textarea / tool arg send it) works too.
        expect(normalizeRequiredOutputs('[{"path":"a.json","type":"json"}]'))
            .toEqual([{ path: 'a.json', type: 'json' }]);
    });

    test('rejects absolute paths, traversal, empty segments, and directory-looking paths', () => {
        for (const bad of ['/etc/passwd', '../escape.json', 'out/../../x', 'a//b', './', '.', 'out/']) {
            expectContractError(() => normalizeRequiredOutputs([bad]), /requiredOutputs\[0\]\.path/);
        }
    });

    test('rejects unsupported or malformed template variables', () => {
        expectContractError(() => normalizeRequiredOutputs(['out/{unknown}.json']), /Unsupported template variable "\{unknown\}"/);
        expectContractError(() => normalizeRequiredOutputs(['out/{utc_date.json']), /unbalanced/);
        expectContractError(() => normalizeRequiredOutputs(['out/utc_date}.json']), /unbalanced/);
        expectContractError(() => normalizeRequiredOutputs(['out/{}.json']), /Unsupported template variable "\{\}"/);
    });

    test('rejects bad shapes, types, sizes, duplicates, and oversized lists', () => {
        expectContractError(() => normalizeRequiredOutputs('not json'), /JSON array/);
        expectContractError(() => normalizeRequiredOutputs({ path: 'a' }), /must be an array/);
        expectContractError(() => normalizeRequiredOutputs([42]), /must be an object/);
        expectContractError(() => normalizeRequiredOutputs([{ type: 'json' }]), /needs a workspace-relative "path"/);
        expectContractError(() => normalizeRequiredOutputs([{ path: 'a.yaml', type: 'yaml' }]), /"file" or "json"/);
        expectContractError(() => normalizeRequiredOutputs([{ path: 'a', minBytes: -1 }]), /non-negative integer/);
        expectContractError(() => normalizeRequiredOutputs([{ path: 'a', minBytes: 1.5 }]), /non-negative integer/);
        expectContractError(() => normalizeRequiredOutputs([{ path: 'a', minBytes: 'lots' }]), /non-negative integer/);
        expectContractError(() => normalizeRequiredOutputs(['a.json', { path: 'a.json', type: 'json' }]), /twice/);
        expectContractError(() => normalizeRequiredOutputs([{ path: 'x'.repeat(600) }]), /too long/);
        expectContractError(
            () => normalizeRequiredOutputs(Array.from({ length: MAX_REQUIRED_OUTPUTS + 1 }, (_, i) => `out/${i}.json`)),
            /too many/
        );
    });
});

describe('resolveOutputContract (fire time)', () => {
    test('substitutes {utc_date} with the UTC date captured now and freezes the paths', () => {
        const frozen = resolveOutputContract([
            { path: 'pipeline/fetch_manifest_{utc_date}.json', type: 'json', minBytes: 2 },
            'logs/{utc_date}/{utc_date}.txt'
        ], { now: NOW });
        expect(frozen).toEqual({
            resolvedAt: '2026-09-18 23:59:30',
            variables: { utc_date: '2026-09-18' },
            outputs: [
                { path: 'pipeline/fetch_manifest_2026-09-18.json', type: 'json', minBytes: 2 },
                { path: 'logs/2026-09-18/2026-09-18.txt', type: 'file' }
            ]
        });
    });

    test('uses the UTC calendar date, not the local one', () => {
        // 23:59 UTC on the 18th is already the 19th in UTC+1 and beyond.
        const late = resolveOutputContract(['d_{utc_date}'], { now: new Date('2026-09-18T23:59:59Z') });
        const early = resolveOutputContract(['d_{utc_date}'], { now: new Date('2026-09-19T00:00:00Z') });
        expect(late.outputs[0].path).toBe('d_2026-09-18');
        expect(early.outputs[0].path).toBe('d_2026-09-19');
    });

    test('returns null when nothing is declared and re-validates at fire time', () => {
        expect(resolveOutputContract(null)).toBeNull();
        expect(resolveOutputContract([])).toBeNull();
        expectContractError(() => resolveOutputContract(['../{utc_date}.json']));
    });
});

describe('normalizeFrozenContract (what observatory.run() accepts)', () => {
    test('accepts a resolved contract or a bare outputs array', () => {
        expect(normalizeFrozenContract({ outputs: [{ path: 'out/a.json', type: 'json' }] })).toEqual({
            resolvedAt: null, variables: {}, outputs: [{ path: 'out/a.json', type: 'json' }]
        });
        expect(normalizeFrozenContract([{ path: 'out/b.csv', minBytes: 3 }]).outputs)
            .toEqual([{ path: 'out/b.csv', type: 'file', minBytes: 3 }]);
        expect(normalizeFrozenContract(JSON.stringify({
            resolvedAt: '2026-09-18 00:00:00', variables: { utc_date: '2026-09-18' }, outputs: ['x.txt']
        }))).toMatchObject({ resolvedAt: '2026-09-18 00:00:00', variables: { utc_date: '2026-09-18' } });
        expect(normalizeFrozenContract(null)).toBeNull();
        expect(normalizeFrozenContract({ outputs: [] })).toBeNull();
    });

    test('refuses unresolved templates, bad shapes, and illegal paths', () => {
        expectContractError(() => normalizeFrozenContract({ outputs: ['out/{utc_date}.json'] }), /not resolved/);
        expectContractError(() => normalizeFrozenContract({ outputs: ['/abs.json'] }));
        expectContractError(() => normalizeFrozenContract({ outputs: ['../up.json'] }));
        expectContractError(() => normalizeFrozenContract({ nope: true }), /outputs array/);
        expectContractError(() => normalizeFrozenContract('{broken'), /resolved contract object/);
        expectContractError(() => normalizeFrozenContract({ outputs: [null] }), /must be an object/);
    });
});

describe('evaluateOutputContract (settle time)', () => {
    let workspace;
    let outside;

    beforeAll(() => {
        workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-contract-ws-'));
        outside = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-contract-outside-'));
        fs.mkdirSync(path.join(workspace, 'pipeline'), { recursive: true });
        fs.mkdirSync(path.join(workspace, 'adir'), { recursive: true });
        fs.writeFileSync(path.join(workspace, 'pipeline', 'manifest.json'), '{"rows": 3}');
        fs.writeFileSync(path.join(workspace, 'pipeline', 'broken.json'), '{not json');
        fs.writeFileSync(path.join(workspace, 'pipeline', 'empty.json'), '');
        fs.writeFileSync(path.join(workspace, 'pipeline', 'rows.csv'), 'a,b\n1,2\n');
        fs.writeFileSync(path.join(outside, 'secret.json'), '{"leaked": true}');
        fs.symlinkSync(path.join(outside, 'secret.json'), path.join(workspace, 'pipeline', 'escape.json'));
        fs.symlinkSync(outside, path.join(workspace, 'outlink'));
    });

    afterAll(() => {
        fs.rmSync(workspace, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
    });

    test('passes when every declared output is a real file of the right shape and size', () => {
        const result = evaluateOutputContract({
            outputs: [
                { path: 'pipeline/manifest.json', type: 'json', minBytes: 2 },
                { path: 'pipeline/rows.csv', type: 'file', minBytes: 4 },
                { path: 'pipeline/empty.json', type: 'file' }
            ]
        }, { workspaceDir: workspace, now: NOW });
        expect(result.ok).toBe(true);
        expect(result.checkedAt).toBe('2026-09-18 23:59:30');
        expect(result.checks).toEqual([
            { path: 'pipeline/manifest.json', type: 'json', ok: true, reason: null, sizeBytes: 11, minBytes: 2 },
            { path: 'pipeline/rows.csv', type: 'file', ok: true, reason: null, sizeBytes: 8, minBytes: 4 },
            { path: 'pipeline/empty.json', type: 'file', ok: true, reason: null, sizeBytes: 0 }
        ]);
    });

    test('reports a distinct reason per failure and never throws', () => {
        const result = evaluateOutputContract({
            outputs: [
                { path: 'pipeline/nope.json', type: 'json' },
                { path: 'pipeline/broken.json', type: 'json' },
                { path: 'pipeline/empty.json', type: 'json' },
                { path: 'pipeline/rows.csv', type: 'file', minBytes: 100 },
                { path: 'adir', type: 'file' },
                { path: 'pipeline/escape.json', type: 'json' },
                { path: 'outlink/secret.json', type: 'json' },
                { path: '../outside.json', type: 'file' },
                { path: '/etc/hostname', type: 'file' }
            ]
        }, { workspaceDir: workspace });
        expect(result.ok).toBe(false);
        expect(result.checks.map(c => [c.path, c.ok, c.reason])).toEqual([
            ['pipeline/nope.json', false, 'missing'],
            ['pipeline/broken.json', false, 'invalid_json'],
            ['pipeline/empty.json', false, 'invalid_json'],
            ['pipeline/rows.csv', false, 'too_small'],
            ['adir', false, 'directory'],
            ['pipeline/escape.json', false, 'symlink'],
            ['outlink/secret.json', false, 'symlink'],
            ['../outside.json', false, 'illegal_path'],
            ['/etc/hostname', false, 'illegal_path']
        ]);
    });

    test('a contract with no outputs trivially passes', () => {
        expect(evaluateOutputContract({ outputs: [] }, { workspaceDir: workspace }).ok).toBe(true);
        expect(evaluateOutputContract(null, { workspaceDir: workspace }).ok).toBe(true);
    });
});

describe('summarizeContractFailure', () => {
    test('is one concise line naming the first few failed paths', () => {
        const result = {
            checks: [
                { path: 'ok.json', ok: true, reason: null },
                { path: 'pipeline/fetch_manifest_2026-09-18.json', ok: false, reason: 'missing' },
                { path: 'b.json', ok: false, reason: 'invalid_json' },
                { path: 'c.csv', ok: false, reason: 'too_small' },
                { path: 'd', ok: false, reason: 'directory' },
                { path: 'e', ok: false, reason: 'symlink' }
            ]
        };
        expect(summarizeContractFailure({ checks: result.checks.slice(0, 2) }))
            .toBe('output contract failed — missing pipeline/fetch_manifest_2026-09-18.json');
        expect(summarizeContractFailure(result))
            .toBe('output contract failed — missing pipeline/fetch_manifest_2026-09-18.json, invalid json b.json, too small c.csv, +2 more');
        expect(summarizeContractFailure({ checks: [] })).toBe('output contract failed');
        expect(summarizeContractFailure(null)).toBe('output contract failed');
    });

    test('exports the stable error code and a forgiving JSON reader', () => {
        expect(OUTPUT_CONTRACT_FAILED).toBe('OUTPUT_CONTRACT_FAILED');
        expect(parseStoredJson('{"ok":true}')).toEqual({ ok: true });
        expect(parseStoredJson({ ok: 1 })).toEqual({ ok: 1 });
        expect(parseStoredJson('{oops')).toBeNull();
        expect(parseStoredJson(null)).toBeNull();
    });
});
