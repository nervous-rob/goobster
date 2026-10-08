/**
 * The acceptance matrix report (#343, documentation/release_acceptance.md): evidence files in, the matrix
 * table out. Covered here: a fixture becomes the right rows and cells, `n/a` and `deferred` render as such,
 * evidence that fails the format or looks like it holds a secret is rejected and never rendered, the
 * intended matrix adds `missing` and `deferred` rows, and the evidence primitives never turn a failure
 * into a pass or let a registered secret through.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const E = require('../scripts/acceptance/lib/evidence');
const matrix = require('../scripts/acceptance/matrix');
const report = require('../scripts/acceptance/report');

function evidence(overrides = {}, statusOf = () => 'pass') {
    const cell = { id: 'linux-x64/new/sqlite/minimal', platform: 'linux', arch: 'x64', install: 'new', db: 'sqlite', features: 'minimal', runnerImage: 'ubuntu-24.04 20260101.1', ...overrides.cell };
    const entry = (def) => {
        const status = statusOf(def.id);
        return { id: def.id, title: def.title, status, result: status === 'pass' ? 'ok' : `${status} because the fixture says so`, durationMs: 10, engine: 'sqlite', commands: [{ command: `goobster-manager ${def.id}`, exitCode: status === 'pass' ? 0 : null, durationMs: 5 }] };
    };
    const doc = {
        schema: E.SCHEMA_VERSION,
        cell,
        artifact: { version: '1.0.0', target: 'linux-x64', profile: 'minimal', features: ['core'], node: '22.0.0', signing: 'development key (throwaway)' },
        commit: 'a'.repeat(40),
        date: '2026-10-07',
        startedAt: '2026-10-07T10:00:00.000Z',
        finishedAt: '2026-10-07T10:07:00.000Z',
        node: 'v22.0.0',
        driverError: null,
        steps: E.STEPS.map(entry),
        injections: E.INJECTIONS.map(entry),
        ...overrides.doc
    };
    doc.summary = { steps: E.summarize(doc.steps), injections: E.summarize(doc.injections) };
    return doc;
}

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-report-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function write(name, doc) {
    fs.writeFileSync(path.join(dir, name), typeof doc === 'string' ? doc : JSON.stringify(doc, null, 2));
}

function rowsOf(markdown) {
    return markdown.split('\n').filter((line) => line.startsWith('| ') && !line.startsWith('| ---'));
}

describe('a fixture becomes the table', () => {
    test('one row per cell with a column per step and per injection', () => {
        write('evidence-linux-x64-new-sqlite-minimal.json', evidence());
        write('evidence-linux-arm64-adopt-sqlite-representative.json', evidence({ cell: { id: 'linux-arm64/adopt/sqlite/representative', arch: 'arm64', install: 'adopt', features: 'representative' } }, (id) => (id === 'update' ? 'fail' : 'pass')));
        const out = report.renderMarkdown(report.buildModel(report.loadEvidence([dir])));
        const [header, ...rows] = rowsOf(out);
        const columns = header.split('|').slice(1, -1).map((cell) => cell.trim());
        expect(columns.slice(0, 4)).toEqual(['platform', 'install', 'database', 'features']);
        expect(columns).toHaveLength(4 + E.STEPS.length + E.INJECTIONS.length);
        for (const id of E.STEPS.map((def) => def.id)) expect(columns).toContain(report.STEP_LABELS[id]);
        for (const id of E.INJECTIONS.map((def) => def.id)) expect(columns).toContain(report.INJECTION_LABELS[id]);
        const first = rows[0].split('|').slice(1, -1).map((cell) => cell.trim());
        expect(first.slice(0, 4)).toEqual(['linux-x64', 'new', 'sqlite', 'minimal']);
        expect(first.slice(4).every((cell) => cell === 'pass')).toBe(true);
        const second = rows[1].split('|').slice(1, -1).map((cell) => cell.trim());
        expect(second.slice(0, 4)).toEqual(['linux-arm64', 'adopt', 'sqlite', 'representative']);
        expect(second[columns.indexOf('update')]).toBe('fail');
        expect(second[columns.lastIndexOf('install')]).toBe('pass');
    });

    test('carries the artifact version, commit, runner image and date of every run', () => {
        write('evidence-linux-x64-new-sqlite-minimal.json', evidence());
        const out = report.renderMarkdown(report.buildModel(report.loadEvidence([dir])));
        expect(out).toContain('1.0.0 (minimal: core)');
        expect(out).toContain('a'.repeat(12));
        expect(out).toContain('ubuntu-24.04 20260101.1');
        expect(out).toContain('2026-10-07');
    });

    test('n/a and deferred render as n/a and deferred, never as a pass', () => {
        write('evidence-linux-x64-new-sqlite-minimal.json', evidence({}, (id) => ({ features: 'not-applicable', migrate: 'not-applicable', 'storage-refusal': 'deferred' }[id] || 'pass')));
        const out = report.renderMarkdown(report.buildModel(report.loadEvidence([dir])));
        const [header, row] = rowsOf(out);
        const columns = header.split('|').slice(1, -1).map((cell) => cell.trim());
        const cells = row.split('|').slice(1, -1).map((cell) => cell.trim());
        expect(cells[columns.lastIndexOf('features')]).toBe('n/a');
        expect(cells[columns.indexOf('migrate')]).toBe('n/a');
        expect(cells[columns.indexOf('storage')]).toBe('deferred');
        expect(cells.filter((cell) => cell === 'pass')).toHaveLength(columns.length - 4 - 3);
        expect(out).not.toMatch(/undefined|null|\[object/);
    });

    test('the JSON form carries the same statuses and the counts', () => {
        write('evidence-linux-x64-new-sqlite-minimal.json', evidence({}, (id) => (id === 'repair' ? 'fail' : 'pass')));
        const json = JSON.parse(report.renderJson(report.buildModel(report.loadEvidence([dir]))));
        expect(json.rows[0].statuses.repair).toBe('fail');
        expect(json.counts.fail).toBe(1);
        expect(json.counts.pass).toBe(E.STEPS.length + E.INJECTIONS.length - 1);
    });
});

describe('evidence that must not be rendered', () => {
    test.each([
        ['a bearer token', { note: 'Bearer abcdefghijklmnopqrstuvwxyz0123456789' }],
        ['a provider key', { note: 'sk-abcdefghijklmnop1234' }],
        ['a home directory', { note: 'wrote /home/someone/goobster/data' }],
        ['a private key', { note: '-----BEGIN PRIVATE KEY-----' }],
        ['a secret-named field with a value', { password: 'hunter2hunter2' }]
    ])('rejects a file with %s and renders none of it', (_label, extra) => {
        const doc = evidence();
        doc.steps[0] = { ...doc.steps[0], ...extra };
        write('evidence-linux-x64-new-sqlite-minimal.json', doc);
        const model = report.buildModel(report.loadEvidence([dir]));
        expect(model.rows).toHaveLength(0);
        expect(model.rejected).toHaveLength(1);
        const out = report.renderMarkdown(model);
        expect(out).toContain('Rejected evidence');
        for (const value of Object.values(extra)) expect(out).not.toContain(value);
    });

    test('rejects a document that breaks the format: a missing step, an unknown status, a reasonless n/a', () => {
        const missing = evidence();
        missing.steps = missing.steps.filter((step) => step.id !== 'reset');
        const unknown = evidence();
        unknown.steps[1].status = 'passed';
        const silent = evidence();
        silent.steps[2] = { ...silent.steps[2], status: 'not-applicable', result: '' };
        write('evidence-a.json', missing);
        write('evidence-b.json', unknown);
        write('evidence-c.json', silent);
        write('evidence-d.json', '{ not json');
        const loaded = report.loadEvidence([dir]);
        expect(loaded.accepted).toHaveLength(0);
        expect(loaded.rejected.map((item) => item.file).sort()).toEqual(['evidence-a.json', 'evidence-b.json', 'evidence-c.json', 'evidence-d.json']);
    });

    test('a directory that does not exist is reported, not ignored', () => {
        const loaded = report.loadEvidence([path.join(dir, 'nope')]);
        expect(loaded.rejected).toHaveLength(1);
    });
});

describe('the intended matrix', () => {
    test('a hosted cell with no evidence is missing, and the cells no runner can give are deferred with their reasons', () => {
        write('evidence-linux-x64-new-sqlite-minimal.json', evidence());
        const model = report.buildModel(report.loadEvidence([dir]), { withMatrix: true });
        expect(model.rows).toHaveLength(matrix.hostedCells().length + matrix.DEFERRED.length);
        expect(model.missing).toHaveLength(matrix.hostedCells().length - 1);
        expect(model.deferredRows).toHaveLength(matrix.DEFERRED.length);
        const out = report.renderMarkdown(model);
        expect(out).toContain('missing');
        expect(out).toContain('Deferred cells:');
        for (const cell of matrix.DEFERRED) expect(out).toContain(cell.reason);
        const pi = model.rows.find((row) => row.platform.includes('Raspberry Pi'));
        expect(Object.values(pi.statuses).every((status) => status === 'deferred')).toBe(true);
        expect(model.counts.pass).toBe(E.STEPS.length + E.INJECTIONS.length);
    });

    test('--strict exits 1 for a failure, a rejected file or a missing cell, and 0 only for a clean report', () => {
        const run = (args) => {
            let out = '';
            const code = report.main(args, { stdout: { write: (text) => { out += text; } }, stderr: { write: () => {} } });
            return { code, out };
        };
        write('evidence-linux-x64-new-sqlite-minimal.json', evidence());
        expect(run([dir, '--strict']).code).toBe(0);
        expect(run([dir, '--strict', '--matrix']).code).toBe(1);
        write('evidence-linux-x64-new-sqlite-representative.json', evidence({ cell: { features: 'representative' } }, (id) => (id === 'update' ? 'fail' : 'pass')));
        expect(run([dir, '--strict']).code).toBe(1);
        expect(run([dir]).code).toBe(0);
        expect(run([]).code).toBe(2);
        expect(run([dir, '--format', 'xml']).code).toBe(2);
    });

    test('the rendered report holds nothing that looks like a secret, a token or a home directory', () => {
        write('evidence-linux-x64-new-sqlite-minimal.json', evidence());
        const out = report.renderMarkdown(report.buildModel(report.loadEvidence([dir]), { withMatrix: true }));
        expect(E.findLeaks({ text: out })).toEqual([]);
        expect(E.findLeaks(JSON.parse(report.renderJson(report.buildModel(report.loadEvidence([dir]), { withMatrix: true }))))).toEqual([]);
    });
});

describe('the generated block of a document', () => {
    const BEGIN = '<!-- acceptance-matrix:begin -->';
    const END = '<!-- acceptance-matrix:end -->';

    test('--doc replaces only the text between the markers, and again leaves the same text', () => {
        write('evidence-linux-x64-new-sqlite-minimal.json', evidence());
        const file = path.join(dir, 'doc.md');
        fs.writeFileSync(file, `# Title\n\nbefore\n\n${BEGIN}\n\nstale table\n\n${END}\n\nafter\n`);
        const run = () => report.main([dir, '--doc', file], { stdout: { write: () => {} }, stderr: { write: () => {} } });
        expect(run()).toBe(0);
        const once = fs.readFileSync(file, 'utf8');
        expect(once).toContain('# Title\n\nbefore\n\n');
        expect(once).toContain('\n\nafter\n');
        expect(once).not.toContain('stale table');
        expect(once).toContain('| linux-x64 | new | sqlite | minimal |');
        expect(run()).toBe(0);
        expect(fs.readFileSync(file, 'utf8')).toBe(once);
    });

    test('a document without the markers is refused and left as it was', () => {
        write('evidence-linux-x64-new-sqlite-minimal.json', evidence());
        const file = path.join(dir, 'plain.md');
        fs.writeFileSync(file, '# No block here\n');
        let said = '';
        expect(report.main([dir, '--doc', file], { stdout: { write: () => {} }, stderr: { write: (text) => { said += text; } } })).toBe(2);
        expect(said).toMatch(/acceptance-matrix:begin/);
        expect(fs.readFileSync(file, 'utf8')).toBe('# No block here\n');
    });
});

describe('the evidence primitives', () => {
    test('a thrown check is a fail, a step that returns nothing is a pass, and a dependent of a failed step does not run', async () => {
        const recorder = new E.Recorder({ redactor: new E.Redactor() });
        await recorder.step('install', () => { E.check(false, 'the install did not hold'); });
        const ran = [];
        await recorder.step('owner', () => { ran.push('owner'); }, { needs: ['install'] });
        await recorder.step('chat', () => ({ status: 'pass', result: 'would have passed' }), { needs: ['install'] });
        await recorder.step('reset', () => E.notApplicable('there is nothing to reset here'));
        await recorder.step('migrate', () => E.deferred('no Postgres in reach'));
        const { steps } = recorder.ordered();
        const by = Object.fromEntries(steps.map((step) => [step.id, step]));
        expect(by.install.status).toBe('fail');
        expect(by.install.result).toBe('the install did not hold');
        expect(ran).toEqual([]);
        expect(by.owner.status).toBe('not-applicable');
        expect(by.owner.result).toMatch(/install step failed/);
        expect(by.chat.status).toBe('not-applicable');
        expect(by.reset).toMatchObject({ status: 'not-applicable', result: 'there is nothing to reset here' });
        expect(by.migrate).toMatchObject({ status: 'deferred' });
        expect(by.update.status).toBe('not-applicable');
        expect(by.update.result).toMatch(/stopped before/);
    });

    test('an unexpected exception is a fail with its name, not a pass and not a crash of the driver', async () => {
        const recorder = new E.Recorder({ redactor: new E.Redactor() });
        const entry = await recorder.step('install', () => { throw new TypeError('boom'); });
        expect(entry.status).toBe('fail');
        expect(entry.result).toBe('TypeError: boom');
    });

    test('registered secrets, home directories and tokens are removed from every recorded string', async () => {
        const redactor = new E.Redactor();
        redactor.secret('correct-horse-battery-staple');
        redactor.path('/tmp/work-area-123', '<work>');
        const recorder = new E.Recorder({ redactor });
        const entry = await recorder.step('install', (step) => {
            step.command({ command: 'goobster-manager install --answers /tmp/work-area-123/answers.json correct-horse-battery-staple', exitCode: 0, durationMs: 1 });
            return { result: 'signed in with correct-horse-battery-staple as /home/someone via Bearer abcdefghijklmnopqrstuvwxyz0123456789 and sk-abcdefghijklmnop1234' };
        });
        const doc = JSON.stringify(entry);
        expect(doc).not.toContain('correct-horse-battery-staple');
        expect(doc).not.toContain('/home/someone');
        expect(doc).not.toContain('abcdefghijklmnopqrstuvwxyz');
        expect(doc).not.toContain('sk-abcdefghijklmnop1234');
        expect(entry.commands[0].command).toContain('<work>/answers.json');
        expect(E.findLeaks(entry)).toEqual([]);
    });
});

describe('how the driver starts a launcher', () => {
    function onPlatform(platform, fn) {
        const original = Object.getOwnPropertyDescriptor(process, 'platform');
        Object.defineProperty(process, 'platform', { value: platform, configurable: true });
        try {
            let operator;
            jest.isolateModules(() => { operator = require('../scripts/acceptance/lib/operator'); });
            return fn(operator);
        } finally {
            Object.defineProperty(process, 'platform', original);
        }
    }

    test('a POSIX launcher is a program with its arguments untouched', () => {
        onPlatform('linux', (operator) => {
            expect(operator.launcherCommand('/opt/goobster/code/current/bin/goobster-manager', ['status', '--json', 'a b']))
                .toEqual({ file: '/opt/goobster/code/current/bin/goobster-manager', args: ['status', '--json', 'a b'], shell: false });
        });
    });

    test('a .cmd launcher goes through cmd.exe with a normalized, quoted path (a forward slash would read as a switch)', () => {
        onPlatform('win32', (operator) => {
            const command = operator.launcherCommand('D:\\a\\_temp/goobster-payload\\bin\\goobster-manager.cmd', ['install', '--answers', 'D:\\a\\_temp/work/answers x.json', '--json']);
            expect(command.shell).toBe(true);
            expect(command.file).toBe('"D:\\a\\_temp\\goobster-payload\\bin\\goobster-manager.cmd"');
            expect(command.args).toEqual(['install', '--answers', '"D:\\a\\_temp/work/answers x.json"', '--json']);
        });
    });

    test('a Windows launcher that is not a .cmd file is a program, not a shell command', () => {
        onPlatform('win32', (operator) => {
            expect(operator.launcherCommand('C:\\Goobster\\runtime\\node.exe', ['x'])).toEqual({ file: 'C:\\Goobster\\runtime\\node.exe', args: ['x'], shell: false });
        });
    });
});

describe('how the driver ends a process it started', () => {
    const { spawn } = require('node:child_process');

    test('on POSIX the signal goes to the process itself, and a pid that is gone is reported as not ended', async () => {
        const operator = require('../scripts/acceptance/lib/operator');
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
        const closed = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
        expect(operator.killTree(child.pid)).toBe(true);
        const ended = await closed;
        expect(ended.signal).toBe('SIGKILL');
        expect(operator.killTree(child.pid)).toBe(false);
        expect(operator.killTree(null)).toBe(false);
    });

    test('on Windows the whole tree is ended with taskkill, because the pid the driver holds is the cmd.exe running the .cmd launcher; a pid already gone is not ended (no taskkill, false)', async () => {
        const live = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
        const gone = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
        await new Promise((resolve) => gone.once('close', resolve));
        const original = Object.getOwnPropertyDescriptor(process, 'platform');
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        const calls = [];
        try {
            jest.isolateModules(() => {
                jest.doMock('node:child_process', () => ({
                    ...jest.requireActual('node:child_process'),
                    execFileSync: (file, args, options) => { calls.push({ file, args, options }); }
                }));
                const operator = require('../scripts/acceptance/lib/operator');
                expect(operator.killTree(live.pid)).toBe(true);
                expect(operator.killTree(gone.pid)).toBe(false);
            });
        } finally {
            jest.dontMock('node:child_process');
            Object.defineProperty(process, 'platform', original);
            live.kill('SIGKILL');
        }
        expect(calls).toEqual([expect.objectContaining({ file: 'taskkill', args: ['/PID', String(live.pid), '/T', '/F'] })]);
    });
});

describe('the process logs a failed cell keeps beside its evidence', () => {
    test('every log is redacted through the cell\'s redactor, and one that still shows something secret-like is replaced by a note', () => {
        const { keepLogs } = require('../scripts/acceptance/run');
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-logs-'));
        try {
            const from = path.join(root, 'logs');
            fs.mkdirSync(from);
            fs.writeFileSync(path.join(from, 'manager.log'), '[manager] state: claimed\ncredential file at /home/someone/data/manager/recovery-credential\nminted s3cr3t-value-here\n');
            fs.writeFileSync(path.join(from, 'scratch-token.log'), 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789\n-----BEGIN PRIVATE KEY-----\nMIIE...\n');
            fs.writeFileSync(path.join(from, 'notes.txt'), 'not a log\n');
            const redactor = new E.Redactor();
            redactor.secret('s3cr3t-value-here');
            const to = path.join(root, 'out', 'logs-cell');
            expect(keepLogs(from, to, redactor)).toEqual(['manager.log', 'scratch-token.log']);
            const manager = fs.readFileSync(path.join(to, 'manager.log'), 'utf8');
            expect(manager).toContain('[manager] state: claimed');
            expect(manager).toContain('minted [redacted]');
            expect(manager).not.toContain('s3cr3t');
            expect(manager).not.toContain('/home/someone');
            expect(fs.readFileSync(path.join(to, 'scratch-token.log'), 'utf8')).toMatch(/^\(not kept: 1 possible leak\(s\): a private key\)\n$/);
            expect(fs.existsSync(path.join(to, 'notes.txt'))).toBe(false);
            expect(keepLogs(path.join(root, 'missing'), to, redactor)).toEqual([]);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
