const fs = require('node:fs');
const path = require('node:path');
const {
    GROUPS,
    auditTestGroups,
    groupById,
    listedFiles,
    resolveEngine,
    toRepoPosix
} = require('./ciGroups');
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
