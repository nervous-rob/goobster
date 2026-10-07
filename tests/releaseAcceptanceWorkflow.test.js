/**
 * The release acceptance workflow's structure (#343, documentation/release_acceptance.md):
 * `.github/workflows/release-acceptance.yml` is parsed, not run. It must hold a read-only token and no
 * secret, run on a manual dispatch and on pull requests that touch what it owns, carry exactly the hosted
 * cells of scripts/acceptance/matrix.js, upload every cell's evidence, name the cells it cannot give, and
 * contain only shell that parses.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const yaml = require('js-yaml');

const matrix = require('../scripts/acceptance/matrix');

const REPO_ROOT = path.resolve(__dirname, '..');
const WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'release-acceptance.yml');
const text = fs.readFileSync(WORKFLOW, 'utf8');
const workflow = yaml.load(text);
const jobs = Object.entries(workflow.jobs);
const steps = jobs.flatMap(([jobId, job]) => (job.steps || []).map((step, index) => ({ jobId, index, step })));

describe('triggers, permissions and secrets', () => {
    test('runs on a manual dispatch and on pull requests for the paths it owns, and on nothing else', () => {
        const triggers = workflow.on || workflow[true];
        expect(Object.keys(triggers).sort()).toEqual(['pull_request', 'workflow_dispatch']);
        expect(triggers.pull_request.paths).toEqual(expect.arrayContaining(['scripts/acceptance/**', '.github/workflows/release-acceptance.yml', 'documentation/release_acceptance.md']));
    });

    test('the token is read-only everywhere and no job asks for more', () => {
        expect(workflow.permissions).toEqual({ contents: 'read' });
        for (const [, job] of jobs) expect(job.permissions).toBeUndefined();
    });

    test('no secret, token or environment is referenced', () => {
        expect(text).not.toMatch(/secrets\./);
        expect(text).not.toMatch(/github\.token/i);
        for (const [, job] of jobs) expect(job.environment).toBeUndefined();
        expect(text).not.toMatch(/GOOBSTER_ACCEPTANCE_PG_URL\s*:/);
    });

    test('pull requests from forks are no different: nothing in the file reads pull-request-controlled text', () => {
        expect(text).not.toMatch(/github\.event\.pull_request\.(title|body|head\.ref)/);
        expect(text).not.toMatch(/github\.head_ref/);
    });

    test('nothing prints the environment or enables shell tracing', () => {
        for (const { step } of steps) {
            const run = typeof step.run === 'string' ? step.run : '';
            expect(run).not.toMatch(/\bprintenv\b/);
            expect(run).not.toMatch(/(^|[\s;&|])set\s+-[a-z]*x/);
            expect(run).not.toMatch(/^\s*env\s*$/m);
        }
    });
});

describe('the matrix', () => {
    const include = workflow.jobs.acceptance.strategy.matrix.include;
    const key = (cell) => [cell.platform, cell.runner, cell.install, cell.db, cell.features].join('/');

    test('one cell does not cancel the others', () => {
        expect(workflow.jobs.acceptance.strategy['fail-fast']).toBe(false);
    });

    test('carries exactly the hosted cells of the matrix definition', () => {
        expect(include.map(key).sort()).toEqual(matrix.hostedCells().map(key).sort());
        expect(new Set(include.map(key)).size).toBe(include.length);
    });

    test('Linux runs new and adopt installs on SQLite and the Docker Postgres, minimal and representative, on x64 and arm64', () => {
        for (const platform of ['linux-x64', 'linux-arm64']) {
            const cells = include.filter((cell) => cell.platform === platform);
            expect(cells).toHaveLength(8);
            expect(new Set(cells.map((cell) => `${cell.install}/${cell.db}/${cell.features}`))).toEqual(new Set(
                ['new', 'adopt'].flatMap((install) => ['sqlite', 'managed-pg'].flatMap((db) => ['minimal', 'representative'].map((features) => `${install}/${db}/${features}`)))
            ));
        }
        expect(include.find((cell) => cell.platform === 'linux-x64').runner).toBe('ubuntu-24.04');
        expect(include.find((cell) => cell.platform === 'linux-arm64').runner).toBe('ubuntu-24.04-arm');
    });

    test('macOS and Windows run one new, SQLite, minimal cell each', () => {
        for (const [platform, runner] of [['darwin-arm64', 'macos-15'], ['darwin-x64', 'macos-15-intel'], ['win32-x64', 'windows-2022']]) {
            const cells = include.filter((cell) => cell.platform === platform);
            expect(cells).toEqual([{ platform, runner, install: 'new', db: 'sqlite', features: 'minimal' }]);
        }
    });

    test('a cell builds its payload for its own target, then runs the driver with its own coordinates', () => {
        const build = steps.find(({ jobId, step }) => jobId === 'acceptance' && /package-runtime\.js/.test(step.run || '')).step.run;
        expect(build).toContain('--target "$TARGET"');
        expect(build).toContain('--dev-sign');
        const run = steps.find(({ jobId, step }) => jobId === 'acceptance' && /acceptance\/run\.js/.test(step.run || '')).step.run;
        for (const flag of ['--payload', '--install "$INSTALL"', '--db "$DATABASE"', '--features "$FEATURES"', '--out "$EVIDENCE"']) expect(run).toContain(flag);
        const env = workflow.jobs.acceptance.env;
        expect(env.TARGET).toBe('${{ matrix.platform }}');
        expect(env.INSTALL).toBe('${{ matrix.install }}');
        expect(env.DATABASE).toBe('${{ matrix.db }}');
        expect(env.FEATURES).toBe('${{ matrix.features }}');
    });

    test('the Docker cells check Docker first', () => {
        const check = steps.find(({ step }) => /docker info/.test(step.run || '')).step;
        expect(check.if).toBe("matrix.db == 'managed-pg'");
    });
});

describe('evidence', () => {
    test('every cell uploads its evidence directory even when the cell failed', () => {
        const upload = steps.find(({ jobId, step }) => jobId === 'acceptance' && /upload-artifact/.test(step.uses || '')).step;
        expect(upload.if).toBe('always()');
        expect(upload.with.name).toBe('acceptance-${{ matrix.platform }}-${{ matrix.install }}-${{ matrix.db }}-${{ matrix.features }}');
        expect(upload.with.path).toContain('goobster-acceptance-evidence');
    });

    test('the evidence goes where the driver writes it', () => {
        const output = steps.find(({ step }) => /EVIDENCE=/.test(step.run || '')).step.run;
        expect(output).toContain('EVIDENCE=$RUNNER_TEMP/goobster-acceptance-evidence');
    });

    test('a report job renders the matrix from every cell, whatever the cells did', () => {
        const report = workflow.jobs.report;
        expect(report.needs).toBe('acceptance');
        expect(report.if).toBe('always()');
        const render = report.steps.find((step) => /report\.js/.test(step.run || '')).run;
        expect(render).toContain('--matrix');
        expect(render).toContain('GITHUB_STEP_SUMMARY');
    });
});

describe('what the workflow cannot give', () => {
    const lower = text.toLowerCase();
    test.each([
        ['Raspberry Pi hardware', 'raspberry pi'],
        ['an existing Postgres without superuser', 'existing-pg'],
        ['the full profile with real keys', 'full feature profile'],
        ['desktop PostgreSQL', 'desktop postgresql'],
        ['major upgrades', 'major upgrades']
    ])('names %s as a deferred cell, with a reason', (_label, needle) => {
        expect(lower).toContain(needle);
    });

    test('every deferred cell of the matrix definition has a reason', () => {
        expect(matrix.DEFERRED.length).toBeGreaterThanOrEqual(5);
        for (const cell of matrix.DEFERRED) expect(cell.reason.length).toBeGreaterThan(40);
    });

    test('cites the native-PostgreSQL evidence of #371 without merging it', () => {
        expect(text).toMatch(/#371/);
        expect(text).toMatch(/joins this matrix after that stack merges/);
    });
});

describe('shell', () => {
    const scripts = steps.filter(({ step }) => typeof step.run === 'string');

    test('every run block of the matrix job uses bash, so one syntax is checked', () => {
        expect(workflow.jobs.acceptance.defaults.run.shell).toBe('bash');
        for (const { jobId, step } of scripts) expect(step.shell === undefined || step.shell === 'bash' || jobId === 'report').toBe(true);
    });

    test.each(scripts.map(({ jobId, index, step }) => [`${jobId} step ${index + 1} (${step.name || 'unnamed'})`, step.run]))('%s parses with bash -n', (_name, run) => {
        const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-wf-')), 'step.sh');
        fs.writeFileSync(file, run.replace(/\$\{\{[^}]*\}\}/g, 'EXPR'));
        const result = childProcess.spawnSync('bash', ['-n', file], { encoding: 'utf8' });
        fs.rmSync(path.dirname(file), { recursive: true, force: true });
        expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    });
});
