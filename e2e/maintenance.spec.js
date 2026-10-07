/**
 * Backup, restore, reset and migration from the wizard and the Host room
 * (documentation/backup_and_restore.md, documentation/setup_wizard.md), driven
 * in a real browser against a real installation manager and, where noted, the
 * real standalone `api` worker it starts. Provider-free: nothing here calls an
 * AI service. Each test builds its own throwaway installation under the OS
 * temp folder (e2e/setupHarness.js).
 */
/* global window */
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { createSecondServer } = require('./helpers');
const { createSetupInstallation, waitFor } = require('./setupHarness');
const { freePort } = require('../tests/helpers/installFixture');
const C = require('./constants');

const ARTIFACTS = process.env.GOOBSTER_E2E_ARTIFACTS || '/opt/cursor/artifacts';
const PASSPHRASE = 'correct-horse-battery-staple-9';
const WRONG = 'not-the-passphrase-at-all-1';
const OPERATOR = '99000000000000390';
const HOST_API = '/api/app/admin/host';
const SECRET_KEY = 'sk-e2e-never-in-the-archive-0123456789';

test.setTimeout(240_000);

const installations = [];
async function installation(options = {}) {
    const h = await createSetupInstallation({ ...options, env: { OPENAI_API_KEY: SECRET_KEY, ...(options.env || {}) } });
    installations.push(h);
    return h;
}
const scratch = [];
function tempDir(name) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `goobster-maint-${name}-`));
    scratch.push(dir);
    return dir;
}
test.afterEach(async ({ page }, testInfo) => {
    if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach('page-text', { body: await page.locator('main').innerText({ timeout: 3000 }).catch(() => '(no page)'), contentType: 'text/plain' }).catch(() => {});
        for (const h of installations) await testInfo.attach('manager-log', { body: h.log, contentType: 'text/plain' }).catch(() => {});
    }
    while (installations.length) await installations.pop().destroy();
    while (scratch.length) fs.rmSync(scratch.pop(), { recursive: true, force: true });
});

async function screenshot(page, name) {
    try {
        fs.mkdirSync(ARTIFACTS, { recursive: true });
        await page.screenshot({ path: path.join(ARTIFACTS, `337-${name}.png`), fullPage: true });
    } catch { /* artifacts are optional */ }
}

async function openMaintain(page, h, p, context) {
    await context.addCookies([{ name: p.session.name, value: p.session.value, domain: '127.0.0.1', path: '/manager', httpOnly: true, sameSite: 'Strict' }]);
    await page.goto(`${h.url}/manager/`);
    await expect(page.getByTestId('step-maintain')).toBeVisible();
    await expect(page.getByTestId('installation-id')).toBeVisible();
}

function filesBelow(dir) {
    const out = [];
    const walk = (current) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) walk(full);
            else out.push(full);
        }
    };
    if (fs.existsSync(dir)) walk(dir);
    return out;
}

/** Nothing under the manager's own store or the archive holds `needle` in clear. */
function expectAbsent(h, needle, extraDirs = []) {
    for (const dir of [path.join(h.data, 'manager'), ...extraDirs]) {
        for (const file of filesBelow(dir)) {
            if (/\.sqlite|\.pre-restore|\.enc$/.test(file) || fs.statSync(file).size > 5_000_000) continue;
            expect(fs.readFileSync(file).toString('latin1').includes(needle), `${file} must not hold the secret`).toBe(false);
        }
    }
}

async function writeBackup(page, dir, { passphrase = PASSPHRASE, includeConfig = true } = {}) {
    await page.getByTestId('action-backup').click();
    await expect(page.getByTestId('step-backup-form')).toBeVisible();
    await page.getByTestId('backup-dir').fill(dir);
    if (!includeConfig) await page.getByTestId('backup-include-config').uncheck();
    else {
        await page.getByTestId('backup-passphrase').fill(passphrase);
        await page.getByTestId('backup-passphrase-repeat').fill(passphrase);
    }
    await page.getByRole('button', { name: 'Review the backup' }).click();
    await expect(page.getByTestId('backup-plan')).toBeVisible();
    await page.getByRole('button', { name: 'Write the backup' }).click();
    await expect(page.getByTestId('backup-done')).toBeVisible({ timeout: 120_000 });
    return (await page.getByTestId('backup-archive').innerText()).trim();
}

