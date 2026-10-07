/**
 * PostgreSQL installed natively on this machine, managed by the installer
 * (documentation/native_postgres.md): the chooser in the setup wizard offers the
 * option only when the host check passes, shows the form and the preview, and the
 * Database page of the maintenance journeys sets the cluster up, starts it, stops
 * it and shows what it owns.
 *
 * Nothing real is touched. The manager runs in this process, so a fake machine
 * (tests/helpers/fakeNative.js: apt-get, pg_createcluster, psql, ... on a private
 * PATH, and the real privileged helper run as an ordinary user inside a throwaway
 * directory) stands in for the distribution. The VM's own PostgreSQL cluster is
 * never read for writing and never started, stopped or changed.
 */
const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { createSetupInstallation } = require('./setupHarness');
const fakeNative = require('../tests/helpers/fakeNative');
const privileged = require('../apps/manager/privileged');
const distroLib = require('../packages/core/db/native/distro');
const { expectedSchema } = require('../packages/core/db/migration/schemaModel');

const ARTIFACTS = process.env.GOOBSTER_E2E_ARTIFACTS || '/opt/cursor/artifacts';
const PASSWORD = 'plain-walnut-ladder-kettle-7';
const LOGIN = 'owner-one';

test.setTimeout(180_000);

const installations = [];
const fakes = [];

/** The schema child process and the probe, scripted, so no server is needed. */
function scriptedDatabase() {
    const tables = Object.entries(expectedSchema().tables).map(([name, model]) => ({ name, columns: model.columns.map((col) => col.name) }));
    const inspected = {
        reachable: true, user: 'goobster', isSuperuser: false, serverVersion: 170004, serverVersionText: '17.4', schema: 'public', schemaExists: true,
        canConnect: true, canCreateInDatabase: false, canCreateInSchema: true, canCreateDatabase: false, canCreateRole: false, tables, otherRelations: [], relationCount: 0,
        extensions: { citext: { available: true, installed: true, trusted: true }, vector: { available: true, installed: true, trusted: false } },
        tls: { encrypted: false, protocol: null }, freeBytes: null
    };
    return {
        probeDeps: { createClient: () => ({}), inspect: async () => inspected },
        runProvisioning: async () => { throw new Error('the native option never provisions through the #338 library'); },
        initDatabase: async () => ({ engine: 'postgres', tables: tables.length }),
        runChild: async () => ({ counts: {} }),
        validate: async () => ({ workers: [{ name: 'api', healthy: true }], layout: 'standalone' })
    };
}

