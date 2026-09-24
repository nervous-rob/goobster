const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');
// Separate account: this journey deliberately keeps a note; shared owner
// fixtures have exact note-count assertions in other suites.
const FIRST_TASK_USER = '990000000000000266';

test('provider-free first task: evidence, explicit keep, acceptance, export, resume and reset', async ({ page }) => {
    await login(page, { userId: FIRST_TASK_USER, name: 'First task learner' });
    await page.request.post('/e2e/fixtures/tutorial-progress', { data: { userId: FIRST_TASK_USER, autoStart: false, rows: [] } });
    let paidCalls = 0;
    page.on('request', request => {
        if (request.method() === 'POST' && /\/expeditions(?:\?|$)|\/briefs(?:\?|$)|\/messages(?:\?|$)/.test(request.url())) paidCalls++;
    });
    await page.goto('/app/');
    await page.getByRole('button', { name: 'Start or resume first task' }).click();
    const panel = page.locator('[data-tutorial-id="home.first-task"][data-tour="tutorial-panel"]');
    async function go(step) {
        await expect(panel).toHaveAttribute('data-step-id', step);
        const link = panel.locator('[data-tour="tutorial-goto"]');
        if (await link.count()) await link.click();
    }
    await go('question');
    await panel.getByRole('button', { name: 'Use this sample question' }).click();
    await go('research');
    await panel.getByRole('button', { name: 'Run the sample pass' }).click();
    await go('evidence');
    await panel.getByRole('button', { name: 'Inspect source' }).click();
    await panel.getByRole('combobox').selectOption('yes');
    await expect(panel.getByRole('button', { name: 'Evidence checked' })).toBeDisabled();
    await panel.getByRole('combobox').selectOption('no');
    await panel.getByRole('button', { name: 'Evidence checked' }).click();
    await go('keep');
    await panel.getByRole('button', { name: 'Pause', exact: true }).click();
    await page.reload();
    await page.goto('/app/settings/tutorials');
    await page.locator('.tutorial-row[data-tutorial-id="home.first-task"]').getByRole('button', { name: 'Resume' }).click();
    await go('keep');
    await panel.getByRole('button', { name: 'Keep this example…' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click();
    await go('accept');
    await expect(panel).toContainText('One observation does not establish');
    await panel.getByRole('button', { name: 'Accept this sample brief' }).click();
    await go('export');
    const download = page.waitForEvent('download');
    await panel.getByRole('button', { name: 'Download sample brief and finish' }).click();
    expect((await download).suggestedFilename()).toBe('sample-coastal-walk-brief.md');
    await expect(panel).toHaveCount(0);
    expect(paidCalls).toBe(0);
    await page.goto('/app/settings/tutorials');
    const row = page.locator('.tutorial-row[data-tutorial-id="home.first-task"]');
    await expect(row).toContainText('Completed');
    await row.getByRole('button', { name: 'Reset', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click();
    await expect(row).toContainText('Not started');
    const notes = await page.request.get(`/api/app/spitball/notes?scope=${encodeURIComponent(`dm:${FIRST_TASK_USER}`)}&view=knowledge`);
    expect((await notes.json()).notes.some(note => note.label === 'Tide-pool anemones')).toBe(true);
});
