/**
 * PostgreSQL in Docker, managed by the installer (documentation/docker_postgres.md):
 * the chooser in the setup wizard offers the option only when the Docker check
 * passes, shows the form and the plan preview, and the Host room's Database
 * page shows the owned instance.
 *
 * No Docker daemon is needed: every journey runs against the fake `docker`
 * executable (tests/helpers/fakeDocker.js) first on the manager's PATH.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');
const { createManagerProcess, bootstrapOperator, tempDir } = require('./hostHarness');
const { createSetupInstallation } = require('./setupHarness');
const fakeDocker = require('../tests/helpers/fakeDocker');

const ARTIFACTS = process.env.GOOBSTER_E2E_ARTIFACTS || '/opt/cursor/artifacts';
const PASSWORD = 'plain-walnut-ladder-kettle-7';
const LOGIN = 'owner-one';
const MANAGED_LATER = 'Available in a later version of this installer';

test.setTimeout(180_000);

const BASE = Number(process.env.GOOBSTER_E2E_PORT || 4173);
const PORTAL_PORT = BASE + 140;
const MANAGER_PORT = BASE + 141;
const OPERATOR = '99000000000000391';

const installations = [];
const fakes = [];

async function installation(mode) {
    // The manager runs in this process, so the fake docker has to be on this process's own PATH. The fake
    // pg_dump beside it keeps the backup-tools check independent of the client this host happens to have.
    const fake = fakeDocker.create({ mode, pgDump: '17.4' }).install();
    fakes.push(fake);
    const h = await createSetupInstallation();
    installations.push(h);
    return { h, fake };
}

test.afterEach(async ({ page }, testInfo) => {
    if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach('page-text', { body: await page.locator('main').innerText({ timeout: 3000 }).catch(() => '(no page)'), contentType: 'text/plain' }).catch(() => {});
    }
    while (installations.length) await installations.pop().destroy();
    while (fakes.length) fakes.pop().restore();
});

async function screenshot(page, name) {
    try {
        fs.mkdirSync(ARTIFACTS, { recursive: true });
        await page.screenshot({ path: path.join(ARTIFACTS, `339-${name}.png`), fullPage: true });
    } catch { /* artifacts are optional */ }
}

async function next(page, name = 'Continue') {
    const button = page.getByTestId('nav-next').filter({ hasText: name });
    await expect(button).toBeEnabled();
    await button.focus();
    await page.keyboard.press('Enter');
}

async function claim(page, h) {
    await page.goto(`${h.url}/manager/`);
    await page.getByLabel('Setup credential').fill(h.setupCredential());
    await page.getByLabel('What should this installation be called?').fill('My Goobster');
    await page.getByLabel('Setup credential').press('Enter');
    await expect(page.getByRole('heading', { name: 'Where should Goobster go?' })).toBeVisible();
}

async function toDatabaseStep(page) {
    await next(page);
    await expect(page.getByTestId('step-features')).toBeVisible();
    await next(page);
    await expect(page.getByRole('heading', { name: 'Connect what you use' })).toBeVisible();
    await page.getByTestId('owner-login').fill(LOGIN);
    await page.getByTestId('owner-password').fill(PASSWORD);
    await page.getByTestId('owner-repeat').fill(PASSWORD);
    await next(page);
    await expect(page.getByTestId('step-database')).toBeVisible();
}

