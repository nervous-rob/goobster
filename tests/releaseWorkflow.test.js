/**
 * The release workflow's structure (#341, documentation/release.md): `.github/workflows/release.yml` is
 * parsed, not run. It must never run for a pull request, must hold a write token in the publish job only,
 * must reference secrets only through the step `env` of jobs that declare the `release` environment, must
 * delete the key material it creates, and must call only release-index commands and scripts that exist.
 * What the signing steps do on a Windows or macOS runner with a real certificate is not testable here.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const yaml = require('js-yaml');

const cli = require('../scripts/release-index');

const REPO_ROOT = path.resolve(__dirname, '..');
const WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'release.yml');
const workflow = yaml.load(fs.readFileSync(WORKFLOW, 'utf8'));
const text = fs.readFileSync(WORKFLOW, 'utf8');

const ALLOWED_SECRETS = new Set([
    'GOOBSTER_RELEASE_SIGNING_KEY_PEM',
    'WINDOWS_SIGNING_CERT_PFX_BASE64',
    'WINDOWS_SIGNING_CERT_PASSWORD',
    'APPLE_DEVELOPER_ID_APPLICATION_CERT_P12_BASE64',
    'APPLE_DEVELOPER_ID_INSTALLER_CERT_P12_BASE64',
    'APPLE_CERT_PASSWORD',
    'APPLE_TEAM_ID',
    'APPLE_NOTARY_KEY_ID',
    'APPLE_NOTARY_ISSUER_ID',
    'APPLE_NOTARY_KEY_P8_BASE64'
]);

const jobs = Object.entries(workflow.jobs);
const steps = jobs.flatMap(([jobId, job]) => (job.steps || []).map((step, index) => ({ jobId, index, step })));

describe('triggers and permissions', () => {
    test('runs on a v* tag push and a manual dispatch, and on nothing else', () => {
        const triggers = workflow.on || workflow[true];
        expect(Object.keys(triggers).sort()).toEqual(['push', 'workflow_dispatch']);
        expect(triggers.push).toEqual({ tags: ['v*'] });
    });

    test('never names a pull request event anywhere in the file', () => {
        expect(text).not.toMatch(/pull_request/);
        expect(text).not.toMatch(/github\.event\.pull_request/);
    });

    test('the default token is read-only and only the publish job can write', () => {
        expect(workflow.permissions).toEqual({ contents: 'read' });
        const writers = jobs.filter(([, job]) => job.permissions && Object.values(job.permissions).includes('write')).map(([id]) => id);
        expect(writers).toEqual(['publish']);
        expect(workflow.jobs.publish.permissions).toEqual({ contents: 'write' });
    });

    test('does not cancel a release in progress', () => {
        expect(workflow.concurrency['cancel-in-progress']).toBe(false);
    });
});

describe('secrets', () => {
    const referenced = [...text.matchAll(/secrets\.([A-Z0-9_]+)/g)].map(match => match[1]);

    test('only the documented secret names are referenced', () => {
        expect(referenced.length).toBeGreaterThan(0);
        for (const name of referenced) expect(ALLOWED_SECRETS).toContain(name);
    });

    test('no run script interpolates a secret or the github token directly', () => {
        for (const { step } of steps) {
            if (typeof step.run === 'string') {
                expect(step.run).not.toMatch(/\$\{\{\s*secrets\./);
                expect(step.run).not.toMatch(/\$\{\{\s*github\.token/);
            }
        }
    });

    test('every job that can read a secret declares the release environment', () => {
        for (const [jobId, job] of jobs) {
            if (JSON.stringify(job).includes('secrets.')) expect({ jobId, environment: job.environment }).toEqual({ jobId, environment: 'release' });
        }
    });

    test('a secret reaches a step through its env only, and the private signing key only through the gated expression', () => {
        const count = (value) => (JSON.stringify(value || '').match(/secrets\./g) || []).length;
        for (const { step } of steps) expect(count(step)).toBe(count(step.env));
        for (const match of text.matchAll(/GOOBSTER_RELEASE_SIGNING_KEY_PEM: (.*)/g)) {
            expect(match[1]).toContain("github.ref_type == 'tag' || github.ref_protected");
        }
    });

    test('nothing prints the environment, enables shell tracing or echoes key material', () => {
        for (const { step } of steps) {
            const run = typeof step.run === 'string' ? step.run : '';
            expect(run).not.toMatch(/\bprintenv\b/);
            expect(run).not.toMatch(/(^|[\s;&|])set\s+-[a-z]*x/);
            expect(run).not.toMatch(/^\s*env\s*$/m);
            expect(run).not.toMatch(/Get-ChildItem\s+env:/i);
            expect(run).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
            expect(run).not.toMatch(/echo[^\n]*(SIGNING_KEY|PASSWORD|P8_BASE64|P12_BASE64|PFX_BASE64)/);
        }
    });
});

describe('key material lifecycle', () => {
    test('each job that writes key material has an always() step that deletes it', () => {
        for (const [jobId, job] of jobs) {
            const writes = (job.steps || []).some(step => typeof step.run === 'string' && /materialize-key|authenticode\.pfx|installer\.p12/.test(step.run));
            if (!writes) continue;
            const cleanup = (job.steps || []).filter(step => /always\(\)/.test(String(step.if || '')) && typeof step.run === 'string' && /rm -rf "\$KEYDIR"|Remove-Item -Recurse -Force \$env:KEYDIR/.test(step.run));
            expect({ jobId, cleanups: cleanup.length > 0 }).toEqual({ jobId, cleanups: true });
        }
    });

    test('the macOS keychain and the Windows store entry are removed too', () => {
        expect(text).toContain('security delete-keychain');
        expect(text).toMatch(/Remove-Item "Cert:\\CurrentUser\\My\\/);
    });

    test('a derived password is masked before it is used', () => {
        expect(text).toMatch(/::add-mask::\$keychain_password/);
    });
});

describe('the build and publish contract', () => {
    test('the build matrix is planned from the plan job and one target failing does not cancel the others', () => {
        expect(workflow.jobs.build.strategy['fail-fast']).toBe(false);
        expect(workflow.jobs.build.strategy.matrix).toContain('needs.plan.outputs.matrix');
        const matrixStep = workflow.jobs.plan.steps.find(step => step.id === 'matrix');
        for (const target of ['linux-x64', 'linux-arm64', 'win32-x64', 'darwin-x64', 'darwin-arm64']) expect(matrixStep.run).toContain(`"target":"${target}"`);
        expect(matrixStep.run).toContain('macos-15-intel');
    });

    test('publish runs after a failed target and does not run when cancelled', () => {
        expect(workflow.jobs.publish.needs).toEqual(['plan', 'build']);
        expect(workflow.jobs.publish.if).toContain('!cancelled()');
    });

    test('the plan job stops a stable run without an active key before anything is built', () => {
        expect(workflow.jobs.build.needs).toBe('plan');
        const planStep = workflow.jobs.plan.steps.find(step => step.id === 'plan');
        expect(planStep.run).toContain('release-index.js plan');
        expect(planStep.run).not.toMatch(/\|\|\s*true/);
    });

    test('a stable release withdraws targets that are not fully signed, and the index is verified before publishing', () => {
        const build = workflow.jobs.publish.steps.find(step => /release-index\.js build/.test(step.run || ''));
        expect(build.run).toContain('--drop-unsigned-targets');
        const order = workflow.jobs.publish.steps.map(step => step.run || step.uses || '');
        const indexOf = (pattern) => order.findIndex(entry => pattern.test(entry));
        expect(indexOf(/release-index\.js build/)).toBeLessThan(indexOf(/release-index\.js sign/));
        expect(indexOf(/release-index\.js sign/)).toBeLessThan(indexOf(/release-index\.js verify/));
        expect(indexOf(/release-index\.js verify/)).toBeLessThan(indexOf(/release-verify-artifacts/));
        expect(indexOf(/release-verify-artifacts/)).toBeLessThan(indexOf(/gh release/));
    });

    test('the unsigned development path is verified as development and refused as production', () => {
        const step = workflow.jobs.publish.steps.find(item => /refused under the production policy/.test(item.run || ''));
        expect(step).toBeDefined();
        expect(step.if).toContain("!= 'release'");
    });

    test('a dev-signed payload key is never offered to the bootstrapper builds as trusted', () => {
        const devStep = workflow.jobs.build.steps.find(step => /--dev-sign/.test(step.run || ''));
        expect(devStep.run).toContain('VERIFY_KEY=');
        expect(devStep.run).not.toContain('PUBKEY=');
    });

    test('every release-index command and script the workflow names exists', () => {
        for (const match of text.matchAll(/release-index\.js (\S+)/g)) {
            if (match[1].startsWith('-')) continue;
            expect(Object.keys(cli.COMMANDS)).toContain(match[1]);
        }
        for (const match of text.matchAll(/scripts\/[A-Za-z0-9/_-]+\.js(?![a-z])/g)) {
            expect(fs.existsSync(path.join(REPO_ROOT, match[0]))).toBe(true);
        }
    });

    test('release-keys.json carries no active key', () => {
        const list = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'release-keys.json'), 'utf8'));
        expect(list.keys.filter(key => key.status === 'active')).toEqual([]);
    });
});

describe('the shell scripts are syntactically valid', () => {
    const bash = childProcess.spawnSync('bash', ['--version'], { encoding: 'utf8' });
    const available = bash.status === 0;

    test.each(steps
        .filter(({ jobId, step }) => typeof step.run === 'string' && (step.shell || workflow.jobs[jobId].defaults?.run?.shell || 'bash') === 'bash')
        .map(({ jobId, index, step }) => [`${jobId}[${index}] ${step.name || step.id || ''}`.trim(), step.run]))('%s', (_label, script) => {
        if (!available) return;
        const file = path.join(os.tmpdir(), `goobster-release-step-${process.pid}-${Math.random().toString(16).slice(2)}.sh`);
        fs.writeFileSync(file, script);
        try {
            const result = childProcess.spawnSync('bash', ['-n', file], { encoding: 'utf8' });
            expect(result.stderr).toBe('');
            expect(result.status).toBe(0);
        } finally {
            fs.rmSync(file, { force: true });
        }
    });
});
