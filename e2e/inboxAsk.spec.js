const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');
const C = require('./constants');
const TITLE = 'JWST Atlas: run failed';

for (const narrow of [false, true]) {
    test(`Inbox draft survives refresh and Back, and its chip can be removed (${narrow ? 'narrow' : 'desktop'})`, async ({ page }) => {
        if (narrow) await page.setViewportSize({ width: 390, height: 844 });
        await login(page);
        let sends = 0;
        page.on('request', request => {
            if (request.method() === 'POST' && /\/api\/app\/(chat(?:\/queue)?|parlor\/chat)$/.test(new URL(request.url()).pathname)) sends++;
        });
        await page.goto('/app/activity/inbox');
        const row = page.locator('.inbox-row').filter({ hasText: TITLE });
        if (narrow) await expect(row.locator('.inbox-ask-compact')).toBeHidden();
        await row.getByRole('button', { name: new RegExp(TITLE), expanded: false }).click();
        await expect(page).toHaveURL(/#inbox-\d+$/);
        const origin = page.url();
        const askButton = row.getByRole('button', { name: 'Ask Goobster', exact: true });
        await askButton.focus();
        await askButton.press('Enter');
        await expect(page).toHaveURL(/\/app\/chat\/\d+$/);
        await expect(page.locator('[aria-label="Inbox context"]')).toContainText(TITLE);
        const composer = page.locator('[data-tour="chat-composer"]');
        await expect(composer).toHaveValue('Why did this fail, and what should I do next?');
        await page.screenshot({ path: test.info().outputPath('inbox-context.png') });
        await composer.fill('What is the smallest safe fix?');
        await page.reload();
        await expect(composer).toHaveValue('What is the smallest safe fix?');
        await expect(page.locator('[aria-label="Inbox context"]')).toContainText(TITLE);
        await page.goBack();
        await expect(page).toHaveURL(origin);
        await expect(row.getByRole('button', { name: new RegExp(TITLE), expanded: true })).toBeVisible();
        await expect(row.getByText('Asked in', { exact: false })).toBeVisible();
        await row.getByRole('link', { name: `About: ${TITLE}` }).click();
        await page.getByRole('button', { name: `Remove context: ${TITLE}` }).click();
        await expect(page.locator('[aria-label="Inbox context"]')).toHaveCount(0);
        await page.reload();
        await expect(page.locator('[aria-label="Inbox context"]')).toHaveCount(0);
        expect(sends).toBe(0);
    });
}

test('Ask in the project opens the shared Conversation and keeps the draft and personal chip', async ({ page }) => {
    await login(page);
    await page.goto('/app/activity/inbox');
    const row = page.locator('.inbox-row').filter({ hasText: TITLE });
    await row.getByRole('button', { name: new RegExp(TITLE), expanded: false }).click();
    await row.getByRole('button', { name: 'Ask in the project', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/app/projects/${C.OWNER}/${C.PROJECT_SLUG}/conversation$`));
    await expect(page.locator('[aria-label="Inbox context"]')).toContainText('visible to project members');
    await expect(page.locator('.obs-chat-dock-composer textarea')).toHaveValue('Why did this fail, and what should I do next?');
    await page.reload();
    await expect(page.locator('[aria-label="Inbox context"]')).toContainText(TITLE);
    await expect(page.locator('.obs-chat-dock-composer textarea')).toHaveValue('Why did this fail, and what should I do next?');
    await page.getByRole('button', { name: `Remove context: ${TITLE}` }).click();
    await expect(page.locator('[aria-label="Inbox context"]')).toHaveCount(0);
});
