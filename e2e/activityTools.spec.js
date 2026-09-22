const { test, expect } = require('@playwright/test');
const { login, openRoom } = require('./helpers');
const C = require('./constants');

async function activityBadge(page) {
    return page.getByRole('navigation', { name: 'Rooms' }).getByRole('link', { name: /Activity/ }).locator('.nav-count');
}

async function unreadCount(page) {
    const me = await page.request.get('/api/app/me');
    expect(me.ok()).toBe(true);
    return (await me.json()).inbox.unread;
}

test.beforeEach(async ({ page }) => { await login(page); });

test.afterEach(async ({ page }) => {
    await page.request.post('/e2e/fixtures/unarchive-inbox', {
        data: { title: C.CONTACT_INBOX_TITLE }
    }).catch(() => {});
    const settings = await page.request.get('/api/app/settings').catch(() => null);
    if (!settings?.ok()) return;
    const appearance = (await settings.json()).sections.appearance;
    if (!appearance?.values?.hiddenToolRooms?.length) return;
    await page.request.patch('/api/app/settings/appearance', {
        data: { expectedRevision: appearance.revision, changes: { hiddenToolRooms: [] } }
    });
});

test('a contact delivery is one inbox row that Attention also names, counted once', async ({ page }) => {
    const unread = await unreadCount(page);
    await openRoom(page, /Activity/);
    await expect(page).toHaveURL(/\/app\/activity\/inbox$/);

    const row = page.locator('.inbox-row').filter({ hasText: C.CONTACT_INBOX_TITLE });
    const delivery = row.getByTestId('inbox-attention-delivery');
    await expect(delivery).toContainText('This is the Inbox delivery of 3 Attention notices.');
    await expect(delivery.getByRole('link', { name: C.CONTACT_LEAD })).toBeVisible();
    await expect(delivery.getByRole('link', { name: C.CONTACT_MORE_1 })).toBeVisible();
    await expect(delivery.getByRole('link', { name: C.CONTACT_MORE_2 })).toBeVisible();
    await expect(row.getByRole('button', { name: 'Acted' })).toHaveCount(0);
    await expect(row.getByRole('button', { name: 'Snooze' })).toHaveCount(0);
    await expect(row.getByRole('button', { name: /Dismiss/ })).toHaveCount(0);

    const badge = await activityBadge(page);
    await expect(badge).toHaveText(String(unread));
    const tabBadge = page.getByRole('navigation', { name: 'Activity views' })
        .getByRole('link', { name: /Inbox/ }).locator('.nav-count');
    await expect(tabBadge).toHaveText(String(unread));

    await delivery.getByRole('link', { name: C.CONTACT_LEAD }).click();
    await expect(page).toHaveURL(/\/app\/activity\/attention#notice-/);
    await expect(page.getByTestId('notice-inbox-delivery')).toHaveCount(3);
    const lead = page.locator('.list-row').filter({ hasText: C.CONTACT_LEAD });
    await expect(lead.getByTestId('notice-inbox-delivery')).toContainText('Delivered to your');
    await expect(lead.getByRole('link', { name: 'Inbox' })).toBeVisible();
    await expect(lead.getByRole('button', { name: 'Acted' })).toBeVisible();
    await expect(lead.getByRole('button', { name: 'Snooze' })).toBeVisible();
    await expect(lead.getByRole('button', { name: `Dismiss ${C.CONTACT_LEAD}` })).toBeVisible();
    await expect(lead.getByRole('button', { name: /Archive/ })).toHaveCount(0);

    const quiet = page.locator('.list-row').filter({ hasText: C.NOTICE_TITLE });
    await expect(quiet.getByTestId('notice-inbox-delivery')).toHaveCount(0);
    await expect(await activityBadge(page)).toHaveText(String(unread));

    await page.reload();
    await expect(page).toHaveURL(/\/app\/activity\/attention/);
    await expect(page.getByRole('heading', { name: /^Attention/ })).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/\/app\/activity\/inbox/);
    await expect(page.getByText(C.CONTACT_INBOX_TITLE)).toBeVisible();
});

