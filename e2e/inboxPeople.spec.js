const { test, expect } = require('@playwright/test');
const { login, openRoom } = require('./helpers');
const C = require('./constants');

test.beforeEach(async ({ page }) => { await login(page); });

test('an opened unread result survives the filtered refetch until it is closed', async ({ page }) => {
    const response = await page.request.get('/api/app/inbox');
    const item = (await response.json()).items.find(row => row.title === C.INBOX_TITLE);
    expect(item).toBeTruthy();
    await page.request.post(`/api/app/inbox/${item.id}/read`, { data: { read: false } });
    await openRoom(page, /Activity/);
    await page.getByRole('tab', { name: 'Unread', exact: true }).click();
    const row = page.locator('.inbox-row').filter({ hasText: C.INBOX_TITLE });
    await expect(row).toBeVisible();
    const refetch = page.waitForResponse(result => new URL(result.url()).pathname === '/api/app/inbox'
        && new URL(result.url()).searchParams.get('unread') === '1');
    await row.getByRole('button', { name: new RegExp(C.INBOX_TITLE), expanded: false }).click();
    await expect(row.getByText(C.INBOX_BODY)).toBeVisible();
    expect((await (await refetch).json()).items.some(result => result.id === item.id)).toBe(false);
    await expect(row.getByRole('button', { name: 'Unread', exact: true })).toBeVisible();
    const refreshed = await page.request.get('/api/app/inbox?unread=1');
    expect((await refreshed.json()).items.some(result => result.id === item.id)).toBe(false);
    await expect(row.getByText(C.INBOX_BODY)).toBeVisible();
    await row.getByRole('button', { name: new RegExp(C.INBOX_TITLE), expanded: true }).click();
    await expect(row).toHaveCount(0);
});

test('the Archive can load and open its fifty-first result', async ({ page }) => {
    await openRoom(page, /Activity/);
    await page.getByRole('tab', { name: 'Archive', exact: true }).click();
    await expect(page.locator('.inbox-row')).toHaveCount(50);
    await expect(page.getByText('Archived result 1', { exact: true })).toHaveCount(0);
    const nextPage = page.waitForResponse(response => new URL(response.url()).pathname === '/api/app/inbox'
        && new URL(response.url()).searchParams.has('cursor'));
    await page.getByRole('button', { name: 'Load older items' }).click();
    expect((await nextPage).ok()).toBe(true);
    await expect(page.locator('.inbox-row')).toHaveCount(51);
    await page.getByText('Archived result 1', { exact: true }).click();
    await expect(page.getByText('Archived details 1.', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Load older items' })).toHaveCount(0);
});

test('an attachment-only result renders its file and preview controls keep it open', async ({ page }) => {
    await openRoom(page, /Activity/);
    const row = page.locator('.inbox-row').filter({ hasText: C.INBOX_ATTACHMENT_TITLE });
    await row.getByRole('button', { name: new RegExp(C.INBOX_ATTACHMENT_TITLE), expanded: false }).click();
    await expect(row.locator('.file-card-title')).toContainText('review.csv');
    await expect(row.getByText('kept attachment', { exact: true })).toBeVisible();
    await row.getByRole('button', { name: 'value', exact: true }).click();
    await expect(row.getByText('kept attachment', { exact: true })).toBeVisible();
    await expect(row.getByRole('link', { name: /Download/ })).toHaveAttribute('href', '/e2e/inbox-attachment.csv');
});

for (const room of ['Discussions', 'Projects']) {
    test(`${room} accepts a pasted native account id without a people-search result`, async ({ page }) => {
        await openRoom(page, new RegExp(room));
        if (room === 'Discussions') {
            await page.getByText('Salon on ingest', { exact: true }).click();
            await page.getByRole('button', { name: 'People in this discussion' }).click();
        } else {
            await page.getByRole('button', { name: new RegExp(C.PROJECT_NAME) }).click();
            const more = page.getByRole('button', { name: 'More actions' });
            if (await more.isVisible()) await more.click();
            await page.getByRole('button', { name: 'People', exact: true }).click();
        }
        const dialog = page.getByRole('dialog');
        const input = dialog.getByPlaceholder('Search people by name, or paste a user id');
        await expect(input).toBeVisible();
        // A retried browser journey reuses the server's DB.
        const pending = dialog.locator('.member-item.pending').filter({ hasText: C.NATIVE_MEMBER_NAME });
        if (await pending.count()) {
            await pending.getByRole('button', { name: 'Withdraw invitation' }).click();
            await expect(pending).toHaveCount(0);
        }
        const invalidSearch = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/invitable')
            && new URL(response.url()).searchParams.get('q') === 'usr_not-a-valid-account');
        await input.fill('usr_not-a-valid-account');
        await invalidSearch;
        await expect(dialog.getByRole('button', { name: /Invite user usr_not/ })).toHaveCount(0);
        await input.fill(C.NATIVE_MEMBER);
        const invitation = page.waitForResponse(response => response.request().method() === 'POST'
            && new URL(response.url()).pathname.endsWith('/invites'));
        await dialog.getByRole('button', { name: new RegExp(`Invite user ${C.NATIVE_MEMBER}`) }).click();
        expect((await invitation).ok()).toBe(true);
        await expect(dialog.getByText(C.NATIVE_MEMBER_NAME, { exact: true })).toBeVisible();
        await expect(dialog.getByText('invited', { exact: true })).toBeVisible();
    });
}
