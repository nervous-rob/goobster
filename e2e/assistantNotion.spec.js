/**
 * The Notion connector in a responsibility (documentation/delegated_notion.md,
 * DA-11e, ADR 0030).
 *
 * The journeys run against an in-memory Notion the fixture installs in
 * place of notionService's requests; nothing here talks to Notion. The
 * installation's owner grants one page by pasting its link, a piece of work
 * (scripted model) edits that page and is refused a page the grant does not
 * name, and moving a sub-page to the trash is never done by the work: it is
 * asked, and happens only when the person approves it on Home. Refusing it
 * in the Inbox changes nothing. Nobody else can see or answer the request.
 */
const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');

const APPROVING = '99000000000011501';
const REFUSING = '99000000000011502';
const STRANGER = '99000000000011503';

async function seed(page, body) {
    const seeded = await page.request.post('/e2e/fixtures/assistant-notion', { data: body });
    expect(seeded.ok(), await seeded.text()).toBe(true);
    return seeded.json();
}

const state = async (page, userId) => (await page.request.get(`/e2e/fixtures/assistant-notion/state?userId=${userId}`)).json();

async function work(page, userId) {
    const ran = await page.request.post('/e2e/fixtures/assistant-notion/run', { data: { userId } });
    expect(ran.ok(), await ran.text()).toBe(true);
    expect(await ran.json()).toEqual({ status: 'COMPLETED', stopCode: null });
}

/** An active responsibility that may read and write the person's page, made through the API. */
async function granted(page, link) {
    const resource = { kind: 'external', ids: [`notion:${link}`] };
    const drafted = await page.request.post('/api/app/assistant/responsibilities', {
        data: {
            title: 'Keep the decade plan current', budgets: { externalOperations: 5 },
            operations: [{ operation: 'read', resource }, { operation: 'external.write', resource }]
        }
    });
    expect(drafted.ok(), await drafted.text()).toBe(true);
    const { responsibility } = await drafted.json();
    const activated = await page.request.post(`/api/app/assistant/responsibilities/${responsibility.id}/actions`, {
        data: { action: 'activate', expectedRevision: responsibility.revision }
    });
    expect(activated.ok(), await activated.text()).toBe(true);
    return responsibility;
}