test('archiving the inbox row shows on the notice, and attention actions show on the row', async ({ page }) => {
    await openRoom(page, /Activity/);
    const row = page.locator('.inbox-row').filter({ hasText: C.CONTACT_INBOX_TITLE });
    await row.getByRole('button', { name: `Archive ${C.CONTACT_INBOX_TITLE}` }).click();
    await expect(row).toHaveCount(0);

    await page.getByRole('navigation', { name: 'Activity views' }).getByRole('link', { name: /Attention/ }).click();
    const deliveries = page.getByTestId('notice-inbox-delivery');
    await expect(deliveries).toHaveCount(3);
    await expect(deliveries.first()).toContainText('archived there');

    const lead = page.locator('.list-row').filter({ hasText: C.CONTACT_LEAD });
    await lead.getByRole('button', { name: `Dismiss ${C.CONTACT_LEAD}` }).click();
    await expect(lead).toHaveCount(0);

    const second = page.locator('.list-row').filter({ hasText: C.CONTACT_MORE_1 });
    await second.getByRole('button', { name: 'Snooze' }).click();
    await expect(second).toHaveCount(0);

    const third = page.locator('.list-row').filter({ hasText: C.CONTACT_MORE_2 });
    await third.getByRole('button', { name: 'Acted' }).click();
    await expect(third).toHaveCount(0);
    await expect(page.getByText(C.NOTICE_TITLE)).toBeVisible();
    await page.reload();
    await expect(page).toHaveURL(/\/app\/activity\/attention/);
    await expect(page.getByRole('heading', { name: /^Attention/ })).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/\/app\/activity\/inbox/);

    await page.getByRole('tab', { name: 'Archive', exact: true }).click();
    const archived = page.locator('.inbox-row').filter({ hasText: C.CONTACT_INBOX_TITLE });
    const archivedDelivery = archived.getByTestId('inbox-attention-delivery');
    await expect(archivedDelivery).toContainText('dismissed in Attention');
    await expect(archivedDelivery).toContainText('snoozed in Attention');
    await expect(archivedDelivery).toContainText('acted on in Attention');
    await expect(archived.getByRole('button', { name: 'Acted' })).toHaveCount(0);
});

test('hiding a tool removes it from Tools and a direct address still opens it', async ({ page }) => {
    await openRoom(page, /Tools/);
    const tools = page.getByRole('navigation', { name: 'Tools' });
    const trading = tools.locator('[data-tour="tool-trading"]');
    await expect(trading).toHaveAttribute('aria-disabled', 'true');
    await expect(trading).toContainText('not connected to Discord');

    await expect(page.getByRole('button', { name: 'Hide Music Lab' })).toBeEnabled();
    await page.getByRole('button', { name: 'Hide Music Lab' }).click();
    await expect(tools.getByText('Music Lab', { exact: true })).toHaveCount(0);
    const hidden = page.getByRole('region', { name: 'Hidden tools' });
    await expect(hidden.getByRole('button', { name: 'Unhide Music Lab' })).toBeVisible();
    await expect(hidden.locator('[aria-disabled="true"]')).toHaveCount(0);
    await expect(hidden).not.toContainText('not connected to Discord');
    await expect(trading).toHaveAttribute('aria-disabled', 'true');

    await page.goto('/app/conservatory');
    await expect(page.locator('#pane-conservatory .chat-title')).toContainText('Music Lab');
    await page.reload();
    await expect(page).toHaveURL(/\/app\/conservatory$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/app\/tools$/);

    await page.getByRole('button', { name: 'Hide Trading game' }).click();
    await expect(tools.locator('[data-tour="tool-trading"]')).toHaveCount(0);
    await page.goto('/app/exchange');
    await expect(page.getByRole('heading', { name: 'Exchange' })).toBeVisible();
    await expect(page.getByText(/not connected to Discord/)).toBeVisible();

    await page.goto('/app/tools');
    await page.getByRole('button', { name: 'Unhide Trading game' }).click();
    await expect(tools.locator('[data-tour="tool-trading"]')).toHaveAttribute('aria-disabled', 'true');
    await expect(tools.locator('[data-tour="tool-trading"]')).toContainText('not connected to Discord');
    await page.getByRole('button', { name: 'Unhide Music Lab' }).click();
    await expect(tools.locator('[data-tour="tool-music"]')).toBeVisible();

    await page.goto('/app/settings/appearance');
    await page.getByRole('checkbox', { name: 'Hide Card decks' }).check();
    await page.getByRole('button', { name: 'Save changes' }).click();
    await page.goto('/app/tools');
    await expect(tools.getByText('Card decks', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Unhide Card decks' })).toBeVisible();
    await expect(tools.locator('[data-tour="tool-trading"]')).toHaveAttribute('aria-disabled', 'true');
});
