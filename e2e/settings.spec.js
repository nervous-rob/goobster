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

test('mobile savebar layout and interaction on narrow screens', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page);
    await page.goto('/app/settings/profile');

    // Initially clean state: static in document flow at the end of section
    const cleanNote = page.getByText('All changes saved');
    await expect(cleanNote).toBeVisible();
    const cleanBar = page.locator('.settings-savebar');
    await expect(cleanBar).not.toHaveClass(/is-dirty/);
    await expect(cleanBar.locator('.settings-save-btn')).toBeHidden();

    // Make an edit to a field that differs from the saved baseline
    const directiveInput = page.locator('#personality-directive-input');
    await directiveInput.fill('Dry wit, warm underneath.');
    await expect(page.getByText('Unsaved changes')).toBeVisible();
    await expect(cleanBar).toHaveClass(/is-dirty/);
    await expect(cleanBar.locator('.settings-save-btn')).toBeVisible();

    const savebarBox = await cleanBar.boundingBox();
    // Should be docked at bottom of viewport (y + height around 844)
    expect(savebarBox.y + savebarBox.height).toBeCloseTo(844, -1);
    // Height should be compact (<= 60px)
    expect(savebarBox.height).toBeLessThanOrEqual(60);

    await page.screenshot({ path: '/opt/cursor/artifacts/mobile_settings_savebar_dirty.png' });

    await page.locator('.settings-content').evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await page.screenshot({ path: '/opt/cursor/artifacts/mobile_settings_savebar_dirty_bottom.png' });

    // Discard restores clean state
    await page.getByRole('button', { name: 'Discard' }).click();
    await expect(directiveInput).toHaveValue('');
    await expect(page.getByText('All changes saved')).toBeVisible();
    await expect(cleanBar).not.toHaveClass(/is-dirty/);

    await page.locator('.settings-content').evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await page.screenshot({ path: '/opt/cursor/artifacts/mobile_settings_savebar_clean.png' });
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
    await expect(page.locator('#retention').getByText(/Currently:/)).toContainText('kept forever');
    await page.locator('#retention-input').selectOption('30');
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Auto-delete after 30 days?' })).toBeVisible();
    await expect(dialog.getByText('Nothing has been deleted yet.')).toBeVisible();
    await dialog.getByRole('button', { name: /Apply/ }).click();
    await expect(page.getByText('Memories now expire after 30 days')).toBeVisible();
    await expect(page.locator('#retention').getByText(/Currently:/)).toContainText('after 30 days');
});

test('search finds Phase 2 fields and account sessions list this device', async ({ page }) => {
    await login(page);
    await openSettings(page);
    const search = page.getByRole('combobox', { name: 'Search settings' });
    await search.fill('timezone');
    await page.getByRole('option').filter({ hasText: /^Timezone/ }).getByRole('button').click();
    await expect(page).toHaveURL(/\/app\/settings\/profile#timezone$/);
    await expect(page.locator('#timezone-input')).toBeVisible();
    await page.locator('#timezone-input').selectOption('America/New_York');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Profile saved.')).toBeVisible();

    await page.getByRole('link', { name: /Account/ }).click();
    await expect(page.locator('#sessions-input')).toBeVisible();
    await expect(page.locator('#sessions-input').getByText(/This device/)).toBeVisible();
});

test('search finds Phase 3 fields and chat-history shows a preview', async ({ page }) => {
    await login(page);
    await openSettings(page);
    const search = page.getByRole('combobox', { name: 'Search settings' });
    await search.fill('personality preset');
    await page.getByRole('option').filter({ hasText: 'Personality preset' }).getByRole('button').click();
    await expect(page).toHaveURL(/\/app\/settings\/profile#personality-preset$/);
    await page.locator('#personality-preset-input').selectOption('concise-direct');
    await expect(page.locator('#answer-length-input')).toHaveValue('concise');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Profile saved.')).toBeVisible();

    await search.fill('learn memories');
    await page.getByRole('option').filter({ hasText: 'Learn new long-term memories' }).getByRole('button').click();
    await expect(page).toHaveURL(/\/app\/settings\/memory#learn-memories$/);
    await page.locator('#learn-memories-input').click();
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Memory & privacy saved.')).toBeVisible();

    await page.locator('#chat-history-input').selectOption('30');
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: /Expire Study chats after 30 days/ })).toBeVisible();
    await expect(dialog.getByText('Nothing has been deleted yet.')).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.locator('#chat-history-input')).toHaveValue('');
});

test('room shortcuts open the matching section with a way back', async ({ page }) => {
    await login(page);
    await page.getByRole('navigation', { name: 'Rooms' }).getByRole('link', { name: /Chat/ }).click();
    await page.getByRole('button', { name: 'Chat settings' }).click();
    await expect(page).toHaveURL(/\/app\/settings\/chat/);
    await expect(page.getByRole('heading', { level: 1, name: 'Chat & models' })).toBeVisible();
    await page.getByRole('link', { name: /Back to Chat/ }).click();
    await expect(page).toHaveURL(/\/app\/chat/);
});

test('saved creation defaults reach the expedition and persona forms', async ({ page }) => {
    await login(page);
    await page.goto('/app/settings/appearance');
    await page.getByLabel('Expedition depth', { exact: true }).selectOption('deep');
    await page.getByLabel('Expedition lens', { exact: true }).selectOption('mathematics');
    await page.getByLabel('New persona emoji', { exact: true }).fill('🔬');
    await page.getByLabel('New persona charter', { exact: true }).fill('Follow the evidence.');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.getByText('All changes saved')).toBeVisible();
    await page.goto('/app/knowledge/research');
    await page.getByRole('button', { name: '+ New expedition', exact: true }).click();
    await expect(page.locator('#exp-lens')).toHaveValue('mathematics');
    await expect(page.locator('.depth-card.active')).toContainText('Deep');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.goto('/app/parlor');
    await page.getByTitle('New persona', { exact: true }).click();
    await expect(page.getByLabel(/Charter/)).toHaveValue('Follow the evidence.');
    await expect(page.getByLabel('Emoji', { exact: true })).toHaveValue('🔬');
    await page.getByPlaceholder('The Researcher').fill('Test scientist');
    await expect(page.getByRole('button', { name: 'Create', exact: true })).toBeEnabled();
});
