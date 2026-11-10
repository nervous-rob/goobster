/**
 * Delivery and interruption for delegated work
 * (documentation/delegated_delivery.md).
 *
 * Before the pilot decision a member is not offered a digest or a contact,
 * and the server refuses one; with it, the choice is part of the draft, of
 * the activation review and of the row. Home and the Responsibilities page
 * change while they are open, and catch up after the event stream drops.
 * The day's digest is one Inbox item, sent once, and leaves Home
 * highlighted. The digest time is a setting.
 */
const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');

const USER = '99000000000000901';
const NAME = 'Reachable';
const TITLE = 'Keep my garden notes current';

const seed = async (page) => {
    const seeded = await page.request.post('/e2e/fixtures/assistant-home', { data: { userId: USER, name: NAME, seed: false } });
    expect(seeded.ok(), await seeded.text()).toBe(true);
};

const step = async (request, name, data = {}) => {
    const done = await request.post('/e2e/fixtures/assistant-delivery', { data: { userId: USER, step: name, ...data } });
    expect(done.ok(), await done.text()).toBe(true);
    return done.json();
};

test.describe('delegated delivery and interruption', () => {
    test.describe.configure({ mode: 'serial' });

    test.beforeAll(async ({ request }) => {
        await step(request, 'pilot', { scope: null });
        await step(request, 'reset');
    });
    test.afterAll(async ({ request }) => {
        await step(request, 'pilot', { scope: null });
        await step(request, 'reset');
    });

    test('before the pilot decision a member is not offered a digest or a contact, and cannot activate one', async ({ page }) => {
        await seed(page);
        await login(page, { userId: USER, name: NAME });
        await page.goto('/app/assistant');
        await expect(page.getByTestId('responsibility-draft')).toBeVisible();
        await expect(page.getByTestId('responsibility-save')).toBeVisible();
        await expect(page.getByTestId('responsibility-interruption')).toHaveCount(0);

        await page.goto('/app/settings/initiative');
        await expect(page.locator('#contact-budget-input')).toBeVisible();
        await expect(page.getByTestId('digest-time')).toHaveCount(0);

        // Asking the server directly is refused when it would start to matter.
        const created = await page.request.post('/api/app/assistant/responsibilities', {
            data: { title: 'Sneak a digest in', operations: [{ operation: 'read', resource: { kind: 'web' } }], rules: { interruption: 'digest' } }
        });
        expect(created.ok(), await created.text()).toBe(true);
        const { responsibility } = await created.json();
        // Activating is confirmed with a receipt for what the person is shown
        // (ADR 0023): a bare activate is refused before anything else is asked.
        const actions = `/api/app/assistant/responsibilities/${responsibility.id}/actions`;
        const bare = await page.request.post(actions, { data: { action: 'activate', expectedRevision: responsibility.revision } });
        expect(bare.status()).toBe(403);
        expect(JSON.stringify(await bare.json())).toContain('HUMAN_CONFIRMATION_REQUIRED');
        const confirmation = await page.request.post('/api/app/assistant/confirmations', {
            data: { subject: 'responsibility', id: responsibility.id, action: 'activate', revision: responsibility.revision, surface: 'portal' }
        });
        expect(confirmation.ok(), await confirmation.text()).toBe(true);
        const activated = await page.request.post(actions, {
            data: { action: 'activate', expectedRevision: responsibility.revision, receipt: (await confirmation.json()).receipt }
        });
        expect(activated.status()).toBe(409);
        expect((await activated.json()).error).toMatchObject({ code: 'PILOT_ONLY' });
        const after = await page.request.get(`/api/app/assistant/responsibilities/${responsibility.id}`);
        expect((await after.json()).responsibility.status).toBe('DRAFT');
    });

    test('the choice is made in the draft, restated before activation and shown on the row', async ({ page }) => {
        await step(page.request, 'pilot', { scope: 'everyone' });
        await seed(page);
        await login(page, { userId: USER, name: NAME });
        await page.goto('/app/assistant');
        await page.getByTestId('responsibility-title').fill(TITLE);
        const choice = page.getByTestId('responsibility-interruption');
        await expect(choice).toHaveValue('home');
        await choice.selectOption('digest');
        await page.getByTestId('responsibility-save').click();

        const row = page.getByTestId('responsibility-row');
        await expect(row.getByTestId('responsibility-status')).toHaveText('draft');
        await expect(row.getByTestId('responsibility-interruption-rule')).toHaveText('Updates go in your daily digest');

        await row.getByRole('button', { name: 'Activate' }).click();
        const dialog = page.getByRole('dialog');
        await expect(dialog).toContainText(`Activate "${TITLE}"?`);
        await expect(dialog).toContainText('Updates go in your daily digest.');
        await dialog.getByRole('button', { name: 'Confirm' }).click();
        await expect(row.getByTestId('responsibility-status')).toHaveText('active');
    });

    test('Home changes while it is open, and catches up after the stream drops', async ({ page }) => {
        await login(page, { userId: USER, name: NAME });
        const overview = page.getByTestId('assistant-overview');
        await expect(overview.getByTestId('assistant-status')).toContainText('Looking after 1 responsibility');
        await expect(overview.getByTestId('assistant-brief-empty')).toBeVisible();

        // Something is found while the page is open: no reload, no navigation.
        await step(page.request, 'finding', { title: 'Frost comes early this year' });
        await expect(overview.getByTestId('assistant-brief-item')).toHaveCount(1);
        await expect(overview.getByTestId('assistant-brief-item')).toContainText('Frost comes early this year');
        await expect(overview.getByTestId('assistant-component-research')).toContainText('1 new update');

        // The stream drops, and a change happens that no event will carry.
        const dropped = await step(page.request, 'drop');
        expect(dropped.dropped).toBeGreaterThanOrEqual(1);
        await step(page.request, 'finding', { title: 'The seed order shipped' });
        // The browser reconnects by itself; the reconnect reads Home again.
        await expect(overview.getByTestId('assistant-brief-item')).toHaveCount(2, { timeout: 20_000 });
        await expect(overview.getByTestId('assistant-component-research')).toContainText('2 new updates');
    });

    test('the day\'s digest is one Inbox item, sent once, and Home stays highlighted', async ({ page }) => {
        await login(page, { userId: USER, name: NAME });
        await page.goto('/app/activity/inbox');
        await expect(page.locator('.inbox-row')).toHaveCount(2);

        // Before the digest time (09:00) nothing goes out.
        expect((await step(page.request, 'sweep', { hour: 8 })).result).toEqual({ contacts: 0, digests: 0, held: 0 });

        const pass = await step(page.request, 'sweep', { hour: 12 });
        expect(pass.result).toEqual({ contacts: 0, digests: 1, held: 0 });
        expect(pass.dms).toEqual([USER]);
        // It arrives in the open Inbox by itself.
        const digest = page.locator('.inbox-row').filter({ hasText: '2 updates from your delegated work' });
        await expect(digest).toHaveCount(1);

        // Later the same day there is no second one, even with something new.
        await step(page.request, 'finding', { title: 'The beans need staking' });
        expect((await step(page.request, 'sweep', { hour: 20 })).result).toMatchObject({ contacts: 0, digests: 0 });
        await expect(page.locator('.inbox-row').filter({ hasText: 'from your delegated work' })).toHaveCount(1);

        // Being told is not having looked: everything is still new on Home.
        await page.goto('/app/');
        await expect(page.getByTestId('assistant-component-research')).toContainText('3 new updates');
        await expect(page.getByTestId('assistant-brief-item')).toHaveCount(3);
    });

    test('the Responsibilities page changes while it is open', async ({ page }) => {
        await login(page, { userId: USER, name: NAME });
        await page.goto('/app/assistant');
        const row = page.getByTestId('responsibility-row');
        await expect(row.getByTestId('responsibility-status')).toHaveText('active');
        await step(page.request, 'pause');
        await expect(row.getByTestId('responsibility-status')).toHaveText('paused');
        await expect(row.getByRole('button', { name: 'Resume' })).toBeVisible();
    });

    test('the digest time is a setting, and clearing it goes back to 09:00', async ({ page }) => {
        await login(page, { userId: USER, name: NAME });
        await page.goto('/app/settings/initiative');
        const time = page.getByTestId('digest-time');
        await expect(time).toHaveValue('');
        await time.fill('18:30');
        await page.getByRole('button', { name: 'Save changes' }).click();
        await expect(page.getByText('Initiative saved.')).toBeVisible();

        await page.reload();
        await expect(page.getByTestId('digest-time')).toHaveValue('18:30');
        const saved = await (await page.request.get('/api/app/settings')).json();
        expect(saved.sections.initiative.values.digestMinute).toBe(18 * 60 + 30);

        await page.getByRole('button', { name: 'Use 09:00' }).click();
        await page.getByRole('button', { name: 'Save changes' }).click();
        await expect(page.getByText('Initiative saved.')).toBeVisible();
        const cleared = await (await page.request.get('/api/app/settings')).json();
        expect(cleared.sections.initiative.values.digestMinute).toBeNull();
        expect(cleared.sections.initiative.effective.digestMinute).toBe(9 * 60);
    });
});
