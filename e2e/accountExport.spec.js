const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const { login } = require('./helpers');
for (const narrow of [false, true]) {
    test(`account archive survives navigation, arrives in Inbox and downloads (${narrow ? 'narrow' : 'desktop'})`, async ({ page }) => {
        const userId = narrow ? '800000000000000052' : '800000000000000051';
        if (narrow) await page.setViewportSize({ width: 390, height: 844 });
        await login(page, { userId, name: 'Export reader' });
        expect((await page.request.post('/e2e/fixtures/account-export', { data: { userId } })).ok()).toBe(true);
        await page.goto('/app/settings/memory');
        await page.getByRole('button', { name: 'Create account export', exact: true }).click();
        await expect(page.locator('.account-export')).toContainText(/Waiting to start|Preparing archive|Ready to download/);
        await page.goto('/app/activity/inbox');
        await expect(page.getByText('Your account export is ready', { exact: true })).toBeVisible({ timeout: 15000 });
        await page.goto('/app/settings/memory');
        await page.reload();
        const exports = page.locator('.account-export');
        await expect(exports.getByText('Ready to download', { exact: true })).toBeVisible();
        const downloading = page.waitForEvent('download');
        await exports.getByRole('link', { name: 'Download account archive' }).click();
        const download = await downloading;
        expect(download.suggestedFilename()).toMatch(/^goobster-account-.*\.tar\.gz$/);
        expect(fs.readFileSync(await download.path()).subarray(0, 2).toString('hex')).toBe('1f8b');
        await exports.screenshot({ path: test.info().outputPath('account-export.png') });
        await exports.getByRole('button', { name: 'Delete export', exact: true }).click();
        await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
        await expect(exports.getByText('Ready to download', { exact: true })).toHaveCount(0);
        await expect(exports.getByRole('button', { name: 'Create account export' })).toBeEnabled();
    });
}