test.describe('the Notion connector in a responsibility', () => {
    test('the owner grants one page by its link, the work edits it, and a trash request is approved on Home', async ({ page }) => {
        const notion = await seed(page, { userId: APPROVING, name: 'Planner', owner: true });
        await login(page, { userId: APPROVING, name: 'Planner' });
        await page.goto('/app/assistant');

        const card = page.getByTestId('connector-row').filter({ hasText: 'Read and write one Notion page' });
        await expect(card.getByTestId('connector-status')).toHaveText('connected');
        await expect(card).toContainText('Can read: page');
        await expect(card).toContainText('Can read: rows');
        await expect(card).toContainText('Can write: append');
        await expect(card).toContainText('Can write: updateBlock');
        await expect(card).toContainText('(checked with the service after a crash)');
        await expect(card.getByTestId('connector-ask')).toContainText('Only with your approval, each time: archive');
        await expect(card.getByTestId('connector-decision')).toContainText('Owner decision 12');

        await page.getByTestId('responsibility-title').fill('Keep the decade plan current');
        await page.getByTestId('responsibility-connector-read-notion').check();
        await page.getByTestId('responsibility-connector-write-notion').check();
        await expect(page.getByTestId('responsibility-connector-read-note')).toContainText('except back into that same resource');
        await expect(page.getByTestId('responsibility-connector-asks-notion')).toContainText('Never done for you (archive)');
        // Reading notes and writing outside do not mix: the form says so while both are ticked.
        await expect(page.getByTestId('responsibility-connector-knowledge-warning')).toContainText('cannot then write to the outside service');
        await page.getByLabel('Read your knowledge').uncheck();
        await expect(page.getByTestId('responsibility-connector-knowledge-warning')).toHaveCount(0);

        // A grant names one page or database: a word is not one, a pasted link is.
        await page.getByTestId('responsibility-connector-resource-notion').fill('everything in my workspace');
        await page.getByTestId('responsibility-save').click();
        await expect(page.getByTestId('responsibility-row')).toHaveCount(0);
        await page.getByTestId('responsibility-connector-resource-notion').fill(notion.link);
        await page.getByTestId('responsibility-external-budget').fill('5');
        await page.getByTestId('responsibility-save').click();

        const row = page.getByTestId('responsibility-row');
        // What is kept is the page's id, not the link.
        await expect(row).toContainText(`read, write to an outside service: ${notion.page} in notion`);
        await expect(row.getByTestId('responsibility-connector-reach')).toContainText('at most 5 outside operations a day');
        await row.getByRole('button', { name: 'Activate' }).click();
        await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click();
        await expect(row.getByTestId('responsibility-status')).toHaveText('active');

        await work(page, APPROVING);
        const after = await state(page, APPROVING);
        expect(after.page).toEqual(expect.arrayContaining(['Run two marathons', 'Reviewed this week.']));
        expect(after.page.filter((text) => /^Goobster · ref [0-9a-f]{12}$/.test(text))).toHaveLength(1);
        // The page the grant does not name was not written, and the sub-page is still there.
        expect(after.other).toEqual(['Not part of the plan']);
        expect(after.childArchived).toBe(false);

        await page.goto('/app/');
        const asked = page.getByTestId('assistant-needs-you-item').filter({ hasText: 'Move it to the trash: the page "Old drafts", in Notion?' });
        await expect(asked).toContainText('An outside action to approve');
        await expect(asked.getByTestId('gate-decision')).toHaveAttribute('data-gate-kind', 'connector_request');
        await expect(asked.getByTestId('gate-decision').getByRole('button')).toHaveText(['Move it to the trash', 'Leave it']);
        await asked.getByRole('button', { name: 'Move it to the trash' }).click();
        // It says what approving does before it is done.
        await expect(page.getByRole('dialog')).toContainText('The page "Old drafts". It is moved to the trash in Notion, as you. You can restore it from Notion\'s trash for 30 days.');
        expect((await state(page, APPROVING)).childArchived).toBe(false);
        await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click();
        await expect(page.locator('#toast')).toHaveText('Moved the page "Old drafts" to the trash.');
        expect((await state(page, APPROVING)).childArchived).toBe(true);
        await expect(page.getByTestId('assistant-needs-you-item').filter({ hasText: 'Old drafts' })).toHaveCount(0);
    });

    test('refusing in the Inbox leaves the page where it is, and nobody else can see or answer the request', async ({ page, browser }) => {
        const notion = await seed(page, { userId: REFUSING, name: 'Keeper', owner: true });
        await login(page, { userId: REFUSING, name: 'Keeper' });
        const responsibility = await granted(page, notion.link);
        const kept = await (await page.request.get(`/api/app/assistant/responsibilities/${responsibility.id}`)).json();
        expect(JSON.stringify(kept)).toContain(`notion:${notion.page}`);
        expect(JSON.stringify(kept)).not.toContain('notion.so');
        await work(page, REFUSING);

        const card = (await (await page.request.get('/api/app/inbox?view=needs_you')).json())
            .items.find((item) => item.decision?.kind === 'connector_request').decision;

        // Somebody else, signed in, is shown nothing and cannot answer it.
        const other = await browser.newContext();
        const stranger = await other.newPage();
        await seed(stranger, { userId: STRANGER, name: 'Visitor' });
        await login(stranger, { userId: STRANGER, name: 'Visitor' });
        expect(await (await stranger.request.get('/api/app/assistant/connectors')).json()).toEqual({ allowed: false, connectors: [] });
        expect((await (await stranger.request.get('/api/app/inbox?view=needs_you')).json()).items).toEqual([]);
        const pressed = await stranger.request.post(`/api/app/assistant/gates/${card.ref}/decide`, {
            data: { option: 'approve', occurrence: card.occurrence, revision: card.revision, surface: 'inbox' }
        });
        expect(pressed.status()).toBe(404);
        await other.close();
        expect((await state(page, REFUSING)).childArchived).toBe(false);

        await page.goto('/app/activity/inbox');
        const row = page.locator('.inbox-row').filter({ hasText: 'Move it to the trash: the page "Old drafts", in Notion?' });
        await row.getByTestId('gate-decision').getByRole('button', { name: 'Leave it' }).click();
        await expect(page.locator('#toast')).toHaveText('Nothing was changed.');
        await expect(row.getByTestId('gate-decision')).toHaveCount(0);
        expect((await state(page, REFUSING)).childArchived).toBe(false);
        await page.goto('/app/');
        await expect(page.getByTestId('assistant-needs-you-item').filter({ hasText: 'Old drafts' })).toHaveCount(0);
    });
});