test.describe('backup from the manager page', () => {
    test('the journey writes a verified archive, says only config.json is encrypted, and keeps the passphrase out of every record', async ({ page, context }) => {
        const h = await installation();
        const p = await h.provision({ features: [], start: true });
        await openMaintain(page, h, p, context);
        const dir = path.join(tempDir('backup'), 'archive');

        await page.getByTestId('action-backup').click();
        await expect(page.getByTestId('step-backup-form')).toBeVisible();
        await expect(page.getByTestId('backup-dir')).not.toHaveValue('');
        await expect(page.getByTestId('backup-encryption-note-form')).toContainText('Only config.json is encrypted');
        await screenshot(page, 'backup-form');

        await page.getByTestId('backup-dir').fill(dir);
        await page.getByTestId('backup-passphrase').fill(PASSPHRASE);
        await page.getByTestId('backup-passphrase-repeat').fill(`${PASSPHRASE}x`);
        await expect(page.getByRole('alert').filter({ hasText: 'do not match' })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Review the backup' })).toBeDisabled();
        await page.getByTestId('backup-passphrase-repeat').fill(PASSPHRASE);
        await page.getByRole('button', { name: 'Review the backup' }).click();

        await expect(page.getByTestId('backup-plan')).toBeVisible();
        await expect(page.getByTestId('backup-config-state')).toContainText('encrypted with your passphrase');
        await expect(page.getByTestId('backup-archive-encrypted')).toHaveText('not encrypted');
        await expect(page.getByTestId('backup-omitted')).toContainText('OPENAI_API_KEY');
        await screenshot(page, 'backup-review');
        await page.getByRole('button', { name: 'Write the backup' }).click();

        await expect(page.getByTestId('backup-done')).toBeVisible({ timeout: 120_000 });
        const archive = (await page.getByTestId('backup-archive').innerText()).trim();
        expect(path.dirname(archive)).toBe(dir);
        await expect(page.getByTestId('backup-omitted-result')).toContainText('OPENAI_API_KEY');
        await screenshot(page, 'backup-result');

        const files = filesBelow(archive).map((file) => path.relative(archive, file));
        expect(files).toContain('config.json.enc');
        expect(files.some((file) => /manifest\.json$/.test(file))).toBe(true);
        expect(fs.existsSync(path.join(archive, 'config.json'))).toBe(false);
        for (const file of filesBelow(archive)) {
            if (file.endsWith('config.json.enc') || /\.sqlite/.test(file)) continue;
            expect(fs.readFileSync(file).toString('latin1')).not.toContain(SECRET_KEY);
        }
        expect(await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }, window.location.href]))).not.toContain(PASSPHRASE);
        expectAbsent(h, PASSPHRASE, [dir]);
        expectAbsent(h, SECRET_KEY, [dir]);
    });

    test('leaving config.json out is explicit and needs no passphrase', async ({ page, context }) => {
        const h = await installation();
        const p = await h.provision({ features: [] });
        await openMaintain(page, h, p, context);
        const dir = path.join(tempDir('noconfig'), 'archive');
        await page.getByTestId('action-backup').click();
        await page.getByTestId('backup-dir').fill(dir);
        await page.getByTestId('backup-include-config').uncheck();
        await expect(page.getByTestId('backup-without-config')).toBeVisible();
        await expect(page.getByTestId('backup-passphrase')).toHaveCount(0);
        await page.getByRole('button', { name: 'Review the backup' }).click();
        await expect(page.getByTestId('backup-config-state')).toContainText('not included');
        await page.getByRole('button', { name: 'Write the backup' }).click();
        await expect(page.getByTestId('backup-done')).toBeVisible({ timeout: 120_000 });
        await expect(page.getByTestId('backup-done')).toContainText('not included');
        const archive = (await page.getByTestId('backup-archive').innerText()).trim();
        expect(fs.existsSync(path.join(archive, 'config.json.enc'))).toBe(false);
    });

    test('a destination inside the data folder is refused with the reason, and nothing is written', async ({ page, context }) => {
        const h = await installation();
        const p = await h.provision({ features: [] });
        await openMaintain(page, h, p, context);
        await page.getByTestId('action-backup').click();
        await page.getByTestId('backup-dir').fill(path.join(h.data, 'manager', 'inside'));
        await page.getByTestId('backup-include-config').uncheck();
        await page.getByRole('button', { name: 'Review the backup' }).click();
        await expect(page.getByTestId('plan-failure')).toBeVisible();
        expect(fs.existsSync(path.join(h.data, 'manager', 'inside'))).toBe(false);
    });
});

