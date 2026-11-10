/**
 * The assistant-first Home, the Inbox's Needs-you filter and the
 * Responsibilities page (documentation/assistant_home.md).
 *
 * Loading Home marks nothing read; one finding is one briefing item and
 * one count; a request stays in Needs you after it is read and leaves every
 * view when the domain resolves it; snooze hides without resolving; a
 * request that can be decided in place is decided from Home or the Inbox by
 * the same card, and a card that changed is refused with the current state;
 * a draft responsibility grants nothing until the person activates it.
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

const FRIEND = '99000000000000413';
const FRIEND_NAME = 'Ada';

const friendRequest = async (page, step = 'ask') => {
    const made = await page.request.post('/e2e/fixtures/assistant-home/friend-request', {
        data: { userId: USER, fromId: FRIEND, fromName: FRIEND_NAME, step }
    });
    expect(made.ok(), await made.text()).toBe(true);
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

    test('a request is decided on Home, and it is settled in the Inbox too', async ({ page }) => {
        await seed(page);
        await friendRequest(page);
        await login(page, { userId: USER, name: NAME });
        const overview = page.getByTestId('assistant-overview');
        await expect(overview.getByTestId('assistant-status')).toContainText('2 need you');
        const asked = overview.getByTestId('assistant-needs-you-item').filter({ hasText: `${FRIEND_NAME} wants to be friends` });
        await expect(asked.getByTestId('gate-decision')).toBeVisible();
        // A request with no decision here still only links to where it is decided.
        const repair = overview.getByTestId('assistant-needs-you-item').filter({ hasText: 'Nightly import' });
        await expect(repair.getByTestId('gate-decision')).toHaveCount(0);

        // The Inbox shows the same request with the same choices...
        const inboxCard = (await (await page.request.get('/api/app/inbox?view=needs_you')).json())
            .items.find((item) => item.friend)?.decision;
        const homeCard = (await (await page.request.get('/api/app/home')).json())
            .assistant.needsYou.find((item) => item.decision)?.decision;
        expect(inboxCard).toBeTruthy();
        expect(homeCard).toEqual(inboxCard);

        // ...and one press on Home settles it everywhere.
        await asked.getByRole('button', { name: 'Accept' }).click();
        await expect(page.locator('#toast')).toHaveText(`You and ${FRIEND_NAME} are friends now.`);
        await expect(overview.getByTestId('assistant-needs-you-item')).toHaveCount(1);
        await expect(overview.getByTestId('assistant-status')).toContainText('1 needs you');
        await page.goto('/app/activity/inbox');
        const row = page.locator('.inbox-row').filter({ hasText: `${FRIEND_NAME} wants to be friends` });
        await expect(row.getByTestId('inbox-friend-outcome')).toContainText('Accepted');
        await expect(row.getByTestId('gate-decision')).toHaveCount(0);
        await page.getByTestId('inbox-view-needs_you').click();
        await expect(page.locator('.inbox-row').filter({ hasText: FRIEND_NAME })).toHaveCount(0);
        await expect(page.locator('.inbox-row').filter({ hasText: 'Nightly import' })).toHaveCount(1);
    });

    test('a card that changed after it was shown is refused with what the request is now', async ({ page }) => {
        await seed(page, { seed: false });
        await friendRequest(page);
        await login(page, { userId: USER, name: NAME });
        await page.goto('/app/activity/inbox');
        const row = page.locator('.inbox-row').filter({ hasText: `${FRIEND_NAME} wants to be friends` });
        await expect(row.getByTestId('gate-decision').getByRole('button')).toHaveText(['Accept', 'Decline']);

        // They take it back while the card is still on screen.
        await friendRequest(page, 'withdraw');
        await row.getByRole('button', { name: 'Accept' }).click();
        await expect(page.locator('#toast')).toHaveText('This request was already settled. They withdrew this request.');
        await expect(page.locator('#toast')).toHaveClass(/error/);
        await expect(row.getByTestId('gate-decision')).toHaveCount(0);
        const friends = await (await page.request.get('/api/app/friends')).json();
        expect(friends.friends).toHaveLength(0);

        // They ask again: that is a new card, and the Inbox decides it too.
        await friendRequest(page);
        await page.reload();
        await page.getByTestId('inbox-view-needs_you').click();
        // The Inbox keeps the earlier notice about the same request beside the
        // new one (it always has); either row decides the one request.
        const again = page.locator('.inbox-row').filter({ hasText: `${FRIEND_NAME} wants to be friends` }).first();
        await again.getByTestId('gate-decision').getByRole('button', { name: 'Decline' }).click();
        await expect(page.locator('#toast')).toHaveText('Declined - they are not told.');
        await expect(page.locator('.inbox-row')).toHaveCount(0);
        await page.goto('/app/');
        await expect(page.getByTestId('assistant-needs-you-empty')).toBeVisible();
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

        // Home: one incident, said once, and one question; the card counts processes, not messages.
        const overview = page.getByTestId('assistant-overview');
        const card = overview.getByTestId('assistant-component-processes');
        await expect(card).toContainText('1 needs you');
        await expect(card).toContainText('1 not working');
        await expect(card).toContainText('1 with a problem');
        await expect(card).toContainText('2 new updates');
        const brief = overview.getByTestId('assistant-brief-item');
        await expect(brief).toHaveCount(1);
        await expect(brief).toContainText('"Nightly import" keeps failing');
        // Whether the watch is still needed is a question for the person: it
        // is asked once under Needs you and is not repeated as a finding.
        const asks = overview.getByTestId('assistant-needs-you-item');
        await expect(asks).toHaveCount(1);
        await expect(asks).toContainText('Still needed?');
        await expect(asks).toContainText('"Release watch" may no longer be needed');
        // It can be answered right there, and says what each answer does.
        await expect(asks.getByTestId('gate-decision').getByRole('button')).toHaveText(['Pause it', 'Keep it running']);
        await expect(asks.getByTestId('gate-decision')).toContainText('The goal it was set up for is resolved. It is still switched on.');

        // Reviewing the update does not make the process healthy.
        await brief.getByRole('button', { name: 'Mark reviewed' }).click();
        await expect(overview.getByTestId('assistant-brief-empty')).toBeVisible();
        await expect(card).toContainText('1 not working');
        // The question is still unanswered, so it is still the one thing new on the card.
        await expect(card).toContainText('1 needs you');
        await expect(card).toContainText('1 new update');
        await expect(card).not.toContainText('2 new updates');

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

        // Each process offers only what applies to it, and asking changed nothing.
        await expect(digest.getByRole('button')).toHaveText(['Pause']);
        await expect(watch.getByRole('button')).toHaveText(['Pause', 'Keep it running']);
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

    test('a process is paused, archived, cleaned up and restored from the page, and its definition is never deleted', async ({ page }) => {
        await seed(page, { seed: false });
        const made = await page.request.post('/e2e/fixtures/assistant-home/processes', { data: { userId: USER } });
        expect(made.ok(), await made.text()).toBe(true);
        await login(page, { userId: USER, name: NAME });
        const overview = page.getByTestId('assistant-overview');
        await expect(overview.getByTestId('assistant-needs-you-item')).toHaveCount(1);
        const processOf = async (name) => (await (await page.request.get('/api/app/assistant/processes')).json())
            .processes.find((entry) => entry.name === name);

        // The question on Home leads to the process it is about.
        await overview.getByTestId('assistant-needs-you-item').getByRole('link', { name: 'Open →' }).click();
        const report = page.getByTestId('assistant-processes');
        const notice = report.getByTestId('process-notice');
        const row = report.getByTestId('process-row').filter({ hasText: 'Release watch' });
        await expect(row).toHaveCount(1);

        // Pause: nothing new starts, it says who paused it, and the question is answered.
        await row.getByRole('button', { name: 'Pause' }).click();
        await expect(notice).toHaveText('Paused "Release watch". Nothing new will start.');
        await expect(row.getByTestId('process-lifecycle')).toContainText('Paused by you');
        await expect(row.getByTestId('process-execution')).toContainText('It is paused, so it is not being judged.');
        await expect(row.getByRole('button')).toHaveText(['Resume', 'Archive']);
        await expect(report.getByTestId('processes-summary')).toContainText('1 paused');
        expect(await processOf('Release watch')).toMatchObject({ enabled: false, archived: false, lifecycle: { stage: 'paused', actor: 'person' } });
        await page.goto('/app/');
        await expect(overview.getByTestId('assistant-needs-you-empty')).toBeVisible();
        await overview.getByTestId('assistant-component-processes').click();

        // Archive: said plainly before it happens, and it leaves the list without leaving the installation.
        await row.getByRole('button', { name: 'Archive' }).click();
        const dialog = page.getByRole('dialog');
        await expect(dialog).toContainText('Archive "Release watch"?');
        await expect(dialog).toContainText('nothing is deleted');
        await dialog.getByRole('button', { name: 'Confirm' }).click();
        await expect(notice).toHaveText('Archived "Release watch". It and its history are kept.');
        await expect(row).toHaveCount(0);
        await expect(report.getByTestId('processes-summary')).toContainText('4 processes');
        await expect(report.getByTestId('processes-summary')).toContainText('1 archived');
        await report.getByTestId('processes-show-archived').click();
        const kept = report.getByTestId('processes-archived').getByTestId('process-row');
        await expect(kept).toHaveCount(1);
        await expect(kept).toContainText('Release watch');
        await expect(kept.getByTestId('process-lifecycle')).toContainText('Archived by you');
        await expect(kept.getByRole('button')).toHaveText(['Restore', 'Clean up…']);

        // Cleanup shows exactly what it would remove, and removes nothing until confirmed.
        await kept.getByRole('button', { name: 'Clean up…' }).click();
        const preview = kept.getByTestId('process-cleanup-preview');
        await expect(preview).toContainText('This removes exactly: 2 run records.');
        await expect(preview).toContainText('It keeps the process itself, its purpose.');
        await preview.getByRole('button', { name: 'Cancel' }).click();
        await expect(preview).toHaveCount(0);
        const before = await (await page.request.get(`/api/app/assistant/processes/automation/${(await processOf('Release watch')).id}`)).json();
        expect(before.observations).toHaveLength(2);

        await kept.getByRole('button', { name: 'Clean up…' }).click();
        await preview.getByTestId('process-cleanup-confirm').click();
        await expect(notice).toHaveText('Removed 2 run records of "Release watch".');
        await expect(kept.getByTestId('process-lifecycle')).toContainText('2 run records removed');
        const after = await (await page.request.get(`/api/app/assistant/processes/automation/${before.process.id}`)).json();
        expect(after.observations).toEqual([]);
        expect(after.contract.purpose).toBe('Tell me when the release ships');

        // Restore brings it back paused, and says what did not come back.
        await kept.getByRole('button', { name: 'Restore' }).click();
        await expect(notice).toHaveText(
            'Restored "Release watch". It is paused until you resume it. What was cleaned up (2 run records) is not restored.'
        );
        await expect(report.getByTestId('processes-show-archived')).toHaveCount(0);
        await expect(row.getByTestId('process-lifecycle')).toContainText('It stays paused until you resume it.');
        expect(await processOf('Release watch')).toMatchObject({ enabled: false, archived: false, lifecycle: { stage: 'paused' } });

        // Resume is a separate act; it is also the answer to "is it still needed".
        await row.getByRole('button', { name: 'Resume' }).click();
        await expect(notice).toHaveText('Resumed "Release watch".');
        await expect(row.getByRole('button')).toHaveText(['Pause']);
        expect(await processOf('Release watch')).toMatchObject({ enabled: true, lifecycle: { stage: 'active' } });
    });

    test('the question is answered on Home: keep it running, and it is not asked again', async ({ page }) => {
        await seed(page, { seed: false });
        const made = await page.request.post('/e2e/fixtures/assistant-home/processes', { data: { userId: USER } });
        expect(made.ok(), await made.text()).toBe(true);
        await login(page, { userId: USER, name: NAME });
        const overview = page.getByTestId('assistant-overview');
        const ask = overview.getByTestId('assistant-needs-you-item');
        await expect(ask).toHaveCount(1);
        await ask.getByRole('button', { name: 'Keep it running' }).click();
        await expect(page.locator('#toast')).toHaveText('"Release watch" stays on.');
        await expect(overview.getByTestId('assistant-needs-you-empty')).toBeVisible();
        await expect(overview.getByTestId('assistant-component-processes')).not.toContainText('needs you');

        // The Processes list shows the answer, and no longer offers the question.
        await overview.getByTestId('assistant-component-processes').click();
        const report = page.getByTestId('assistant-processes');
        const row = report.getByTestId('process-row').filter({ hasText: 'Release watch' });
        await expect(row.getByRole('button')).toHaveText(['Pause']);
        await expect(row.getByTestId('process-lifecycle')).toContainText('You chose to keep it running');
        // Still judged a candidate from the evidence; the person's answer is what changed.
        await expect(row.getByTestId('process-relevance')).toContainText('May no longer be needed');
        const pass = await page.request.post('/e2e/fixtures/assistant-home/processes/pass', { data: { userId: USER } });
        expect(await pass.json()).toMatchObject({ pass: { relevance: 0, paused: 0 } });
        const listed = await (await page.request.get('/api/app/assistant/processes')).json();
        expect(listed.processes.find((entry) => entry.name === 'Release watch')).toMatchObject({ enabled: true, controls: ['pause'] });
        await page.goto('/app/');
        await expect(overview.getByTestId('assistant-needs-you-empty')).toBeVisible();
    });

    test('with Attention off the page says why nothing runs', async ({ page }) => {
        await seed(page, { seed: false, attention: false });
        await login(page, { userId: USER, name: NAME });
        await expect(page.getByTestId('assistant-status')).toContainText('Attention is off');
        await expect(page.getByTestId('assistant-attention-off')).toBeVisible();
    });
});
