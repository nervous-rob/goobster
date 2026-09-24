const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');
const tours = require('../packages/core/config/workflowTutorials');
const modes = [
    { name: 'keyboard', width: 1280, height: 800 },
    { name: 'narrow', width: 375, height: 667 },
    { name: 'zoom equivalent', width: 640, height: 400 }
];
for (const [ti, tour] of tours.entries()) for (const [mi, mode] of modes.entries()) {
    test(`${tour.id}: ${mode.name}, simulation, Back, feedback, resume and finish`, async ({ page }) => {
        await page.setViewportSize({ width: mode.width, height: mode.height });
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await login(page, { userId: `99000000000000${ti}8${mi}`, name: 'Workflow learner' });
        const unexpected = [];
        page.on('request', r => {
            if (r.method() !== 'GET' && r.url().includes('/api/app/') && !r.url().includes('/tutorial')) unexpected.push(r.url());
        });
        await page.goto('/app/settings/tutorials');
        const row = page.locator(`.tutorial-row[data-tutorial-id="${tour.id}"]`);
        await row.getByRole('button', { name: 'Resume', exact: true }).click();
        const panel = page.getByRole('region', { name: `${tour.title} tutorial`, exact: true });
        await expect(panel).toBeVisible();
        const box = await panel.boundingBox();
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(mode.width);
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.y + box.height).toBeLessThanOrEqual(mode.height);
        await expect(panel).toHaveCSS('animation-name', 'none');
        for (const [si, step] of tour.steps.entries()) {
            await expect(panel).toHaveAttribute('data-step-id', step.id);
            const action = panel.getByRole('button', { name: step.preview.action, exact: true });
            await action.focus();
            await page.keyboard.press('Enter');
            await expect(panel.getByRole('status')).toHaveText(step.preview.after);
            if (si === 0) {
                await panel.getByRole('button', { name: 'Unclear', exact: true }).click();
                await expect(page.locator('#toast')).toContainText('Step feedback saved.');
                await panel.getByRole('button', { name: 'Pause', exact: true }).click();
                await page.reload();
                await row.getByRole('button', { name: 'Resume', exact: true }).click();
                await expect(panel).toHaveAttribute('data-step-id', step.id);
            }
            if (si === 1) {
                await panel.getByRole('button', { name: 'Back', exact: true }).click();
                await expect(panel).toHaveAttribute('data-step-id', tour.steps[0].id);
                await panel.getByRole('button', { name: 'Next', exact: true }).click();
                await expect(panel).toHaveAttribute('data-step-id', step.id);
            }
            await panel.getByRole('button', { name: si === tour.steps.length - 1 ? 'Finish' : 'Next', exact: true }).click();
        }
        await expect(panel).toHaveCount(0);
        await expect(row).toContainText('Completed');
        expect(unexpected).toEqual([]);
    });
}
