const { test, expect } = require('@playwright/test');

// A signed-out visitor's /me query has no data, so every background poll
// used to flip the session gate back to "Looking around…" and unmount the
// sign-up form, erasing whatever had been typed.
test('the sign-up form keeps what was typed across the session poll', async ({ page }) => {
    let mePolls = 0;
    await page.route('**/api/app/me', async route => {
        mePolls += 1;
        await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Not signed in', code: 'UNAUTHENTICATED' }) });
    });
    await page.route('**/api/app/config', async route => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ registration: 'open', registrationPaused: null, installationName: 'Test Berry', passwordMinLength: 15 })
        });
    });

    await page.clock.install();
    await page.goto('/app/register');
    await expect(page.getByRole('heading', { name: 'Join Test Berry' })).toBeVisible();

    await page.getByLabel('Email').fill('someone@example.com');
    await page.getByLabel('Login name').fill('someone');
    await page.getByLabel('Passphrase (at least 15 characters)').fill('a long enough passphrase');
    const pollsBefore = mePolls;

    await page.clock.runFor(16_000);
    await expect.poll(() => mePolls).toBeGreaterThan(pollsBefore);
    await page.clock.runFor(16_000);

    await expect(page.getByLabel('Email')).toHaveValue('someone@example.com');
    await expect(page.getByLabel('Login name')).toHaveValue('someone');
    await expect(page.getByLabel('Passphrase (at least 15 characters)')).toHaveValue('a long enough passphrase');
});
