const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
    GROUPS,
    auditEngineShards,
    auditTestGroups,
    groupById,
    listedFiles,
    resolveEngine,
    toRepoPosix
} = require('./ciGroups');
const { listSpecFiles, loadDurations, planShards, durationsFromReport } = require('../scripts/lib/e2eShards');
const {
    formatInventory,
    inventory,
    isCredentialPresent,
    skipReasonFor
} = require('../scripts/lib/liveCredentials');

const ROOT = path.join(__dirname, '..');

function globUnitTests() {
    return fs.readdirSync(__dirname)
        .filter((name) => name.endsWith('.test.js'))
        .map((name) => `tests/${name}`)
        .sort();
}

describe('test group inventory', () => {
    test('every discovered unit spec is in exactly one group', () => {
        const discovered = globUnitTests();
        const workflowSource = fs.readFileSync(
            path.join(ROOT, '.github/workflows/ci.yml'),
            'utf8'
        );
        const errors = auditTestGroups({ discovered, groups: GROUPS, workflowSource });
        expect(errors).toEqual([]);
        expect(listedFiles()).toHaveLength(discovered.length);
        expect(workflowSource).not.toMatch(/uses:\s*\.\/\.github\/actions\/run-test-groups/);
    });

    test('reports missing, duplicated, and undiscovered paths', () => {
        const errors = auditTestGroups({
            discovered: ['tests/a.test.js', 'tests/orphan.test.js'],
            groups: [
                {
                    id: 'core',
                    name: 'Core',
                    files: ['tests/a.test.js', 'tests/a.test.js', 'tests/ghost.test.js']
                },
                {
                    id: 'chat',
                    name: 'Chat',
                    files: ['tests/a.test.js']
                }
            ]
        });
        expect(errors).toEqual(expect.arrayContaining([
            'duplicated inside core: tests/a.test.js',
            'duplicated across groups: tests/a.test.js (core, chat)',
            'listed but not discovered by Jest: tests/ghost.test.js',
            'missing from any group: tests/orphan.test.js'
        ]));
    });

    test('requires every group id as a named step in both engine jobs', () => {
        const errors = auditTestGroups({
            discovered: ['tests/a.test.js'],
            groups: [{ id: 'core', name: 'Core', files: ['tests/a.test.js'] }],
            workflowSource: 'run: node scripts/run-test-group.js chat\n'
        });
        expect(errors).toEqual(expect.arrayContaining([
            'group id "core" is not a named step in .github/workflows/ci.yml',
            '.github/workflows/ci.yml references unknown group id "chat"'
        ]));
    });

    test('requires each group id once per engine job', () => {
        const errors = auditTestGroups({
            discovered: ['tests/a.test.js'],
            groups: [{ id: 'core', name: 'Core', files: ['tests/a.test.js'] }],
            workflowSource: 'run: node scripts/run-test-group.js core\n'
        });
        expect(errors).toEqual(expect.arrayContaining([
            'group id "core" appears 1 time(s) in .github/workflows/ci.yml; expected once per engine job (2)'
        ]));
    });

    test('groupById and path helpers', () => {
        expect(groupById('privacy').name).toBe('Privacy and execution safety');
        expect(groupById('nope')).toBeNull();
        expect(toRepoPosix(path.join(ROOT, 'tests', 'ciGroups.test.js'), ROOT))
            .toBe('tests/ciGroups.test.js');
        expect(resolveEngine({})).toBe('sqlite');
        expect(resolveEngine({ GOOBSTER_DB_URL: 'postgres://x' })).toBe('postgres');
    });
});