test.describe('restore from the manager page', () => {
    test('inspect, a wrong passphrase changes nothing, then a confirmed restore leaves the instance paused with maintenance held', async ({ page, context }) => {
        const h = await installation();
        const p = await h.provision({ features: [], start: true });
        await openMaintain(page, h, p, context);
        const dir = await writeBackup(page, path.join(tempDir('restore'), 'archive'));
        await page.getByTestId('back-to-maintain').click();
        await expect(page.getByTestId('step-maintain')).toBeVisible();
        const id = (await page.getByTestId('installation-id').innerText()).trim();
        const dbFile = path.join(h.data, 'goobster.sqlite');
        const dbBefore = crypto.createHash('sha256').update(fs.readFileSync(dbFile)).digest('hex');

        await page.getByTestId('action-restore').click();
        await expect(page.getByTestId('restore-warning')).toContainText('paused');
        await page.getByTestId('restore-dir').fill(path.join(dir, 'nope'));
        await page.getByTestId('restore-inspect').click();
        await expect(page.getByTestId('restore-inspect-error')).toBeVisible();
        await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled();

        await page.getByTestId('restore-dir').fill(dir);
        await page.getByTestId('restore-inspect').click();
        await expect(page.getByTestId('restore-inspection')).toHaveAttribute('data-restorable', 'true');
        await expect(page.getByTestId('inspect-config')).toContainText('encrypted with the backup passphrase');
        await expect(page.getByTestId('inspect-ok')).toBeVisible();
        await screenshot(page, 'restore-inspect');
        await page.getByRole('button', { name: 'Continue' }).click();

        await expect(page.getByTestId('step-restore-options')).toBeVisible();
        await page.getByTestId('restore-passphrase').fill(WRONG);
        await page.getByRole('button', { name: 'Review the restore' }).click();
        await expect(page.getByTestId('plan-failure')).toHaveAttribute('data-code', 'BAD_PASSPHRASE');
        await expect(page.getByTestId('plan-failure')).toContainText('Nothing was changed');
        expect(crypto.createHash('sha256').update(fs.readFileSync(dbFile)).digest('hex')).toBe(dbBefore);
        await page.getByRole('button', { name: 'Back' }).click();

        await page.getByTestId('restore-passphrase').fill(PASSPHRASE);
        await page.getByRole('button', { name: 'Review the restore' }).click();
        await expect(page.getByTestId('restore-plan')).toBeVisible();
        await expect(page.getByTestId('plan-config')).toContainText('restored');
        await expect(page.getByTestId('plan-secrets')).toContainText('OPENAI_API_KEY');
        await expect(page.getByRole('button', { name: 'Restore now' })).toBeDisabled();

        await page.getByTestId('restore-confirm-input').fill(`${id}x`);
        await page.getByTestId('restore-confirm-check').click();
        await expect(page.getByTestId('restore-confirm-wrong')).toBeVisible();
        await expect(page.getByRole('button', { name: 'Restore now' })).toBeDisabled();
        await page.getByTestId('restore-confirm-input').fill(id);
        await page.getByTestId('restore-confirm-check').click();
        await expect(page.getByTestId('restore-confirmed')).toBeVisible();
        await screenshot(page, 'restore-review');
        await page.getByRole('button', { name: 'Restore now' }).click();

        await expect(page.getByTestId('restore-done')).toBeVisible({ timeout: 180_000 });
        await expect(page.getByTestId('result-maintenance')).toHaveText('still held');
        await expect(page.getByTestId('result-interrupted')).toContainText('interrupted by restore');
        await expect(page.getByTestId('result-config')).toHaveText('restored');
        await expect(page.getByTestId('restore-resume-note')).toContainText('Resume the instance');
        await expect(page.getByTestId('restore-retained')).toBeVisible();
        await expect(page.getByTestId('barrier-panel')).toBeVisible();
        await expect(page.getByTestId('barrier-resume-note')).toContainText('does not');
        await screenshot(page, 'restore-result');

        const setAside = fs.readdirSync(h.data).filter((name) => name.includes('.pre-restore'));
        expect(setAside.length).toBeGreaterThan(0);
        expectAbsent(h, PASSPHRASE);

        await expect(page.getByTestId('barrier-release')).toBeDisabled();
        await page.getByTestId('barrier-acknowledge').check();
        await page.getByTestId('barrier-release').click();
        await expect(page.getByTestId('barrier-panel')).toHaveCount(0, { timeout: 30_000 });
    });

    test('restoring without config.json leaves the current one untouched and lists it among the things to recreate', async ({ page, context }) => {
        const h = await installation();
        const p = await h.provision({ features: [], start: true });
        await openMaintain(page, h, p, context);
        const dir = await writeBackup(page, path.join(tempDir('withoutconfig'), 'archive'));
        await page.getByTestId('back-to-maintain').click();
        const id = (await page.getByTestId('installation-id').innerText()).trim();
        const configFile = path.join(h.data, 'config.json');
        const configBefore = fs.readFileSync(configFile, 'utf8');

        await page.getByTestId('action-restore').click();
        await page.getByTestId('restore-dir').fill(dir);
        await page.getByTestId('restore-inspect').click();
        await page.getByRole('button', { name: 'Continue' }).click();
        await page.getByTestId('restore-without-config').check();
        await expect(page.getByTestId('restore-passphrase')).toHaveCount(0);
        await page.getByRole('button', { name: 'Review the restore' }).click();
        await expect(page.getByTestId('plan-config')).toContainText('left as it is');
        await expect(page.getByTestId('plan-secrets')).toContainText('config.json');
        await page.getByTestId('restore-confirm-input').fill(id);
        await page.getByTestId('restore-confirm-check').click();
        await page.getByRole('button', { name: 'Restore now' }).click();
        await expect(page.getByTestId('restore-done')).toBeVisible({ timeout: 180_000 });
        await expect(page.getByTestId('result-config')).toContainText('left as it was');
        expect(fs.readFileSync(configFile, 'utf8')).toBe(configBefore);
    });

    test('a target that holds data gets a verified safety backup first, and an archive inside the data folder is blocked', async ({ page, context }) => {
        const h = await installation();
        const p = await h.provision({ features: [], start: true });
        await openMaintain(page, h, p, context);
        const dir = await writeBackup(page, path.join(tempDir('safety'), 'archive'), { includeConfig: false });
        await page.getByTestId('back-to-maintain').click();

        const inside = path.join(h.data, 'manager', 'inside-archive');
        fs.cpSync(dir, inside, { recursive: true });
        await page.goto(`${h.url}/manager/#/restore/source`);
        await page.getByTestId('restore-dir').fill(inside);
        await page.getByTestId('restore-inspect').click();
        await expect(page.getByTestId('inspect-blocks')).toContainText('inside the manager');
        await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled();

        await page.getByTestId('restore-dir').fill(dir);
        await page.getByTestId('restore-inspect').click();
        await expect(page.getByTestId('inspect-ok')).toBeVisible();
        await expect(page.getByTestId('restore-no-config').or(page.getByTestId('inspect-config'))).toBeVisible();
        await page.getByRole('button', { name: 'Continue' }).click();
        await page.getByRole('button', { name: 'Review the restore' }).click();
        await expect(page.getByTestId('restore-plan')).toContainText('Safety backup');
        await expect(page.getByTestId('restore-plan')).toContainText('written to');
    });
});

