/**
 * Manager updates from the portal Host room (documentation/manager_update.md), driven in a real
 * browser against a real installation manager supervising the real standalone api worker, with a
 * directory standing in for the release source (a signed index plus a payload archive built here).
 * Provider-free and offline: nothing calls an AI service or the network. Each test builds its own
 * throwaway installation under the OS temp folder (e2e/setupHarness.js).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { createSecondServer } = require('./helpers');
const { createSetupInstallation, waitFor } = require('./setupHarness');
const { freePort, drive } = require('../tests/helpers/installFixture');
const { newKey, makePayload, publish } = require('../tests/helpers/updateFixture');

const ARTIFACTS = process.env.GOOBSTER_E2E_ARTIFACTS || '/opt/cursor/artifacts';
const OPERATOR = '99000000000000390';
const HOST_API = '/api/app/admin/host';

test.setTimeout(240_000);

const installations = [];
const scratch = [];
let portal = null;

function tempDir(name) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `goobster-update-${name}-`));
    scratch.push(dir);
    return dir;
}

test.afterEach(async ({ page }, testInfo) => {
    if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach('page-text', { body: await page.locator('main').innerText({ timeout: 3000 }).catch(() => '(no page)'), contentType: 'text/plain' }).catch(() => {});
        for (const h of installations) await testInfo.attach('manager-log', { body: h.log, contentType: 'text/plain' }).catch(() => {});
    }
    if (portal) await portal.stop();
    portal = null;
    while (installations.length) await installations.pop().destroy();
    while (scratch.length) fs.rmSync(scratch.pop(), { recursive: true, force: true });
});

async function screenshot(page, name) {
    try {
        fs.mkdirSync(ARTIFACTS, { recursive: true });
        const panel = page.getByTestId('host-updates');
        await panel.scrollIntoViewIfNeeded();
        await panel.screenshot({ path: path.join(ARTIFACTS, `342-${name}.png`) });
    } catch { /* artifacts are optional */ }
}

/** A running installation whose update source is a directory offering `core`, signed by a throwaway key. */
async function world({ core = '2.5.0' } = {}) {
    const key = newKey(scratch, 'key');
    const payload = makePayload(tempDir('next'), key, { core });
    const published = await publish(scratch, key, payload);
    const h = await createSetupInstallation({ env: { GOOBSTER_RELEASE_PUBLIC_KEY_FILE: key.publicKeyPath } });
    installations.push(h);
    await h.provision({ features: [], start: true });
    await drive({ manager: h.manager }, 'update.policy', { mode: 'check', source: { kind: 'directory', dir: published.dir } });
    return { h, key, published };
}

async function startPortal(h) {
    const dir = tempDir('portal');
    const port = await freePort();
    const server = createSecondServer({ port, dataDir: dir });
    await server.start({
        env: {
            GOOBSTER_MANAGER_URL: h.url,
            GOOBSTER_MANAGER_BRIDGE_KEY_FILE: path.join(h.data, 'manager', 'bridge-key')
        }
    });
    return { url: server.url, stop: async () => { await server.stop(); } };
}

async function devSession(page, userId, name) {
    const response = await page.request.post(`${portal.url}/api/app/auth/dev-session`, { data: { userId, name } });
    expect(response.ok()).toBe(true);
    const seeded = await page.request.post(`${portal.url}/e2e/fixtures/tutorial-progress`, { data: { userId, autoStart: false, rows: [] } });
    expect(seeded.ok()).toBe(true);
}

async function openPanel(page, h) {
    portal = await startPortal(h);
    await devSession(page, OPERATOR, 'Host operator');
    await page.goto(`${portal.url}/app/host`);
    await expect(page.getByTestId('host-updates')).toBeVisible();
    await expect(page.getByTestId('update-installed')).toContainText('2.4.0');
}

