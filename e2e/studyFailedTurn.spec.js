/**
 * A Study turn the model fails (this harness has no provider, so every
 * turn fails) keeps the user's message and the error reply on screen. The
 * server stores nothing for a failed turn, so the local copy is all there
 * is - it must survive the history reconcile and the live-turn poll that
 * settles afterwards, in a brand-new chat and in an existing one.
 */
const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');

test('a failed turn keeps the message and its error visible', async ({ page }) => {
    await login(page);
    await page.goto('/app/chat');
    const box = page.getByRole('textbox', { name: 'Message Goobster' });
    await box.fill('Study test message one');
    await box.press('Enter');
    await expect(page.locator('.msg.assistant.error')).toBeVisible();
    await expect(page.locator('.chat-log')).toContainText('Study test message one');
    // The poll that notices the server turn ended must not wipe it.
    await page.waitForTimeout(2500);
    await expect(page.locator('.chat-log')).toContainText('Study test message one');
    await expect(page.locator('.msg.assistant.error')).toBeVisible();
    // The route only changes once a turn settles, so the chat is still selected.
    await expect(page.locator('.conv-item.active')).toContainText('Study test message one');

    await box.fill('Study test message two');
    await box.press('Enter');
    await expect(page.locator('.chat-log')).toContainText('Study test message two');
    await page.waitForTimeout(2500);
    await expect(page.locator('.chat-log')).toContainText('Study test message two');
    expect(await page.locator('.msg.user').count()).toBe(1);
});
