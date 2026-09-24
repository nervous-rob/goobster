const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');

for (const [index, mode] of [
    { name: 'keyboard', width: 1280, height: 800 },
    { name: 'narrow reduced motion', width: 375, height: 667 },
    { name: '200% zoom equivalent viewport', width: 640, height: 400 }
].entries()) {
    test(`Research tour: ${mode.name}, feedback, Back, skip and resume without providers`, async ({ page }) => {
        let workRequests = 0;
        page.on('request', r => { if (r.method() === 'POST' && /\/expeditions(?:\?|$)|\/briefs(?:\?|$)/.test(r.url())) workRequests++; });
        await page.setViewportSize({ width: mode.width, height: mode.height });
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await login(page, { userId: `99000000000000027${index}`, name: 'Research learner' });
        await page.goto('/app/settings/tutorials');
        const row = page.locator('.tutorial-row[data-tutorial-id="knowledge.research"]');
        await row.getByRole('button', { name: 'Resume', exact: true }).click();
        const panel = page.getByRole('region', { name: 'Research tutorial', exact: true });
        await expect(panel).toBeVisible();
        await expect(panel.getByRole('button', { name: 'Back', exact: true })).toBeDisabled();
        const box = await panel.boundingBox();
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(mode.width);
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.y + box.height).toBeLessThanOrEqual(mode.height);
        await expect(panel).toHaveCSS('animation-name', 'none');
        // Native buttons and a named group expose feedback to assistive technology.
        const unclear = panel.getByRole('group', { name: 'Step feedback' }).getByRole('button', { name: 'Unclear', exact: true });
        await unclear.focus();
        await expect(unclear).toBeFocused();
        const feedback = page.waitForResponse(r => r.url().includes('/knowledge.research/events') && r.request().postDataJSON()?.action === 'feedback');
        await page.keyboard.press('Enter');
        expect((await feedback).ok()).toBe(true);
        await expect(page.locator('#toast')).toContainText('Step feedback saved.');
        await expect(panel).toHaveAttribute('data-step-id', 'question-budget');
        await panel.getByRole('button', { name: 'Next', exact: true }).click();
        await expect(panel).toHaveAttribute('data-step-id', 'progress-stop');
        await panel.getByRole('button', { name: 'Back', exact: true }).click();
        await expect(panel).toHaveAttribute('data-step-id', 'question-budget');
        await panel.getByRole('button', { name: 'Next', exact: true }).click();
        await panel.getByRole('button', { name: 'Skip step', exact: true }).click();
        await expect(panel).toHaveAttribute('data-step-id', 'source-claim');
        await expect(panel).toContainText('not a complete survey');
        await panel.getByRole('button', { name: 'Pause', exact: true }).click();
        await page.reload();
        await row.getByRole('button', { name: 'Resume', exact: true }).click();
        await expect(panel).toHaveAttribute('data-step-id', 'source-claim');
        await panel.getByRole('button', { name: 'Next', exact: true }).click();
        await expect(panel).toHaveAttribute('data-step-id', 'keep-note');
        // Preview remains sample-only; this journey does not Keep.
        await panel.getByRole('button', { name: 'Next', exact: true }).click();
        await expect(panel).toContainText('unreviewed · not accepted');
        await panel.getByRole('button', { name: 'Next', exact: true }).click();
        await expect(panel).toContainText('Sample failure: budget exceeded');
        await panel.getByRole('button', { name: 'Finish', exact: true }).click();
        await expect(panel).toHaveCount(0);
        await expect(row).toContainText('Finished (with skips)');
        expect(workRequests).toBe(0);
    });
}
