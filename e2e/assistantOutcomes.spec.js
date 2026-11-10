/**
 * The outcome summary (documentation/delegated_pilot.md, "The outcome
 * summary"; DA-6).
 *
 * The Responsibilities page says what each responsibility did over a
 * period and what it cost: results the system checked itself apart from
 * results a run only reported, what was refused or stopped, the tokens
 * spent per checked result, and which prompt and model the runs were
 * given. It says what it cannot know, and it is absent when nothing is
 * delegated.
 */
const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');

const PILOT = '99000000000001601';
const IDLE = '99000000000001602';
const NAME = 'Pilot';

async function fixture(page, body) {
    const made = await page.request.post('/e2e/fixtures/assistant-outcomes', { data: body });
    expect(made.ok(), await made.text()).toBe(true);
    return made.json();
}

test.describe('the outcome summary', () => {
    test.describe.configure({ mode: 'serial' });

    test('checked results apart from reported ones, with cost, for the chosen period', async ({ page }) => {
        const seeded = await fixture(page, { userId: PILOT, name: NAME });
        await login(page, { userId: PILOT, name: NAME });
        await page.goto('/app/assistant');

        const summary = page.getByTestId('outcome-summary');
        await expect(summary.getByRole('heading', { name: 'What your responsibilities did' })).toBeVisible();
        await expect(summary.getByTestId('outcome-period')).toHaveValue('14');
        const rows = summary.getByTestId('outcome-row');
        await expect(rows).toHaveCount(2);

        // The plan: three verified steps in a fortnight, one run that failed its check.
        const plan = rows.filter({ hasText: 'Carry the crossing plan forward' });
        await expect(plan.getByTestId('outcome-results')).toHaveText('3 checked results (3 plan steps).');
        await expect(plan.getByTestId('outcome-attention')).toHaveText('1 run stopped before a result.');
        await expect(plan.getByTestId('outcome-cost')).toHaveText('Cost: 2,900 tokens, 967 per checked result.');
        await expect(plan.getByTestId('outcome-models')).toHaveText(`Ran on openai / fixture-model, prompt ${seeded.prompt} (4 runs).`);

        // The notes: a finding nothing checked is not a checked result, and the refusal is counted.
        const notes = rows.filter({ hasText: 'Keep what I know about the crossing current' });
        await expect(notes.getByTestId('outcome-results')).toHaveText('No checked results. 1 finding reported.');
        await expect(notes.getByTestId('outcome-attention')).toHaveText('1 call refused.');
        await expect(notes.getByTestId('outcome-cost')).toHaveText('Cost: 600 tokens, 600 per result.');

        await expect(summary.getByTestId('outcome-totals'))
            .toHaveText('In total: 3 checked results (3 plan steps). 1 finding reported. Cost: 3,500 tokens, 1,167 per checked result.');
        await expect(summary.getByTestId('outcome-not-measured')).toContainText(
            'It cannot tell whether a result was useful to you, whether anything it did was unwanted, how responsive chat stayed while it worked'
        );
        await expect(summary.getByTestId('outcome-not-measured')).toContainText(`Runs started now are given prompt ${seeded.prompt}.`);
        await expect(summary.getByTestId('outcome-not-measured')).not.toContainText('not final');

        // A week: the step from twelve days ago is outside it.
        await summary.getByTestId('outcome-period').selectOption('7');
        await expect(plan.getByTestId('outcome-results')).toHaveText('2 checked results (2 plan steps).');
        await expect(plan.getByTestId('outcome-cost')).toHaveText('Cost: 2,400 tokens, 1,200 per checked result.');
        await expect(plan.getByTestId('outcome-models')).toContainText('(3 runs)');

        // The page shows what the route returns, and the route is the person's own.
        const body = await (await page.request.get('/api/app/assistant/outcomes?days=7')).json();
        expect(body.outcomes.period.days).toBe(7);
        expect(body.outcomes.costSource).toBe('ledger');
        expect(body.outcomes.totals).toMatchObject({
            verified: { planSteps: 2, repairs: 0, total: 2 }, reported: { findings: 1 }, refusals: { total: 1 }, cost: { tokens: 3000 }
        });
    });

    test('nothing delegated: no summary, and nobody else\'s figures', async ({ page }) => {
        await fixture(page, { userId: IDLE, name: 'Idle', empty: true });
        await login(page, { userId: IDLE, name: 'Idle' });
        await page.goto('/app/assistant');
        await expect(page.getByTestId('responsibilities-empty')).toBeVisible();
        await expect(page.getByTestId('outcome-summary')).toHaveCount(0);
        const body = await (await page.request.get('/api/app/assistant/outcomes')).json();
        expect(body.outcomes.responsibilities).toEqual([]);
        expect(body.outcomes.totals.cost.tokens).toBe(0);
    });
});
