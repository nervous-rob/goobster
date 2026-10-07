const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MANAGER_ENTRY = path.join(ROOT, 'apps', 'manager', 'index.js');
const IDENTITY_REPORT = path.join(ROOT, 'scripts', 'identity-report.js');

/** Provider credentials the host running the tests may export; a journey never needs or wants them. */
const PROVIDER_ENV = [
    'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'PERPLEXITY_API_KEY', 'ELEVENLABS_API_KEY',
    'GITHUB_TOKEN', 'GITHUB_WEBHOOK_SECRET', 'CURSOR_API_KEY', 'CURSOR_WEBHOOK_SECRET', 'SPOTIFY_CLIENT_SECRET', 'RESEND_API_KEY', 'GOOBSTER_SMTP_URL',
    'GOOBSTER_SMTP_PASS', 'DISCORD_CLIENT_SECRET', 'GOOBSTER_VAPID_PRIVATE_KEY'
];

function cleanEnv(extra = {}) {
    const env = { ...process.env };
    for (const name of PROVIDER_ENV) delete env[name];
    for (const name of Object.keys(env)) {
        if (name.startsWith('GOOBSTER_MANAGER_') || name.startsWith('GOOBSTER_FEATURE_')) delete env[name];
    }
    return { ...env, ...extra };
}

async function waitFor(check, { timeout = 60_000, interval = 250, what = 'the condition' } = {}) {
    const deadline = Date.now() + timeout;
    let last = null;
    while (Date.now() < deadline) {
        try {
            const value = await check();
            if (value) return value;
        } catch (error) {
            last = error;
        }
        await new Promise((resolve) => setTimeout(resolve, interval));
    }
    throw new Error(`Timed out waiting for ${what}${last ? `: ${last.message}` : ''}`);
}

async function getJson(url, init) {
    const response = await fetch(url, init);
    return { status: response.status, json: await response.json().catch(() => null) };
}

/**
 * A real installation manager in its own process (documentation/manager.md),
 * with its own state directory, claimed through the bootstrap credential the
 * way an operator does it. `supervise` also runs the standalone api worker
 * (documentation/manager_lifecycle.md), so the restart journey is real.
 */
function createManagerProcess({ dir, port, env = {}, supervise = false }) {
    const url = `http://127.0.0.1:${port}`;
    let child = null;
    let log = '';

    async function start() {
        fs.mkdirSync(dir, { recursive: true });
        const configPath = path.join(dir, 'config.json');
        if (!fs.existsSync(configPath)) {
            fs.writeFileSync(configPath, JSON.stringify({ webapp: { enabled: true, devMode: true } }));
        }
        log = '';
        child = spawn(process.execPath, [MANAGER_ENTRY, ...(supervise ? ['--supervise'] : [])], {
            cwd: ROOT,
            env: cleanEnv({
                GOOBSTER_DATA_DIR: dir,
                GOOBSTER_DB_PATH: path.join(dir, 'goobster-e2e.sqlite'),
                GOOBSTER_CONFIG_PATH: configPath,
                GOOBSTER_MANAGER_PORT: String(port),
                GOOBSTER_MANAGER_HOST: '127.0.0.1',
                ...env
            }),
            stdio: ['ignore', 'pipe', 'pipe']
        });
        child.stdout.on('data', (chunk) => { log += chunk; });
        child.stderr.on('data', (chunk) => { log += chunk; });
        await waitFor(async () => {
            if (child.exitCode !== null) throw new Error(`the manager exited:\n${log.slice(-2000)}`);
            const { status } = await getJson(`${url}/manager/api/status`);
            return status === 200;
        }, { what: 'the manager to listen' });
    }

    async function claim(label = 'E2E host') {
        const credential = fs.readFileSync(path.join(dir, 'manager', 'bootstrap-credential'), 'utf8').trim();
        const { status, json } = await getJson(`${url}/manager/api/claim`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ credential, label })
        });
        if (status !== 200) throw new Error(`claim failed (${status}): ${JSON.stringify(json)}`);
    }

    async function stop() {
        if (!child || child.exitCode !== null) return;
        const exited = new Promise((resolve) => child.once('exit', resolve));
        child.kill('SIGTERM');
        const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
        await exited;
        clearTimeout(timer);
    }

    return {
        url,
        dir,
        get pid() { return child?.pid ?? null; },
        get log() { return log; },
        start,
        claim,
        stop
    };
}

/** Grants the operator role through the documented bootstrap command, against the same database the worker uses. */
function bootstrapOperator({ dir, principalId }) {
    const result = spawnSync(process.execPath, [IDENTITY_REPORT, '--bootstrap-operators', principalId], {
        cwd: ROOT,
        env: cleanEnv({
            GOOBSTER_DATA_DIR: dir,
            GOOBSTER_DB_PATH: path.join(dir, 'goobster-e2e.sqlite'),
            GOOBSTER_CONFIG_PATH: path.join(dir, 'config.json')
        }),
        encoding: 'utf8'
    });
    if (result.status !== 0 || !/granted 1|promoted 1|unchanged 1/.test(result.stdout)) {
        throw new Error(`bootstrap-operators failed:\n${result.stdout}\n${result.stderr}`);
    }
}

function tempDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

module.exports = { createManagerProcess, bootstrapOperator, waitFor, getJson, tempDir };
