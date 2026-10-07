/**
 * The Host room's operator pages (#326, documentation/host_operations.md):
 * Features, Connections and Instance Defaults previewed and applied through
 * the installation manager, plus the restart panel.
 *
 * Nothing here mocks the manager. Each describe block runs a real manager
 * process (apps/manager) claimed through its bootstrap credential, and a real
 * portal behind the authenticated bridge:
 *
 *   - "through the manager" runs the e2e portal (e2e/server.js) with an
 *     unsupervised manager and covers denial, dependency conflicts, the
 *     Gambling attestation on a shared instance, masked secrets, env-controlled
 *     fields, a stale revision and the manager being away.
 *   - "restart" runs `manager --supervise` with a standalone api worker, so the
 *     feature change, the countdown, Restart now and the new running state are
 *     the real lifecycle, not a stand-in.
 *
 * Neither needs a Discord token, a provider key or a network.
 */
const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { login, createSecondServer } = require('./helpers');
const { createManagerProcess, bootstrapOperator, waitFor, getJson, tempDir } = require('./hostHarness');
const C = require('./constants');

const BASE = Number(process.env.GOOBSTER_E2E_PORT || 4173);
const PORTAL_PORT = BASE + 110;
const MANAGER_PORT = BASE + 111;
const SUPERVISED_MANAGER_PORT = BASE + 120;
const SUPERVISED_API_PORT = BASE + 121;

// A dedicated operator identity the e2e portal grants an operator account (e2e/server.js).
const OPERATOR = '99000000000000390';
const OPERATOR_NAME = 'Host operator';
const HOST_API = '/api/app/admin/host';
const ENV_SECRET = 'sk_envcontrolled4321';

const feature = (page, id) => page.locator(`[data-testid="host-feature"][data-feature="${id}"]`);
const field = (page, id) => page.locator(`[data-testid="host-field"][data-field="${id}"]`);
const toggle = (page, id) => feature(page, id).getByTestId('host-feature-toggle');

async function openHost(page, tab) {
    await page.goto(`/app/host/${tab}`);
    await expect(page.getByRole('heading', { name: 'Host', exact: true })).toBeVisible();
}

async function openFeatures(page) {
    await openHost(page, 'features');
    await expect(feature(page, 'projects')).toBeVisible();
    await expect(page.getByTestId('manager-unavailable')).toHaveCount(0);
    await expect(toggle(page, 'projects')).toBeEnabled();
}

function readFeaturesFile(dir) {
    return JSON.parse(fs.readFileSync(path.join(dir, 'features.json'), 'utf8'));
}

async function devSession(page, userId, name) {
    const response = await page.request.post('/api/app/auth/dev-session', { data: { userId, name } });
    expect(response.ok()).toBe(true);
}