test.describe('reset from the manager page', () => {
    test('the confirmation text is exact, the scope is previewed first, and a reset that cannot start releases maintenance and says nothing was removed', async ({ page, context }) => {
        const h = await installation();
        const p = await h.provision({ features: [], start: true });
        await openMaintain(page, h, p, context);
        const id = (await page.getByTestId('installation-id').innerText()).trim();

        await page.getByTestId('action-reset').click();
        await expect(page.getByTestId('step-reset-scope')).toBeVisible();
        await expect(page.getByTestId('reset-preview')).toBeDisabled();
        await page.getByTestId('reset-feature').fill('tavern');
        await page.getByTestId('reset-preview').click();
        await expect(page.getByTestId('reset-preview-view')).toBeVisible();
        await expect(page.getByTestId('reset-boundary')).toContainText('verified backup');
        await screenshot(page, 'reset-scope');
        await page.getByRole('button', { name: 'Continue' }).click();

        await expect(page.getByTestId('step-reset-backup')).toBeVisible();
        await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled();
        await page.getByTestId('reset-backup-dir').fill(path.join(tempDir('reset'), 'before'));
        await page.getByTestId('reset-skip-config').check();
        await page.getByRole('button', { name: 'Continue' }).click();

        await expect(page.getByTestId('reset-confirm-text')).toHaveText(`${id}:tavern`);
        await page.getByTestId('reset-confirm-input').fill(id);
        await expect(page.getByTestId('reset-confirm-mismatch')).toBeVisible();
        await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled();
        await page.getByTestId('reset-confirm-input').fill(`${id}:tavern`);
        await page.getByRole('button', { name: 'Continue' }).click();
        await expect(page.getByTestId('reset-summary')).toContainText('verified');
        await page.getByRole('button', { name: 'Reset now' }).click();
        // The harness runs the manager inside the test process, whose own database is not this throwaway installation's:
        // data.reset refuses (FOREIGN_TARGET) before it removes anything, which is the failure path the journey must handle.
        await expect(page.getByTestId('reset-failed')).toBeVisible({ timeout: 90_000 });
        await expect(page.getByTestId('reset-failed')).toHaveAttribute('data-code', 'FOREIGN_TARGET');
        await expect(page.getByTestId('reset-failed')).toContainText('Maintenance was released');
        await expect(page.getByTestId('barrier-panel')).toHaveCount(0);
        await screenshot(page, 'reset-refused');
        expect(fs.existsSync(path.join(h.data, 'goobster.sqlite'))).toBe(true);
    });

    test('resetting the whole instance from a setup session is sent to the local command', async ({ page, context }) => {
        const h = await installation();
        const p = await h.provision({ features: [] });
        await openMaintain(page, h, p, context);
        await page.getByTestId('action-reset').click();
        await page.getByTestId('reset-scope-instance').check();
        await page.getByTestId('reset-preview').click();
        await expect(page.getByTestId('reset-preview-view')).toBeVisible();
        await page.getByRole('button', { name: 'Continue' }).click();
        await page.getByTestId('reset-backup-dir').fill(path.join(tempDir('instance'), 'before'));
        await page.getByTestId('reset-skip-config').check();
        await page.getByRole('button', { name: 'Continue' }).click();
        const id = (await page.getByTestId('reset-confirm-text').innerText()).trim();
        await page.getByTestId('reset-confirm-input').fill(id);
        await page.getByRole('button', { name: 'Continue' }).click();
        await expect(page.getByTestId('reset-needs-local')).toContainText('reset --scope instance');
        await expect(page.getByRole('button', { name: 'Reset now' })).toHaveCount(0);
    });
});

