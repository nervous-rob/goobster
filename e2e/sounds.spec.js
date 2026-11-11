/* global window, AudioBufferSourceNode */
const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');

test('sound families preview real assets, save, and respect mute and category settings', async ({ page }) => {
    test.setTimeout(90_000);
    await page.addInitScript(() => {
        window.soundStarts = [];
        const start = AudioBufferSourceNode.prototype.start;
        AudioBufferSourceNode.prototype.start = function (...args) {
            window.soundStarts.push(this.buffer?.duration);
            return start.apply(this, args);
        };
    });
    await login(page);
    await page.goto('/app/settings/initiative');
    await expect(page.locator('#sound-family-input')).toHaveValue('goo-pop');
    await expect(page.getByLabel('Enable app sounds')).not.toBeChecked();
    const cues = ['notification', 'success', 'attention', 'failure', 'send', 'voice-open', 'voice-close'];
    for (const family of ['goo-pop', 'pocket-wood', 'prism', 'orbit']) {
        await page.locator('#sound-family-input').selectOption(family);
        for (const cue of cues) {
            const response = page.waitForResponse(r => r.url().endsWith(`/sounds/${family}/${cue}.wav`));
            const before = await page.evaluate(() => window.soundStarts.length);
            await page.getByRole('button', { name: `Preview ${cue.replace('-', ' ')}`, exact: true }).click();
            expect((await response).status()).toBe(200);
            await expect.poll(() => page.evaluate(() => window.soundStarts.length)).toBe(before + 1);
        }
    }
    await page.getByLabel('Enable app sounds').check();
    await page.locator('#sound-volume-input').fill('35');
    await page.getByLabel('Chat sends and action errors').uncheck();
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.getByText('All changes saved')).toBeVisible();
    await page.reload();
    await expect(page.locator('#sound-family-input')).toHaveValue('orbit');
    await expect(page.locator('#sound-volume-input')).toHaveValue('35');
    await expect(page.getByLabel('Chat sends and action errors')).not.toBeChecked();
    // A gesture unlocks automatic cues. A fresh inbox failure must use the
    // notification category, even when interaction sounds are disabled.
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('goobster-inbox', {
        detail: { itemId: 987654, kind: 'system', sourceType: 'work_failure' }
    })));
    await expect.poll(() => page.evaluate(() => window.soundStarts.length)).toBe(1);
    await page.waitForTimeout(800);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('goobster-inbox', {
        detail: { itemId: 987654, kind: 'system', sourceType: 'work_failure' }
    })));
    await page.waitForTimeout(350);
    expect(await page.evaluate(() => window.soundStarts.length)).toBe(1);
    await page.getByLabel('Enable app sounds').uncheck();
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.getByText('All changes saved')).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('goobster-inbox', {
        detail: { itemId: 987655, kind: 'task' }
    })));
    await page.waitForTimeout(350);
    expect(await page.evaluate(() => window.soundStarts.length)).toBe(1);
});
