/**
 * Repairing a process (documentation/process_stewardship.md, "Repair"; DA-5c).
 *
 * A process that keeps failing is offered one repair that changes nothing
 * about it: run it once more. Nothing happens until the person approves it;
 * what the run after it records decides whether it worked; when the attempts
 * allowed are used up the person is asked once whether to pause it; and
 * while repair is in the pilot only the installation's owner is offered one.
 */
const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');

const OWNER = '99000000000001301';
const OTHER = '99000000000001302';
const NAME = 'Keeper';

async function fixture(page, body) {
    const made = await page.request.post('/e2e/fixtures/assistant-process-repair', { data: body });
    expect(made.ok(), await made.text()).toBe(true);
    return made.json();
}

const nightly = async (page) => (await (await page.request.get('/api/app/assistant/processes')).json())
    .processes.find((entry) => entry.name === 'Nightly import');

test.describe('repairing a process', () => {
    test.describe.configure({ mode: 'serial' });

    test('a proposed repair changes nothing until approved, fails its check, and asks once what to do', async ({ page }) => {
        const seeded = await fixture(page, { userId: OWNER, name: NAME });
        expect(seeded.pass).toMatchObject({ opened: 1, repairs: 1 });
        await login(page, { userId: OWNER, name: NAME });

        // Home: the repair is a question, with what each answer does.
        const overview = page.getByTestId('assistant-overview');
        const asks = overview.getByTestId('assistant-needs-you-item');
        await expect(asks).toHaveCount(1);
        await expect(asks).toContainText('"Nightly import" keeps failing: run it once more?');
        await expect(asks.getByTestId('gate-decision').getByRole('button')).toHaveText(['Run it once now', 'Leave it']);
        await expect(asks.getByTestId('gate-decision')).toContainText('It keeps failing (RUN_FAILED). Nothing has been changed.');

        // Nothing has been done: it is proposed, not applied.
        const before = await nightly(page);
        expect(before.repair).toMatchObject({ status: 'proposed', action: 'rerun', attempt: 0, appliedAt: null });

        // The same question sits on the process it is about.
        await overview.getByTestId('assistant-component-processes').click();
        const report = page.getByTestId('assistant-processes');
        const row = report.getByTestId('process-row').filter({ hasText: 'Nightly import' });
        const repair = row.getByTestId('process-repair');
        await expect(repair).toHaveAttribute('data-repair-status', 'proposed');
        await expect(repair).toContainText('A repair is proposed: run it once more with nothing changed. Nothing has been done yet.');
        await expect(repair.getByTestId('gate-decision').getByRole('button')).toHaveText(['Run it once now', 'Leave it']);

        // Approving applies it as the person's own act and starts the check.
        await repair.getByRole('button', { name: 'Run it once now' }).click();
        await expect(page.locator('#toast')).toHaveText('"Nightly import" is being run now. You will be told how it went.');
        await expect(repair).toHaveAttribute('data-repair-status', 'verifying');
        await expect(repair).toContainText('Repair under way');
        await expect(repair).toContainText('as you approved');
        await expect(repair).toContainText('Attempt 1 of 1.');
        await expect(repair.getByTestId('gate-decision')).toHaveCount(0);
        expect((await nightly(page)).repair).toMatchObject({ status: 'verifying', actor: 'person', attempt: 1, allowed: 1, rollback: null });

        // The run after it fails: that, not a model's opinion, is the verdict.
        const after = await fixture(page, { userId: OWNER, step: 'outcome', outcome: 'failed' });
        expect(after.pass).toMatchObject({ repairs: 1 });
        await page.reload();
        await expect(repair).toHaveAttribute('data-repair-status', 'failed');
        await expect(repair).toContainText('Repair did not work');
        await expect(repair).toContainText('the run after it failed (RUN_FAILED)');
        await expect(repair).toContainText('No attempts are left.');
        await expect(repair.getByTestId('gate-decision').getByRole('button')).toHaveText(['Pause it', 'Leave it running']);
        expect((await nightly(page)).repair).toMatchObject({ status: 'failed', stopCode: 'RUN_FAILED', direction: 'asked' });

        // The attempt cap holds: another pass offers nothing more, and the one question stays one.
        const again = await fixture(page, { userId: OWNER, step: 'outcome', outcome: 'failed' });
        expect(again.pass.repairs).toBe(0);
        await page.goto('/app/');
        await expect(asks).toHaveCount(1);
        await expect(asks).toContainText('"Nightly import" still fails after 1 repair attempt');

        // Pausing from the question pauses the process and answers it everywhere.
        await asks.getByRole('button', { name: 'Pause it' }).click();
        await expect(page.locator('#toast')).toHaveText('Paused "Nightly import". Nothing new will start, and you can resume it from Processes.');
        await expect(overview.getByTestId('assistant-needs-you-empty')).toBeVisible();
        expect(await nightly(page)).toMatchObject({
            enabled: false, lifecycle: { stage: 'paused', actor: 'person' }, repair: { status: 'failed', direction: 'pause' }
        });
    });

    test('a repair that works is said once and watched until the next scheduled run', async ({ page }) => {
        await fixture(page, { userId: OWNER, name: NAME });
        await login(page, { userId: OWNER, name: NAME });
        await page.goto('/app/assistant#processes');
        const report = page.getByTestId('assistant-processes');
        const repair = report.getByTestId('process-row').filter({ hasText: 'Nightly import' }).getByTestId('process-repair');
        await repair.getByRole('button', { name: 'Run it once now' }).click();
        await expect(repair).toHaveAttribute('data-repair-status', 'verifying');

        // The run after it works: verified, and still watched.
        expect((await fixture(page, { userId: OWNER, step: 'outcome', outcome: 'ok' })).pass).toMatchObject({ repairs: 1 });
        await page.reload();
        await expect(repair).toHaveAttribute('data-repair-status', 'observing');
        await expect(repair).toContainText('Repaired');
        await expect(repair).toContainText('Its next scheduled run is being watched before it counts as fixed.');
        await expect(repair.getByTestId('gate-decision')).toHaveCount(0);

        // Its next run works too: the repair held, and nothing asks for the person.
        await fixture(page, { userId: OWNER, step: 'outcome', outcome: 'ok' });
        await page.reload();
        await expect(repair).toHaveAttribute('data-repair-status', 'succeeded');
        await expect(repair).toContainText('Repair held');
        await page.goto('/app/');
        const overview = page.getByTestId('assistant-overview');
        await expect(overview.getByTestId('assistant-needs-you-empty')).toBeVisible();
        await expect(overview.getByTestId('assistant-brief-item').filter({ hasText: 'The repair of "Nightly import" held' })).toHaveCount(1);
    });

    test('a declined repair is not offered again, and nobody but the owner is offered one', async ({ page }) => {
        await fixture(page, { userId: OWNER, name: NAME });
        await login(page, { userId: OWNER, name: NAME });
        const overview = page.getByTestId('assistant-overview');
        const asks = overview.getByTestId('assistant-needs-you-item');
        await asks.getByRole('button', { name: 'Leave it' }).click();
        await expect(page.locator('#toast')).toHaveText('"Nightly import" is left as it is.');
        await expect(overview.getByTestId('assistant-needs-you-empty')).toBeVisible();
        expect((await nightly(page)).repair).toMatchObject({ status: 'declined', appliedAt: null });

        // It still fails, and the next pass leaves the person's answer alone.
        expect((await fixture(page, { userId: OWNER, step: 'outcome', outcome: 'failed' })).pass.repairs).toBe(0);
        await page.reload();
        await expect(overview.getByTestId('assistant-needs-you-empty')).toBeVisible();
        await overview.getByTestId('assistant-component-processes').click();
        const row = page.getByTestId('assistant-processes').getByTestId('process-row').filter({ hasText: 'Nightly import' });
        await expect(row.getByTestId('process-execution')).toContainText('Blocked');
        await expect(row.getByTestId('process-repair')).toHaveCount(0);

        // Somebody who is not the owner has the same failing process and is told about it, with no repair.
        const other = await fixture(page, { userId: OTHER, name: 'Guest', owner: false });
        expect(other.pass).toMatchObject({ opened: 1, repairs: 0 });
        await page.context().clearCookies();
        await login(page, { userId: OTHER, name: 'Guest' });
        await expect(page.getByTestId('assistant-overview').getByTestId('assistant-needs-you-empty')).toBeVisible();
        await expect(page.getByTestId('assistant-overview').getByTestId('assistant-brief-item')).toContainText('"Nightly import" keeps failing');
        expect((await nightly(page)).repair).toBeNull();
    });
});