/** A two-engine workflow in the shape of ci.yml, with the given shard lists. */
function shardWorkflow({ sqlite, postgres, stepIf = (id) => `contains(matrix.groups, '${id}')`, verdictIf = 'always()', needs = '[test-sqlite, test-postgres]' }) {
    const job = (id, shards, ids) => [
        `  ${id}:`,
        '    strategy:',
        '      fail-fast: false',
        '      matrix:',
        '        include:',
        ...shards.map((groups, i) => `          - shard: s${i + 1}\n            groups: [${groups.join(', ')}]`),
        '    steps:',
        ...ids.map((gid) => `      - if: ${stepIf(gid)}\n        run: node scripts/run-test-group.js ${gid}`),
        `      - if: ${verdictIf}`,
        "        run: node scripts/require-test-groups.js ${{ join(matrix.groups, ' ') }}"
    ].join('\n');
    const ids = ['core', 'chat'];
    return [
        'jobs:',
        job('test-sqlite', sqlite, ids),
        job('test-postgres', postgres, ids),
        '  both-engines:',
        `    needs: ${needs}`,
        ''
    ].join('\n');
}

describe('engine shard matrix', () => {
    const groups = [
        { id: 'core', name: 'Core', files: ['tests/a.test.js'] },
        { id: 'chat', name: 'Chat', files: ['tests/b.test.js'] }
    ];

    test('the real workflow runs every group in exactly one shard of each engine', () => {
        const workflowSource = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
        expect(auditEngineShards({ groups: GROUPS, workflowSource })).toEqual([]);
    });

    test('accepts different shard layouts per engine', () => {
        const workflowSource = shardWorkflow({ sqlite: [['core', 'chat']], postgres: [['core'], ['chat']] });
        expect(auditEngineShards({ groups, workflowSource })).toEqual([]);
    });

    test('a group left out of an engine, listed twice, or unknown is an error', () => {
        const workflowSource = shardWorkflow({ sqlite: [['core']], postgres: [['core', 'chat'], ['chat', 'ghost']] });
        expect(auditEngineShards({ groups, workflowSource })).toEqual([
            'group id "chat" is in no shard of test-sqlite; it would never run on that engine',
            'group id "chat" is in 2 shards of test-postgres (s1, s2)',
            'test-postgres shard matrix references unknown group id "ghost"'
        ]);
    });

    test('a group step must be gated on its own id and the verdict step must always run', () => {
        const ungated = shardWorkflow({ sqlite: [['core', 'chat']], postgres: [['core', 'chat']], stepIf: () => "contains(matrix.groups, 'core')" });
        expect(auditEngineShards({ groups, workflowSource: ungated })).toEqual([
            'test-sqlite step for group id "chat" must have `if: contains(matrix.groups, \'chat\')`',
            'test-postgres step for group id "chat" must have `if: contains(matrix.groups, \'chat\')`'
        ]);
        const quiet = shardWorkflow({ sqlite: [['core', 'chat']], postgres: [['core', 'chat']], verdictIf: 'success()' });
        expect(auditEngineShards({ groups, workflowSource: quiet })).toEqual([
            'test-sqlite require-test-groups.js step must have `if: always()`',
            'test-postgres require-test-groups.js step must have `if: always()`'
        ]);
    });

    test('the aggregator must wait on both engine jobs', () => {
        const workflowSource = shardWorkflow({ sqlite: [['core', 'chat']], postgres: [['core', 'chat']], needs: '[test-sqlite]' });
        expect(auditEngineShards({ groups, workflowSource })).toEqual(['both-engines must need test-postgres']);
    });

    describe('require-test-groups.js', () => {
        let dir;
        const run = (ids, env = {}) => spawnSync(process.execPath, [path.join(ROOT, 'scripts/require-test-groups.js'), ...ids], {
            encoding: 'utf8',
            env: { ...process.env, GOOBSTER_DB_URL: '', GOOBSTER_TEST_RESULTS_DIR: dir, ...env }
        });
        const write = (engine, id, summary) => fs.writeFileSync(
            path.join(dir, `${engine}-${id}.summary.json`),
            JSON.stringify({ groupId: id, engine, success: true, passed: 3, failed: 0, total: 3, ...summary })
        );

        beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-require-groups-')); });
        afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

        test('passes only when every named group ran and passed on this engine', () => {
            write('sqlite', 'core', {});
            write('sqlite', 'chat', {});
            expect(run(['core', 'chat']).status).toBe(0);
        });

        test('a group that did not run fails, including one that ran on the other engine', () => {
            write('sqlite', 'core', {});
            write('postgres', 'chat', {});
            const result = run(['core', 'chat']);
            expect(result.status).toBe(1);
            expect(result.stderr).toMatch(/Chat and AI \(sqlite\) did not run/);
        });

        test('a failed group, an empty group and an unknown id fail', () => {
            write('sqlite', 'core', { success: false, passed: 2, failed: 1 });
            expect(run(['core']).status).toBe(1);
            write('sqlite', 'core', { passed: 0, total: 0 });
            expect(run(['core']).status).toBe(1);
            expect(run(['nope']).status).toBe(1);
            expect(run([]).status).toBe(2);
        });
    });
});

