/**
 * Wider opportunity sources (documentation/delegated_opportunity_sources.md,
 * ADR 0026): the installation's owner lets the assistant notice requests
 * made in their own chats and new causes of failed project runs. What was
 * there before delegating is shown as history and never acted on; a polite
 * request proposes one piece of work that quotes the message and links to
 * the chat; a passing mention proposes nothing; three failed runs with one
 * cause are one problem; and the result comes back with a link to the chat.
 *
 * The owner is an operator account, so the pilot capability is theirs. A
 * person who is not the owner does not see the choices (no pilot decision is
 * recorded here, and hostAssistant.spec.js restores that state).
 */
const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');
const C = require('./constants');

const OWNER_ID = '99000000000000451';
const OWNER_NAME = 'Source owner';

async function post(page, path, data) {
    const response = await page.request.post(path, { data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
}

test.describe('wider opportunity sources', () => {
    test.describe.configure({ mode: 'serial' });

    test('requests in the owner\'s own chats and new failure causes are noticed from activation on; history is shown and left alone', async ({ page }) => {
        const { conversationId } = await post(page, '/e2e/fixtures/assistant-sources', { userId: OWNER_ID, name: OWNER_NAME, project: 'Pipeline' });
        await login(page, { userId: OWNER_ID, name: OWNER_NAME });

        // Delegating: the choices are the owner's while the pilot is closed.
        await page.goto('/app/assistant');
        await page.getByTestId('responsibility-title').fill('Look into what I ask for and what breaks');
        await page.getByTestId('responsibility-project').selectOption({ label: 'Pipeline' });
        const choices = page.getByTestId('responsibility-wider-sources');
        await expect(choices).toContainText('Anything already there is history and is never acted on');
        await expect(choices).toContainText('At most 3 pieces of work a day');
        await page.getByTestId('responsibility-chat-requests').check();
        await page.getByTestId('responsibility-job-failures').check();
        await page.getByTestId('responsibility-save').click();

        // Before activating: what it would count as history, read only.
        const row = page.getByTestId('responsibility-row');
        await expect(row.getByTestId('responsibility-status')).toHaveText('draft');
        await row.getByTestId('responsibility-sources-toggle').click();
        const rows = row.getByTestId('responsibility-source-row');
        await expect(rows).toHaveCount(2);
        await expect(rows.filter({ hasText: 'Requests in your own chats' })).toContainText('1 already there will be treated as history');
        await expect(rows.filter({ hasText: 'Failed project runs' })).toContainText('1 already there will be treated as history');
        await expect(row.getByTestId('responsibility-sources-body')).toContainText('Everything before then is history');
        await expect(page.getByTestId('initiative-row')).toHaveCount(0);

        await row.getByRole('button', { name: 'Activate' }).click();
        await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click();
        await expect(row.getByTestId('responsibility-status')).toHaveText('active');
        await page.reload();
        await expect(page.getByTestId('initiative-row')).toHaveCount(0);

        // A passing mention proposes nothing; asking politely proposes one piece of work.
        expect(await post(page, '/e2e/fixtures/assistant-sources/say', { text: 'I looked at framework Y last week and it was fine.' })).toMatchObject({ proposed: 0 });
        expect(await post(page, '/e2e/fixtures/assistant-sources/say', { text: 'Could you please look into framework X for me?' })).toMatchObject({ proposed: 1 });
        // Three failed runs with one cause are one problem.
        expect(await post(page, '/e2e/fixtures/assistant-sources/fail', { count: 3 })).toMatchObject({ proposed: 1 });
        expect(await post(page, '/e2e/fixtures/assistant-sources/fail', { count: 2 })).toMatchObject({ proposed: 0 });

        await page.reload();
        const work = page.getByTestId('initiative-row');
        await expect(work).toHaveCount(2);
        const chatWork = work.filter({ hasText: 'Asked in "Framework choice"' });
        await expect(chatWork).toHaveCount(1);
        await expect(chatWork.getByTestId('initiative-origin')).toContainText('Could you please look into framework X for me?');
        await expect(chatWork.getByTestId('initiative-origin-link')).toHaveAttribute('href', new RegExp(`/chat/${conversationId}$`));
        const failedWork = work.filter({ hasText: 'A python run failed' });
        await expect(failedWork).toHaveCount(1);
        await expect(failedWork.getByTestId('initiative-origin')).toContainText('python run #');

        // The preview now shows today's counts against the cap.
        await row.getByTestId('responsibility-sources-toggle').click();
        await expect(row.getByTestId('responsibility-sources-today')).toContainText('1 of 3 proposed');

        // Start the request: the result comes back with a link to the chat, and nothing was written into it.
        await chatWork.getByRole('button', { name: 'Start' }).click();
        await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click();
        await expect(chatWork.getByTestId('initiative-status')).toHaveText('queued');
        expect(await post(page, '/e2e/fixtures/assistant-conversation/run', {})).toMatchObject({ started: 1 });
        await page.reload();
        await expect(chatWork.getByTestId('initiative-result')).toContainText('Framework X and framework Y compared');

        await page.goto('/app/');
        const finding = page.getByTestId('assistant-brief-item').filter({ hasText: 'Framework X and framework Y compared' });
        await expect(finding).toHaveCount(1);
        await finding.getByTestId('assistant-brief-conversation').click();
        await expect(page).toHaveURL(new RegExp(`/chat/${conversationId}$`));
    });

    test('a person who is not the owner is not offered the choices while the pilot is closed', async ({ page }) => {
        await login(page, { userId: C.MEMBER, name: C.MEMBER_NAME });
        await page.goto('/app/assistant');
        await expect(page.getByTestId('responsibility-title')).toBeVisible();
        await expect(page.getByTestId('responsibility-wider-sources')).toHaveCount(0);
    });
});
