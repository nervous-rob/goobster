/**
 * Connecting an installation to an existing PostgreSQL server
 * (documentation/database_connection.md): the chooser in the setup wizard, the
 * connection form and its read-only test, preparing a server from the page,
 * the maintenance journeys (update the schema, connect) and the Host room's
 * Database page.
 *
 * Everything runs against a real installation manager (e2e/setupHarness.js).
 * The parts that need a PostgreSQL server run only when one is configured:
 * GOOBSTER_DB_URL (the suite's own server) with an administrative role, either
 * that role when it is a superuser or GOOBSTER_PG_TEST_ADMIN_URL (which alone is
 * enough, and leaves the portal under test on SQLite). Without it
 * they skip and the rest still runs.
 */
/* global window */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { Client } = require('pg');
const { login } = require('./helpers');
const { createManagerProcess, bootstrapOperator, tempDir } = require('./hostHarness');
const { createSetupInstallation } = require('./setupHarness');
const { freePort } = require('../tests/helpers/installFixture');
const C = require('./constants');

const ARTIFACTS = process.env.GOOBSTER_E2E_ARTIFACTS || '/opt/cursor/artifacts';
const PASSWORD = 'plain-walnut-ladder-kettle-7';
const LOGIN = 'owner-one';

test.setTimeout(180_000);

const BASE = Number(process.env.GOOBSTER_E2E_PORT || 4173);
const PORTAL_PORT = BASE + 130;
const MANAGER_PORT = BASE + 131;
const OPERATOR = '99000000000000390';

/* ------------------------------------------------------------ the server */

const SERVER_URL = (process.env.GOOBSTER_DB_URL || process.env.GOOBSTER_PG_TEST_ADMIN_URL || '').split('?')[0] || null;
let adminUrl = null;

test.beforeAll(async () => {
    if (!SERVER_URL) return;
    const candidates = [process.env.GOOBSTER_PG_TEST_ADMIN_URL ? process.env.GOOBSTER_PG_TEST_ADMIN_URL.split('?')[0] : null, process.env.GOOBSTER_DB_URL ? process.env.GOOBSTER_DB_URL.split('?')[0] : null].filter(Boolean);
    for (const candidate of candidates) {
        const client = new Client({ connectionString: candidate });
        try {
            await client.connect();
            const row = (await client.query('SELECT rolsuper OR rolcreaterole AS ok FROM pg_roles WHERE rolname = current_user')).rows[0];
            if (row && row.ok) { adminUrl = candidate; break; }
        } catch { /* try the next */ } finally {
            await client.end().catch(() => {});
        }
    }
});

function server() {
    const url = new URL(adminUrl);
    return { host: url.hostname, port: url.port || '5432', adminUser: decodeURIComponent(url.username), adminPassword: decodeURIComponent(url.password) };
}

const cleanups = [];
test.afterEach(async ({ page }, testInfo) => {
    if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach('page-text', { body: await page.locator('main').innerText({ timeout: 3000 }).catch(() => '(no page)'), contentType: 'text/plain' }).catch(() => {});
    }
    while (cleanups.length) await cleanups.pop()().catch(() => {});
});

/** A role and a database of its own on the server; `prepared` creates them, otherwise the page does. */
async function world({ prepared }) {
    const suffix = crypto.randomBytes(4).toString('hex');
    const names = { role: `e2e338_r_${suffix}`, database: `e2e338_d_${suffix}`, password: `e2e-app-secret-${suffix}-never-shown` };
    const where = server();
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    cleanups.push(async () => {
        try {
            await admin.query(`DROP DATABASE IF EXISTS "${names.database}" WITH (FORCE)`);
            await admin.query(`DROP ROLE IF EXISTS "${names.role}"`);
        } finally {
            await admin.end().catch(() => {});
        }
    });
    if (prepared) {
        await admin.query(`CREATE ROLE "${names.role}" LOGIN PASSWORD '${names.password}'`);
        await admin.query(`CREATE DATABASE "${names.database}" OWNER "${names.role}"`);
        const inside = new Client({ connectionString: adminUrl.replace(/\/[^/]*$/, `/${names.database}`) });
        await inside.connect();
        try {
            await inside.query('CREATE EXTENSION IF NOT EXISTS citext');
            await inside.query('CREATE EXTENSION IF NOT EXISTS vector');
        } finally {
            await inside.end();
        }
    }
    return { ...names, ...where, admin };
}