test.describe('the Docker choice in the database step', () => {
    test('is disabled, with the reason and what to do, when the daemon does not answer', async ({ page }) => {
        const { h } = await installation('unreachable');
        await claim(page, h);
        await toDatabaseStep(page);

        await expect(page.getByTestId('engine-postgres-docker')).toBeDisabled();
        await expect(page.getByTestId('docker-availability')).toContainText('Not available');
        await expect(page.getByTestId('engine-postgres-native')).toBeDisabled();
        await expect(page.getByTestId('postgres-later')).toHaveText(MANAGED_LATER);
        await expect(page.getByTestId('engine-sqlite')).toBeChecked();
        await expect(page.getByTestId('docker-option')).toHaveCount(0);
        await screenshot(page, 'docker-unreachable');
    });

    test('is enabled when the daemon answers, with the form, the names it will create and a way on', async ({ page }) => {
        const { h, fake } = await installation('ok');
        await claim(page, h);
        await toDatabaseStep(page);

        const radio = page.getByTestId('engine-postgres-docker');
        await expect(radio).toBeEnabled();
        await expect(page.getByTestId('docker-availability')).toContainText('Docker answered');
        await expect(page.getByTestId('engine-postgres-native')).toBeDisabled();
        await expect(page.getByTestId('postgres-later')).toHaveText(MANAGED_LATER);

        await radio.check();
        await expect(page.getByTestId('docker-daemon-card')).toHaveAttribute('data-state', 'ready');
        const form = page.getByTestId('docker-form');
        await expect(form).toBeVisible();
        await expect(page.getByTestId('docker-port')).toHaveValue('5432');
        await expect(page.getByTestId('docker-bind')).toHaveValue('127.0.0.1');
        await expect(page.getByTestId('docker-storage-volume')).toBeChecked();
        await expect(page.getByTestId('docker-image')).toContainText('pgvector/pgvector:pg17');

        const preview = page.getByTestId('docker-plan-preview');
        await expect(preview).toBeVisible();
        await expect(page.getByTestId('docker-name-container')).toHaveText(/^goobster-pg-/);
        await expect(page.getByTestId('docker-name-volume')).toHaveText(/^goobster-pgdata-/);
        await expect(page.getByTestId('docker-name-network')).toHaveText(/^goobster-/);
        await expect(preview).toContainText('Generated for you and never shown');
        await expect(preview).toContainText('Keeps the data unless you ask to remove it');
        await screenshot(page, 'docker-form');

        // Choosing a folder instead of the volume changes the preview; a relative path holds Continue back.
        const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-e2e-pgdata-'));
        await page.getByTestId('docker-storage-path').check();
        await page.getByTestId('docker-path').fill('relative/data');
        await expect(page.getByTestId('nav-next')).toBeDisabled();
        await page.getByTestId('docker-path').fill(folder);
        await expect(preview).toContainText(folder);
        await expect(preview).toContainText('never deleted by the installer');
        await expect(page.getByTestId('docker-free')).toContainText('free there');
        await page.getByTestId('docker-storage-volume').check();

        await expect(page.getByTestId('docker-next-hint')).toContainText('Docker is ready');
        await next(page);
        await expect(page.getByTestId('step-defaults')).toBeVisible();

        // Looking must not have created anything on the daemon.
        expect(fake.mutations()).toEqual([]);
        await screenshot(page, 'docker-after-continue');
    });

    test('switching back to SQLite leaves the Docker form behind', async ({ page }) => {
        const { h } = await installation('ok');
        await claim(page, h);
        await toDatabaseStep(page);
        await page.getByTestId('engine-postgres-docker').check();
        await expect(page.getByTestId('docker-form')).toBeVisible();
        await page.getByTestId('engine-sqlite').check();
        await expect(page.getByTestId('docker-option')).toHaveCount(0);
        await expect(page.getByTestId('data-root')).toBeVisible();
        await expect(page.getByTestId('nav-next')).toBeEnabled();
    });
});

test.describe('the Database page of the Host room, with Docker', () => {
    test.describe.configure({ mode: 'serial' });
    const dir = tempDir('goobster-e2e-docker-host-');
    const fake = fakeDocker.create({ mode: 'ok', pgDump: '17.4' });
    const manager = createManagerProcess({ dir, port: MANAGER_PORT, env: fake.env() });
    const { createSecondServer } = require('./helpers');
    const portal = createSecondServer({ port: PORTAL_PORT, dataDir: dir });
    test.use({ baseURL: portal.url });

    test.beforeAll(async () => {
        test.setTimeout(180_000);
        await manager.start();
        await manager.claim();
        bootstrapOperator({ dir, principalId: OPERATOR });
        await portal.start({ env: { GOOBSTER_MANAGER_URL: manager.url, GOOBSTER_CONFIG_PATH: path.join(dir, 'config.json') } });
    });
    test.afterAll(async () => {
        await portal.stop();
        await manager.stop();
        portal.cleanup();
        fake.restore();
    });

    test('shows that the installer runs no PostgreSQL yet, and offers to set one up', async ({ page }) => {
        await login(page, { userId: OPERATOR, name: 'Host operator' });
        await page.goto('/app/host/database');
        await expect(page.getByTestId('database-page')).toBeVisible();
        const card = page.getByTestId('docker-instance');
        await expect(card).toBeVisible();
        await expect(page.getByTestId('docker-none')).toBeVisible();
        await screenshot(page, 'host-docker-card');
    });
});