test.describe('migration status from the manager page', () => {
    test('shows that no migration exists, the rollback-boundary sentence, and the commands; a bad address is a stated problem', async ({ page, context }) => {
        const h = await installation();
        const p = await h.provision({ features: [] });
        await openMaintain(page, h, p, context);
        await page.getByTestId('action-migration').click();
        await expect(page.getByTestId('migrate-state')).toContainText('none');
        await expect(page.getByTestId('migrate-rollback-limit')).toContainText('Rollback to the SQLite source is possible until the first write reaches Postgres');
        await expect(page.getByTestId('migrate-commands')).toContainText('migrate run');
        await screenshot(page, 'migration-status');

        await expect(page.getByTestId('migrate-preflight')).toBeDisabled();
        await page.getByTestId('migrate-url').fill('postgres://nobody:s3cret-pw@127.0.0.1:1/none');
        await page.getByTestId('migrate-preflight').click();
        await expect(page.getByTestId('migrate-report').or(page.getByTestId('migrate-preflight-error'))).toBeVisible({ timeout: 60_000 });
        await expect(page.getByTestId('migrate-url')).toHaveValue('');
        const text = await page.locator('main').innerText();
        expect(text).not.toContain('s3cret-pw');
        expect(await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }, window.location.href]))).not.toContain('s3cret-pw');
        expectAbsent(h, 's3cret-pw');
    });
});

