/**
 * Discussions: picking a discussion from the list while the address names
 * another one opens the picked one (the route used to pull the room back to
 * the discussion in the address).
 */
const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');
const C = require('./constants');

test.beforeEach(async ({ page }) => {
    await login(page);
});

test('choosing another discussion from a deep link opens it and the address follows', async ({ page }) => {
    const { conversations } = await page.request.get('/api/app/parlor/conversations').then((r) => r.json());
    const salon = conversations.find((c) => c.title === 'Salon on ingest');
    expect(salon).toBeTruthy();
    const { personas } = await page.request.get('/api/app/parlor/personas').then((r) => r.json());
    const created = await page.request.post('/api/app/parlor/conversations', { data: { personaIds: [personas[0].id] } });
    expect(created.ok()).toBe(true);
    const other = await created.json();
    try {
        await page.goto(`/app/discussions/${salon.id}`);
        await expect(page.getByText(C.PARLOR_REPLY)).toBeVisible();

        await page.locator('.conv-item', { hasText: 'New discussion' }).click();
        await expect(page).toHaveURL(new RegExp(`/app/discussions/${other.id}$`));
        await expect(page.getByText(C.PARLOR_REPLY)).toHaveCount(0);

        // Back returns to the discussion the link named.
        await page.goBack();
        await expect(page).toHaveURL(new RegExp(`/app/discussions/${salon.id}$`));
        await expect(page.getByText(C.PARLOR_REPLY)).toBeVisible();
    } finally {
        await page.request.delete(`/api/app/parlor/conversations/${other.id}`);
    }
});
