/**
 * Appearance: the accent palette and the navigation layout. Both preview
 * live, both save to the account and keep a device copy, and both are
 * painted before the app mounts on reload. The top-bar layout keeps the
 * same "Rooms" landmark and Settings link the sidebar exposes, so the
 * rest of the portal (and its tests) address navigation the same way.
 */
/* global document, getComputedStyle */
const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');

// Later specs address the sidebar; put the account back however a run ended.
test.afterEach(async ({ page }) => {
    await page.request.patch('/api/app/settings/appearance', {
        data: { changes: { accent: 'blueberry', navLayout: 'sidebar' } }
    }).catch(() => {});
});

async function accentOf(page) {
    return page.evaluate(() => document.documentElement.getAttribute('data-accent'));
}

async function accentRgb(page) {
    return page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--accent').trim());
}

test('accent previews live, saves to the account, and survives a reload', async ({ page }) => {
    await login(page);
    await page.goto('/app/settings/appearance');

    const swatches = page.getByRole('radiogroup', { name: 'Accent color' });
    await expect(swatches.getByRole('radio', { name: 'Blueberry' })).toHaveAttribute('aria-checked', 'true');
    const before = await accentRgb(page);

    await swatches.getByRole('radio', { name: 'Mint' }).click();
    expect(await accentOf(page)).toBe('mint');
    const previewed = await accentRgb(page);
    expect(previewed).not.toBe(before);
    await expect(page.getByText('Unsaved changes')).toBeVisible();

    // Discard paints the stored accent back.
    await page.getByRole('button', { name: 'Discard' }).click();
    expect(await accentOf(page)).toBe('blueberry');
    expect(await accentRgb(page)).toBe(before);

    await swatches.getByRole('radio', { name: 'Sunset' }).click();
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.getByText('All changes saved')).toBeVisible();

    const settings = await page.request.get('/api/app/settings');
    expect((await settings.json()).sections.appearance.values.accent).toBe('sunset');
    expect(await page.evaluate(() => localStorage.getItem('goobster-accent'))).toBe('sunset');

    await page.reload();
    expect(await accentOf(page)).toBe('sunset');
    await expect(page.getByRole('radiogroup', { name: 'Accent color' }).getByRole('radio', { name: 'Sunset' }))
        .toHaveAttribute('aria-checked', 'true');
    await page.screenshot({ path: '/opt/cursor/artifacts/appearance_accent_sunset.png' });
});

test('the accent follows light and dark surfaces', async ({ page }) => {
    await login(page);
    await page.goto('/app/settings/appearance');
    await page.getByRole('radiogroup', { name: 'Accent color' }).getByRole('radio', { name: 'Ocean' }).click();
    const dark = await accentRgb(page);
    await page.getByRole('radio', { name: /Light/ }).click();
    await expect(page.locator('body')).toHaveClass(/light/);
    const light = await accentRgb(page);
    expect(light).not.toBe(dark);
    expect(await accentOf(page)).toBe('ocean');
});

test('navigation layout previews live and moves the rooms to a top bar', async ({ page }) => {
    await login(page);
    await page.goto('/app/settings/appearance');
    await expect(page.locator('#sidebar')).toBeVisible();
    await expect(page.locator('#topbar')).toHaveCount(0);

    await page.getByRole('radiogroup', { name: 'Navigation layout' }).getByRole('radio', { name: /Across the top/ }).click();
    const topbar = page.locator('#topbar');
    await expect(topbar).toBeVisible();
    await expect(page.locator('#sidebar')).toHaveCount(0);
    await expect(page.locator('.app')).toHaveClass(/nav-top/);

    // Same landmark and entries as the sidebar; the bar sits above the stage.
    const nav = topbar.getByRole('navigation', { name: 'Rooms' });
    await expect(nav.getByRole('link', { name: /Chat/ })).toBeVisible();
    await expect(nav.getByRole('link', { name: /Activity/ })).toBeVisible();
    const barBox = await topbar.boundingBox();
    const stageBox = await page.locator('#stage').boundingBox();
    expect(barBox.y).toBe(0);
    expect(stageBox.y).toBeGreaterThanOrEqual(barBox.y + barBox.height - 1);
    expect(stageBox.x).toBeLessThan(20);

    // Discard puts the sidebar back without saving anything.
    await page.getByRole('button', { name: 'Discard' }).click();
    await expect(page.locator('#sidebar')).toBeVisible();
    await expect(topbar).toHaveCount(0);

    await page.getByRole('radiogroup', { name: 'Navigation layout' }).getByRole('radio', { name: /Across the top/ }).click();
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.getByText('All changes saved')).toBeVisible();
    const settings = await page.request.get('/api/app/settings');
    expect((await settings.json()).sections.appearance.values.navLayout).toBe('top');

    // Persisted: a reload renders the bar straight away, and the account
    // menu carries what the sidebar footer held.
    await page.reload();
    await expect(page.locator('#topbar')).toBeVisible();
    await expect(page.locator('#sidebar')).toHaveCount(0);
    await page.screenshot({ path: '/opt/cursor/artifacts/appearance_top_nav_settings.png' });

    await page.locator('#topbar').getByRole('navigation', { name: 'Rooms' }).getByRole('link', { name: /Chat/ }).click();
    await expect(page).toHaveURL(/\/app\/chat/);
    await expect(page.locator('#topbar a.nav-btn[data-room="chat"]')).toHaveClass(/active/);
    // The room header's ☰ opens a drawer this layout does not have, so it hides.
    await expect(page.locator('.icon-action.menu-btn').first()).toBeHidden();
    await page.screenshot({ path: '/opt/cursor/artifacts/appearance_top_nav_chat.png' });

    await page.getByRole('button', { name: 'Account menu' }).click();
    const menu = page.getByRole('menu', { name: 'Account' });
    await expect(menu.getByRole('menuitem', { name: /Usage/ })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /Documentation/ })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Log out' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);

    // Settings stays one click away from the bar (the tutorial anchor too).
    await page.locator('#topbar [data-tour="nav-settings"]').click();
    await expect(page).toHaveURL(/\/app\/settings/);

    // Back to the sidebar.
    await page.goto('/app/settings/appearance');
    await page.getByRole('radiogroup', { name: 'Navigation layout' }).getByRole('radio', { name: /Sidebar/ }).click();
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.getByText('All changes saved')).toBeVisible();
    await expect(page.locator('#sidebar')).toBeVisible();
});

test('the top bar scrolls sideways on a phone instead of opening a drawer', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page);
    await page.goto('/app/settings/appearance');
    await page.getByRole('radiogroup', { name: 'Navigation layout' }).getByRole('radio', { name: /Across the top/ }).click();
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.getByText('All changes saved')).toBeVisible();

    await page.goto('/app/chat');
    const topbar = page.locator('#topbar');
    await expect(topbar).toBeVisible();
    const nav = topbar.locator('.topbar-nav');
    const scrollable = await nav.evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(scrollable).toBe(true);
    await expect(page.locator('.icon-action.menu-btn').first()).toBeHidden();
    await page.screenshot({ path: '/opt/cursor/artifacts/appearance_top_nav_mobile.png' });

    await page.goto('/app/settings/appearance');
    await page.getByRole('radiogroup', { name: 'Navigation layout' }).getByRole('radio', { name: /Sidebar/ }).click();
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.getByText('All changes saved')).toBeVisible();
});
