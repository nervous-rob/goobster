/**
 * Delegating by conversation (documentation/delegated_conversation.md).
 *
 * The model is scripted; everything else is real: the chat turn, the tools,
 * the cards under the reply and the confirmations. What a person asks for
 * in chat becomes a draft that grants nothing; only their own press on the
 * card turns it on; a model that tries is refused; declining leaves no
 * draft; a request is decided from its chat card by the same operation as
 * on Home and in the Inbox.
 */
const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');

const USER = '99000000000000711';
const NAME = 'Owner';
const FRIEND = '99000000000000712';
const TITLE = 'Keep my garden notes current';

const PROPOSE = {
    name: 'proposeResponsibility',
    arguments: {
        title: TITLE,
        outcome: 'Garden notes reflect what I last decided.',
        operations: [
            { operation: 'read', resource: { kind: 'knowledge', ids: ['personal'] } },
            { operation: 'kg.generated.add', resource: { kind: 'knowledge', ids: ['personal'] } }
        ]
    }
};

const script = async (page, rounds, reply) => {
    const seeded = await page.request.post('/e2e/fixtures/assistant-chat-delegation', { data: { userId: USER, name: NAME, rounds, reply } });
    expect(seeded.ok(), await seeded.text()).toBe(true);
};
const state = async (page) => (await page.request.get(`/e2e/fixtures/assistant-chat-delegation/state?userId=${USER}`)).json();

/** Send one message in a new chat and wait for the turn to settle (the new chat gets its own address then). */
async function say(page, text, reply) {
    await page.goto('/app/chat');
    await page.getByLabel('Message Goobster').fill(text);
    await page.getByLabel('Message Goobster').press('Enter');
    await expect(page.locator('.chat-log').getByText(reply).first()).toBeVisible();
    await expect(page).toHaveURL(/\/app\/chat\/\d+$/);
}

