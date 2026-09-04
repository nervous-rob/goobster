const { expect } = require('@playwright/test');
const { OWNER, OWNER_NAME } = require('./constants');

/**
 * Mint a webapp.devMode session through the login form (the real React
 * wiring, not a cookie inject). The heading on Home includes the display name.
 */
async function login(page, { userId = OWNER, name = OWNER_NAME } = {}) {
    await page.goto('/app/');
    await expect(page.getByText('Dev mode — mint a local identity')).toBeVisible();
    await page.getByPlaceholder('Discord user id (digits)').fill(userId);
    await page.getByPlaceholder('Display name').fill(name);
    await page.getByRole('button', { name: 'Enter' }).click();
    await expect(page.getByRole('heading', { name: new RegExp(name) })).toBeVisible({
        timeout: 15_000
    });
}

async function openRoom(page, label) {
    await page.getByRole('navigation', { name: 'Rooms' }).getByRole('link', { name: label }).click();
}

module.exports = { login, openRoom };
