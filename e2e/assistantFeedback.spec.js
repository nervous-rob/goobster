/**
 * Feedback on delegated work, and what is learned from it
 * (documentation/delegated_feedback.md).
 *
 * Before the pilot decision a member is offered no feedback and the server
 * refuses it. With it, a finding on Home offers each kind that has an
 * effect, with the one thing it changes: "wrong time" marks an hour that
 * Settings shows and removes; "this is wrong" marks the note the finding
 * wrote as disputed, on record and undoable; "less of this" lowers the rate
 * of the source it came from, shown on the responsibility with a reset; and
 * "stop this responsibility" is the ordinary confirmed pause.
 */
const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');

const USER = '99000000000001001';
const NAME = 'Reader';
const FINDING = 'Tomatoes want six hours of sun';

const step = async (request, name, data = {}) => {
    const done = await request.post('/e2e/fixtures/assistant-feedback', { data: { userId: USER, name: NAME, step: name, ...data } });
    expect(done.ok(), await done.text()).toBe(true);
    return done.json();
};

test.describe('feedback on delegated work', () => {
    test.describe.configure({ mode: 'serial' });
    let seeded;

    test.beforeAll(async ({ request }) => {
        seeded = await step(request, 'seed');
    });
    test.afterAll(async ({ request }) => {
        await step(request, 'pilot', { scope: null });
    });

    test('before the pilot decision a member is offered no feedback, and the server refuses it', async ({ page }) => {
        await login(page, { userId: USER, name: NAME });
        const finding = page.getByTestId('assistant-brief-item').filter({ hasText: FINDING });
        await expect(finding).toBeVisible();
        await expect(finding.getByTestId('assistant-feedback')).toHaveCount(0);

        await page.goto('/app/assistant');
        await expect(page.getByTestId('initiative-row').first()).toBeVisible();
        await expect(page.getByTestId('assistant-feedback')).toHaveCount(0);

        const refused = await page.request.post(`/api/app/assistant/updates/${seeded.updateId}/feedback`, { data: { kind: 'useful' } });
        expect(refused.status()).toBe(403);
        expect((await refused.json()).error).toMatchObject({ code: 'PILOT_ONLY' });
        const work = await page.request.post(`/api/app/assistant/initiatives/${seeded.proposals[0]}/feedback`, { data: { kind: 'less_of_this' } });
        expect(work.status()).toBe(403);
    });

    test('"wrong time" marks the hour it was sent; Settings shows it and removes it', async ({ page }) => {
        await step(page.request, 'pilot', { scope: 'everyone' });
        await login(page, { userId: USER, name: NAME });
        const finding = page.getByTestId('assistant-brief-item').filter({ hasText: FINDING });
        await finding.getByTestId('assistant-feedback-toggle').click();
        const options = finding.getByTestId('assistant-feedback-options');
        // Every kind that has an effect on this finding, each with what it changes.
        for (const kind of ['useful', 'already_knew', 'wrong', 'less_of_this', 'wrong_time', 'keep_wording', 'stop_responsibility']) {
            await expect(options.getByTestId(`assistant-feedback-${kind}`)).toBeVisible();
        }
        await expect(options).toContainText('What is looked for does not change.');

        await options.getByTestId('assistant-feedback-wrong_time').click();
        await expect(page.locator('#toast')).toContainText('between 14:00 and 15:00');
        await expect(finding.getByTestId('assistant-feedback-given')).toHaveText('You said: wrong time');
        await expect(finding.getByTestId('assistant-feedback-wrong_time')).toHaveCount(0);
        // Feedback is not review: the finding is still new.
        await expect(finding).toBeVisible();

        await page.goto('/app/settings/initiative');
        const hours = page.getByTestId('avoid-hours');
        await expect(hours.getByTestId('avoid-hour')).toHaveCount(1);
        await expect(hours.getByTestId('avoid-hour')).toContainText('14:00–15:00');
        await hours.getByRole('button', { name: 'Allow 14:00–15:00 again' }).click();
        await page.getByRole('button', { name: 'Save changes' }).click();
        await expect(page.getByTestId('avoid-hours')).toHaveCount(0);
        const settings = await (await page.request.get('/api/app/settings')).json();
        expect(settings.sections.initiative.values.avoidHours).toEqual([]);
    });

    test('"this is wrong" disputes the note the finding wrote, deletes nothing, and can be undone', async ({ page }) => {
        await login(page, { userId: USER, name: NAME });
        const finding = page.getByTestId('assistant-brief-item').filter({ hasText: FINDING });
        await finding.getByTestId('assistant-feedback-toggle').click();
        await finding.getByTestId('assistant-feedback-wrong').click();
        await expect(page.locator('#toast')).toContainText('Nothing was deleted');
        await expect(finding.getByTestId('assistant-feedback-given')).toContainText('this is wrong');

        await page.goto('/app/assistant');
        const change = page.getByTestId('knowledge-change').filter({ hasText: 'Tomato sunlight' });
        await expect(change).toContainText('You said this was wrong');
        await expect(change).toContainText('marked disputed');
        await expect(change).toHaveAttribute('data-status', 'APPLIED');
        await change.getByTestId('knowledge-undo').click();
        await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click();
        await expect(change).toHaveAttribute('data-status', 'REVERTED');
    });

    test('"less of this" lowers the rate of the source it came from; the responsibility shows it and resets it', async ({ page }) => {
        await login(page, { userId: USER, name: NAME });
        await page.goto('/app/assistant');
        const row = page.getByTestId('responsibility-row').filter({ hasText: 'Keep up with my reading' });
        await expect(row.getByTestId('responsibility-learned')).toHaveCount(0);

        const proposal = row.getByTestId('initiative-row').filter({ has: page.getByRole('button', { name: 'Start' }) }).first();
        await proposal.getByTestId('assistant-feedback-toggle').click();
        // A proposal has found nothing yet: only the kinds that can apply are offered.
        await expect(proposal.getByTestId('assistant-feedback-options').locator('li')).toHaveCount(2);
        await proposal.getByTestId('assistant-feedback-less_of_this').click();
        await expect(page.locator('#toast')).toContainText('up to 2 a day');

        const learned = row.getByTestId('responsibility-learned-row');
        await expect(learned).toHaveCount(1);
        await expect(learned).toContainText('Items you kept from followed sources');
        await expect(learned).toContainText('may propose up to 2 a day now (usually up to 3 a day)');
        await expect(learned).toContainText('you said "less of this" once');

        // The next day five more kept items arrive: two are proposed, not three.
        expect((await step(page.request, 'propose', { days: 1, count: 5 })).proposed).toBe(2);

        await learned.getByTestId('responsibility-learned-reset').click();
        await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click();
        await expect(row.getByTestId('responsibility-learned')).toHaveCount(0);
        expect((await step(page.request, 'propose', { days: 2, count: 5 })).proposed).toBe(3);
    });

    test('"stop this responsibility" is the ordinary pause, confirmed', async ({ page }) => {
        await login(page, { userId: USER, name: NAME });
        await page.goto('/app/assistant');
        const row = page.getByTestId('responsibility-row').filter({ hasText: 'Keep up with my reading' });
        await expect(row.getByTestId('responsibility-status')).toHaveText('active');
        const proposal = row.getByTestId('initiative-row').filter({ has: page.getByRole('button', { name: 'Start' }) }).first();
        await proposal.getByTestId('assistant-feedback-toggle').click();
        await proposal.getByTestId('assistant-feedback-stop_responsibility').click();

        // Cancelling the confirmation changes nothing.
        await proposal.getByTestId('assistant-feedback-stop-pause').click();
        await expect(page.getByRole('dialog')).toContainText('Pause "Keep up with my reading"?');
        await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
        await expect(row.getByTestId('responsibility-status')).toHaveText('active');

        await proposal.getByTestId('assistant-feedback-stop-pause').click();
        await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click();
        await expect(row.getByTestId('responsibility-status')).toHaveText('paused');
        await expect(row.getByRole('button', { name: 'Resume' })).toBeVisible();
    });
});
