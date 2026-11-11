const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');

test('scheduled tasks can be created, paused, edited, filtered and restored on reload', async ({ page }) => {
    await login(page);
    await page.goto('/app/activity/scheduled');
    await expect(page.getByRole('heading', { name: 'Scheduled', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'New task' }).click();
    const dialog = page.getByRole('dialog', { name: 'New task' });
    await dialog.getByLabel('Name', { exact: true }).fill('Browser responsibility');
    await dialog.getByLabel('What should Goobster do?').fill('Review my project blockers without changing anything.');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    let row = page.locator('.task-row').filter({ hasText: 'Browser responsibility' });
    await expect(row).toBeVisible();
    await row.getByRole('switch').click();
    await expect(row.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    await row.getByRole('button', { name: 'Edit Browser responsibility' }).click();
    const edit = page.getByRole('dialog', { name: 'Edit task' });
    await edit.getByLabel('Name', { exact: true }).fill('Weekly responsibility');
    await edit.getByRole('combobox', { name: 'Schedule (UTC)' }).selectOption('0 17 * * 5');
    await edit.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('combobox', { name: 'Filter scheduled work' }).selectOption('paused');
    row = page.locator('.task-row').filter({ hasText: 'Weekly responsibility' });
    await expect(row).toContainText('Fridays at 17:00');
    await page.reload();
    await expect(page.locator('.task-row').filter({ hasText: 'Weekly responsibility' }).getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    await page.getByRole('searchbox', { name: 'Search scheduled work' }).fill('no such responsibility');
    await expect(page.getByText('No scheduled work matches this view.')).toBeVisible();
    const tasks = await (await page.request.get('/api/app/tasks')).json();
    for (const task of tasks.automations.filter(t => t.name === 'Weekly responsibility')) await page.request.delete(`/api/app/tasks/automations/${task.id}`);
});

test('scheduled tasks remain usable on a narrow screen', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page);
    await page.goto('/app/activity/scheduled');
    await expect(page.getByRole('button', { name: 'New task' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Commitments & watches →' })).toBeVisible();
    await page.getByRole('button', { name: 'New task' }).click();
    await expect(page.getByRole('dialog', { name: 'New task' })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.window.innerWidth)).toBe(true);
});


test('delegated responsibilities have one searchable management page with setup shortcuts', async ({ page }) => {
    const userId = '99000000000000681';
    const name = 'Responsibility manager';
    const seeded = await page.request.post('/e2e/fixtures/assistant-home', { data: { userId, name, seed: false } });
    expect(seeded.ok(), await seeded.text()).toBe(true);
    await login(page, { userId, name });
    await page.getByRole('button', { name: 'Responsibilities', exact: true }).click();
    await expect(page).toHaveURL(/\/app\/assistant$/);
    await page.getByRole('button', { name: 'New responsibility', exact: true }).click();
    await expect(page.getByTestId('responsibility-title')).toBeFocused();
    await page.getByTestId('responsibility-title').fill('Look after garden research');
    await page.getByTestId('responsibility-save').click();
    const row = page.getByTestId('responsibility-row').filter({ hasText: 'Look after garden research' });
    await expect(row).toBeVisible();
    await page.getByRole('combobox', { name: 'Filter responsibilities' }).selectOption('ACTIVE');
    await expect(page.getByText('No responsibilities match this view.')).toBeVisible();
    await page.getByRole('combobox', { name: 'Filter responsibilities' }).selectOption('DRAFT');
    await page.getByRole('searchbox', { name: 'Search responsibilities' }).fill('garden');
    await expect(row).toBeVisible();
    await expect(row.getByTestId('responsibility-status')).toHaveText('draft');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('button', { name: 'Initiative & boundaries' })).toBeVisible();
    expect(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.window.innerWidth)).toBe(true);
    await page.getByRole('link', { name: 'Scheduled tasks →' }).click();
    await expect(page).toHaveURL(/\/app\/activity\/scheduled$/);
    await expect(page.getByRole('heading', { name: 'Scheduled', exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Responsibilities →', exact: true }).click();
    await expect(page).toHaveURL(/\/app\/assistant$/);
    await expect(row).toBeVisible();
});
