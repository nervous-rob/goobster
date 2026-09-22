const { expect } = require('@playwright/test');
const { OWNER, OWNER_NAME } = require('./constants');

/**
 * Mint a webapp.devMode session through the login form (the real React
 * wiring, not a cookie inject). The heading on Home includes the display name.
 *
 * Tutorial auto-start defaults off for e2e so the offer panel does not
 * intercept clicks in unrelated journeys. Suites that exercise offers
 * (tutorials.spec.js) re-enable via /e2e/fixtures/tutorial-progress or
 * the Settings toggle.
 */
async function login(page, { userId = OWNER, name = OWNER_NAME, autoStartTutorials = false } = {}) {
    // Seed prefs before the session mounts TutorialProvider so the first
    // /api/app/tutorials fetch already has the intended autoStart.
    const seeded = await page.request.post('/e2e/fixtures/tutorial-progress', {
        data: { userId, autoStart: Boolean(autoStartTutorials), rows: [] }
    });
    expect(seeded.ok()).toBe(true);

    await page.goto('/app/');
    await expect(page.getByText('Dev mode — mint a local identity')).toBeVisible();
    await page.getByPlaceholder('Principal id (digits or usr_…)').fill(userId);
    await page.getByPlaceholder('Display name').fill(name);
    await page.getByRole('button', { name: 'Enter' }).click();
    await expect(page.getByRole('heading', { name: new RegExp(name) })).toBeVisible({
        timeout: 15_000
    });

    // Belt-and-suspenders: dismiss a racey offer if one still painted.
    const dismiss = page.locator('[data-tour="tutorial-offer-dismiss"]');
    if (await dismiss.isVisible().catch(() => false)) {
        await dismiss.click();
        await expect(page.locator('[data-tour="tutorial-offer"]')).toHaveCount(0);
    }
}

async function openRoom(page, label) {
    await page.getByRole('navigation', { name: 'Rooms' }).getByRole('link', { name: label }).click();
}

module.exports = { login, openRoom };
