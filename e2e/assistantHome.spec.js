/**
 * The assistant-first Home, the Inbox's Needs-you filter and the
 * Responsibilities page (documentation/assistant_home.md).
 *
 * Loading Home marks nothing read; one finding is one briefing item and
 * one count; a request stays in Needs you after it is read and leaves every
 * view when the domain resolves it; snooze hides without resolving; a draft
 * responsibility grants nothing until the person activates it.
 */
const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');

const USER = '99000000000000412';
const NAME = 'Delegator';

const seed = async (page, data = {}) => {
    const seeded = await page.request.post('/e2e/fixtures/assistant-home', { data: { userId: USER, name: NAME, ...data } });
    expect(seeded.ok(), await seeded.text()).toBe(true);
    return seeded.json();
};

test.describe('assistant-first Home', () => {
    test.describe.configure({ mode: 'serial' });

    test('a person with nothing delegated is told so, and nothing is implied', async ({ page }) => {
        await seed(page, { seed: false });
        await login(page, { userId: USER, name: NAME });
        const overview = page.getByTestId('assistant-overview');
        await expect(overview.getByTestId('assistant-status')).toHaveText('Nothing delegated yet.');
        await expect(overview.getByTestId('assistant-needs-you-empty')).toBeVisible();
        await expect(overview.getByTestId('assistant-brief-empty')).toHaveText('No important changes.');
        await expect(overview.getByTestId('assistant-none-delegated')).toBeVisible();
        // The creation actions are still right there.
        await expect(page.getByRole('button', { name: /New chat/ })).toBeVisible();
    });

    test('findings, requests and their counts stay separate, and reading resolves nothing', async ({ page }) => {
        await seed(page);
        await login(page, { userId: USER, name: NAME });
        const overview = page.getByTestId('assistant-overview');
        await expect(overview.getByTestId('assistant-status')).toContainText('1 needs you');
        await expect(overview.getByTestId('assistant-needs-you-item')).toHaveCount(1);
        await expect(overview.getByTestId('assistant-needs-you-item')).toContainText('Nightly import: review the proposed repair');
        // The request is not repeated under What changed.
        await expect(overview.getByTestId('assistant-brief-item')).toHaveCount(1);
        await expect(overview.getByTestId('assistant-brief-item')).toContainText('The library now supports your platform');
        await expect(overview.getByTestId('assistant-component-knowledge')).toContainText('1 new update');
        await expect(overview.getByTestId('assistant-component-research')).toContainText('1 new update');
        await expect(overview.getByTestId('assistant-component-processes')).toContainText('1 needs you');
        await expect(overview.getByTestId('assistant-component-projects')).toContainText('Up to date');

        // Loading Home read nothing: both items are still unread in the Inbox.
        const before = await (await page.request.get('/api/app/inbox')).json();
        expect(before).toMatchObject({ unread: 2, needsYou: 1 });

        // Mark reviewed clears the finding everywhere it was highlighted.
        await overview.getByTestId('assistant-brief-item').getByRole('button', { name: 'Mark reviewed' }).click();
        await expect(overview.getByTestId('assistant-brief-empty')).toBeVisible();
        await expect(overview.getByTestId('assistant-component-knowledge')).toContainText('Up to date');
        // ...and resolved nothing.
        await expect(overview.getByTestId('assistant-needs-you-item')).toHaveCount(1);

        // The Inbox shows the same request under Needs you; reading it keeps it there.
        await overview.getByRole('link', { name: 'View all in Inbox →' }).click();
        await expect(page.getByTestId('inbox-view-needs_you')).toHaveAttribute('aria-selected', 'true');
        const row = page.locator('.inbox-row').filter({ hasText: 'Nightly import' });
        await expect(row).toHaveCount(1);
        await expect(row.getByTestId('inbox-needs-you')).toBeVisible();
        await row.locator('.inbox-row-main').click();
        await expect(row).not.toHaveClass(/unread/);
        await page.getByTestId('inbox-view-open').click();
        await page.getByTestId('inbox-view-needs_you').click();
        await expect(page.locator('.inbox-row').filter({ hasText: 'Nightly import' })).toHaveCount(1);
        // Updates holds only what asks nothing.
        await page.getByTestId('inbox-view-updates').click();
        await expect(page.locator('.inbox-row').filter({ hasText: 'The library now supports your platform' })).toHaveCount(1);
        await expect(page.locator('.inbox-row').filter({ hasText: 'Nightly import' })).toHaveCount(0);

        // Snooze hides it from Needs you without resolving it.
        await page.getByTestId('inbox-view-needs_you').click();
        await page.locator('.inbox-row').filter({ hasText: 'Nightly import' }).getByRole('button', { name: 'Snooze 1 day' }).click();
        await expect(page.locator('.inbox-row').filter({ hasText: 'Nightly import' })).toHaveCount(0);
        await page.getByTestId('inbox-view-snoozed').click();
        await expect(page.locator('.inbox-row').filter({ hasText: 'Nightly import' })).toHaveCount(1);
    });

    test('resolving the request clears it from Home and Needs you, and keeps it in history', async ({ page }) => {
        await seed(page);
        await login(page, { userId: USER, name: NAME });
        await expect(page.getByTestId('assistant-needs-you-item')).toHaveCount(1);
        expect((await page.request.post('/e2e/fixtures/assistant-home/resolve', { data: { userId: USER } })).ok()).toBe(true);
        await page.reload();
        await expect(page.getByTestId('assistant-needs-you-empty')).toBeVisible();
        await page.goto('/app/activity/inbox');
        const row = page.locator('.inbox-row').filter({ hasText: 'Nightly import' });
        await expect(row).toHaveCount(1);
        await expect(row).toContainText('resolved');
        await page.getByTestId('inbox-view-needs_you').click();
        await expect(page.locator('.inbox-row')).toHaveCount(0);
    });

    test('a responsibility is drafted, reviewed, activated and paused by the person', async ({ page }) => {
        await seed(page, { seed: false });
        await login(page, { userId: USER, name: NAME });
        await page.getByTestId('assistant-none-delegated').getByRole('link', { name: 'Draft one →' }).click();
        await expect(page.getByRole('heading', { name: 'Responsibilities' })).toBeVisible();
        await expect(page.getByTestId('responsibilities-empty')).toBeVisible();
        await page.getByTestId('responsibility-title').fill('Keep my garden notes current');
        await page.getByTestId('responsibility-save').click();
        const row = page.getByTestId('responsibility-row');
        await expect(row.getByTestId('responsibility-status')).toHaveText('draft');
        await expect(row).toContainText('the web');
        await expect(row).toContainText('your knowledge');

        // A draft is not delegation.
        await page.goto('/app/');
        await expect(page.getByTestId('assistant-status')).toHaveText('Nothing delegated yet.');

        // Activation states exactly what is granted and needs a yes.
        await page.goto('/app/assistant');
        await page.getByTestId('responsibility-row').getByRole('button', { name: 'Activate' }).click();
        const dialog = page.getByRole('dialog');
        await expect(dialog).toContainText('Activate "Keep my garden notes current"?');
        await expect(dialog).toContainText('your knowledge');
        await dialog.getByRole('button', { name: 'Confirm' }).click();
        await expect(page.getByTestId('responsibility-status')).toHaveText('active');

        await page.goto('/app/');
        await expect(page.getByTestId('assistant-status')).toContainText('Looking after 1 responsibility');
        await expect(page.getByTestId('assistant-responsibility')).toContainText('Keep my garden notes current');

        // Pause from Home: stated, confirmed, and visible as paused.
        await page.getByRole('button', { name: 'Pause assistant work' }).click();
        await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click();
        await expect(page.getByTestId('assistant-status')).toContainText('paused');
        await expect(page.getByRole('button', { name: 'Pause assistant work' })).toHaveCount(0);
    });

    test('proposed work waits for Start, then runs within the grant and reports on Home', async ({ page }) => {
        await seed(page, { seed: false });
        const made = await page.request.post('/e2e/fixtures/assistant-home/initiative', { data: { userId: USER } });
        expect(made.ok(), await made.text()).toBe(true);
        await login(page, { userId: USER, name: NAME });
        await expect(page.getByTestId('assistant-responsibility')).toContainText('1 proposed');

        // Nothing runs until the person starts it.
        expect(await (await page.request.post('/e2e/fixtures/assistant-home/run')).json()).toMatchObject({ started: 0 });
        await page.goto('/app/assistant');
        const work = page.getByTestId('initiative-row');
        await expect(work.getByTestId('initiative-status')).toHaveText('proposed');
        await work.getByRole('button', { name: 'Start' }).click();
        const dialog = page.getByRole('dialog');
        await expect(dialog).toContainText('It can only do what the responsibility lists above');
        await dialog.getByRole('button', { name: 'Confirm' }).click();
        await expect(work.getByTestId('initiative-status')).toHaveText('queued');

        const ran = await (await page.request.post('/e2e/fixtures/assistant-home/run')).json();
        expect(ran).toMatchObject({ started: 1 });
        expect(ran.results[0]).toMatchObject({ status: 'COMPLETED', outcome: 'DONE' });
        await page.reload();
        await expect(page.getByTestId('initiative-status')).toHaveText('done');
        await expect(page.getByTestId('initiative-result')).toContainText('Your notes put the first frost on the 14th');

        // The result is one finding on Home.
        await page.goto('/app/');
        await expect(page.getByTestId('assistant-brief-item')).toHaveCount(1);
        await expect(page.getByTestId('assistant-brief-item')).toContainText('Your notes put the first frost on the 14th');
        await expect(page.getByTestId('assistant-component-research')).toContainText('1 new update');
    });

    test('a failing process is one incident, stays on its card after it is reviewed, and is judged twice', async ({ page }) => {
        await seed(page, { seed: false });
        const made = await page.request.post('/e2e/fixtures/assistant-home/processes', { data: { userId: USER } });
        expect(made.ok(), await made.text()).toBe(true);
        expect((await made.json()).pass).toMatchObject({ opened: 1, relevance: 1 });
        await login(page, { userId: USER, name: NAME });

        // Home: one incident and one relevance note, each said once; the card counts processes, not messages.
        const overview = page.getByTestId('assistant-overview');
        const card = overview.getByTestId('assistant-component-processes');
        await expect(card).toContainText('1 not working');
        await expect(card).toContainText('1 with a problem');
        await expect(card).toContainText('2 new updates');
        const brief = overview.getByTestId('assistant-brief-item');
        await expect(brief).toHaveCount(2);
        await expect(brief.filter({ hasText: '"Nightly import" keeps failing' })).toHaveCount(1);
        await expect(brief.filter({ hasText: '"Release watch" may no longer be needed' })).toHaveCount(1);
        // Neither asks for anything.
        await expect(overview.getByTestId('assistant-needs-you-empty')).toBeVisible();

        // Reviewing the updates does not make the process healthy.
        for (const title of ['keeps failing', 'may no longer be needed']) {
            await brief.filter({ hasText: title }).getByRole('button', { name: 'Mark reviewed' }).click();
            await expect(brief.filter({ hasText: title })).toHaveCount(0);
        }
        await expect(overview.getByTestId('assistant-brief-empty')).toBeVisible();
        await expect(card).toContainText('1 not working');
        await expect(card).not.toContainText('new update');

        // The card opens the report, where each process has both judgments in words.
        await card.click();
        const report = page.getByTestId('assistant-processes');
        await expect(report.getByRole('heading', { name: 'Processes' })).toBeVisible();
        await expect(report.getByTestId('processes-summary')).toHaveText(
            '5 processes · 1 not working · 1 running with a problem · 1 may no longer be needed · 1 not enough to judge'
        );
        const incident = report.getByTestId('process-incident');
        await expect(incident).toHaveCount(1);
        await expect(incident).toContainText('"Nightly import" keeps failing');
        await expect(incident.getByTestId('process-incident-status')).toHaveText('Open');

        const rows = report.getByTestId('process-row');
        await expect(rows).toHaveCount(4);
        // Not working first.
        await expect(rows.first()).toContainText('Nightly import');
        await expect(rows.first().getByTestId('process-execution')).toContainText('Blocked');
        await expect(rows.first().getByTestId('process-execution')).toContainText('It has failed 3 times in a row (RUN_FAILED).');
        // No purpose recorded: its usefulness is not judged, and the page says so.
        await expect(rows.first().getByTestId('process-relevance')).toContainText('Usefulness not judged');
        await expect(rows.first()).toContainText('part of an open incident');

        const flaky = rows.filter({ hasText: 'Price check' });
        await expect(flaky.getByTestId('process-execution')).toContainText('Running with a problem');
        const digest = rows.filter({ hasText: 'Morning digest' });
        await expect(digest.getByTestId('process-execution')).toContainText('Working');
        // Working and no longer needed are separate answers about the same process.
        const watch = rows.filter({ hasText: 'Release watch' });
        await expect(watch.getByTestId('process-execution')).toContainText('Working');
        await expect(watch.getByTestId('process-relevance')).toContainText('May no longer be needed');
        await expect(watch.getByTestId('process-relevance')).toContainText('The goal it was set up for is resolved. It is still switched on.');

        // A report only: nothing on it changes a process.
        await expect(rows.getByRole('button')).toHaveCount(0);
        await expect(incident.getByRole('button')).toHaveCount(0);

        // A switched-off process with nothing to report is folded away, not dropped.
        await report.getByTestId('processes-show-idle').click();
        await expect(rows).toHaveCount(5);
        const off = rows.filter({ hasText: 'Old weekly report' });
        await expect(off.getByTestId('process-execution')).toContainText('Not enough to judge');
        await expect(off.getByTestId('process-execution')).toContainText('It is switched off.');
        const after = await (await page.request.get('/api/app/assistant/processes')).json();
        expect(after.processes.filter((entry) => entry.enabled).map((entry) => entry.name).sort())
            .toEqual(['Morning digest', 'Nightly import', 'Price check', 'Release watch']);
    });

    test('with Attention off the page says why nothing runs', async ({ page }) => {
        await seed(page, { seed: false, attention: false });
        await login(page, { userId: USER, name: NAME });
        await expect(page.getByTestId('assistant-status')).toContainText('Attention is off');
        await expect(page.getByTestId('assistant-attention-off')).toBeVisible();
    });
});