async function startPortal(h) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goobster-maint-portal-'));
    const port = await freePort();
    const server = createSecondServer({ port, dataDir: dir });
    await server.start({
        env: {
            GOOBSTER_MANAGER_URL: h.url,
            GOOBSTER_MANAGER_BRIDGE_KEY_FILE: path.join(h.data, 'manager', 'bridge-key')
        }
    });
    return { url: server.url, stop: async () => { await server.stop(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

async function devSession(page, portal, userId, name) {
    const response = await page.request.post(`${portal.url}/api/app/auth/dev-session`, { data: { userId, name } });
    expect(response.ok()).toBe(true);
    const seeded = await page.request.post(`${portal.url}/e2e/fixtures/tutorial-progress`, { data: { userId, autoStart: false, rows: [] } });
    expect(seeded.ok()).toBe(true);
}

test.describe('the same four from the portal Host room', () => {
    let portal = null;
    test.afterEach(async () => { if (portal) await portal.stop(); portal = null; });

    test('the Overview card opens the Maintenance page; a backup runs through the bridge, is audited, and restore, reset and migration say what the portal cannot do', async ({ page }) => {
        const h = await installation();
        await h.provision({ features: [] });
        portal = await startPortal(h);
        await devSession(page, portal, OPERATOR, 'Host operator');
        const parent = path.join(tempDir('portal'), 'archive');

        await page.goto(`${portal.url}/app/host`);
        await expect(page.getByTestId('maintenance-card')).toBeVisible();
        await screenshot(page, 'portal-maintenance-card');
        await page.getByTestId('host-backup').click();
        await expect(page.getByTestId('step-backup-form')).toBeVisible();
        await expect(page.getByTestId('back-to-maintain')).toHaveText('Maintenance');
        await page.getByTestId('backup-dir').fill(parent);
        await page.getByTestId('backup-passphrase').fill(PASSPHRASE);
        await page.getByTestId('backup-passphrase-repeat').fill(PASSPHRASE);
        await page.getByRole('button', { name: 'Review the backup' }).click();
        await expect(page.getByTestId('backup-plan')).toBeVisible();
        await page.getByRole('button', { name: 'Write the backup' }).click();
        await expect(page.getByTestId('backup-done')).toBeVisible({ timeout: 120_000 });
        const dir = (await page.getByTestId('backup-archive').innerText()).trim();
        expect(fs.existsSync(path.join(dir, 'config.json.enc'))).toBe(true);

        const cookies = await page.context().cookies();
        expect(cookies.some((cookie) => cookie.name === 'goobster-manager-session')).toBe(false);
        expect(await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }]))).not.toContain(PASSPHRASE);
        const audit = await page.request.get(`${portal.url}/api/app/admin/audit`);
        const entries = (await audit.json()).entries;
        const backups = entries.filter((entry) => entry.action === 'host.backup.apply');
        expect(backups.length).toBeGreaterThan(0);
        expect(backups[0].actor).toBe(OPERATOR);
        expect(JSON.stringify(entries)).not.toContain(PASSPHRASE);
        expect(JSON.stringify(entries)).not.toContain(dir);

        await page.getByTestId('back-to-maintain').click();
        await expect(page.getByTestId('maintenance-hub')).toBeVisible();
        await page.getByTestId('maintenance-restore').click();
        await page.getByTestId('restore-dir').fill(dir);
        await page.getByTestId('restore-inspect').click();
        await expect(page.getByTestId('restore-inspection')).toHaveAttribute('data-restorable', 'true');
        await page.getByRole('button', { name: 'Continue' }).click();
        await page.getByTestId('restore-passphrase').fill(PASSPHRASE);
        await page.getByRole('button', { name: 'Review the restore' }).click();
        await expect(page.getByTestId('restore-plan')).toBeVisible();
        await screenshot(page, 'portal-restore-review');

        await page.goto(`${portal.url}/app/host/maintenance#/reset/scope`);
        await page.getByTestId('reset-feature').fill('tavern');
        await page.getByTestId('reset-preview').click();
        await expect(page.getByTestId('reset-preview-view')).toBeVisible();
        await page.getByRole('button', { name: 'Continue' }).click();
        await page.getByTestId('reset-backup-dir').fill(path.join(tempDir('portal-reset'), 'before'));
        await page.getByTestId('reset-skip-config').check();
        await page.getByRole('button', { name: 'Continue' }).click();
        const id = (await page.getByTestId('reset-confirm-text').innerText()).trim();
        await page.getByTestId('reset-confirm-input').fill(id);
        await page.getByRole('button', { name: 'Continue' }).click();
        await expect(page.getByTestId('reset-cli-only')).toContainText('cli.js reset');

        await page.goto(`${portal.url}/app/host/maintenance#/migration/status`);
        await expect(page.getByTestId('migrate-state')).toContainText('none');
        await expect(page.getByTestId('migrate-rollback-limit')).toBeVisible();
        await expect(page.getByTestId('migrate-preflight-cli')).toBeVisible();
        await expect(page.getByTestId('migrate-url')).toHaveCount(0);
    });

    test('a member is refused: the pages and the routes answer 403', async ({ page }) => {
        const h = await installation();
        await h.provision({ features: [] });
        portal = await startPortal(h);
        await devSession(page, portal, C.MEMBER, C.MEMBER_NAME);
        await page.goto(`${portal.url}/app/host/maintenance`);
        await expect(page.getByText('Only the host of this installation can open this room.')).toBeVisible();
        await expect(page.getByTestId('maintenance-card')).toHaveCount(0);
        for (const route of ['/backup/status', '/maintenance', '/migrate/status', '/reset/plan?scope=instance']) {
            const response = await page.request.get(`${portal.url}${HOST_API}${route}`);
            expect(response.status(), route).toBe(403);
        }
        const planned = await page.request.post(`${portal.url}${HOST_API}/operations`, { data: { kind: 'backup.create', input: {} } });
        expect(planned.status()).toBe(403);
        await waitFor(async () => true);
    });
});
