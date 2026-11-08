/**
 * Host → Schedules (documentation/operator_schedules.md): an operator
 * pauses, resumes, runs and deletes any server's automation or reminder;
 * a member is refused; private tasks never appear.
 */
const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');
const C = require('./constants');

// One of the dedicated operator identities e2e/server.js grants an account.
const OPERATOR = '99000000000000391';

const rowFor = (page, text) => page.getByTestId('schedule-row').filter({ hasText: text });

test.describe('Host schedules', () => {
    test.describe.configure({ mode: 'serial' });

    test.beforeEach(async ({ page }) => {
        const seeded = await page.request.post('/e2e/fixtures/schedules');
        expect(seeded.ok()).toBe(true);
    });

    test('a member is refused the page and the routes', async ({ page }) => {
        await login(page, { userId: C.MEMBER, name: C.MEMBER_NAME });
        await page.goto('/app/host/schedules');
        await expect(page.getByText('Only the host of this installation can open this room.')).toBeVisible();
        await expect(page.getByTestId('host-schedules')).toHaveCount(0);
        expect((await page.request.get('/api/app/admin/schedules')).status()).toBe(403);
    });

    test('the host lists server schedules and manages them', async ({ page }) => {
        await login(page, { userId: OPERATOR, name: 'Host operator' });
        await page.goto('/app/host/schedules');
        await expect(page.getByTestId('host-schedules')).toBeVisible();

        await expect(rowFor(page, 'Daily Gloat')).toBeVisible();
        await expect(rowFor(page, 'Morning Taunt')).toBeVisible();
        await expect(rowFor(page, 'Stand-up in five')).toBeVisible();
        await expect(page.getByText('Private digest')).toHaveCount(0);
        await expect(page.getByText('never shown')).toHaveCount(0);

        const gloat = rowFor(page, 'Daily Gloat');
        await gloat.getByTestId('schedule-pause').click();
        await page.getByRole('button', { name: 'Confirm' }).click();
        await expect(gloat.getByText('paused', { exact: true })).toBeVisible();
        await expect(gloat.getByTestId('schedule-trigger')).toBeDisabled();

        await page.getByTestId('schedules-status').selectOption('paused');
        await expect(page.getByTestId('schedule-row')).toHaveCount(1);
        await page.getByTestId('schedules-status').selectOption('');

        await gloat.getByTestId('schedule-resume').click();
        await expect(gloat.getByText('active', { exact: true })).toBeVisible();

        const taunt = rowFor(page, 'Morning Taunt');
        await taunt.getByTestId('schedule-trigger').click();
        await page.getByRole('button', { name: 'Confirm' }).click();
        await expect(page.getByText(/Queued/)).toBeVisible();

        await taunt.getByTestId('schedule-delete').click();
        await page.getByRole('button', { name: 'Confirm' }).click();
        await expect(rowFor(page, 'Morning Taunt')).toHaveCount(0);

        const reminder = rowFor(page, 'Stand-up in five');
        await reminder.getByTestId('schedule-pause').click();
        await page.getByRole('button', { name: 'Confirm' }).click();
        await expect(reminder.getByText('paused', { exact: true })).toBeVisible();

        const audit = await page.request.get('/api/app/admin/audit?limit=20');
        const actions = (await audit.json()).entries.map((entry) => entry.action);
        expect(actions).toEqual(expect.arrayContaining(['schedule.pause', 'schedule.resume', 'schedule.trigger', 'schedule.delete']));
    });
});