test.describe('the Updates panel', () => {
    test('check, download and apply move the installation to the new release; the audit rows carry versions only', async ({ page }) => {
        const { h } = await world();
        await openPanel(page, h);
        await expect(page.getByTestId('update-mode')).toHaveValue('check');
        await expect(page.getByTestId('update-last-check')).toContainText('Not checked yet');
        await expect(page.getByTestId('update-stage')).toBeDisabled();
        await expect(page.getByTestId('update-apply')).toBeDisabled();
        await screenshot(page, 'panel-before');

        await page.getByTestId('update-check').click();
        await expect(page.getByTestId('update-last-check')).toContainText('A newer release is available');
        await expect(page.getByTestId('update-last-check')).toContainText('2.5.0');

        await page.getByTestId('update-mode').selectOption('apply');
        await expect(page.getByTestId('update-mode')).toHaveValue('apply');
        await expect(page.getByTestId('update-stage')).toBeEnabled();
        await page.getByTestId('update-stage').click();
        await expect(page.getByTestId('update-staged')).toContainText('2.5.0');
        await screenshot(page, 'panel-staged');

        await page.getByTestId('update-apply').click();
        await expect(page.getByRole('button', { name: 'Confirm' })).toBeVisible();
        await screenshot(page, 'panel-confirm');
        await page.getByRole('button', { name: 'Confirm' }).click();
        await expect(page.getByTestId('update-installed')).toContainText('2.5.0', { timeout: 120_000 });
        await expect(page.getByTestId('update-last-apply')).toContainText('Applied');
        await expect(page.getByTestId('update-last-apply')).toContainText('2.4.0 to 2.5.0');
        await expect(page.getByTestId('update-staged')).toHaveCount(0);
        await screenshot(page, 'panel-applied');

        const status = await (await page.request.get(`${portal.url}${HOST_API}/update/status`)).json();
        expect(status.installed.version).toBe('2.5.0');
        expect(status.recovery).toBeNull();
        expect(JSON.stringify(status)).not.toContain(h.dir);

        const audit = (await (await page.request.get(`${portal.url}/api/app/admin/audit`)).json()).entries;
        const rows = audit.filter((entry) => entry.action === 'host.update.apply');
        expect(rows.length).toBeGreaterThanOrEqual(4);
        expect(rows.every((entry) => entry.actor === OPERATOR)).toBe(true);
        expect(JSON.stringify(rows)).not.toContain(h.dir);
        expect(JSON.stringify(rows)).not.toContain(os.tmpdir());
        expect(await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }]))).not.toContain(h.dir);
    });

    test('a source with nothing newer is reported as up to date and stages nothing', async ({ page }) => {
        const { h } = await world({ core: '2.4.0' });
        await openPanel(page, h);
        await page.getByTestId('update-check').click();
        await expect(page.getByTestId('update-last-check')).toContainText('Up to date');
        await expect(page.getByTestId('update-stage')).toBeDisabled();
        await expect(page.getByTestId('update-apply')).toBeDisabled();
    });

    test('an update waiting for a decision is shown, the decision is not offered in the portal, and the route refuses it', async ({ page }) => {
        const { h } = await world();
        await openPanel(page, h);
        const dir = path.join(h.data, 'manager', 'update');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'recovery.json'), JSON.stringify({
            version: 1,
            code: 'VERIFY_FAILED',
            cause: 'WORKER_NOT_HEALTHY',
            target: 'to',
            at: '2026-10-07 12:00:00',
            from: { releaseId: 'old', version: '2.4.0' },
            to: { releaseId: 'new', version: '2.5.0' },
            schemaChanging: true,
            backup: { at: '2026-10-07 11:59:00', name: 'update-backup' },
            operationId: 'op-1'
        }));
        await waitFor(async () => (await (await page.request.get(`${portal.url}${HOST_API}/update/status`)).json()).recovery, { what: 'the recovery state to show' });
        await page.reload();
        const card = page.getByTestId('update-recovery');
        await expect(card).toBeVisible();
        await expect(card).toContainText('2.4.0');
        await expect(card).toContainText('2.5.0');
        await expect(card).toContainText('update recovery --decision restore');
        await expect(page.getByTestId('update-apply')).toBeDisabled();
        await expect(card.getByRole('button')).toHaveCount(0);
        await screenshot(page, 'panel-recovery');

        const refused = await page.request.post(`${portal.url}${HOST_API}/operations`, { data: { kind: 'update.recover', input: { decision: 'restore' } } });
        expect(refused.status()).toBeGreaterThanOrEqual(400);
        expect(refused.status()).toBeLessThan(500);
        const audit = (await (await page.request.get(`${portal.url}/api/app/admin/audit`)).json()).entries;
        expect(audit.filter((entry) => entry.action === 'host.update.apply')).toHaveLength(0);
        expect(fs.existsSync(path.join(dir, 'recovery.json'))).toBe(true);
    });
});
