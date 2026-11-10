/**
 * Requests made in conversation, a change of direction, and the project
 * board (documentation/delegated_conversation_requests.md,
 * documentation/assistant_home.md "Project boards", ADR 0021).
 *
 * A person who asks Goobster for something in a project conversation gets
 * proposed work that quotes the request and links back to where it was
 * said; the result comes to them and commits the project to nothing. When
 * they change direction there, what had not finished is withdrawn and they
 * are told. A plan approval is the same request on the project board, on
 * Home and in the Inbox, and approving it from the project settles it on
 * all three.
 */
const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');

const USER = '99000000000000441';
const NAME = 'Asker';
// Deciding a request from its card is the owner's alone until the pilot
// decision is recorded (documentation/delegated_operations.md), so the board
// journey runs as an owner. No other spec uses this id.
const OWNER = '99000000000000713';

async function seed(page, project, userId = USER) {
    const seeded = await page.request.post('/e2e/fixtures/assistant-conversation', {
        data: { userId, name: NAME, project, owner: userId === OWNER }
    });
    expect(seeded.ok(), await seeded.text()).toBe(true);
    return seeded.json();
}

async function say(page, conversationId, text) {
    const said = await page.request.post('/e2e/fixtures/assistant-conversation/say', { data: { userId: USER, name: NAME, conversationId, text } });
    expect(said.ok(), await said.text()).toBe(true);
    return said.json();
}

async function adopt(page, userId = USER) {
    const adopted = await page.request.post('/e2e/fixtures/assistant-conversation/adopt', { data: { userId } });
    expect(adopted.ok(), await adopted.text()).toBe(true);
}

