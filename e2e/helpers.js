const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { expect } = require('@playwright/test');
const { OWNER, OWNER_NAME } = require('./constants');

/**
 * Mint a webapp.devMode session through the login form (the real React
 * wiring, not a cookie inject). The heading on Home includes the display name.
 *
 * Tutorial auto-start defaults off for e2e so the offer panel does not
 * intercept clicks in unrelated journeys. Suites that exercise offers
 * (tutorials.spec.js) re-enable via /e2e/fixtures/tutorial-progress or
 * the Settings toggle.
 */
async function login(page, { userId = OWNER, name = OWNER_NAME, autoStartTutorials = false } = {}) {
    // Seed prefs before the session mounts TutorialProvider so the first
    // /api/app/tutorials fetch already has the intended autoStart.
    const seeded = await page.request.post('/e2e/fixtures/tutorial-progress', {
        data: { userId, autoStart: Boolean(autoStartTutorials), rows: [] }
    });
    expect(seeded.ok()).toBe(true);

    await page.goto('/app/');
    await expect(page.getByText('Dev mode — mint a local identity')).toBeVisible();
    await page.getByPlaceholder('Principal id (digits or usr_…)').fill(userId);
    await page.getByPlaceholder('Display name').fill(name);
    await page.getByRole('button', { name: 'Enter' }).click();
    await expect(page.getByRole('heading', { name: new RegExp(name) })).toBeVisible({
        timeout: 15_000
    });

    // Belt-and-suspenders: dismiss a racey offer if one still painted.
    const dismiss = page.locator('[data-tour="tutorial-offer-dismiss"]');
    if (await dismiss.isVisible().catch(() => false)) {
        await dismiss.click();
        await expect(page.locator('[data-tour="tutorial-offer"]')).toHaveCount(0);
    }
}

async function openRoom(page, label) {
    await page.getByRole('navigation', { name: 'Rooms' }).getByRole('link', { name: label }).click();
}

const SERVER_ENTRY = path.join(__dirname, 'server.js');

/**
 * A second headless portal in its own process, data dir and port, so a spec
 * can change installation state (a features.json, a GOOBSTER_FEATURE_<ID>
 * override) without touching the shared server Playwright started.
 * `restart` reuses the data dir and database (GOOBSTER_E2E_KEEP_DB=1 skips
 * the fixture seed), which is how a spec proves a re-enabled feature gets its
 * saved data back.
 */
function createSecondServer({ port, dataDir = null } = {}) {
    const dir = dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-e2e-second-'));
    let child = null;
    let started = false;
    let log = '';

    async function waitForHealth() {
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline) {
            if (child.exitCode !== null) throw new Error(`second e2e server exited early:\n${log.slice(-2000)}`);
            try {
                const res = await fetch(`http://127.0.0.1:${port}/health`);
                if (res.ok) return;
            } catch { /* not listening yet */ }
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
        throw new Error(`second e2e server did not become healthy:\n${log.slice(-2000)}`);
    }

    async function start({ features = null, env = {} } = {}) {
        const stateFile = path.join(dir, 'features.json');
        if (features) {
            const entries = {};
            for (const [id, value] of Object.entries(features)) {
                entries[id] = value && typeof value === 'object' ? value : { installed: true, active: value };
            }
            fs.writeFileSync(stateFile, JSON.stringify({
                version: 1, revision: 1, updatedAt: '2026-10-06 21:14:02', origin: 'operator', features: entries
            }));
        } else {
            fs.rmSync(stateFile, { force: true });
        }
        log = '';
        child = spawn(process.execPath, [SERVER_ENTRY], {
            env: {
                ...process.env,
                GOOBSTER_E2E_PORT: String(port),
                GOOBSTER_DATA_DIR: dir,
                GOOBSTER_DB_PATH: path.join(dir, 'goobster-e2e.sqlite'),
                ...(started ? { GOOBSTER_E2E_KEEP_DB: '1' } : {}),
                ...env
            },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        child.stdout.on('data', (chunk) => { log += chunk; });
        child.stderr.on('data', (chunk) => { log += chunk; });
        started = true;
        await waitForHealth();
    }

    async function stop() {
        if (!child || child.exitCode !== null) return;
        const exited = new Promise((resolve) => child.once('exit', resolve));
        child.kill('SIGTERM');
        const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
        await exited;
        clearTimeout(timer);
    }

    async function restart(options) {
        await stop();
        await start(options);
    }

    return {
        port,
        dir,
        url: `http://127.0.0.1:${port}`,
        start,
        stop,
        restart,
        cleanup() { fs.rmSync(dir, { recursive: true, force: true }); }
    };
}

module.exports = { login, openRoom, createSecondServer };