test.describe('delegating by conversation', () => {
    test.describe.configure({ mode: 'serial' });

    test.afterAll(async ({ request }) => {
        await request.post('/e2e/fixtures/assistant-chat-delegation', { data: { restore: true } });
    });

    test('a request in chat becomes a draft, and only the person turns it on', async ({ page }) => {
        // The model drafts it, then tries to turn it on itself.
        await script(page, [
            [PROPOSE],
            [{ name: 'controlDelegatedWork', arguments: { action: 'activate', id: '$draft', confirmed: true } }]
        ], 'I drafted that. It is not on: the card shows what it would allow.');
        await login(page, { userId: USER, name: NAME });
        await say(page, 'Keep my garden notes current from now on.', 'I drafted that. It is not on');

        const card = page.getByTestId('proposal-card');
        await expect(card).toBeVisible();
        await expect(card).toContainText(TITLE);
        await expect(card.getByTestId('proposal-status')).toHaveText('draft · not on');
        await expect(card.getByTestId('proposal-grants')).toContainText('read, add generated notes: your knowledge');
        await expect(card).toContainText('it allows nothing until you turn it on');

        // Nothing is delegated: a draft marked as the model's, and no confirmation exists.
        let now = await state(page);
        // The model did make its attempt, and it moved nothing.
        expect(now.unplayed).toBe(0);
        await page.locator('.thinking-summary').click();
        await expect(page.locator('.thinking-body')).toContainText('control delegated work');
        expect(now.responsibilities).toHaveLength(1);
        expect(now.responsibilities[0]).toMatchObject({ title: TITLE, status: 'DRAFT', proposedBy: 'model', activatedAt: null });
        expect(now.receipts).toEqual([]);
        const chatUrl = page.url();
        await page.goto('/app/');
        await expect(page.getByTestId('assistant-status')).toHaveText('Nothing delegated yet.');

        // The card is still there when the conversation is reopened, and the press is the person's.
        await page.goto(chatUrl);
        await expect(card.getByTestId('proposal-status')).toHaveText('draft · not on');
        await card.getByRole('button', { name: 'Turn on' }).click();
        await expect(card.getByTestId('proposal-status')).toHaveText('on');
        await expect(card.getByRole('button', { name: 'Turn on' })).toHaveCount(0);

        now = await state(page);
        expect(now.responsibilities[0]).toMatchObject({ status: 'ACTIVE', revision: 2 });
        expect(now.receipts).toHaveLength(1);
        expect(now.receipts[0]).toMatchObject({ subjectKind: 'responsibility', action: 'activate', surface: 'chat' });
        expect(now.receipts[0].consumedAt).toBeTruthy();
        await page.goto('/app/');
        await expect(page.getByTestId('assistant-status')).toContainText('Looking after 1 responsibility');
    });

    test('declining leaves no draft', async ({ page }) => {
        await script(page, [[PROPOSE]], 'Drafted. Nothing is on.');
        await login(page, { userId: USER, name: NAME });
        await say(page, 'Could you look after my garden notes?', 'Drafted. Nothing is on.');
        const card = page.getByTestId('proposal-card');
        await expect(card.getByTestId('proposal-status')).toHaveText('draft · not on');
        await card.getByRole('button', { name: 'Discard' }).click();
        await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click();
        await expect(card.getByTestId('proposal-state')).toHaveText('Discarded. Nothing was turned on.');
        expect((await state(page)).responsibilities).toEqual([]);

        // The card in the conversation's history says so too.
        await page.reload();
        await expect(page.getByTestId('proposal-card').getByTestId('proposal-state')).toContainText('This draft is gone');
    });

    test('a kept draft is reviewed and activated on the Responsibilities page, with its own confirmation', async ({ page }) => {
        await script(page, [[PROPOSE]], 'Drafted. Nothing is on.');
        await login(page, { userId: USER, name: NAME });
        await say(page, 'Look after my garden notes, but let me review it first.', 'Drafted. Nothing is on.');
        const card = page.getByTestId('proposal-card');
        await card.getByRole('button', { name: 'Keep as draft' }).click();
        await expect(card.getByTestId('proposal-state')).toHaveText('Kept as a draft in Responsibilities.');

        await card.getByRole('link', { name: 'Review or edit' }).click();
        const row = page.getByTestId('responsibility-row');
        await expect(row.getByTestId('responsibility-status')).toHaveText('draft');
        await expect(row.getByTestId('responsibility-proposed')).toHaveText('proposed in a conversation');
        await row.getByRole('button', { name: 'Activate' }).click();
        const dialog = page.getByRole('dialog');
        await expect(dialog).toContainText(`Activate "${TITLE}"?`);
        await expect(dialog).toContainText('your knowledge');
        await dialog.getByRole('button', { name: 'Confirm' }).click();
        await expect(row.getByTestId('responsibility-status')).toHaveText('active');

        const now = await state(page);
        expect(now.responsibilities[0]).toMatchObject({ status: 'ACTIVE', proposedBy: 'model' });
        expect(now.receipts).toHaveLength(1);
        expect(now.receipts[0]).toMatchObject({ action: 'activate', surface: 'portal' });
        expect(now.receipts[0].consumedAt).toBeTruthy();
    });

    test('a request is decided from its card in chat', async ({ page }) => {
        await script(page, [[{ name: 'describeDelegatedWork', arguments: { what: 'requests' } }]], 'One request is waiting on you.');
        const asked = await page.request.post('/e2e/fixtures/assistant-home/friend-request', {
            data: { userId: USER, fromId: FRIEND, fromName: 'Ada', step: 'ask' }
        });
        expect(asked.ok(), await asked.text()).toBe(true);
        await login(page, { userId: USER, name: NAME });
        await say(page, 'What needs me?', 'One request is waiting on you.');

        const request = page.getByTestId('request-card');
        await expect(request).toContainText('Ada wants to be friends');
        await request.getByTestId('gate-decision').getByRole('button', { name: 'Accept' }).click();
        await expect(page.locator('#toast')).toHaveText('You and Ada are friends now.');
        await expect(request.getByTestId('gate-decision')).toHaveCount(0);
        await expect(request).toContainText('You accepted this request.');

        const now = await state(page);
        expect(now.receipts).toHaveLength(1);
        expect(now.receipts[0]).toMatchObject({ subjectKind: 'gate', action: 'decide', surface: 'chat' });
        expect(now.receipts[0].consumedAt).toBeTruthy();
        // It is settled everywhere: the Inbox no longer asks.
        await page.goto('/app/');
        await expect(page.getByTestId('assistant-needs-you-empty')).toBeVisible();
    });
});