describe('playwright shard plan', () => {
    const specs = listSpecFiles();

    test('every spec file runs in exactly one shard, for any shard count', () => {
        expect(specs.length).toBeGreaterThan(0);
        for (let total = 1; total <= 8; total += 1) {
            const shards = planShards({ files: specs, durations: loadDurations(), total });
            expect(shards).toHaveLength(total);
            expect(shards.flatMap((shard) => shard.files).sort()).toEqual(specs);
        }
    });

    test('balances by recorded seconds and still places a spec with no record', () => {
        const shards = planShards({
            files: ['a.spec.js', 'b.spec.js', 'c.spec.js', 'd.spec.js', 'new.spec.js'],
            durations: { 'a.spec.js': 100, 'b.spec.js': 60, 'c.spec.js': 30, 'd.spec.js': 10 },
            total: 2
        });
        expect(shards.map((shard) => shard.files)).toEqual([
            ['a.spec.js', 'c.spec.js'],
            ['b.spec.js', 'd.spec.js', 'new.spec.js']
        ]);
        expect(() => planShards({ files: specs, total: 0 })).toThrow(/positive integer/);
    });

    test('the plan is the same however the file list is ordered', () => {
        const durations = loadDurations();
        const forward = planShards({ files: specs, durations, total: 5 });
        const reversed = planShards({ files: [...specs].reverse(), durations, total: 5 });
        expect(reversed).toEqual(forward);
    });

    test('reads per-file seconds from a Playwright JSON report', () => {
        const report = {
            suites: [{
                file: 'a.spec.js',
                specs: [{ tests: [{ results: [{ duration: 1500 }, { duration: 700 }] }] }],
                suites: [{ specs: [{ tests: [{ results: [{ duration: 800 }] }] }] }]
            }, {
                file: 'b.spec.js',
                specs: [{ tests: [{ results: [{ duration: 20 }] }] }]
            }]
        };
        expect(durationsFromReport(report)).toEqual({ 'a.spec.js': 3, 'b.spec.js': 1 });
    });

    test('the workflow runs shards 1..n and one check reports them all', () => {
        const { jobs } = require('yaml').parse(
            fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8')
        );
        const shards = jobs['test-e2e'].strategy.matrix.shard;
        expect(shards).toEqual(shards.map((_, i) => i + 1));
        expect(jobs['test-e2e'].strategy['fail-fast']).toBe(false);
        const run = jobs['test-e2e'].steps.map((step) => step.run || '').find((text) => /e2e-shard\.js/.test(text));
        expect(run).toBe('node scripts/e2e-shard.js ${{ matrix.shard }} ${{ strategy.job-total }}');
        expect(jobs.e2e.name).toBe('test (playwright)');
        expect(jobs.e2e.if).toBe('always()');
        expect([].concat(jobs.e2e.needs)).toEqual(['test-e2e']);
    });

    // PR #416 merged with the single Playwright job cancelled at its limit and
    // seven journeys unrun. Journeys keep being added, so ask for another
    // shard while each one still fits in half of its limit.
    test('every shard is planned to finish in half of the job limit', () => {
        const { jobs } = require('yaml').parse(
            fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8')
        );
        const total = jobs['test-e2e'].strategy.matrix.shard.length;
        const limitSeconds = jobs['test-e2e']['timeout-minutes'] * 60;
        const setupSeconds = 120; // checkout, npm ci, client build, Chromium: about 60 s measured
        const planned = planShards({ files: specs, durations: loadDurations(), total })
            .map((shard) => Math.round(shard.seconds + setupSeconds));
        const longest = Math.max(...planned);
        if (longest > limitSeconds / 2) {
            throw new Error(
                `The longest of ${total} Playwright shards is planned at ${longest}s, over half of the ${limitSeconds}s job limit. `
                + 'Add the next number to the test-e2e `shard` list in .github/workflows/ci.yml.'
            );
        }
    });
});

