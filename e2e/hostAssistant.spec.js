/**
 * Host → Delegated work (documentation/delegated_operations.md): the host
 * stops all delegated work and resumes it, sets a cap and records the pilot
 * decision; a member is refused; the person whose work was stopped is told
 * on Home; every change is in the operator audit.
 */
const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');
const C = require('./constants');

// One of the dedicated operator identities e2e/server.js grants an account.
const OPERATOR = '99000000000000391';
const DELEGATOR = '99000000000000418';
const DELEGATOR_NAME = 'Stopped delegator';

const reset = async (request) => {
    const cleared = await request.post('/e2e/fixtures/assistant-controls/reset');
    expect(cleared.ok(), await cleared.text()).toBe(true);
};

test.describe('Host delegated work', () => {
    test.describe.configure({ mode: 'serial' });

    test.beforeAll(async ({ request }) => { await reset(request); });
    test.afterAll(async ({ request }) => { await reset(request); });

    test('a member is refused the page and the routes', async ({ page }) => {
        await login(page, { userId: C.MEMBER, name: C.MEMBER_NAME });
        await page.goto('/app/host/assistant');
        await expect(page.getByText('Only the host of this installation can open this room.')).toBeVisible();
        await expect(page.getByTestId('assistant-status')).toHaveCount(0);
        expect((await page.request.get('/api/app/admin/assistant')).status()).toBe(403);
        expect((await page.request.post('/api/app/admin/assistant/pause')).status()).toBe(403);
        expect((await page.request.patch('/api/app/admin/assistant/caps', { data: { installationRuns: 9 } })).status()).toBe(403);
        expect((await page.request.post('/api/app/admin/assistant/pilot', { data: { scope: 'everyone' } })).status()).toBe(403);
    });

    test('the host stops all delegated work, and nothing starts', async ({ page }) => {
        // Somebody has a piece of work proposed under an active responsibility.
        const seeded = await page.request.post('/e2e/fixtures/assistant-home', { data: { userId: DELEGATOR, name: DELEGATOR_NAME, seed: false } });
        expect(seeded.ok(), await seeded.text()).toBe(true);
        expect((await page.request.post('/e2e/fixtures/assistant-home/initiative', { data: { userId: DELEGATOR } })).ok()).toBe(true);

        await login(page, { userId: OPERATOR, name: 'Host operator' });
        await page.goto('/app/host/assistant');
        const status = page.getByTestId('assistant-status');
        await expect(status).toContainText('Running');
        await expect(page.getByTestId('assistant-running')).toHaveText('0 of 2');
        // Accounts are listed by id; what their work is about is not on the page.
        await expect(page.getByTestId('assistant-accounts')).toContainText(DELEGATOR);
        await expect(page.getByText('Keep my garden notes current')).toHaveCount(0);
        await expect(page.getByText('Your frost-date goal changed')).toHaveCount(0);

        await status.getByRole('button', { name: 'Stop all' }).click();
        await page.getByRole('button', { name: 'Confirm' }).click();
        await expect(status).toContainText('Stopped');
        await expect(status.getByRole('button', { name: 'Resume' })).toBeVisible();

        // A runner pass claims nothing while it is stopped.
        const pass = await page.request.post('/e2e/fixtures/assistant-home/run');
        expect(await pass.json()).toEqual({ skipped: 'paused', started: 0 });
    });

    test('the person whose work was stopped is told on Home', async ({ page }) => {
        await login(page, { userId: DELEGATOR, name: DELEGATOR_NAME });
        await expect(page.getByTestId('assistant-overview').getByTestId('assistant-status'))
            .toContainText('The host has stopped all delegated work for now.');
        const access = await (await page.request.get('/api/app/assistant/access')).json();
        expect(access).toMatchObject({ hostPaused: true, pilot: 'owner', capabilities: { reach: false } });
    });

    test('the host resumes, sets a cap and records the pilot decision; each is audited', async ({ page }) => {
        await login(page, { userId: OPERATOR, name: 'Host operator' });
        await page.goto('/app/host/assistant');
        const status = page.getByTestId('assistant-status');
        await expect(status).toContainText('Stopped');
        await status.getByRole('button', { name: 'Resume' }).click();
        await page.getByRole('button', { name: 'Confirm' }).click();
        await expect(status).toContainText('Running');
        await expect(status.getByRole('button', { name: 'Stop all' })).toBeVisible();

        const form = page.getByTestId('assistant-caps-form');
        await expect(form.getByRole('button', { name: 'Save caps' })).toBeDisabled();
        await page.getByTestId('assistant-cap-installationRuns').fill('3');
        await form.getByRole('button', { name: 'Save caps' }).click();
        await expect(page.getByTestId('assistant-running')).toHaveText('0 of 3');
        // Emptying the box restores the default.
        await page.getByTestId('assistant-cap-installationRuns').fill('');
        await form.getByRole('button', { name: 'Save caps' }).click();
        await expect(page.getByTestId('assistant-running')).toHaveText('0 of 2');
        // A number outside the allowed range is refused and nothing changes.
        const refused = await page.request.patch('/api/app/admin/assistant/caps', { data: { installationRuns: 500 } });
        expect(refused.status()).toBe(400);

        const pilot = page.getByTestId('assistant-pilot');
        await expect(pilot).toContainText('Host only');
        await expect(pilot).toContainText('no decision recorded');
        await pilot.getByRole('button', { name: 'Open to everyone' }).click();
        await page.getByRole('button', { name: 'Confirm' }).click();
        await expect(pilot.getByRole('button', { name: 'Limit to the host' })).toBeVisible();
        await expect(pilot).toContainText('decided');
        await pilot.getByRole('button', { name: 'Limit to the host' }).click();
        await page.getByRole('button', { name: 'Confirm' }).click();
        await expect(pilot).toContainText('Host only');

        const audit = await page.request.get('/api/app/admin/audit?limit=20');
        const entries = (await audit.json()).entries.filter((entry) => entry.action.startsWith('assistant.'));
        expect(entries.map((entry) => entry.action).reverse()).toEqual([
            'assistant.pause_all', 'assistant.resume_all', 'assistant.set_caps', 'assistant.set_caps',
            'assistant.pilot_decision', 'assistant.pilot_decision'
        ]);
        // Codes and numbers only.
        expect(JSON.stringify(entries)).not.toMatch(/garden|frost/i);
        await page.goto('/app/host');
        await expect(page.getByTestId('host-audit')).toContainText('stopped all delegated work');
    });
});