test.describe('requests made in conversation', () => {
    test.describe.configure({ mode: 'serial' });

    test('a request to Goobster in the project conversation is proposed, done and reported with a link back; a change of direction withdraws what had not finished', async ({ page }) => {
        const { conversationId, slug } = await seed(page, 'API choice');
        await login(page, { userId: USER, name: NAME });

        // Delegating: the person says where Goobster takes requests from.
        await page.goto('/app/assistant');
        await page.getByTestId('responsibility-title').fill('Look into what I ask for');
        await page.getByTestId('responsibility-project').selectOption({ label: 'API choice' });
        await page.getByTestId('responsibility-project-requests').check();
        await expect(page.getByTestId('responsibility-draft')).toContainText('Nobody else\'s messages are read.');
        await page.getByTestId('responsibility-save').click();
        const row = page.getByTestId('responsibility-row');
        await expect(row.getByTestId('responsibility-listens')).toContainText('its project\'s conversations');
        await row.getByRole('button', { name: 'Activate' }).click();
        await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click();
        await expect(row.getByTestId('responsibility-status')).toHaveText('active');

        // Talking about it is not asking for it; asking Goobster is.
        expect(await say(page, conversationId, 'We should compare framework X and framework Y at some point.')).toMatchObject({ proposed: 0 });
        expect(await say(page, conversationId, 'Goobster, compare framework X and framework Y')).toMatchObject({ proposed: 1 });
        await page.reload();
        const work = page.getByTestId('initiative-row');
        await expect(work).toHaveCount(1);
        await expect(work.getByTestId('initiative-status')).toHaveText('proposed');
        await expect(work.getByTestId('initiative-origin')).toContainText('Goobster, compare framework X and framework Y');
        await expect(work.getByTestId('initiative-origin-link')).toHaveAttribute('href', new RegExp(`/discussions/${conversationId}$`));
        await work.getByRole('button', { name: 'Start' }).click();
        await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click();
        await expect(work.getByTestId('initiative-status')).toHaveText('queued');

        const ran = await (await page.request.post('/e2e/fixtures/assistant-conversation/run')).json();
        expect(ran).toMatchObject({ started: 1 });
        await page.reload();
        await expect(work.getByTestId('initiative-status')).not.toHaveText('queued');
        await expect(work.getByTestId('initiative-result')).toContainText('Framework X and framework Y compared');

        // Looking into it decided nothing: the plan is still a draft waiting for its owner.
        await page.goto(`/app/projects/${USER}/${slug}/mission`);
        await expect(page.locator('.obs-section-head .badge')).toHaveText('DRAFT');

        // The finding is on Home, and leads back to where it was asked.
        await page.goto('/app/');
        const finding = page.getByTestId('assistant-brief-item').filter({ hasText: 'Framework X and framework Y compared' });
        await expect(finding).toHaveCount(1);
        await finding.getByTestId('assistant-brief-conversation').click();
        await expect(page).toHaveURL(new RegExp(`/discussions/${conversationId}$`));
        await expect(page.getByText('Goobster, compare framework X and framework Y')).toBeVisible();

        // A second request, then a change of direction before it started.
        expect(await say(page, conversationId, 'Goobster, look into framework Z as well')).toMatchObject({ proposed: 1 });
        await say(page, conversationId, 'Goobster, never mind');
        await page.goto('/app/assistant');
        const withdrawn = page.getByTestId('initiative-row').filter({ hasText: 'superseded' });
        await expect(withdrawn).toHaveCount(1);
        await expect(withdrawn).toContainText('You changed direction in that conversation');
        await expect(withdrawn.getByTestId('initiative-origin')).toContainText('look into framework Z as well');
        await expect(withdrawn.getByRole('button', { name: 'Try again' })).toBeVisible();
        // The finished comparison was not withdrawn.
        await expect(page.getByTestId('initiative-result')).toContainText('Framework X and framework Y compared');

        await page.goto('/app/');
        const steered = page.getByTestId('assistant-brief-item').filter({ hasText: 'Changed direction' });
        await expect(steered).toHaveCount(1);
        await expect(steered).toContainText('1 request stopped');
        await expect(steered).toContainText('Nothing was undone');
    });

    test('a plan approval is one request on the project board, on Home and in the Inbox, and approving it from the project settles it everywhere', async ({ page }) => {
        const { slug } = await seed(page, 'Board choice', OWNER);
        await adopt(page, OWNER);
        await login(page, { userId: OWNER, name: NAME });

        // Home shows the request with its decision.
        const overview = page.getByTestId('assistant-overview');
        const onHome = overview.getByTestId('assistant-needs-you-item');
        await expect(onHome).toHaveCount(1);
        await expect(onHome.getByTestId('gate-decision').getByRole('button')).toHaveText(['Approve plan']);

        // The project's Overview shows the same request, with the same button.
        await page.goto(`/app/projects/${OWNER}/${slug}`);
        const now = page.getByTestId('project-now-needs');
        await expect(now).toHaveCount(1);
        await expect(now).toContainText('Approve mission plan');
        await expect(now.getByTestId('gate-decision').getByRole('button')).toHaveText(['Approve plan']);

        // So does the board across projects. Approve it there.
        await page.goto('/app/projects');
        const board = page.getByTestId('project-needs-you');
        const card = board.getByTestId('board-card');
        await expect(card).toHaveCount(1);
        await expect(card).toContainText('Approve mission plan');
        await expect(board.getByTestId('project-needs-you-count')).toHaveText('1');
        await card.getByTestId('gate-decision').getByRole('button', { name: 'Approve plan' }).click();

        // The approval is gone from the board; the plan now waits to be started.
        await expect(board.getByTestId('board-card')).toContainText('Start approved mission');
        await expect(board.getByTestId('board-card').filter({ hasText: 'Approve mission plan' })).toHaveCount(0);
        await page.goto(`/app/projects/${OWNER}/${slug}/mission`);
        await expect(page.locator('.obs-section-head .badge')).toHaveText('APPROVED');

        // And it is settled on Home and in the Inbox: the next request (start) took its place.
        await adopt(page, OWNER);
        await page.goto('/app/');
        await expect(onHome).toHaveCount(1);
        await expect(onHome.getByTestId('gate-decision').getByRole('button')).toHaveText(['Start mission']);
        await page.goto('/app/activity/inbox');
        await expect(page.getByTestId('gate-decision').getByRole('button', { name: 'Approve plan' })).toHaveCount(0);
        await expect(page.getByTestId('gate-decision').getByRole('button', { name: 'Start mission' })).toHaveCount(1);
    });
});
