/**
 * Study composer layout: phones must not squeeze the draft beside the
 * attach / settings / voice buttons.
 */
const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');

async function openStudy(page) {
    await page.route('**/api/app/voice/capabilities', async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ stt: true, tts: true, live: true })
        });
    });
    await login(page);
    await page.goto('/app/study');
    await expect(page.getByLabel('Message Goobster')).toBeVisible();
    await expect(page.getByLabel('Voice chat')).toBeVisible();
}

test.describe('Study composer', () => {
    test('on a phone, the textarea uses the full composer width and grows', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await openStudy(page);

        const input = page.getByLabel('Message Goobster');
        const attach = page.getByLabel('Attach files');
        const settings = page.getByLabel('Chat settings');
        const send = page.getByLabel('Send');
        const wrap = page.locator('.composer-wrap');

        const inputBox = await input.boundingBox();
        const wrapBox = await wrap.boundingBox();
        const attachBox = await attach.boundingBox();
        expect(inputBox).toBeTruthy();
        expect(wrapBox).toBeTruthy();
        expect(attachBox).toBeTruthy();

        // Full-width row: only wrap padding (10px each side) sits beside it.
        expect(inputBox.width).toBeGreaterThan(wrapBox.width - 36);
        // Tools sit on the row beneath, not beside the draft.
        expect(attachBox.y).toBeGreaterThan(inputBox.y + inputBox.height - 8);
        await expect(settings).toBeVisible();
        await expect(send).toBeVisible();

        const before = inputBox.height;
        await input.fill(`${'A long thought that should wrap. '.repeat(12)}And a bit more.`);
        const after = await input.boundingBox();
        expect(after.height).toBeGreaterThan(before + 16);
        expect(after.width).toBeGreaterThan(wrapBox.width - 36);
    });

    test('on desktop, tools stay on the same row as the input', async ({ page }) => {
        await page.setViewportSize({ width: 1280, height: 800 });
        await openStudy(page);

        const inputBox = await page.getByLabel('Message Goobster').boundingBox();
        const attachBox = await page.getByLabel('Attach files').boundingBox();
        const wrapBox = await page.locator('.composer-wrap').boundingBox();
        expect(inputBox).toBeTruthy();
        expect(attachBox).toBeTruthy();
        expect(wrapBox).toBeTruthy();

        expect(Math.abs(inputBox.y - attachBox.y)).toBeLessThan(24);
        expect(inputBox.x).toBeGreaterThan(attachBox.x + attachBox.width);
        expect(inputBox.width).toBeLessThan(wrapBox.width - 120);
    });
});
