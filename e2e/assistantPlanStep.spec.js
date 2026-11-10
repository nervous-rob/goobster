/**
 * Delegated plan steps (documentation/delegated_plan_steps.md, ADR 0019).
 *
 * A plan's assistant step has no Start button: a person approves and starts
 * the plan, delegates "carry out the assistant steps" on the project, and
 * starts the proposed work. The step is marked done only after the file it
 * had to produce was checked, the evidence is linked, and the plan still
 * waits for a person to complete it. A result that only claims its file
 * blocks the plan instead.
 */
const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');

const USER = '99000000000000431';
const NAME = 'Planner';

async function seed(page, project) {
    const seeded = await page.request.post('/e2e/fixtures/assistant-plan-step', { data: { userId: USER, name: NAME, project } });
    expect(seeded.ok(), await seeded.text()).toBe(true);
    return seeded.json();
}

/** Approve and start the plan as the person, then delegate its assistant steps and start the proposed work. */
async function approveAndDelegate(page, slug, project) {
    await page.goto(`/app/projects/${USER}/${slug}/mission`);
    const step = page.getByTestId('plan-step');
    await expect(step).toHaveAttribute('data-step-kind', 'agent');
    await expect(step).toContainText('Must produce: docs/comparison.md');
    await expect(step.getByTestId('agent-step-state')).toContainText('once the plan is approved and started');
    await page.getByRole('button', { name: 'Approve & start' }).click();
    await expect(step.getByTestId('plan-step-status')).toHaveText('READY');
    // Nobody starts an assistant step by hand.
    await expect(step.getByRole('button', { name: 'Start' })).toHaveCount(0);
    await expect(step.getByTestId('agent-step-state')).toContainText('Waiting for an assistant');

    await page.goto('/app/assistant');
    await page.getByTestId('responsibility-title').fill('Carry the charting plan forward');
    await page.getByTestId('responsibility-project').selectOption({ label: project });
    await page.getByTestId('responsibility-plan-steps').check();
    await page.getByTestId('responsibility-save').click();
    const row = page.getByTestId('responsibility-row');
    await expect(row).toContainText('carry out assistant steps of its approved plan');
    await row.getByRole('button', { name: 'Activate' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('carry out assistant steps of its approved plan');
    await dialog.getByRole('button', { name: 'Confirm' }).click();
    await expect(row.getByTestId('responsibility-status')).toHaveText('active');

    // The ready step is proposed work, and it waits for the person.
    const work = page.getByTestId('initiative-row');
    await expect(work).toContainText('Plan step ready: Write the comparison');
    await expect(work.getByTestId('initiative-status')).toHaveText('proposed');
    await work.getByRole('button', { name: 'Start' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click();
    await expect(work.getByTestId('initiative-status')).toHaveText('queued');
}

test.describe('delegated plan steps', () => {
    test.describe.configure({ mode: 'serial' });

    test('an approved plan\'s assistant step is carried out, checked and linked as evidence; the plan still waits for a person', async ({ page }) => {
        const { slug } = await seed(page, 'Charting choice');
        await login(page, { userId: USER, name: NAME });
        await approveAndDelegate(page, slug, 'Charting choice');

        const ran = await (await page.request.post('/e2e/fixtures/assistant-plan-step/run', { data: { written: true } })).json();
        expect(ran).toMatchObject({ started: 1 });
        expect(ran.results[0]).toMatchObject({ status: 'COMPLETED', outcome: 'DONE' });
        await page.reload();
        await expect(page.getByTestId('initiative-status')).toHaveText('done');
        await expect(page.getByTestId('initiative-result')).toContainText('Plan step done: Write the comparison');
        await expect(page.getByTestId('initiative-result')).toContainText('Wrote the comparison of X and Y');

        await page.goto(`/app/projects/${USER}/${slug}/mission`);
        const step = page.getByTestId('plan-step');
        await expect(step.getByTestId('plan-step-status')).toHaveText('DONE');
        await expect(step.getByTestId('agent-step-state')).toContainText('Carried out by a delegated assistant');
        const evidence = page.getByTestId('plan-evidence');
        await expect(evidence).toHaveCount(1);
        await expect(evidence).toContainText('assistant run');
        await expect(evidence).toContainText('neutral');
        // Every step is done, so the plan is in review: completing it is still a person's button.
        await expect(page.locator('.obs-section-head .badge')).toHaveText('REVIEW');
        await expect(page.getByRole('button', { name: 'Complete plan' })).toBeVisible();
    });

    test('a result that only claims its file fails the check and blocks the plan', async ({ page }) => {
        const { slug } = await seed(page, 'Charting recheck');
        await login(page, { userId: USER, name: NAME });
        await approveAndDelegate(page, slug, 'Charting recheck');

        const ran = await (await page.request.post('/e2e/fixtures/assistant-plan-step/run', { data: { written: false } })).json();
        expect(ran.results[0]).toMatchObject({ status: 'FAILED', stopCode: 'VERIFICATION_FAILED' });
        await page.reload();
        const work = page.getByTestId('initiative-row');
        await expect(work.getByTestId('initiative-status')).toHaveText('failed');
        await expect(work).toContainText('did not pass the check');

        await page.goto(`/app/projects/${USER}/${slug}/mission`);
        const step = page.getByTestId('plan-step');
        await expect(step.getByTestId('plan-step-status')).toHaveText('FAILED');
        await expect(page.locator('.obs-section-head .badge')).toHaveText('BLOCKED');
        await expect(page.getByTestId('plan-evidence')).toHaveCount(0);
        await expect(step.getByRole('button', { name: 'Retry' })).toBeVisible();
    });
});