test.describe('Host pages change the installation through the manager', () => {
    test.describe.configure({ mode: 'serial' });

    const dir = tempDir('goobster-e2e-host-');
    const portal = createSecondServer({ port: PORTAL_PORT, dataDir: dir });
    const manager = createManagerProcess({
        dir,
        port: MANAGER_PORT,
        env: { ELEVENLABS_API_KEY: ENV_SECRET }
    });
    test.use({ baseURL: portal.url });

    test.beforeAll(async () => {
        test.setTimeout(180_000);
        await manager.start();
        await manager.claim();
        await portal.start({
            features: { economy: true, exchange: true, gambling: false, projects: true, music: true, push: true },
            env: {
                GOOBSTER_MANAGER_URL: manager.url,
                GOOBSTER_CONFIG_PATH: path.join(dir, 'config.json')
            }
        });
    });

    test.afterAll(async () => {
        await portal.stop();
        await manager.stop();
        portal.cleanup();
    });

    test('a member is refused: no tabs, no data, and the routes answer 403', async ({ page }) => {
        await login(page, { userId: C.MEMBER, name: C.MEMBER_NAME });
        await page.goto('/app/host/features');
        await expect(page.getByText('Only the host of this installation can open this room.')).toBeVisible();
        await expect(page.getByTestId('host-tabs')).toHaveCount(0);
        await expect(page.getByTestId('host-features')).toHaveCount(0);
        for (const route of ['/features', '/config', '/lifecycle', '/manager']) {
            const response = await page.request.get(`${HOST_API}${route}`);
            expect(response.status(), route).toBe(403);
        }
        const attempt = await page.request.post(`${HOST_API}/operations`, { data: { kind: 'features.set', input: { changes: { music: false }, expectedRevision: 1 } } });
        expect(attempt.status()).toBe(403);
    });

    test('an operator sees the pages, and each control has an accessible name and works by keyboard', async ({ page }) => {
        await login(page, { userId: OPERATOR, name: OPERATOR_NAME });
        await openFeatures(page);
        const tabs = page.getByRole('navigation', { name: 'Host pages' });
        await expect(tabs.getByRole('link')).toHaveText(['Overview', 'Features', 'Connections', 'Instance Defaults', 'Installation']);
        await expect(tabs.locator('[aria-current="page"]')).toHaveText('Features');

        const music = page.getByRole('checkbox', { name: /for Music/ });
        await expect(music).toBeChecked();
        await music.focus();
        await page.keyboard.press('Space');
        await expect(music).not.toBeChecked();
        await expect(page.getByTestId('host-features-preview')).toBeEnabled();
        await page.keyboard.press('Space');
        await expect(music).toBeChecked();
        await expect(page.getByTestId('host-features-preview')).toBeDisabled();

        await expect(page.getByTestId('keeps-data-note')).toContainText('keeps its data');
        await expect(page.getByTestId('host-lifecycle-live')).toHaveAttribute('aria-live', 'polite');
        await expect(page.getByTestId('host-lifecycle')).toBeVisible();
    });

    test('turning Economy off names what else turns off, and a missing dependency blocks the preview', async ({ page }) => {
        await login(page, { userId: OPERATOR, name: OPERATOR_NAME });
        await openFeatures(page);

        await toggle(page, 'economy').uncheck();
        await expect(feature(page, 'economy').getByTestId('cascade')).toContainText('also turns off');
        await expect(feature(page, 'exchange')).toHaveAttribute('data-changed', 'true');
        await expect(toggle(page, 'exchange')).not.toBeChecked();

        await toggle(page, 'gambling').check();
        await expect(feature(page, 'gambling').getByTestId('missing-dependency')).toContainText('needs Economy');
        await expect(page.getByTestId('host-features-preview')).toBeDisabled();

        await toggle(page, 'gambling').uncheck();
        await page.getByTestId('host-features-preview').click();
        const review = page.getByTestId('host-features-review-preview');
        await expect(review).toBeVisible();
        await expect(review.getByTestId('host-features-review-change')).toHaveCount(2);
        await expect(review).toContainText('Nothing has been applied yet.');
        // A preview applies nothing.
        expect(readFeaturesFile(dir).revision).toBe(1);
        await review.getByTestId('host-features-review-discard').click();
        await expect(page.getByTestId('host-features-review-preview')).toHaveCount(0);
        expect(readFeaturesFile(dir).features.economy.active).toBe(true);
    });

    test('Gambling on a shared instance needs the attestation, then applies as pending', async ({ page, browser }) => {
        const other = await browser.newContext({ baseURL: portal.url });
        const otherPage = await other.newPage();
        await devSession(otherPage, C.MEMBER, C.MEMBER_NAME);
        await other.close();

        await login(page, { userId: OPERATOR, name: OPERATOR_NAME });
        await openFeatures(page);
        await expect(page.getByTestId('shared-instance')).toContainText('shared');

        await toggle(page, 'gambling').check();
        const attestation = page.getByTestId('attestation-checkbox');
        await expect(attestation).toBeVisible();
        await expect(page.getByTestId('host-features-preview')).toBeDisabled();
        await attestation.check();
        await expect(page.getByTestId('host-features-preview')).toBeEnabled();
        await page.getByTestId('host-features-preview').click();

        const review = page.getByTestId('host-features-review-preview');
        await expect(review).toContainText('Attested by you');
        await expect(review.getByTestId('host-features-review-change')).toContainText('Turn on Gambling');
        expect(readFeaturesFile(dir).features.gambling.active).toBe(false);

        await page.getByTestId('host-features-review-apply').click();
        const applied = page.getByTestId('host-features-review-applied');
        await expect(applied).toContainText('Applied.');
        await expect(applied).toContainText('pending');
        await expect(feature(page, 'gambling').getByTestId('chip-pending')).toContainText('turns on after the restart');
        // The manager wrote the file; the portal still reports the running state until the workers restart.
        const saved = readFeaturesFile(dir);
        expect(saved.features.gambling).toMatchObject({ active: false, pendingActive: true });
        expect(saved.revision).toBe(2);
        await expect(feature(page, 'gambling').getByTestId('chip-active')).toHaveAttribute('data-on', 'false');
    });

    test('a stale revision is refused and nothing is overwritten', async ({ page, context }) => {
        await login(page, { userId: OPERATOR, name: OPERATOR_NAME });
        await openFeatures(page);
        await toggle(page, 'music').uncheck();
        await page.getByTestId('host-features-preview').click();
        await expect(page.getByTestId('host-features-review-preview')).toBeVisible();

        const second = await context.newPage();
        await openFeatures(second);
        await toggle(second, 'push').uncheck();
        await second.getByTestId('host-features-preview').click();
        await second.getByTestId('host-features-review-apply').click();
        await expect(second.getByTestId('host-features-review-applied')).toBeVisible();
        const revision = readFeaturesFile(dir).revision;
        await second.close();

        await page.getByTestId('host-features-review-apply').click();
        const failure = page.getByTestId('host-features-review-error');
        await expect(failure).toHaveAttribute('data-code', 'REVISION_CONFLICT');
        await expect(failure).toContainText('Someone changed this while you were reviewing it');
        const after = readFeaturesFile(dir);
        expect(after.revision).toBe(revision);
        expect(after.features.music.pendingActive).toBeUndefined();
        expect(after.features.push.pendingActive).toBe(false);
    });

    test('a provider key is typed once, shown only by fingerprint, replaced and removed; the value never comes back', async ({ page }) => {
        const first = 'pplx-e2e-secret-AAAA1111';
        const second = 'pplx-e2e-secret-BBBB2222';
        const seen = [];
        page.on('response', async (response) => {
            if (!response.url().includes(HOST_API)) return;
            seen.push(await response.text().catch(() => ''));
        });
        await login(page, { userId: OPERATOR, name: OPERATOR_NAME });
        await openHost(page, 'connections');
        const key = field(page, 'perplexity.apiKey');
        await expect(key).toBeVisible();
        await expect(key.getByTestId('secret-state')).toHaveAttribute('data-present', 'false');

        await key.getByTestId('secret-replace').click();
        await key.getByTestId('secret-input').fill(first);
        await page.getByTestId('host-config-preview').click();
        const review = page.getByTestId('host-config-review-preview');
        await expect(review).toContainText('Replace perplexity.apiKey');
        await expect(page.locator('body')).not.toContainText(first);
        await page.getByTestId('host-config-review-apply').click();
        await expect(page.getByTestId('host-config-review-applied')).toBeVisible();
        await expect(key.getByTestId('fingerprint')).toHaveText('1111');
        await expect(page.locator('body')).not.toContainText(first);
        await page.getByRole('button', { name: 'Done' }).click();

        await key.getByTestId('secret-replace').click();
        await key.getByTestId('secret-input').fill(second);
        await page.getByTestId('host-config-preview').click();
        await page.getByTestId('host-config-review-apply').click();
        await expect(page.getByTestId('host-config-review-applied')).toBeVisible();
        await expect(key.getByTestId('fingerprint')).toHaveText('2222');
        await page.getByRole('button', { name: 'Done' }).click();

        await key.getByTestId('secret-remove').click();
        await expect(key.getByTestId('secret-removing')).toBeVisible();
        await page.getByTestId('host-config-preview').click();
        await expect(page.getByTestId('host-config-review-preview')).toContainText('Remove the saved perplexity.apiKey');
        await page.getByTestId('host-config-review-apply').click();
        await expect(page.getByTestId('host-config-review-applied')).toBeVisible();
        await expect(key.getByTestId('secret-state')).toHaveAttribute('data-present', 'false');
        await expect(key.getByTestId('fingerprint')).toHaveCount(0);

        expect(seen.length).toBeGreaterThan(4);
        for (const body of seen) {
            expect(body).not.toContain(first);
            expect(body).not.toContain(second);
        }
        const onDisk = fs.readFileSync(path.join(dir, 'config.json'), 'utf8');
        expect(onDisk).not.toContain('pplx-e2e-secret');
    });

    test('a field the environment controls is read-only and says which variable', async ({ page }) => {
        await login(page, { userId: OPERATOR, name: OPERATOR_NAME });
        await openHost(page, 'connections');
        const key = field(page, 'elevenlabs.apiKey');
        await expect(key).toBeVisible();
        await expect(key).toHaveAttribute('data-env', 'true');
        await expect(key.getByTestId('field-readonly')).toContainText('ELEVENLABS_API_KEY');
        await expect(key.getByTestId('fingerprint')).toHaveText('4321');
        await expect(key.getByTestId('secret-replace')).toHaveCount(0);
        await expect(key.getByTestId('secret-remove')).toHaveCount(0);
        await expect(page.locator('body')).not.toContainText(ENV_SECRET);
    });

    test('Instance Defaults separates defaults from enforced policy', async ({ page }) => {
        await login(page, { userId: OPERATOR, name: OPERATOR_NAME });
        await openHost(page, 'defaults');
        await expect(page.getByTestId('defaults-explainer')).toContainText('never blocks, caps or overwrites');
        await expect(page.getByTestId('limits-explainer')).toContainText('enforced for everyone');
        await expect(page.getByTestId('host-defaults-preview')).toBeDisabled();
    });

    test('when the manager is away the pages say so, change nothing, and recover on their own', async ({ page }) => {
        await login(page, { userId: OPERATOR, name: OPERATOR_NAME });
        await openFeatures(page);
        await manager.stop();

        await page.reload();
        const notice = page.getByTestId('manager-unavailable');
        await expect(notice).toBeVisible();
        await expect(notice).toHaveAttribute('data-code', 'MANAGER_UNREACHABLE');
        await expect(notice).toContainText('The manager is not running');
        await expect(toggle(page, 'projects')).toBeDisabled();
        await expect(page.getByTestId('host-features-preview')).toBeDisabled();
        const status = await page.request.get(`${HOST_API}/manager`);
        expect(status.status()).toBe(200);
        expect((await status.json()).reachable).toBe(false);
        const refused = await page.request.get(`${HOST_API}/config`);
        expect(refused.status()).toBe(503);
        expect((await refused.json()).code ?? (await refused.json()).error?.code).toBe('MANAGER_UNAVAILABLE');

        await manager.start();
        await expect(page.getByTestId('manager-unavailable')).toHaveCount(0, { timeout: 30_000 });
        await expect(toggle(page, 'projects')).toBeEnabled();
    });
});