// The Chromium install step of the journey shards (scripts/ci-playwright-chromium.sh).
// The real commands are replaced by stand-ins on PATH, so this checks which
// commands run in which order, not apt itself.
(process.platform === 'win32' ? describe.skip : describe)('chromium install step', () => {
    const SCRIPT = path.join(ROOT, 'scripts/ci-playwright-chromium.sh');
    const FULL = 'npx playwright install --with-deps chromium';
    const CHECK = 'npx playwright install --with-deps --dry-run chromium';
    const BROWSER = 'npx playwright install chromium';
    const STANDINS = {
        sudo: 'exec "$@"',
        timeout: [
            'while [[ "$1" == --* ]]; do shift; done; shift',
            'if [ "$1 $2" = "apt-get update" ] && [ -n "${FAKE_UPDATE_STALLS:-}" ]; then echo "apt-get update (killed by timeout)" >> "$CALLS"; exit 124; fi',
            'exec "$@"'
        ].join('\n'),
        'apt-get': [
            'echo "apt-get $*" >> "$CALLS"',
            'case "$1" in',
            '  install) [ -n "${FAKE_INSTALL_FAILS:-}" ] && exit 100; touch "$STATE/fonts";;',
            '  download) shift; for p in "$@"; do touch "${p%%=*}_${p##*=}_all.deb"; done;;',
            'esac',
            'exit 0'
        ].join('\n'),
        npx: [
            'echo "npx $*" >> "$CALLS"',
            'case "$*" in',
            `  "${CHECK.slice(4)}")`,
            '    [ -n "${FAKE_CHECK_WORDING:-}" ] && { echo "Nothing to do."; exit 0; }',
            '    [ -e "$STATE/fonts" ] && { echo "All system dependencies are installed."; exit 0; }',
            '    echo "Missing system dependencies (2):"; exit 1;;',
            `  "${BROWSER.slice(4)}") [ -n "\${FAKE_BROWSER_FAILS:-}" ] && exit 3;;`,
            `  "${FULL.slice(4)}")`,
            '    [ -n "${FAKE_FULL_FAILS:-}" ] && exit 7',
            '    touch "$STATE/fonts"; printf "fonts-a=1.0\\nfonts-b=2.0\\n" >> "$STATE/dpkg";;',
            'esac',
            'exit 0'
        ].join('\n'),
        'dpkg-query': 'sed "s/^/ii /" "$STATE/dpkg"; echo "rc removed-earlier=9"',
        'dpkg-deb': [
            'name="$(basename "$2")"; rest="${name#*_}"',
            'if [ "$3" = Version ]; then echo "${rest%%_*}"; else echo "${name%%_*}"; fi'
        ].join('\n'),
        'apt-cache': [
            'echo "apt-cache $*" >> "$CALLS"',
            'echo "Package: ${2%%=*}"; echo "SHA256: ${FAKE_INDEX_HASH:-cafe}"'
        ].join('\n'),
        sha256sum: 'if [ $# -gt 0 ]; then echo "cafe  $1"; else cat > /dev/null; echo "cafe  -"; fi',
        'fc-list': 'exit 0'
    };

    let dir;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chromium-step-'));
        for (const name of ['bin', 'state', 'cache', 'archives']) fs.mkdirSync(path.join(dir, name));
        for (const [name, body] of Object.entries(STANDINS)) {
            fs.writeFileSync(path.join(dir, 'bin', name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
        }
        fs.writeFileSync(path.join(dir, 'state', 'dpkg'), 'base-files=1\n');
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    const cached = () => {
        for (const name of ['fonts-a_1.0_all.deb', 'fonts-b_2.0_all.deb']) fs.writeFileSync(path.join(dir, 'cache', name), '');
    };
    const run = (env = {}) => {
        const result = spawnSync('bash', [SCRIPT, path.join(dir, 'cache')], {
            encoding: 'utf8',
            env: {
                PATH: `${path.join(dir, 'bin')}${path.delimiter}${process.env.PATH}`,
                HOME: dir,
                CALLS: path.join(dir, 'calls'),
                STATE: path.join(dir, 'state'),
                GITHUB_OUTPUT: path.join(dir, 'output'),
                PW_APT_ARCHIVES: path.join(dir, 'archives'),
                PW_INSTALL_RETRY_WAIT: '0',
                ...env
            }
        });
        const read = (name) => (fs.existsSync(path.join(dir, name)) ? fs.readFileSync(path.join(dir, name), 'utf8') : '');
        return { ...result, calls: read('calls').split('\n').filter(Boolean), output: read('output') };
    };

    test('with no cache it runs the command the step always ran, then saves what that installed', () => {
        // What apt-get left in its archive folder, plus a file nobody asked for.
        for (const name of ['fonts-a_1.0_all.deb', 'fonts-b_2.0_all.deb', 'other_3.0_all.deb']) {
            fs.writeFileSync(path.join(dir, 'archives', name), '');
        }
        const { status, calls, output } = run();
        expect(status).toBe(0);
        expect(calls).toEqual([FULL]);
        expect(fs.readdirSync(path.join(dir, 'cache')).sort()).toEqual(['fonts-a_1.0_all.deb', 'fonts-b_2.0_all.deb']);
        expect(output).toContain('harvested=true');
        expect(output).toContain('path=full install, no cache');
    });

    test('a package apt did not keep is downloaded again for the cache', () => {
        fs.writeFileSync(path.join(dir, 'archives', 'fonts-a_1.0_all.deb'), '');
        const { status, calls, output } = run();
        expect(status).toBe(0);
        expect(calls).toEqual([FULL, 'apt-get download fonts-b=2.0']);
        expect(fs.readdirSync(path.join(dir, 'cache')).sort()).toEqual(['fonts-a_1.0_all.deb', 'fonts-b_2.0_all.deb']);
        expect(output).toContain('harvested=true');
    });

    test('with a cache it installs from it without downloading, has Playwright confirm, and fetches only the browser', () => {
        cached();
        const { status, calls, output } = run();
        expect(status).toBe(0);
        expect(calls.slice(0, 3)).toEqual(['apt-get update -qq', 'apt-cache show fonts-a=1.0', 'apt-cache show fonts-b=2.0']);
        expect(calls[3]).toMatch(/^apt-get install -y --no-install-recommends --no-download -o Dir::Cache::archives=\S+ fonts-a fonts-b$/);
        expect(calls.slice(4)).toEqual([CHECK, BROWSER]);
        expect(calls).not.toContain(FULL);
        expect(output).toContain('path=system packages from the cache');
        expect(output).not.toContain('harvested');
    });

    test('a stalled mirror during apt-get update does not stop the cached install', () => {
        cached();
        const { status, calls } = run({ FAKE_UPDATE_STALLS: '1' });
        expect(status).toBe(0);
        expect(calls[0]).toBe('apt-get update (killed by timeout)');
        expect(calls.slice(-2)).toEqual([CHECK, BROWSER]);
        expect(calls).not.toContain(FULL);
    });

    test.each([
        ['a cached file is not the one the package index lists', { FAKE_INDEX_HASH: 'beef' }],
        ['apt refuses the cached files', { FAKE_INSTALL_FAILS: '1' }],
        ['Playwright does not say that nothing is missing', { FAKE_CHECK_WORDING: '1' }]
    ])('when %s it falls back to the full install and the step passes', (_name, env) => {
        cached();
        const { status, calls, output } = run(env);
        expect(status).toBe(0);
        expect(calls[calls.length - 1]).toBe(FULL);
        expect(calls).not.toContain(BROWSER);
        if (env.FAKE_INDEX_HASH) expect(calls.some((call) => call.startsWith('apt-get install'))).toBe(false);
        expect(output).toContain('path=full install, cache not usable');
        // The key already exists, so there is nothing to save.
        expect(output).not.toContain('harvested');
    });

    test('when the browser download fails after the cached install, the full install runs', () => {
        cached();
        const { status, calls } = run({ FAKE_BROWSER_FAILS: '1' });
        expect(status).toBe(0);
        expect(calls.slice(-3)).toEqual([CHECK, BROWSER, FULL]);
    });

    test('a failing full install is tried once more, then fails the step as it did before', () => {
        const { status, calls } = run({ FAKE_FULL_FAILS: '1' });
        expect(status).toBe(7);
        expect(calls).toEqual([FULL, FULL]);
    });

    test('the workflow runs the script, and a cache step cannot fail a shard', () => {
        const { jobs } = require('yaml').parse(
            fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8')
        );
        const steps = jobs['test-e2e'].steps;
        const byName = (name) => steps.find((step) => step.name === name);
        expect(byName('Install Playwright Chromium').run).toBe('bash scripts/ci-playwright-chromium.sh "$HOME/.cache/playwright-debs"');
        const restore = byName('Restore Chromium system packages');
        const save = byName('Save Chromium system packages');
        for (const step of [restore, save]) {
            expect(step['continue-on-error']).toBe(true);
            expect(step.with.path).toBe('~/.cache/playwright-debs');
            expect(step.with.key).toBe('${{ steps.debs-key.outputs.key }}');
        }
        expect(restore.with['restore-keys']).toBeUndefined();
        expect(steps.indexOf(restore)).toBeLessThan(steps.indexOf(byName('Install Playwright Chromium')));
        expect(steps.indexOf(save)).toBeGreaterThan(steps.indexOf(byName('Install Playwright Chromium')));
    });
});

describe('live credential inventory', () => {
    const env = {
        OPENAI_API_KEY: ' sk-test ',
        ANTHROPIC_API_KEY: '',
        GEMINI_API_KEY: '   ',
        PERPLEXITY_API_KEY: 'pplx-test',
        UNRELATED: 'ignore-me'
    };

    test('treats empty and whitespace-only values as absent', () => {
        expect(isCredentialPresent('OPENAI_API_KEY', env)).toBe(true);
        expect(isCredentialPresent('ANTHROPIC_API_KEY', env)).toBe(false);
        expect(isCredentialPresent('GEMINI_API_KEY', env)).toBe(false);
        expect(isCredentialPresent('ELEVENLABS_API_KEY', env)).toBe(false);
        expect(skipReasonFor('openai', env)).toBeNull();
        expect(skipReasonFor('anthropic', env)).toBe('ANTHROPIC_API_KEY is not set');
        expect(skipReasonFor('elevenlabs', env)).toBe('ELEVENLABS_API_KEY is not set');
        expect(() => skipReasonFor('nope', env)).toThrow(/Unknown live provider/);
    });

    test('inventory never includes secret values', () => {
        const rows = inventory(env);
        const blob = JSON.stringify(rows) + formatInventory(rows);
        expect(blob).not.toMatch(/sk-test/);
        expect(blob).not.toMatch(/pplx-test/);
        expect(blob).toMatch(/OPENAI_API_KEY: present/);
        expect(blob).toMatch(/ANTHROPIC_API_KEY: absent/);
        expect(rows.find((row) => row.id === 'openai').present).toBe(true);
        expect(rows.find((row) => row.id === 'gemini').present).toBe(false);
        expect(rows.find((row) => row.id === 'perplexity').present).toBe(true);
    });
});