async function installation({ distro = 'debian', machine = {}, elevation = null, nativeDeps = {} } = {}) {
    const fake = fakeNative.create({ distro, ...machine }).install();
    fakes.push(fake);
    const h = await createSetupInstallation({
        installDeps: { privileged, privilegedOptions: fake.privilegedOptions(elevation ? { elevation } : {}) },
        nativeDeps: { ...fake.nativeDeps(nativeDeps), databaseDeps: scriptedDatabase() }
    });
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
        await page.screenshot({ path: path.join(ARTIFACTS, `340-${name}.png`), fullPage: true });
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

async function openDatabase(page, h, p, context) {
    await context.addCookies([{ name: p.session.name, value: p.session.value, domain: '127.0.0.1', path: '/manager', httpOnly: true, sameSite: 'Strict' }]);
    await page.goto(`${h.url}/manager/`);
    await expect(page.getByTestId('step-maintain')).toBeVisible();
    await page.getByTestId('action-database').click();
    await expect(page.getByTestId('step-database-status')).toBeVisible();
}

test.describe('the native choice in the database step', () => {
    test('is disabled, with the reason, on a distribution the installer does not support', async ({ page }) => {
        const unsupported = distroLib.classify({ release: distroLib.parseOsRelease('ID=alpine\nVERSION_ID=3.20\nPRETTY_NAME="Alpine Linux"\n'), arch: 'x64' });
        const { h, fake } = await installation({ nativeDeps: { distro: { ...unsupported, remedy: unsupported.reason ? distroLib.REASONS[unsupported.reason] : null } } });
        await claim(page, h);
        await toDatabaseStep(page);

        await expect(page.getByTestId('engine-postgres-native')).toBeDisabled();
        await expect(page.getByTestId('native-availability')).toContainText('Not available');
        await expect(page.getByTestId('native-option')).toHaveCount(0);
        await expect(page.getByTestId('engine-sqlite')).toBeChecked();
        expect(fake.mutations()).toEqual([]);
        await screenshot(page, 'wizard-unsupported');
    });

    test('is disabled, with the remedy, when no administrator rights can be obtained', async ({ page }) => {
        const { h } = await installation({ elevation: { kind: 'none', reason: 'NO_ELEVATION' } });
        await claim(page, h);
        await toDatabaseStep(page);

        await expect(page.getByTestId('engine-postgres-native')).toBeDisabled();
        await expect(page.getByTestId('native-availability')).toContainText('administrator rights');
        await expect(page.getByTestId('native-availability')).toContainText('passwordless sudo');
    });

    test('is enabled on a supported machine, shows the other cluster it will not touch, and holds Continue back until the approvals are given', async ({ page }) => {
        const { h, fake } = await installation();
        const foreign = fake.seedForeignCluster({ name: 'main', port: 5432 });
        const before = fake.snapshot(foreign.files);
        await claim(page, h);
        await toDatabaseStep(page);

        const radio = page.getByTestId('engine-postgres-native');
        await expect(radio).toBeEnabled();
        await expect(page.getByTestId('native-availability')).toContainText('This machine can run it');
        await radio.check();

        const card = page.getByTestId('native-host-card');
        await expect(card).toHaveAttribute('data-state', 'ready');
        await expect(page.getByTestId('native-distro')).toContainText('Debian');
        await expect(page.getByTestId('native-clusters')).toContainText('main');
        await expect(page.getByTestId('native-clusters')).toContainText('left exactly as they are');
        await expect(page.getByTestId('native-packages')).toContainText('not installed yet');
        await expect(page.getByTestId('native-port')).toHaveValue('5432');
        await expect(page.getByTestId('native-bind')).toHaveValue('127.0.0.1');
        await expect(page.getByTestId('native-port-taken')).toContainText('main');
        await expect(page.getByTestId('native-name-cluster')).toHaveText('goobster');
        await expect(page.getByTestId('native-plan-preview')).toContainText('Generated for you and never shown');
        await expect(page.getByTestId('native-plan-preview')).toContainText('Not touched');
        await screenshot(page, 'wizard-native-form');

        await expect(page.getByTestId('nav-next')).toBeDisabled();
        await page.getByTestId('native-install-packages').check();
        await page.getByTestId('native-port').fill('80');
        await expect(page.getByTestId('nav-next')).toBeEnabled();
        await page.getByTestId('nav-next').click();
        await expect(page.getByTestId('native-port-problem')).toBeVisible();
        await page.getByTestId('native-port').fill('5433');
        await page.getByTestId('native-bind').fill('0.0.0.0');
        await expect(page.getByTestId('native-lan')).toBeVisible();
        await page.getByTestId('native-bind').fill('127.0.0.1');
        await page.getByTestId('native-path').fill('relative/data');
        await page.getByTestId('nav-next').click();
        await expect(page.getByTestId('native-path-problem')).toBeVisible();
        await page.getByTestId('native-path').fill('');

        await expect(page.getByTestId('native-next-hint')).toContainText('This machine is ready');
        await next(page);
        await expect(page.getByTestId('step-defaults')).toBeVisible();

        expect(fake.mutations()).toEqual([]);
        expect(fake.snapshot(foreign.files)).toEqual(before);
        await screenshot(page, 'wizard-after-continue');
    });

    test('switching back to SQLite leaves the native form behind', async ({ page }) => {
        const { h } = await installation();
        await claim(page, h);
        await toDatabaseStep(page);
        await page.getByTestId('engine-postgres-native').check();
        await expect(page.getByTestId('native-form')).toBeVisible();
        await page.getByTestId('engine-sqlite').check();
        await expect(page.getByTestId('native-option')).toHaveCount(0);
        await expect(page.getByTestId('data-root')).toBeVisible();
        await expect(page.getByTestId('nav-next')).toBeEnabled();
    });
});

test.describe('the native database in the database journeys', () => {
    test('is set up from a reviewed plan, started and stopped, and no password is ever shown or passed on a command line', async ({ page, context }) => {
        const { h, fake } = await installation();
        const foreign = fake.seedForeignCluster({ name: 'main', port: 5432 });
        const before = fake.snapshot(foreign.files);
        const p = await h.provision({ features: [], owner: false });
        await openDatabase(page, h, p, context);

        await expect(page.getByTestId('native-instance')).toHaveAttribute('data-state', 'none');
        await expect(page.getByTestId('native-none')).toBeVisible();
        await expect(page.getByTestId('native-setup')).toBeEnabled();
        await screenshot(page, 'journey-native-none');

        const dataDirectory = path.join(fake.dir, 'srv', 'pgdata');
        await page.getByTestId('native-setup').click();
        await expect(page.getByTestId('step-database-native')).toBeVisible();
        await expect(page.getByTestId('native-form')).toBeVisible();
        await page.getByTestId('native-port').fill('5433');
        await page.getByTestId('native-path').fill(dataDirectory);
        await page.getByTestId('native-install-packages').check();
        await next(page, 'Review');
        await expect(page.getByTestId('plan-native')).toBeVisible();
        await expect(page.getByTestId('plan-native-cluster')).toHaveText('goobster');
        await expect(page.getByTestId('plan-native-data')).toHaveText(dataDirectory);
        await expect(page.getByTestId('plan-native-listen')).toHaveText('127.0.0.1:5433');
        await expect(page.getByTestId('plan-native-packages')).toContainText('postgresql-17');
        await screenshot(page, 'journey-native-review');
        expect(fake.mutations()).toEqual([]);

        await next(page, 'Create it');
        await expect(page.getByTestId('database-done')).toBeVisible({ timeout: 120_000 });
        await expect(page.getByTestId('database-done')).toContainText('native database is running and ready');
        await screenshot(page, 'journey-native-done');
        await page.getByTestId('database-back').click();

        await expect(page.getByTestId('native-instance')).toHaveAttribute('data-state', 'ok');
        await expect(page.getByTestId('native-state')).toHaveText('running');
        await expect(page.getByTestId('native-instance-port')).toHaveText('127.0.0.1:5433');
        await expect(page.getByTestId('native-connected')).toHaveText('does not use it yet');
        await expect(page.getByTestId('native-foreign')).toContainText('main');
        await expect(page.getByTestId('native-start')).toBeDisabled();
        await screenshot(page, 'journey-native-running');

        await page.getByTestId('native-stop').click();
        await expect(page.getByTestId('native-state')).toHaveText('stopped', { timeout: 60_000 });
        await expect(page.getByTestId('native-start')).toBeEnabled();
        await page.getByTestId('native-start').click();
        await expect(page.getByTestId('native-state')).toHaveText('running', { timeout: 60_000 });
        await screenshot(page, 'journey-native-restarted');

        // The generated password reaches the overlay only; the helper was given a hash.
        const overlay = JSON.parse(fs.readFileSync(path.join(h.data, 'manager', 'environment.json'), 'utf8'));
        const staged = JSON.stringify(overlay);
        const secret = /postgres(?:ql)?:\/\/[^:]+:([^@]+)@/.exec(staged);
        expect(secret).not.toBeNull();
        const password = decodeURIComponent(secret[1]);
        expect(password.length).toBeGreaterThanOrEqual(24);
        expect(await page.locator('main').innerText()).not.toContain(password);
        expect(fake.argvText()).not.toContain(password);
        expect(fake.stdinText()).not.toContain(password);
        expect(fake.stdinText()).toContain('NOSUPERUSER');
        expect(fake.stdinText()).toContain('SCRAM-SHA-256$');
        const stored = await page.evaluate(() => JSON.stringify([window.sessionStorage, window.localStorage]));
        expect(stored).not.toContain(password);
        expect(h.log).not.toContain(password);

        // The other cluster is byte-for-byte what it was.
        expect(fake.snapshot(foreign.files)).toEqual(before);
        expect(fake.state().clusters.find((cluster) => cluster.name === 'main').online).toBe(true);
    });
});