test.describe('a feature change takes effect through a real restart', () => {
    test.describe.configure({ mode: 'serial' });

    const dir = tempDir('goobster-e2e-host-restart-');
    const manager = createManagerProcess({
        dir,
        port: SUPERVISED_MANAGER_PORT,
        supervise: true,
        env: {
            GOOBSTER_RUNTIME_MODE: 'standalone',
            GOOBSTER_API_PORT: String(SUPERVISED_API_PORT),
            GOOBSTER_SANDBOX_ENABLED: '0',
            GOOBSTER_OBSERVATORY_ENABLED: '0'
        }
    });
    const portalUrl = `http://127.0.0.1:${SUPERVISED_API_PORT}`;
    test.use({ baseURL: portalUrl });

    test.beforeAll(async () => {
        test.setTimeout(240_000);
        await manager.start();
        await manager.claim();
        await waitFor(async () => (await getJson(`${portalUrl}/health`)).status === 200, { timeout: 120_000, what: 'the api worker to be healthy' });
        bootstrapOperator({ dir, principalId: OPERATOR });
    });

    test.afterAll(async () => {
        await manager.stop();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('apply, schedule, skip the countdown, and the workers come back with the feature off', async ({ page }) => {
        test.setTimeout(240_000);
        await devSession(page, OPERATOR, OPERATOR_NAME);
        await openFeatures(page);
        const lifecycle = page.getByTestId('host-lifecycle');
        await expect(lifecycle).toContainText('the manager starts the workers');
        await expect(page.getByTestId('host-worker').first()).toBeVisible();
        const before = Number(await page.getByTestId('host-revision').innerText());

        await expect(feature(page, 'music').getByTestId('chip-active')).toHaveAttribute('data-on', 'true');
        await toggle(page, 'music').uncheck();
        await page.getByTestId('host-features-preview').click();
        const review = page.getByTestId('host-features-review-preview');
        await expect(review).toContainText('Turn off Music');
        await expect(review.getByTestId('host-features-review-schedule')).toBeChecked();
        await page.getByTestId('host-features-review-apply').click();

        await expect(page.getByTestId('host-features-review-applied')).toContainText('restart is scheduled');
        await expect(feature(page, 'music').getByTestId('chip-pending')).toContainText('turns off after the restart');
        await expect(feature(page, 'music').getByTestId('chip-active')).toHaveAttribute('data-on', 'true');
        const countdown = page.getByTestId('host-countdown');
        await expect(countdown).toBeVisible();
        const first = Number((await countdown.innerText()).replace(/\D+/g, ''));
        expect(first).toBeLessThanOrEqual(65);
        expect(first).toBeGreaterThan(30);
        await expect.poll(async () => Number((await countdown.innerText()).replace(/\D+/g, '')), { timeout: 10_000 }).toBeLessThan(first);

        await page.getByTestId('host-restart-now').click();
        await page.getByRole('button', { name: 'Confirm' }).click();

        await expect(page.getByTestId('host-last-outcome')).toHaveAttribute('data-outcome', 'applied', { timeout: 120_000 });
        await expect(page.getByTestId('host-countdown')).toHaveCount(0);
        await expect(page.getByTestId('host-revision')).not.toHaveText(String(before));
        await expect(feature(page, 'music').getByTestId('chip-active')).toHaveAttribute('data-on', 'false');
        await expect(feature(page, 'music').getByTestId('chip-pending')).toHaveCount(0);
        for (const worker of await page.getByTestId('host-worker').all()) {
            await expect(worker).toContainText('acknowledged');
        }

        const status = await (await page.request.get('/api/app/features')).json();
        expect(status.features.music.active).toBe(false);
        expect(status.features.projects.active).toBe(true);
        expect(readFeaturesFile(dir).features.music.active).toBe(false);
    });

    test('Cancel keeps the change pending and the running feature untouched', async ({ page }) => {
        test.setTimeout(120_000);
        await devSession(page, OPERATOR, OPERATOR_NAME);
        await openFeatures(page);
        await toggle(page, 'music').check();
        await page.getByTestId('host-features-preview').click();
        await page.getByTestId('host-features-review-apply').click();
        await expect(page.getByTestId('host-countdown')).toBeVisible();

        await page.getByTestId('host-cancel-restart').click();
        await expect(page.getByTestId('host-countdown')).toHaveCount(0);
        await expect(feature(page, 'music').getByTestId('chip-pending')).toContainText('turns on after the restart');
        await expect(feature(page, 'music').getByTestId('chip-active')).toHaveAttribute('data-on', 'false');
        await expect(page.getByTestId('host-last-outcome')).toHaveAttribute('data-outcome', 'cancelled');
    });
});
