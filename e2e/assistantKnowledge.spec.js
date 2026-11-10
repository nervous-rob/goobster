/**
 * Knowledge work done for you (documentation/delegated_knowledge.md, DA-11b).
 *
 * A suggested change to a note the person saved shows what would change as a
 * diff, and nothing changes until they apply it; an applied change and a
 * change a run made directly can be undone; an archived generated note comes
 * back with Restore; the note-work grants are offered to the installation's
 * owner and to nobody else while it is in the pilot.
 */
const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');

const OWNER = '99000000000001201';
const OTHER = '99000000000001202';

async function seed(page, body) {
    const seeded = await page.request.post('/e2e/fixtures/assistant-knowledge', { data: body });
    expect(seeded.ok(), await seeded.text()).toBe(true);
    return seeded.json();
}

test.describe('knowledge work done for you', () => {
    test.describe.configure({ mode: 'serial' });

    test('a suggested change shows a diff, changes nothing until applied, and can be undone', async ({ page }) => {
        const { proposalId } = await seed(page, { userId: OWNER, name: 'Gardener', owner: true });
        await login(page, { userId: OWNER, name: 'Gardener' });

        // Waiting for you: listed in the Assistant room and decided in the Inbox.
        await page.goto('/app/assistant');
        const panel = page.getByTestId('knowledge-changes');
        await expect(panel.getByTestId('knowledge-proposals')).toContainText('One suggestion is waiting for you');
        await expect(panel.getByTestId('knowledge-proposal')).toContainText('Frost date');

        await page.goto('/app/activity/inbox');
        const row = page.locator('.inbox-row').filter({ hasText: 'Suggested change to "Frost date"' });
        await expect(row).toHaveCount(1);
        const diff = row.getByTestId('gate-diff');
        await expect(diff.locator('[data-op="del"]')).toContainText('Frost is expected on the 14th.');
        await expect(diff.locator('[data-op="add"]')).toContainText('Frost is expected on the 9th.');
        await expect(diff.locator('[data-op="same"]')).toContainText('Cover the beans.');
        await expect(row.getByTestId('gate-decision').getByRole('button')).toHaveText(['Apply change', 'Dismiss']);

        // Nothing has changed yet.
        let overview = await (await page.request.get('/api/app/assistant/knowledge')).json();
        expect(overview.proposals.map((entry) => entry.id)).toEqual([proposalId]);

        await row.getByRole('button', { name: 'Apply change' }).click();
        await expect(page.locator('#toast')).toHaveText('Applied.');
        await expect(row.getByTestId('gate-decision')).toHaveCount(0);

        overview = await (await page.request.get('/api/app/assistant/knowledge')).json();
        expect(overview.proposals).toEqual([]);
        expect(overview.changes.find((entry) => entry.id === proposalId)).toMatchObject({ status: 'APPLIED', revertible: true });

        // The Assistant room offers the undo.
        await page.goto('/app/assistant');
        const applied = page.getByTestId('knowledge-change').filter({ hasText: 'Suggested change: Frost date' });
        await expect(applied).toContainText('Applied');
        await applied.getByTestId('knowledge-undo').click();
        await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click();
        await expect(page.locator('#toast')).toHaveText('Put back.');
        await expect(applied).toContainText('Undone');
        await expect(applied.getByTestId('knowledge-undo')).toHaveCount(0);
    });

    test('a change a run made directly is undone, and an archived note is restored', async ({ page }) => {
        const { directId } = await seed(page, { userId: OWNER, name: 'Gardener', owner: true });
        await login(page, { userId: OWNER, name: 'Gardener' });
        await page.goto('/app/assistant');

        const direct = page.getByTestId('knowledge-change').filter({ hasText: 'Changed directly: Soil test' });
        await expect(direct).toContainText('Applied');
        await direct.getByTestId('knowledge-undo').click();
        await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click();
        await expect(direct).toContainText('Undone');
        const overview = await (await page.request.get('/api/app/assistant/knowledge')).json();
        expect(overview.changes.find((entry) => entry.id === directId).status).toBe('REVERTED');

        const archived = page.getByTestId('knowledge-archived-note').filter({ hasText: 'Old watering schedule' });
        await expect(archived).toContainText('archived by an assistant run');
        await archived.getByTestId('knowledge-restore-note').click();
        await expect(page.locator('#toast')).toHaveText('Restored.');
        await expect(page.getByTestId('knowledge-archived-note')).toHaveCount(0);
    });

    test('a suggestion can be dismissed and the note stays as it was', async ({ page }) => {
        const { proposalId } = await seed(page, { userId: OWNER, name: 'Gardener', owner: true });
        await login(page, { userId: OWNER, name: 'Gardener' });
        await page.goto('/app/activity/inbox');
        const row = page.locator('.inbox-row').filter({ hasText: 'Suggested change to "Frost date"' });
        await row.getByRole('button', { name: 'Dismiss' }).click();
        await expect(row.getByTestId('gate-decision')).toHaveCount(0);
        const overview = await (await page.request.get('/api/app/assistant/knowledge')).json();
        expect(overview.changes.find((entry) => entry.id === proposalId)).toMatchObject({ status: 'REJECTED', revertible: false });
        await page.goto('/app/assistant');
        await expect(page.getByTestId('knowledge-proposals')).toHaveCount(0);
    });

    test('the owner is offered note work in the draft form, and somebody else is not', async ({ page }) => {
        await seed(page, { userId: OWNER, name: 'Gardener', owner: true });
        await login(page, { userId: OWNER, name: 'Gardener' });
        const access = page.waitForResponse((response) => response.url().includes('/api/app/assistant/access'));
        await page.goto('/app/assistant');
        expect((await (await access).json()).capabilities.reach).toBe(true);
        await page.getByTestId('responsibility-title').fill('Tidy my notes');
        const work = page.getByTestId('responsibility-note-work');
        await expect(work).toBeVisible();
        await page.getByTestId('responsibility-propose-notes').check();
        await page.getByTestId('responsibility-link-notes').check();
        await page.getByTestId('responsibility-save').click();
        const drafted = page.getByTestId('responsibility-row').filter({ hasText: 'Tidy my notes' });
        await expect(drafted).toContainText('May read, suggest changes to notes you saved (you apply them), connect notes: your knowledge');
        await expect(drafted).not.toContainText('amend notes you saved directly');
    });

    test('somebody who is not the owner is not offered note work during the pilot, and the server agrees', async ({ page }) => {
        await seed(page, { userId: OTHER, name: 'Neighbour' });
        await login(page, { userId: OTHER, name: 'Neighbour' });
        const access = page.waitForResponse((response) => response.url().includes('/api/app/assistant/access'));
        await page.goto('/app/assistant');
        expect((await (await access).json()).capabilities.reach).toBe(false);
        await expect(page.getByTestId('responsibility-title')).toBeVisible();
        await expect(page.getByTestId('responsibility-note-work')).toHaveCount(0);

        const drafted = await page.request.post('/api/app/assistant/responsibilities', {
            data: {
                title: 'Suggest note changes',
                operations: [
                    { operation: 'read', resource: { kind: 'knowledge', ids: ['personal'] } },
                    { operation: 'kg.saved.propose', resource: { kind: 'knowledge', ids: ['personal'] } }
                ]
            }
        });
        expect(drafted.ok(), await drafted.text()).toBe(true);
        const { responsibility } = await drafted.json();
        // Activating is confirmed with a receipt for what the person is shown
        // (ADR 0023): a bare activate is refused before anything else is asked.
        const bare = await page.request.post(`/api/app/assistant/responsibilities/${responsibility.id}/actions`, {
            data: { action: 'activate', expectedRevision: responsibility.revision }
        });
        expect(bare.status()).toBe(403);
        expect(JSON.stringify(await bare.json())).toContain('HUMAN_CONFIRMATION_REQUIRED');
        const confirmation = await page.request.post('/api/app/assistant/confirmations', {
            data: { subject: 'responsibility', id: responsibility.id, action: 'activate', revision: responsibility.revision, surface: 'portal' }
        });
        expect(confirmation.ok(), await confirmation.text()).toBe(true);
        const activated = await page.request.post(`/api/app/assistant/responsibilities/${responsibility.id}/actions`, {
            data: { action: 'activate', expectedRevision: responsibility.revision, receipt: (await confirmation.json()).receipt }
        });
        expect(activated.status()).toBe(409);
        expect(JSON.stringify(await activated.json())).toContain('PILOT_ONLY');
        const after = await page.request.get(`/api/app/assistant/responsibilities/${responsibility.id}`);
        expect((await after.json()).responsibility.status).toBe('DRAFT');

        // A source review is the owner's too.
        const review = await page.request.post('/api/app/assistant/knowledge/retractions', { data: { sourceKind: 'research_source', sourceId: 1 } });
        expect(review.status()).toBe(403);
        expect(JSON.stringify(await review.json())).toContain('PILOT_ONLY');
    });
});
