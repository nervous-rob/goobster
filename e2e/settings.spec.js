/**
 * Settings: one searchable home for personal preferences. Search deep-links
 * to a control, sections save with explicit Save/Discard, resets are
 * previewed, attention limits never turn attention on, and the retention
 * change shows its impact before deleting anything. No AI, no Discord.
 */
const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');

async function openSettings(page) {
    await page.getByRole('link', { name: 'Settings' }).first().click();
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
}

test('search lands on the control and Save persists a profile change', async ({ page }) => {
    await login(page);
    await openSettings(page);

    const search = page.getByRole('combobox', { name: 'Search settings' });
    await search.fill('call me');
    await page.getByRole('option').filter({ hasText: 'What Goobster calls you' }).getByRole('button').click();
    await expect(page).toHaveURL(/\/app\/settings\/profile#preferred-name$/);
    const nameInput = page.locator('#preferred-name-input');
    await expect(nameInput).toBeFocused();

    await nameInput.fill('Captain');
    await expect(page.getByText('Unsaved changes')).toBeVisible();
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Profile saved.')).toBeVisible();
    await expect(page.getByText('All changes saved')).toBeVisible();

    await page.reload();
    await expect(page.locator('#preferred-name-input')).toHaveValue('Captain');
    await expect(page.getByText(/Currently\s+Captain/)).toBeVisible();
});

test('Discard restores the saved value and leaving with edits asks first', async ({ page }) => {
    await login(page);
    await page.goto('/app/settings/profile');
    const bot = page.locator('#bot-name-input');
    await bot.fill('Goob');
    await page.getByRole('button', { name: 'Discard' }).click();
    await expect(bot).toHaveValue('');

    await bot.fill('Goob');
    await page.getByRole('link', { name: /Chat & models/ }).click();
    const guard = page.getByRole('dialog');
    await expect(guard.getByText('You have unsaved settings changes. Leave and discard them?')).toBeVisible();
    await guard.getByRole('button', { name: 'Cancel' }).click();
    await expect(page).toHaveURL(/\/settings\/profile/);
    await expect(bot).toHaveValue('Goob');
});

test('reset previews the diff and applies without touching other sections', async ({ page }) => {
    await login(page);
    await page.goto('/app/settings/profile');
    await page.locator('#bot-name-input').fill('Goob');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Profile saved.')).toBeVisible();

    await page.getByRole('button', { name: 'Reset to defaults…' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('What you call Goobster')).toBeVisible();
    await expect(dialog.getByText(/Goob → default/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Reset', exact: true }).click();
    await expect(page.getByText('Profile reset to defaults.')).toBeVisible();
    await expect(page.locator('#bot-name-input')).toHaveValue('');
});

test('saving initiative limits leaves the attention switch alone', async ({ page }) => {
    // The e2e seed enrolls the owner; turn it off first via the explicit switch.
    await login(page);
    await page.goto('/app/settings/initiative');
    const toggle = page.getByRole('switch', { name: 'Pay attention on my behalf' });
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await toggle.click();
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');

    await page.getByRole('radio', { name: 'observe' }).click();
    await page.locator('#contact-budget-input').fill('1');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Initiative saved.')).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByRole('radio', { name: 'observe' })).toHaveAttribute('aria-checked', 'true');
});

test('retention shows a read-only impact preview before applying', async ({ page }) => {
    await login(page);
    await page.goto('/app/settings/memory');
    await expect(page.getByText(/Currently:/)).toContainText('kept forever');
    await page.locator('#retention-input').selectOption('30');
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Auto-delete after 30 days?' })).toBeVisible();
    await expect(dialog.getByText('Nothing has been deleted yet.')).toBeVisible();
    await dialog.getByRole('button', { name: /Apply/ }).click();
    await expect(page.getByText('Memories now expire after 30 days')).toBeVisible();
    await expect(page.getByText(/Currently:/)).toContainText('after 30 days');
});

test('room shortcuts open the matching section with a way back', async ({ page }) => {
    await login(page);
    await page.getByRole('navigation', { name: 'Rooms' }).getByRole('link', { name: 'Study' }).click();
    await page.getByRole('button', { name: 'Chat settings' }).click();
    await expect(page).toHaveURL(/\/app\/settings\/chat/);
    await expect(page.getByRole('heading', { level: 1, name: 'Chat & models' })).toBeVisible();
    await page.getByRole('link', { name: /Back to the Study/ }).click();
    await expect(page).toHaveURL(/\/app\/study/);
});