async function tablesIn(w) {
    const client = new Client({ host: w.host, port: Number(w.port), database: w.database, user: w.role, password: w.password });
    await client.connect();
    try {
        return Number((await client.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'")).rows[0].n);
    } finally {
        await client.end();
    }
}

/** Every file under a folder that contains the text. */
function filesContaining(dir, text, found = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) filesContaining(full, text, found);
        else if (entry.isFile() && fs.statSync(full).size < 20_000_000 && fs.readFileSync(full).includes(text)) found.push(full);
    }
    return found;
}

/* ------------------------------------------------------------- the pages */

const installations = [];
async function installation(options) {
    const h = await createSetupInstallation(options);
    installations.push(h);
    return h;
}
test.afterEach(async () => {
    while (installations.length) await installations.pop().destroy();
});

async function screenshot(page, name) {
    try {
        fs.mkdirSync(ARTIFACTS, { recursive: true });
        await page.screenshot({ path: path.join(ARTIFACTS, `338-${name}.png`), fullPage: true });
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

async function fillConnection(page, values) {
    for (const [id, value] of Object.entries(values)) await page.getByTestId(id).fill(String(value));
}

async function signInManager(context, p) {
    await context.addCookies([{ name: p.session.name, value: p.session.value, domain: '127.0.0.1', path: '/manager', httpOnly: true, sameSite: 'Strict' }]);
}

async function openDatabase(page, h, p, context) {
    await signInManager(context, p);
    await page.goto(`${h.url}/manager/`);
    await expect(page.getByTestId('step-maintain')).toBeVisible();
    await page.getByTestId('action-database').click();
    await expect(page.getByTestId('step-database-status')).toBeVisible();
}

/* ----------------------------------------------------- the setup chooser */

test.describe('the database step of the setup wizard', () => {
    test('says which engine fits which workload, offers an existing server, and holds back what this version cannot set up', async ({ page }) => {
        const h = await installation();
        await claim(page, h);
        await toDatabaseStep(page);

        const guidance = page.getByTestId('engine-guidance');
        await expect(guidance.getByTestId('guidance-sqlite')).toContainText('One machine, one process');
        await expect(guidance.getByTestId('guidance-paired')).toContainText('PostgreSQL is required');
        await expect(guidance.getByTestId('guidance-heavy')).toContainText('consider PostgreSQL');
        await expect(guidance).not.toContainText(/\b\d+\s*(users|people|members)\b/i);

        await expect(page.getByTestId('engine-sqlite')).toBeChecked();
        await expect(page.getByTestId('engine-postgres-docker')).toBeDisabled();
        await expect(page.getByTestId('engine-postgres-native')).toHaveCount(1);
        await expect(page.getByTestId('native-availability')).toBeVisible();
        await expect(page.getByTestId('data-root')).toBeVisible();
        await expect(page.getByTestId('db-connection-form')).toHaveCount(0);
        await screenshot(page, 'chooser-sqlite');

        await page.getByTestId('engine-postgres-existing').check();
        const form = page.getByTestId('db-connection-form');
        await expect(form).toBeVisible();
        for (const id of ['db-host', 'db-port', 'db-database', 'db-schema', 'db-user', 'db-password', 'db-tls', 'db-ca']) await expect(page.getByTestId(id)).toBeVisible();
        await expect(page.getByTestId('db-schema')).toHaveValue('public');
        await expect(page.getByTestId('db-password')).toHaveAttribute('type', 'password');
        expect(await page.getByTestId('db-tls').locator('option').evaluateAll((options) => options.map((option) => option.value))).toEqual(['', 'disable', 'prefer', 'require', 'verify-full']);
        await expect(page.getByTestId('db-storage-block')).toContainText('read-only here');
        await expect(page.getByTestId('storage-owner')).toContainText('The installation does not own it');
        await expect(page.getByTestId('nav-next')).toBeDisabled();

        // Nothing can be tested without a host and a password; the page says which.
        await page.getByTestId('db-test').click();
        await expect(page.getByTestId('db-host-problem')).toBeVisible();
        await expect(page.getByTestId('db-password-problem')).toBeVisible();
        await screenshot(page, 'chooser-postgres-form');

        // Back to SQLite: the way on is open again and the secret was never kept.
        await page.getByTestId('db-password').fill('typed-secret-never-stored-91');
        const stored = await page.evaluate(() => JSON.stringify([window.sessionStorage, window.localStorage]));
        expect(stored).not.toContain('typed-secret-never-stored-91');
        await page.getByTestId('engine-sqlite').check();
        await expect(page.getByTestId('nav-next')).toBeEnabled();
    });

    test('an unreachable server is reported, with what to do, and does not let the page go on', async ({ page }) => {
        const h = await installation();
        await claim(page, h);
        await toDatabaseStep(page);
        await page.getByTestId('engine-postgres-existing').check();
        const closed = await freePort();
        await fillConnection(page, { 'db-host': '127.0.0.1', 'db-port': closed, 'db-database': 'goobster', 'db-user': 'goobster', 'db-password': 'whatever-pw-1' });
        await page.getByTestId('db-test').click();
        const report = page.getByTestId('db-report');
        await expect(report).toBeVisible();
        await expect(report).toHaveAttribute('data-verdict', 'block');
        await expect(page.getByTestId('db-auth')).toHaveAttribute('data-auth', 'unreachable');
        await expect(page.getByTestId('db-block')).toContainText(/reach|connect/i);
        await expect(page.getByTestId('db-remediation').first()).toBeVisible();
        await expect(page.getByTestId('nav-next')).toBeDisabled();
        await screenshot(page, 'unreachable');

        // Changing a setting makes the earlier answer stale.
        await page.getByTestId('db-port').fill(String(closed + 1));
        await expect(page.getByTestId('db-report-stale')).toBeVisible();
    });

    test.describe('against a PostgreSQL server', () => {
        test.skip(() => !SERVER_URL, 'needs GOOBSTER_DB_URL or GOOBSTER_PG_TEST_ADMIN_URL');

        test('prepares the server from the page, installs onto it, and keeps the password in one private file', async ({ page }) => {
            test.skip(!adminUrl, 'needs an administrative role on the server');
            const w = await world({ prepared: false });
            const h = await installation();
            await claim(page, h);
            await toDatabaseStep(page);
            await page.getByTestId('engine-postgres-existing').check();
            await fillConnection(page, { 'db-host': w.host, 'db-port': w.port, 'db-database': w.database, 'db-user': w.role, 'db-password': w.password });
            await page.getByTestId('db-tls').selectOption('prefer');

            await page.getByTestId('db-test').click();
            await expect(page.getByTestId('db-report')).toHaveAttribute('data-verdict', 'block');
            await expect(page.getByTestId('nav-next')).toBeDisabled();

            for (const action of ['create-role', 'create-database', 'create-extension.citext', 'create-extension.vector', 'grant']) {
                await page.getByTestId(`prov-${action}`).check();
            }
            await page.getByTestId('prov-user').fill(w.adminUser);
            await page.getByTestId('prov-password').fill(w.adminPassword);
            await page.getByTestId('prov-check').click();
            await expect(page.getByTestId('prov-plan')).toBeVisible();
            await expect(page.getByTestId('prov-plan')).not.toContainText(w.password);
            await expect(page.getByTestId('prov-plan')).not.toContainText(w.adminPassword);
            await screenshot(page, 'provision-plan');
            await page.getByTestId('prov-run').click();
            await expect(page.getByTestId('prov-done')).toBeVisible({ timeout: 60_000 });
            await expect(page.getByTestId('prov-password')).toHaveValue('');

            await page.getByTestId('db-test').click();
            await expect(page.getByTestId('db-schema-state')).toHaveAttribute('data-state', 'empty');
            await expect(page.getByTestId('db-report')).toHaveAttribute('data-verdict', /ok|warn/);
            await screenshot(page, 'tested');
            await next(page);
            await expect(page.getByTestId('step-defaults')).toBeVisible();
            await next(page);
            await next(page);
            await expect(page.getByTestId('step-review')).toBeVisible();
            await expect(page.getByTestId('plan-database-postgres')).toContainText(w.database, { timeout: 30_000 });
            await expect(page.getByTestId('plan-database-postgres')).toContainText('never deleted');
            await expect(page.locator('main')).not.toContainText(w.password);
            await screenshot(page, 'review');

            await next(page, 'Install');
            await expect(page.getByTestId('operation-applied')).toBeVisible({ timeout: 120_000 });
            expect(await tablesIn(w)).toBeGreaterThan(20);

            const stored = await page.evaluate(() => JSON.stringify([window.sessionStorage, window.localStorage]));
            expect(stored).not.toContain(w.password);
            expect(stored).not.toContain(w.adminPassword);
            const holders = filesContaining(h.data, w.password).map((file) => path.relative(h.data, file));
            expect(holders).toEqual([path.join('manager', 'environment.json')]);
            expect(filesContaining(h.data, w.adminPassword)).toEqual([]);
            expect(h.log).not.toContain(w.password);
            expect(h.log).not.toContain(w.adminPassword);
        });
    });
});

/* ------------------------------------------------- the maintenance journeys */

test.describe('the database journeys of an installed installation', () => {
    test('shows the engine and the three different jobs, and offers no migration through a connection change', async ({ page, context }) => {
        const h = await installation();
        const p = await h.provision({ features: [], owner: false });
        await openDatabase(page, h, p, context);
        await expect(page.getByTestId('database-engine')).toHaveText('SQLite');
        await expect(page.getByTestId('storage-owner').first()).toContainText('owns it');
        const kinds = page.getByTestId('db-three-kinds');
        await expect(kinds).toContainText('Connection setup');
        await expect(kinds).toContainText('Schema update');
        await expect(kinds).toContainText('PostgreSQL server upgrade');
        await expect(page.getByTestId('db-failure-help')).toBeVisible();
        await screenshot(page, 'journey-status');

        await page.getByTestId('database-connect').click();
        await expect(page.getByTestId('step-database-connect')).toBeVisible();
        await expect(page.getByTestId('nav-next')).toBeDisabled();
        await page.getByTestId('nav-back').click();
        await expect(page.getByTestId('step-database-status')).toBeVisible();
    });

    test('a SQLite database that holds data is routed to the migration, and nothing changes', async ({ page, context }) => {
        const h = await installation();
        const p = await h.provision({ features: [], owner: true });
        await openDatabase(page, h, p, context);
        await expect(page.getByTestId('database-migrate-hint')).toContainText('migrate');
        await expect(page.getByTestId('database-engine')).toHaveText('SQLite');
    });

    test.describe('against a PostgreSQL server', () => {
        test.skip(() => !SERVER_URL, 'needs GOOBSTER_DB_URL or GOOBSTER_PG_TEST_ADMIN_URL');

        test('applies the schema to an empty database, then connects the installation to it', async ({ page, context }) => {
            test.skip(!adminUrl, 'needs an administrative role on the server');
            const w = await world({ prepared: true });
            const h = await installation();
            const p = await h.provision({ features: [], owner: false });
            await openDatabase(page, h, p, context);

            const connection = async () => {
                await fillConnection(page, { 'db-host': w.host, 'db-port': w.port, 'db-database': w.database, 'db-user': w.role, 'db-password': w.password });
                await page.getByTestId('db-tls').selectOption('prefer');
                await page.getByTestId('db-test').click();
                await expect(page.getByTestId('db-schema-state')).toBeVisible();
            };

            await page.getByTestId('database-schema').click();
            await connection();
            await expect(page.getByTestId('db-schema-state')).toHaveAttribute('data-state', 'empty');
            await next(page, 'Review');
            await expect(page.getByTestId('plan-schema')).toBeVisible();
            await expect(page.getByTestId('plan-schema')).not.toContainText(w.password);
            await screenshot(page, 'journey-schema-review');
            await next(page, 'Apply the schema');
            await expect(page.getByTestId('database-done')).toBeVisible({ timeout: 90_000 });
            expect(await tablesIn(w)).toBeGreaterThan(20);
            await page.getByTestId('database-back').click();

            await page.getByTestId('database-connect').click();
            await connection();
            await expect(page.getByTestId('db-schema-state')).toHaveAttribute('data-state', 'goobster-current');
            await next(page, 'Review');
            await expect(page.getByTestId('plan-connect')).toBeVisible();
            await expect(page.getByTestId('plan-connect')).not.toContainText(w.password);
            await expect(page.getByTestId('database-release')).toBeChecked();
            await screenshot(page, 'journey-connect-review');
            await next(page, 'Connect');
            await expect(page.getByTestId('database-done')).toBeVisible({ timeout: 90_000 });
            await screenshot(page, 'journey-connect-done');
            await page.getByTestId('database-back').click();

            await expect(page.getByTestId('database-engine')).toHaveText('PostgreSQL');
            await expect(page.getByTestId('database-connection')).toContainText(w.database);
            await expect(page.locator('main')).not.toContainText(w.password);
            const stored = await page.evaluate(() => JSON.stringify([window.sessionStorage, window.localStorage]));
            expect(stored).not.toContain(w.password);
            expect(filesContaining(h.data, w.password).map((file) => path.relative(h.data, file))).toEqual([path.join('manager', 'environment.json')]);
            expect(h.log).not.toContain(w.password);
        });
    });
});

/* ----------------------------------------------------------- the Host room */

test.describe('the Database page of the Host room', () => {
    test.describe.configure({ mode: 'serial' });
    const dir = tempDir('goobster-e2e-db-host-');
    const manager = createManagerProcess({ dir, port: MANAGER_PORT });
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
    });

    test('has a tab, a card on the overview, and the same journey as the manager\'s own page', async ({ page }) => {
        await login(page, { userId: OPERATOR, name: 'Host operator' });
        await page.goto('/app/host');
        await expect(page.getByTestId('database-card')).toBeVisible();
        await page.getByTestId('host-database').click();
        await expect(page.getByTestId('database-page')).toBeVisible();
        await expect(page.getByTestId('database-facts')).toBeVisible();
        await expect(page.getByTestId('database-engine')).toHaveText('SQLite');
        await expect(page.getByTestId('db-three-kinds')).toBeVisible();
        await expect(page.getByTestId('db-three-kinds').getByRole('link', { name: /PostgreSQL guide/ })).toHaveAttribute('href', /\/app\/docs\/postgres#upgrading-the-server/);
        await screenshot(page, 'host-database');
    });

    test('a member does not see it', async ({ page }) => {
        await login(page, { userId: C.MEMBER, name: C.MEMBER_NAME });
        await page.goto('/app/host/database');
        await expect(page.getByText('Only the host of this installation can open this room.')).toBeVisible();
        await expect(page.getByTestId('database-page')).toHaveCount(0);
    });
});
